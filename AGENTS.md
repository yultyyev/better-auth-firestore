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
});
```

## Firestore Index (Optional)

No composite index is required. The adapter never issues a filter + `orderBy` query: `findMany` calls that combine a `where` filter with a `sortBy` apply the filter server-side and sort the results in memory. Verification-token lookups (`identifier ==` ordered by `createdAt desc`) therefore work with only Firestore's automatic single-field indexes.

Older versions (< v1.1) required a composite index on the verification collection (`identifier` ASC, `createdAt` DESC, `__name__` DESC). If a user reports `9 FAILED_PRECONDITION: The query requires an index` (often surfaced by Better Auth as `Failed to parse state`), the fix is to upgrade — not to create the index.

Helper (optional, for advanced/direct-query setups only): `generateIndexSetupUrl(projectId, databaseId?, collectionName?)` and `getIndexConfig(collectionName?)`. Both default `collectionName` to `verificationTokens` (use `verification_tokens` for snake_case).

## Important Constraints

- **Edge Runtime not supported** — Firebase Admin SDK requires Node.js. If a route sets `export const runtime = 'edge'`, the Admin SDK will not load. Standard Vercel deployments (Node.js serverless runtime) work fine.
- **FIREBASE_PRIVATE_KEY newlines** — Environment variables often store the key with literal `\n` strings. Users must call `.replace(/\\n/g, "\n")`.
- **Scoped package deprecated** — `@yultyyev/better-auth-firestore` → `better-auth-firestore`. The API is identical; only the import path changes.
- **Emulator support** — Set `FIRESTORE_EMULATOR_HOST=localhost:8080`; the Admin SDK automatically routes requests there. No credentials needed.

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
pnpm test          # Run tests (requires FIRESTORE_EMULATOR_HOST)
pnpm lint          # Check for linting issues
pnpm lint:fix      # Fix auto-fixable linting issues
```

## Test Setup

Tests use Vitest and run against the Firestore Emulator:

```bash
docker run -d --rm -p 8080:8080 google/cloud-sdk:emulators \
  gcloud beta emulators firestore start --host-port=0.0.0.0:8080

FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm vitest run
```

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
