# AI Assistant Guidelines

This document provides additional context for AI assistants working on this project. **Please read [README.md](./README.md) first** for project overview and features.

## Quick Reference

- **Package name:** `better-auth-firestore` (unscoped — `@yultyyev/better-auth-firestore` is deprecated)
- **Main Documentation:** See [README.md](./README.md)
- **Contributing Guidelines:** See [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Adapter Guide:** See [Better Auth Adapter Guide](https://www.better-auth.com/docs/guides/create-a-db-adapter)

## Current Project State

All phases are complete. The adapter is production-ready and actively maintained.

**Phase 1: Core Adapter** ✅ Complete  
**Phase 2: Collection naming strategies** ✅ Complete  
**Phase 3: Composite index tooling** ✅ Complete (`generateIndexSetupUrl`)  
**Phase 4: Emulator support** ✅ Complete  
**Phase 5: Tests (Vitest + Firestore Emulator)** ✅ Complete  
**Phase 6: CI/CD and Example Project** ✅ Complete  
**Phase 7: Migration from scoped package** ✅ Complete  

## Project Structure

```
src/
  firebase-adapter.ts    # Core Firestore adapter implementation
  firestore.ts           # initFirestore helper and Firestore utilities
  setup.ts               # generateIndexSetupUrl helper
  types.ts               # TypeScript types for adapter options
  index.ts               # Public exports
tests/
  *.test.ts              # Vitest integration tests (run against Firestore Emulator)
examples/
  minimal/               # Minimal Next.js App Router example
scripts/                 # Build/release scripts
```

## Key Exports

```ts
import {
  firestoreAdapter,         // Main adapter factory
  initFirestore,            // Helper to initialize Firebase Admin + Firestore
  generateIndexSetupUrl,    // Generate Firebase Console URL for index creation
  backfillAccountIssuers,   // One-off data migration for Better Auth 1.7 (account.issuer)
} from "better-auth-firestore";
```

## Adapter Options

```ts
firestoreAdapter({
  firestore?: Firestore;          // Firebase Admin Firestore instance (default: getFirestore())
  namingStrategy?: "default" | "snake_case";  // Collection naming convention
  collections?: {
    users?: string;
    sessions?: string;
    accounts?: string;
    verificationTokens?: string;
  };
  debugLogs?: boolean | DBAdapterDebugLogOption;
  migrationChecks?: boolean;      // default true: warn once at startup if account docs lack `issuer` (Better Auth 1.7)
});
```

## CLI

`npx better-auth-firestore backfill-account-issuers [--apply]` (`src/cli.ts`, `bin/better-auth-firestore.js`) is the one-command form of the Better Auth 1.7 account-issuer migration: dry run by default, `--apply` to write, `--collection` / `--naming-strategy` / `--issuer provider=url` / `--service-account` / `--json`; exit 1 on collisions or unresolved documents, 2 on usage errors. Credentials resolve like `initFirestore()` (service account file, `FIREBASE_*` env trio, ADC, emulator). It is the answer to "existing users can't sign in after upgrading to 1.7" — the startup check logs the exact command.

## Firestore Index (Optional)

No composite index is required. The adapter never issues a filter + `orderBy` query: `findMany` calls that combine a `where` filter with a `sortBy` apply the filter server-side and sort the results in memory. Verification-token lookups (`identifier ==` ordered by `createdAt desc`) therefore work with only Firestore's automatic single-field indexes. The native `incrementOne` (v1.3+) follows the same rule: only equality filters reach Firestore, range guards are evaluated in memory inside a transaction, so `rateLimit.storage: "database"` needs no composite index either.

Older versions required composite indexes — on the verification collection (`identifier` ASC, `createdAt` DESC, `__name__` DESC; < v1.1) and on `rateLimit` (< v1.3). If a user reports `9 FAILED_PRECONDITION: The query requires an index` (often surfaced by Better Auth as `Failed to parse state`), the fix is to upgrade — not to create the index.

## Better Auth 1.7 Compatibility

- 1.7 made `incrementOne` and `consumeOne` **required** on custom adapters and removed the `transaction(findMany + updateMany)` fallback. Both are implemented natively in `src/firebase-adapter.ts` — on the plain adapter *and* on the transaction adapter (`runWithTransaction` hands whatever our `transaction()` passes to its callback to plugins as the current adapter). Adding them is additive: 1.6 prefers a native implementation when present, so one codebase supports 1.6 and 1.7. CI runs the suite against both.
- 1.7 identifies accounts by `(issuer, accountId)`; `account.issuer` is required. Firestore has no `auth migrate`, so `backfillAccountIssuers` (`src/backfill-account-issuers.ts`, exposed as the CLI above) stamps existing documents. Rules mirror `@better-auth/core`: `credential` → `local:credential` (with `accountId = userId`), `siwe` → `local:siwe`, other providers → `local:oauth:<encodeURIComponent(providerId)>`; real issuers via `issuers` / `resolveIssuer`. `warnIfAccountsLackIssuer` in `src/firebase-adapter.ts` runs once per process when the adapter is bound to a `betterAuth()` instance whose schema has `issuer` (two `count()` aggregations; `orderBy(issuer)` excludes documents missing the field) and warns with the exact command.
- `SecondaryStorage.getAndDelete` / `increment` are required in 1.7; the test helper `tests/helpers/firestore-secondary-storage.ts` implements both (and encodes keys — better-auth keys contain `/`, which Firestore reads as a path separator).
- The transaction adapter is factory-wrapped, like the official MongoDB adapter: `transaction()` builds a per-transaction `CustomAdapter` (`createTransactionAdapter`) and passes it through `createAdapterFactory({ ...config, transaction: false })(options)` before handing it to the callback, so it receives the same mapped `modelName`/`fieldName`s, cleaned `where` clauses and transformed data (generated ids, `createdAt`/`updatedAt`, `emailVerified` defaults) as the plain adapter. better-auth calls the current adapter with schema model keys and raw data, so an unwrapped adapter silently targets the wrong collection as soon as a `modelName` is customised — `tests/transaction-model-name.test.ts` pins this. A custom `modelName` names the Firestore collection directly and takes precedence over the `collections` option, inside and outside transactions.

Helper (optional, for advanced/direct-query setups only): `generateIndexSetupUrl(projectId, databaseId?, collectionName?)` and `getIndexConfig(collectionName?)`. Both default `collectionName` to `verificationTokens` (use `verification_tokens` for snake_case).

## Important Constraints

- **Edge Runtime not supported** — Firebase Admin SDK requires Node.js. If a route sets `export const runtime = 'edge'`, the Admin SDK will not load. Standard Vercel deployments (Node.js serverless runtime) work fine.
- **FIREBASE_PRIVATE_KEY newlines** — Environment variables often store the key with literal `\n` strings. Users must call `.replace(/\\n/g, "\n")`.
- **Scoped package deprecated** — `@yultyyev/better-auth-firestore` → `better-auth-firestore`. The API is identical; only the import path changes.
- **Emulator support** — Set `FIRESTORE_EMULATOR_HOST=localhost:8080`; the Admin SDK automatically routes requests there. No credentials needed. The emulator does **not** enforce composite indexes, so index requirements only surface against real Firestore.

## Sister Package

`better-auth-firebase-auth` ([GitHub](https://github.com/yultyyev/better-auth-firebase-auth)) is the companion Firebase Authentication plugin. It handles Phone OTP, Google Sign-In, and Email/Password via Firebase. The two packages are designed to be used together:

- `better-auth-firestore` — database storage layer
- `better-auth-firebase-auth` — authentication/identity layer

## Code Style

- BiomeJS for formatting (tab indentation)
- TypeScript strict mode
- No classes — follow Better Auth's functional plugin conventions
- Keep functions small and focused

## Build Commands

```bash
pnpm install       # Install dependencies
pnpm build         # Build the project (outputs to dist/)
pnpm typecheck     # Typecheck src + tests without emitting
pnpm test          # Run tests (requires FIRESTORE_EMULATOR_HOST)
pnpm verify:pack   # Pack the tarball and import/type-check it from a scratch consumer (after pnpm build)
pnpm lint          # Check for linting issues
pnpm lint:fix      # Fix auto-fixable linting issues
```

The build emits ESM only; `main` and both `exports["."]` conditions (`import`, `require`) point at `./dist/index.js`, and `require()` works through Node's `require(esm)` (>= 22.12). Never point `main` or `require` at a `.cjs` file — the build does not produce one, and that exact mistake shipped in every release up to 1.2.9. `pnpm verify:pack` is what catches it.

## Test Setup

Tests use Vitest and run against the Firestore Emulator:

```bash
docker run -d --rm -p 8080:8080 google/cloud-sdk:emulators \
  gcloud beta emulators firestore start --host-port=0.0.0.0:8080

FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm vitest run
```

CI runs three things on every PR: the lint/build/test job as a matrix against the lockfile's Better Auth (1.7) and the latest 1.6 (`pnpm add -D better-auth@1.6`), each ending with `pnpm verify:pack`; and a `types` job that typechecks and builds under TypeScript 5, 6 and 7. Keep all of them green — the adapter promises to work with every combination.

## Commit Messages

Follow Conventional Commits:

- `feat(adapter): description` — New features
- `fix(adapter): description` — Bug fixes
- `docs: description` — Documentation changes
- `chore: description` — Build/tooling changes
- `test: description` — Test changes

## References

- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Better Auth Adapter Guide](https://www.better-auth.com/docs/guides/create-a-db-adapter)
- [Firebase Admin SDK Docs](https://firebase.google.com/docs/admin/setup)
- [Firestore Emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore)
- [better-auth-firebase-auth](https://github.com/yultyyev/better-auth-firebase-auth)
