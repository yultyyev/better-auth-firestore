#!/usr/bin/env bash
#
# Packaging smoke test.
#
# The test suite imports from src/, so nothing else exercises what npm
# actually publishes. This packs the tarball, installs it into a throwaway
# consumer alongside the peer deps, and asserts that the published entry
# point resolves at runtime (ESM and CommonJS) and keeps its types under
# both `moduleResolution: "nodenext"` and `"bundler"`.
#
# Requires `pnpm build` to have run first. Run locally with `pnpm verify:pack`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="better-auth-firestore"
PEERS=("better-auth" "firebase-admin")

actual_name="$(cd "$REPO_ROOT" && node -p 'require("./package.json").name')"
if [[ "$actual_name" != "$PKG_NAME" ]]; then
	echo "error: package is now named '$actual_name'; update the fixtures in $0" >&2
	exit 1
fi

if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
	echo "error: dist/ is missing or incomplete. Run \`pnpm build\` first." >&2
	exit 1
fi

TSC="$REPO_ROOT/node_modules/typescript/bin/tsc"
if [[ ! -f "$TSC" ]]; then
	echo "error: typescript not found at $TSC. Run \`pnpm install\` first." >&2
	exit 1
fi

# Outside the repo on purpose: inside it, pnpm would treat the consumer as
# part of this project.
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pack-smoke.XXXXXX")"
if [[ -n "${PACK_SMOKE_KEEP:-}" ]]; then
	echo "note: keeping $WORK (PACK_SMOKE_KEEP is set)"
else
	trap 'rm -rf "$WORK"' EXIT
fi

CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"

echo "==> npm pack"
(cd "$REPO_ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)
TARBALL="$(find "$WORK" -maxdepth 1 -name '*.tgz' -print -quit)"
if [[ -z "$TARBALL" ]]; then
	echo "error: npm pack produced no tarball" >&2
	exit 1
fi
echo "    $(basename "$TARBALL")"

# Pin the peers to the ranges the test suite already runs against, so this
# never drifts from package.json.
PEER_DEPS="$(cd "$REPO_ROOT" && node -p '
	const dev = require("./package.json").devDependencies ?? {};
	const peers = process.argv.slice(1);
	const missing = peers.filter((name) => !dev[name]);
	if (missing.length > 0) {
		console.error(`error: no devDependency range for ${missing.join(", ")}`);
		process.exit(1);
	}
	JSON.stringify(Object.fromEntries(peers.map((name) => [name, dev[name]])), null, 2);
' "${PEERS[@]}")"

cat > "$CONSUMER/package.json" <<EOF
{
  "name": "pack-smoke-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": $PEER_DEPS
}
EOF

echo "==> installing the tarball next to ${PEERS[*]}"
(cd "$CONSUMER" && npm install --no-audit --no-fund --ignore-scripts --loglevel=error "$TARBALL")

EXPECTED_EXPORTS='["firestoreAdapter","initFirestore","generateIndexSetupUrl","getIndexConfig","backfillAccountIssuers","localAccountIssuer","oauthAccountIssuer"]'

cat > "$CONSUMER/esm-smoke.mjs" <<EOF
const expected = $EXPECTED_EXPORTS;
const mod = await import("better-auth-firestore");
const missing = expected.filter((name) => typeof mod[name] !== "function");
if (missing.length > 0) {
	throw new Error(\`import("better-auth-firestore") is missing: \${missing.join(", ")}\`);
}
console.log('    ok  import("better-auth-firestore")');
EOF

cat > "$CONSUMER/cjs-smoke.cjs" <<EOF
// The package is ESM-only, so this leans on Node's require(esm) support (>= 22.12).
const expected = $EXPECTED_EXPORTS;
const mod = require("better-auth-firestore");
const missing = expected.filter((name) => typeof mod[name] !== "function");
if (missing.length > 0) {
	throw new Error(\`require("better-auth-firestore") is missing: \${missing.join(", ")}\`);
}
console.log('    ok  require("better-auth-firestore")');
EOF

cat > "$CONSUMER/consumer.ts" <<'EOF'
import {
	backfillAccountIssuers,
	firestoreAdapter,
	generateIndexSetupUrl,
	getIndexConfig,
	initFirestore,
	localAccountIssuer,
	oauthAccountIssuer,
} from "better-auth-firestore";
import type {
	BackfillAccountIssuersOptions,
	BackfillAccountIssuersResult,
	FirestoreAdapterConfig,
	FirestoreCollectionsOverride,
	NamingStrategy,
} from "better-auth-firestore";

const namingStrategy: NamingStrategy = "snake_case";
const collections: FirestoreCollectionsOverride = { users: "app_users" };
const config: FirestoreAdapterConfig = { namingStrategy, collections };

export const adapter = firestoreAdapter({ firestore: initFirestore(), ...config });
export const indexUrl: string = generateIndexSetupUrl("project-id");
export const indexConfig = getIndexConfig("verification_tokens");
export const issuers: [string, string] = [
	localAccountIssuer("credential"),
	oauthAccountIssuer("firebase"),
];

const backfillOptions: BackfillAccountIssuersOptions = {
	dryRun: true,
	issuers: { okta: "https://acme.okta.com" },
};
export const backfill: Promise<BackfillAccountIssuersResult> =
	backfillAccountIssuers(backfillOptions);

// If the published declarations degrade to `any` -- which is how a
// nodenext resolution failure shows up under skipLibCheck -- these stop
// erroring, and tsc then reports the directives themselves as unused,
// failing the check.
// @ts-expect-error "camelCase" is not a NamingStrategy.
export const badStrategy: NamingStrategy = "camelCase";
// @ts-expect-error dryRun is a boolean, not a string.
export const badOptions: BackfillAccountIssuersOptions = { dryRun: "yes" };
EOF

write_tsconfig() {
	cat > "$CONSUMER/tsconfig.$1.json" <<EOF
{
  "compilerOptions": {
    "module": "$2",
    "moduleResolution": "$1",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "files": ["consumer.ts"]
}
EOF
}
write_tsconfig nodenext nodenext
write_tsconfig bundler preserve

echo "==> resolving the entry point"
(cd "$CONSUMER" && node ./esm-smoke.mjs && node ./cjs-smoke.cjs)

echo "==> running the CLI from the installed package"
BIN="$CONSUMER/node_modules/.bin/better-auth-firestore"
if [[ ! -x "$BIN" ]]; then
	echo "error: the package did not install a better-auth-firestore bin" >&2
	exit 1
fi
if ! (cd "$CONSUMER" && "$BIN" --help | grep -q "backfill-account-issuers"); then
	echo "error: better-auth-firestore --help did not list backfill-account-issuers" >&2
	exit 1
fi
echo "    ok  better-auth-firestore --help"

echo "==> type-checking a consumer"
for resolution in nodenext bundler; do
	(cd "$CONSUMER" && node "$TSC" -p "tsconfig.$resolution.json")
	echo "    ok  moduleResolution: \"$resolution\""
done

echo "==> packaging smoke test passed"
