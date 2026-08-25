import { parseArgs } from "node:util";
import {
	type App,
	type AppOptions,
	cert,
	deleteApp,
	initializeApp,
} from "firebase-admin/app";
import { type Firestore, initializeFirestore } from "firebase-admin/firestore";
import {
	type BackfillAccountIssuersResult,
	backfillAccountIssuers,
} from "./backfill-account-issuers.js";
import type { NamingStrategy } from "./types.js";

// `npx better-auth-firestore <command>` — the package's one-off maintenance
// commands. Dependency-free: Node's `parseArgs` plus the Admin SDK the
// adapter already requires.

const HELP = `Usage: better-auth-firestore <command> [options]

Commands:
  backfill-account-issuers   Stamp \`issuer\` on existing account documents for
                             Better Auth 1.7. Reports only, unless --apply.

Options for backfill-account-issuers:
  --apply                    Write the changes (default: dry run, report only)
  --collection <name>        Accounts collection (default: accounts)
  --naming-strategy <s>      "default" or "snake_case", as passed to firestoreAdapter
  --issuer <providerId=url>  Issuer for a provider whose real one can't be resolved
                             offline (repeatable), e.g. --issuer okta=https://acme.okta.com.
                             Required for cognito, paybin, microsoft (Entra ID),
                             okta, auth0, keycloak, microsoft-entra-id — google,
                             apple, facebook and line resolve on their own.
  --overwrite                Re-stamp documents that already have an issuer
  --batch-size <n>           Documents per page / write batch, 1-500 (default: 500)
  --service-account <file>   Service-account JSON to authenticate with
  --project <id>             Firebase project id (when not in the credentials)
  --database <id>            Firestore database id (default: "(default)")
  --json                     Print the report as JSON
  -h, --help                 Show this help

Credentials are resolved the way the adapter's initFirestore() does:
--service-account, then FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL +
FIREBASE_PRIVATE_KEY, then GOOGLE_APPLICATION_CREDENTIALS / Application
Default Credentials. FIRESTORE_EMULATOR_HOST routes everything to the emulator.

Exit status: 0 when every document resolved and no (issuer, accountId) pair is
shared; 1 when the report lists collisions or unresolved documents, or on a
runtime error; 2 on usage errors.`;

const OPTIONS = {
	apply: { type: "boolean" },
	collection: { type: "string" },
	"naming-strategy": { type: "string" },
	issuer: { type: "string", multiple: true },
	overwrite: { type: "boolean" },
	"batch-size": { type: "string" },
	"service-account": { type: "string" },
	project: { type: "string" },
	database: { type: "string" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<
	typeof parseArgs<{ options: typeof OPTIONS }>
>["values"];

export interface CliIO {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const defaultIO: CliIO = {
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
};

class UsageError extends Error {}

/**
 * Admin SDK app options from the flags and the environment, mirroring the
 * credential sources the README documents for the adapter. Returns `{}`
 * for the Application Default Credentials / emulator case.
 */
function resolveAppOptions(values: Values): AppOptions {
	const options: AppOptions = {};
	if (values.project) options.projectId = values.project;

	if (values["service-account"]) {
		options.credential = cert(values["service-account"]);
		return options;
	}

	const projectId = process.env.FIREBASE_PROJECT_ID;
	const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
	const privateKey = process.env.FIREBASE_PRIVATE_KEY;
	if (projectId && clientEmail && privateKey) {
		options.credential = cert({
			projectId,
			clientEmail,
			// Env vars routinely carry the key with literal "\n" sequences.
			privateKey: privateKey.replace(/\\n/g, "\n"),
		});
		options.projectId ??= projectId;
		return options;
	}

	if (projectId) options.projectId ??= projectId;
	return options;
}

function parseIssuers(entries: string[]): Record<string, string> {
	const issuers: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf("=");
		if (eq <= 0 || eq === entry.length - 1)
			throw new UsageError(
				`--issuer expects <providerId>=<issuer>, got "${entry}"`,
			);
		issuers[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return issuers;
}

function parseNamingStrategy(value: string | undefined): NamingStrategy {
	if (value === undefined || value === "default") return "default";
	if (value === "snake_case") return "snake_case";
	throw new UsageError(
		`--naming-strategy must be "default" or "snake_case", got "${value}"`,
	);
}

function parseBatchSize(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number.parseInt(value, 10);
	if (!(n >= 1 && n <= 500))
		throw new UsageError(
			`--batch-size must be between 1 and 500, got "${value}"`,
		);
	return n;
}

function formatReport(
	result: BackfillAccountIssuersResult,
	apply: boolean,
): string[] {
	const lines: string[] = [];
	const noun = result.scanned === 1 ? "document" : "documents";
	lines.push(
		`${apply ? "Backfilled" : "Dry run over"} ${result.scanned} account ${noun}`,
	);
	lines.push(
		`  ${apply ? "updated" : "would update"}: ${result.updated}   already stamped: ${result.skipped}   unresolved: ${result.unresolved.length}`,
	);
	if (result.credentialAccountIdsRepaired > 0)
		lines.push(
			`  credential accountId ${apply ? "repaired" : "to repair"} (set to userId): ${result.credentialAccountIdsRepaired}`,
		);
	if (result.legacyIssuersRepaired.length > 0) {
		// These accounts could not sign in on 1.7: adapter v1.3.0's backfill
		// stamped the synthetic issuer on a provider that publishes a real one.
		lines.push(
			`  wrong issuers left by the v1.3.0 backfill ${apply ? "repaired" : "to repair"}: ${result.legacyIssuersRepaired.length}`,
		);
		for (const r of result.legacyIssuersRepaired.slice(0, 20))
			lines.push(`    ${r.id}: ${r.from} → ${r.to}`);
		if (result.legacyIssuersRepaired.length > 20)
			lines.push(`    … ${result.legacyIssuersRepaired.length - 20} more`);
	}
	if (result.legacySupersededSkipped.length > 0) {
		// Left alone on purpose: the user self-healed during the outage, so a
		// correctly stamped row already owns this (issuer, accountId).
		lines.push(
			`  stale duplicates left by the v1.3.0 backfill, superseded by a correctly`,
			`  stamped account — inert, delete at your discretion: ${result.legacySupersededSkipped.length}`,
		);
		for (const s of result.legacySupersededSkipped.slice(0, 20))
			lines.push(`    ${s.id}  (${s.issuer} / ${s.accountId})`);
		if (result.legacySupersededSkipped.length > 20)
			lines.push(`    … ${result.legacySupersededSkipped.length - 20} more`);
	}
	const byIssuer = Object.entries(result.byIssuer).sort(
		([, a], [, b]) => b - a,
	);
	if (byIssuer.length > 0) {
		lines.push("  by issuer:");
		for (const [issuer, count] of byIssuer)
			lines.push(`    ${issuer}  ${count}`);
	}
	if (result.unresolved.length > 0) {
		lines.push(
			"  unresolved (no providerId, the resolver returned nothing, or the provider's",
			"  real issuer isn't knowable offline — pass --issuer) — document ids:",
		);
		for (const id of result.unresolved.slice(0, 20)) lines.push(`    ${id}`);
		if (result.unresolved.length > 20)
			lines.push(`    … ${result.unresolved.length - 20} more`);
	}
	if (result.collisions.length > 0) {
		lines.push(
			"  collisions — Better Auth 1.7 treats (issuer, accountId) as unique; resolve these by hand:",
		);
		for (const c of result.collisions.slice(0, 20))
			lines.push(`    ${c.issuer} / ${c.accountId}: ${c.ids.join(", ")}`);
		if (result.collisions.length > 20)
			lines.push(`    … ${result.collisions.length - 20} more`);
	}
	if (!apply)
		lines.push(
			"Nothing was written. Re-run with --apply to write the changes.",
		);
	return lines;
}

let appCounter = 0;

/**
 * Runs the CLI with the arguments after the program name and returns the
 * process exit status. Exported so tests can drive it in-process;
 * `bin/better-auth-firestore.js` wires it to `process.argv`.
 */
export async function runCli(
	argv: string[],
	io: CliIO = defaultIO,
): Promise<number> {
	let values: Values;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			options: OPTIONS,
			allowPositionals: true,
			strict: true,
		}));
	} catch (error) {
		io.stderr(`error: ${(error as Error).message}`);
		io.stderr("");
		io.stderr(HELP);
		return 2;
	}

	if (values.help) {
		io.stdout(HELP);
		return 0;
	}
	if (positionals.length === 0) {
		io.stderr(HELP);
		return 2;
	}
	if (positionals[0] !== "backfill-account-issuers" || positionals.length > 1) {
		io.stderr(`error: unknown command "${positionals.join(" ")}"`);
		io.stderr("");
		io.stderr(HELP);
		return 2;
	}

	let app: App | undefined;
	try {
		const namingStrategy = parseNamingStrategy(values["naming-strategy"]);
		const batchSize = parseBatchSize(values["batch-size"]);
		const issuers = parseIssuers(values.issuer ?? []);
		const apply = values.apply === true;

		// The CLI owns its app so it can tear the gRPC channel down at the end;
		// otherwise the process lingers after the report is printed.
		app = initializeApp(
			resolveAppOptions(values),
			`better-auth-firestore-cli-${++appCounter}`,
		);
		const firestore: Firestore = values.database
			? initializeFirestore(app, {}, values.database)
			: initializeFirestore(app);

		const result = await backfillAccountIssuers({
			firestore,
			collection: values.collection,
			namingStrategy,
			issuers,
			overwrite: values.overwrite === true,
			dryRun: !apply,
			batchSize,
		});

		if (values.json) io.stdout(JSON.stringify({ apply, ...result }, null, 2));
		else for (const line of formatReport(result, apply)) io.stdout(line);

		return result.collisions.length > 0 || result.unresolved.length > 0 ? 1 : 0;
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`error: ${error.message}`);
			io.stderr("Run `better-auth-firestore --help` for usage.");
			return 2;
		}
		io.stderr(
			`error: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	} finally {
		if (app) await deleteApp(app).catch(() => undefined);
	}
}
