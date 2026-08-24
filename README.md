# better-auth-firestore

[![npm version](https://img.shields.io/npm/v/better-auth-firestore.svg)](https://www.npmjs.com/package/better-auth-firestore)
[![CI](https://github.com/yultyyev/better-auth-firestore/actions/workflows/release.yml/badge.svg)](https://github.com/yultyyev/better-auth-firestore/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![skills.sh](https://skills.sh/b/yultyyev/better-auth-firestore)](https://skills.sh/yultyyev/better-auth-firestore)

**Firestore (Firebase Admin SDK) adapter for Better Auth.** A drop-in replacement for the Auth.js Firebase adapter with matching data shape.

- **Install:** `pnpm add better-auth-firestore firebase-admin better-auth`
- **Docs:** [Quickstart](#quick-start) • [Options](#options) • [Better Auth 1.7 upgrade](#upgrading-to-better-auth-17) • [Migration](#migration-from-authjsnextauth) • [Emulator](#using-the-firestore-emulator)
- **Example:** See [`/examples/minimal`](./examples/minimal) for a complete Next.js App Router example
- **AI skill:** [Cursor, Claude Code, Codex & 70+ agents](#ai-assistant-skill) — `npx skills add yultyyev/better-auth-firestore` • [llms.txt](./llms.txt)

> [!IMPORTANT]
> **Upgrading to Better Auth 1.7 with existing users?** 1.7 looks accounts up by a new `issuer` field that older documents don't have, so existing users can't sign in until it's backfilled. Before your first deploy on 1.7, run:
>
> ```bash
> npx better-auth-firestore backfill-account-issuers          # dry run — prints a report
> npx better-auth-firestore backfill-account-issuers --apply  # writes
> ```
>
> The adapter warns on startup while any account document is missing it. Details: [Upgrading to Better Auth 1.7](#upgrading-to-better-auth-17).

---

## Related: Firebase Auth Plugin

For Firebase Authentication integration with Better Auth, see **[better-auth-firebase-auth](https://github.com/yultyyev/better-auth-firebase-auth)**. It provides:

- Firebase Phone Authentication (SMS OTP) — no Twilio required
- Google Sign-In via Firebase OAuth flow
- Email/Password sign-in and password reset via Firebase
- Full TypeScript support with separate server/client entry points

Use `better-auth-firebase-auth` for authentication and `better-auth-firestore` for data storage. They are designed to be used together:

```ts
import { firestoreAdapter } from "better-auth-firestore";
import { firebaseAuthPlugin } from "better-auth-firebase-auth/server";

export const auth = betterAuth({
  database: firestoreAdapter({ firestore }),
  plugins: [firebaseAuthPlugin({ firebaseAdminAuth: getAuth() })],
});
```

---

## Installation

# npm

```bash
npm install better-auth-firestore firebase-admin better-auth
```

# pnpm

```bash
pnpm add better-auth-firestore firebase-admin better-auth
```

# yarn

```bash
yarn add better-auth-firestore firebase-admin better-auth
```

# bun

```bash
bun add better-auth-firestore firebase-admin better-auth
```

### Minimal usage

```ts
import { firestoreAdapter } from "better-auth-firestore";
import { betterAuth } from "better-auth";
import { getFirestore } from "firebase-admin/firestore";

export const auth = betterAuth({
  database: firestoreAdapter({ firestore: getFirestore() })
});
```

## Quick start

```ts
import { betterAuth } from "better-auth";
import { firestoreAdapter, initFirestore } from "better-auth-firestore";
import { cert } from "firebase-admin/app";

const firestore = initFirestore({
	credential: cert({
		projectId: process.env.FIREBASE_PROJECT_ID!,
		clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
		privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
	}),
	projectId: process.env.FIREBASE_PROJECT_ID!,
	name: "better-auth",
});

export const auth = betterAuth({
	// ... your Better Auth options
	database: firestoreAdapter({
		firestore,
		namingStrategy: "default", // or "snake_case"
		collections: {
			// users: "users",
			// sessions: "sessions",
			// accounts: "accounts",
			// verificationTokens: "verificationTokens",
		},
	}),
});
```

## Firebase Setup

### 1. Create a new Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" or "Create a project"
3. Enter a project name and follow the setup wizard

### 2. Create Firestore Database

1. In your Firebase project, go to **Build** → **Firestore Database**
2. Click "Create database"
3. Choose your preferred security rules mode (you can update rules later)
4. Select a location for your database

### 3. Firestore Index (Optional)

> **No composite index is required.** As of v1.1, the adapter sorts filtered queries — including verification-token lookups — in memory, so Firestore's automatic single-field indexes are sufficient. As of v1.3 that includes `rateLimit.storage: "database"`: the adapter implements Better Auth's `incrementOne` natively and evaluates the limiter's range guards in memory inside a Firestore transaction, so only an equality filter on `key` ever reaches Firestore.

If you're upgrading from an earlier version that required composite indexes — on the verification collection (`identifier` ASC, `createdAt` DESC, before v1.1) or on `rateLimit` (`key`/`lastRequest` and `key`/`count`/`lastRequest`, before v1.3) — you can safely leave them in place or delete them; the adapter no longer depends on either.

The `generateIndexSetupUrl` / `getIndexConfig` helpers and the bundled `firestore.indexes.json` are still exported for advanced setups (for example, if you run your own `where` + `orderBy` queries directly against the verification collection outside the adapter). They default to the `verificationTokens` collection; pass `"verification_tokens"` when using the snake_case naming strategy, or your custom collection name.

### 4. Generate Service Account Key

1. Go to **Project Settings** (gear icon) → **Service Accounts**
2. Under "Firebase Admin SDK", click **"Generate new private key"**
3. Download the JSON file (keep it secure - never commit it to version control)

### 5. Extract Environment Variables

From the downloaded service account JSON file, extract these values:

- `project_id` → `FIREBASE_PROJECT_ID`
- `client_email` → `FIREBASE_CLIENT_EMAIL`
- `private_key` → `FIREBASE_PRIVATE_KEY` (requires newline replacement - see [Troubleshooting](#troubleshooting))

**Alternative:** You can use the JSON file directly by setting `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of your service account JSON file.

### 6. (Optional) Set up Security Rules

The adapter uses the Firebase Admin SDK (server-side), so Firestore security rules should deny direct client access. See [Firestore Security Rules](#firestore-security-rules) below.

## Environment Variables

Required environment variables:

- `FIREBASE_PROJECT_ID` - Your Firebase project ID
- `FIREBASE_CLIENT_EMAIL` - Service account email from the JSON file
- `FIREBASE_PRIVATE_KEY` - Service account private key (with newlines properly escaped)

**Note:** The `FIREBASE_PRIVATE_KEY` often contains literal `\n` characters in environment variables. See [Troubleshooting](#troubleshooting) for how to handle this.

## Options

```ts
firestoreAdapter({
	firestore?: Firestore;
	namingStrategy?: "default" | "snake_case";
	collections?: { users?: string; sessions?: string; accounts?: string; verificationTokens?: string };
	debugLogs?: boolean | DBAdapterDebugLogOption;
	migrationChecks?: boolean; // default true — see "Upgrading to Better Auth 1.7"
});
```

**Default collection names:**
- `users`: "users"
- `sessions`: "sessions"
- `accounts`: "accounts"
- `verificationTokens`: "verification_tokens" (snake_case) or "verificationTokens" (default)

**Custom model names:** a Better Auth `modelName` (for example `user: { modelName: "app_users" }`, or a plugin model) names the Firestore collection directly and takes precedence over `collections`. The mapping is applied consistently, including for operations Better Auth runs inside `adapter.transaction` (such as sign-up).

### Debug logging

```ts
firestoreAdapter({
  firestore,
  debugLogs: true, // Enable verbose logging
});
```

## Compatibility

### Better Auth versions

| Better Auth | Status | Notes |
|---|---|---|
| `^1.7.0` | ✅ Recommended | Requires adapter v1.3+ (native `incrementOne`). Existing deployments must run the [account issuer backfill](#upgrading-to-better-auth-17) first. |
| `^1.6.0` | ✅ Supported | Tested in CI alongside 1.7; the same adapter release works with both. |
| `< 1.6` | ⚠️ Not covered by CI | Pin an older adapter release (≤ v1.2) if you need one. |

> **For older projects:** if your app still uses older Better Auth patterns (`createAuth` + `adapter`), this adapter remains compatible, but new projects should use `betterAuth` + `database`.

### TypeScript versions

| TypeScript | Status | Notes |
|---|---|---|
| `7.x` | ✅ Supported | Native compiler. Produces byte-identical declarations to 5.x/6.x. |
| `6.x` | ✅ Supported | Drop-in — no config changes required. |
| `5.x` | ✅ Supported | Minimum supported version is `5.0`; used for the published build. |

Every version above is exercised in CI (typecheck + build). TypeScript is an
**optional** peer dependency, so JavaScript-only projects never install it.

### Runtime compatibility

| Runtime | Supported | Notes |
|---|---|---|
| Node 22+ | ✅ | Required (active LTS and newer). `import` works throughout; `require()` needs 22.12+ — see below. |
| Next.js on Vercel (Node.js runtime) | ✅ | Default serverless runtime — fully supported |
| Cloud Functions / Cloud Run | ✅ | Provide `FIREBASE_*` creds |
| Vercel Edge Runtime (`runtime = 'edge'`) | ❌ | Firebase Admin SDK requires Node.js |
| Cloudflare Workers | ❌ | Firebase Admin SDK requires Node.js |

> **Vercel works.** The ❌ above applies only if you explicitly set `export const runtime = 'edge'` on a route. The default Node.js serverless runtime on Vercel is fully supported.

> **ESM and CommonJS.** The package ships a single ESM build. `import` works on any supported Node. `require("better-auth-firestore")` relies on Node's `require(esm)`, unflagged since **22.12** — so CommonJS callers (Firebase Cloud Functions and friends) need 22.12 or newer, which every current 22.x LTS release satisfies. TypeScript projects that emit CommonJS need `"module": "nodenext"` — the older `"node16"` setting predates `require(esm)` and reports [TS1479](https://typescript.tv/errors/#ts1479).

## Collections & Data Shape

The adapter maintains the same data shape as Auth.js/NextAuth for seamless migration:

| Collection | Typical fields |
|---|---|
| `users` | `id`, `email`, `name`, `image`, `createdAt`, `updatedAt` |
| `accounts` | `provider`, `providerAccountId`, `userId`, `access_token`, `refresh_token` |
| `sessions` | `sessionToken`, `userId`, `expires` |
| `verificationTokens` | `identifier`, `token`, `expires` |

> **Defaults:** Collections default to `users`, `sessions`, `accounts`, `verification_tokens` (snake_case) / `verificationTokens` (default). See [Options](#options) to customize collection names.
>
> **Note:** No composite index is required. Verification-token lookups are sorted in memory. See [Firebase Setup - Step 3](#3-firestore-index-optional) for details.

### Minimal Firestore Security Rules (server/admin only)

Since this adapter uses the Firebase Admin SDK (server-side), Firestore security rules should deny direct client access:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## Why this vs Auth.js Firebase adapter?

| Feature | Better Auth Firestore | Auth.js Firebase Adapter |
|---|---|---|
| **Status** | ✅ Active development | Now maintained by Better Auth team ([announcement](https://www.better-auth.com/blog/authjs-joins-better-auth)) |
| **Firebase Admin SDK** | ✅ Uses Admin SDK | ✅ Uses Admin SDK |
| **Data shape compatibility** | ✅ Matching shape, migration-free | - |
| **Drop-in replacement** | ✅ Yes | - |

This adapter is the Better Auth-native solution for Firestore users, recommended for new projects.

## Migration from Scoped Package

The scoped package `@yultyyev/better-auth-firestore` was unpublished from npm in August 2026 (it had been deprecated since January). Projects that still reference it keep working from their installed `node_modules`, but any fresh install — a new machine, CI, `rm -rf node_modules` — fails with `404 Not Found`. The fix is a rename; the API is identical:

1. **Update package name in your dependencies:**
   ```bash
   npm uninstall @yultyyev/better-auth-firestore
   npm install better-auth-firestore
   # or
   pnpm remove @yultyyev/better-auth-firestore
   pnpm add better-auth-firestore
   ```

2. **Update import statements:**
   ```ts
   // Before
   import { firestoreAdapter } from "@yultyyev/better-auth-firestore";
   
   // After
   import { firestoreAdapter } from "better-auth-firestore";
   ```

That's it! The API is identical, so no code changes are needed beyond the import path.

## Upgrading to Better Auth 1.7

Better Auth 1.7 changed how accounts are identified and what it requires from database adapters. Two things matter for Firestore users — read the official [1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide) for everything else (OAuth provider, SSO, SCIM, MCP, …).

**1. Adapter v1.3+ is required.** 1.7 made `incrementOne` a mandatory adapter method and removed the fallback earlier versions relied on. With adapter ≤ v1.2 on Better Auth 1.7, sign-in still works but every feature built on atomic counters throws `Adapter "firestore" must implement incrementOne` — database-backed rate limiting, organization invitations and team seats, device authorization, and two-factor lockout. v1.3 implements it natively and also works with 1.6, so upgrade the adapter first, independently of Better Auth.

**2. Existing account documents need an `issuer`.** 1.7 identifies an account by the pair `(issuer, accountId)` and stores `issuer` on every new account. Documents written by earlier versions don't have it, so after upgrading, 1.7 can't find them — **existing users can no longer sign in** until the field is backfilled. SQL users get this from `npx auth migrate`; Firestore has no migration runner, so the adapter ships the migration as one command. Run it with the same credentials your app uses (`GOOGLE_APPLICATION_CREDENTIALS`, the `FIREBASE_*` variables from [Environment Variables](#environment-variables), or `--service-account key.json`):

```bash
npx better-auth-firestore backfill-account-issuers            # dry run: prints the report, writes nothing
npx better-auth-firestore backfill-account-issuers --apply    # writes, with authentication writes paused
```

Add `--collection` / `--naming-strategy snake_case` if you customised the adapter, and `--issuer <providerId>=<url>` for a provider whose real issuer the backfill can't determine on its own — the built-in `cognito`, `paybin`, and `microsoft` (Entra ID) providers, and the fixed-id generic-OAuth helpers `okta`, `auth0`, `keycloak`, and `microsoft-entra-id`, whose issuer depends on how they're configured or on the live token. Those are reported as unresolved (exit status 1) until you supply one, rather than stamped with a value that may be wrong. `google`, `apple`, `facebook`, and `line` publish a fixed real issuer and resolve automatically; every other built-in social provider gets the synthetic `local:oauth:<providerId>` form 1.7 assigns when a provider has none of its own. (`slack` is ambiguous — the built-in social provider has no issuer, the generic-OAuth helper uses `https://slack.com`; it defaults to the synthetic form, so pass `--issuer slack=https://slack.com` if you use the helper.) `--help` lists everything.

> **Already ran this on adapter v1.3.0?** That release stamped `local:oauth:google` instead of the real `https://accounts.google.com` (and likewise for `apple`, `facebook`, and `line`), so those users still can't sign in even though the field is set — and because the field *is* set, the startup warning stays silent and a re-run of the old command reported nothing to do. Upgrade the adapter and run the backfill again: it detects that exact wrong value, repairs it, and lists the affected documents as `wrong issuers left by the v1.3.0 backfill`. Deliberate issuers you supplied yourself are never touched.

The command mirrors 1.7's own rules: `credential` → `local:credential` (and repairs `accountId` to equal `userId`), `siwe` → `local:siwe`, `google`/`apple`/`facebook`/`line` → their real issuer, and every other provider without one of its own → `local:oauth:<encodeURIComponent(providerId)>`. It refuses to guess for providers with a real issuer it can't determine offline — those come back unresolved until you pass `--issuer`. It is idempotent (stamped documents are skipped, apart from the v1.3.0 values noted above, which are repaired), paginates, and exits with status 1 when it finds `(issuer, accountId)` collisions or documents it cannot resolve — 1.7 treats that pair as unique, so resolve those by hand before deploying. The same logic is available programmatically as `backfillAccountIssuers({ firestore, dryRun, issuers, resolveIssuer, … })`.

**If you forget:** the adapter checks on startup and logs a `[better-auth-firestore]` warning with the exact command whenever Better Auth expects `issuer` but account documents lack it (two aggregation reads per process; `migrationChecks: false` disables it).

Run the backfill (dry run, then real) before your first deploy on Better Auth 1.7; it ships in v1.3 and is harmless on 1.6. Once you're on v1.3 you can also delete the `rateLimit` composite indexes; see [Firestore Index](#3-firestore-index-optional).

> **Plugin authors:** 1.7 removed `internalAdapter.findOAuthUser(email, accountId, providerId)`. Use `findAccountOwnerByKey({ issuer, accountId })` and pass `issuer` to `linkAccount` / `createOAuthUser`. If you use [`better-auth-firebase-auth`](https://github.com/yultyyev/better-auth-firebase-auth), upgrade it to [v2.2.0 or later](https://github.com/yultyyev/better-auth-firebase-auth/releases/tag/v2.2.0) — earlier releases call the removed API and every sign-in fails on 1.7 (one build supports Better Auth 1.5–1.7; [v2.2.1](https://github.com/yultyyev/better-auth-firebase-auth/releases/tag/v2.2.1) adds `npx better-auth-firebase-auth backfill-account-issuers`). Its `providerId: "firebase"` account documents are already covered by the backfill above: the default rule stamps them `local:oauth:firebase`, exactly the issuer that plugin uses.

## Migration from Auth.js/NextAuth

> **For complete migration steps**, see the [Better Auth NextAuth Migration Guide](https://www.better-auth.com/docs/guides/next-auth-migration-guide), which covers route handlers, client setup, and server-side session handling.

### Adapter-Specific Migration

This adapter uses the same default collection names and field names as Auth.js Firebase adapter, making it a **drop-in replacement** for the database adapter portion of your migration:

- **Collection names:** `users`, `sessions`, `accounts`, `verificationTokens` (same as Auth.js)
- **Field names:** `sessionToken`, `userId`, `providerAccountId`, etc. (same as Auth.js)
- **Data shape:** Identical, so no data migration scripts needed

Simply replace your Auth.js Firebase adapter with this one:

```ts
// Before (Auth.js)
import { FirestoreAdapter } from "@auth/firebase-adapter";

// After (Better Auth)
import { firestoreAdapter } from "better-auth-firestore";

// Same Firestore instance, same collections, same data shape
export const auth = betterAuth({
  database: firestoreAdapter({ firestore }),
});
```

If you were using custom collection names with Auth.js, you can override them:

```ts
firestoreAdapter({
	firestore,
	collections: {
		accounts: "authjs_accounts", // or whatever custom names you were using
		// ... other overrides
	},
});
```

## Recipes

### Use snake_case collections

```ts
firestoreAdapter({
  firestore,
  namingStrategy: "snake_case",
});
```

### Keep Auth.js collection names (no data migration)

```ts
firestoreAdapter({
  firestore,
  collections: {
    accounts: "accounts", // or your custom collection names
    // ... other overrides
  },
});
```

### Usage with Next.js (App Router)

```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

### Usage in Node.js script

```ts
import { firestoreAdapter } from "better-auth-firestore";
import { betterAuth } from "better-auth";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

export const auth = betterAuth({
  database: firestoreAdapter({ firestore: getFirestore(app) }),
});
```

## Using the Firestore Emulator

The adapter fully supports the Firestore Emulator for both **local development** and **testing**. When `FIRESTORE_EMULATOR_HOST` is set, the Firebase Admin SDK automatically routes all requests to the emulator instead of production Firestore. Collection names remain unchanged — the adapter uses the same collections in emulator mode as in production.

### Local development

```bash
# 1. Start the emulator
docker run -d --rm \
	--name auth-firestore \
	-p 8080:8080 \
	google/cloud-sdk:emulators gcloud beta emulators firestore start \
	--host-port=0.0.0.0:8080

# 2. Set the env var and start your app
export FIRESTORE_EMULATOR_HOST=localhost:8080
pnpm run dev
```

Or add `FIRESTORE_EMULATOR_HOST=localhost:8080` to your `.env` file (supported by Next.js, Vite, etc.).

> **Note:** No credential or service account setup is needed when using the emulator — the Admin SDK skips authentication automatically.

### Running tests

```bash
export FIRESTORE_EMULATOR_HOST=localhost:8080
pnpm vitest run
```

## Troubleshooting

### Error: `FIREBASE_PRIVATE_KEY` has literal `\n`

**Symptom:** Authentication fails or you see errors about invalid private key format.

**Fix:** Environment variables often store newlines as literal `\n` strings. Replace them at runtime:

```ts
privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n")
```

See also the [AI Assistant Skill](#ai-assistant-skill) — agents use it to avoid this mistake during setup.

### Error: Requests hang on local dev

**Symptom:** Firebase Admin SDK requests hang or time out during local development.

**Fix:** Use the Firestore Emulator and set `FIRESTORE_EMULATOR_HOST=localhost:8080` before running your app. See [Using the Firestore Emulator](#using-the-firestore-emulator) for setup instructions. The [AI Assistant Skill](#ai-assistant-skill) includes emulator commands for agents.

### Error: `9 FAILED_PRECONDITION: The query requires an index`

**Symptom:** Queries on verification tokens fail with a `FAILED_PRECONDITION` / "The query requires an index" error (often surfaced by Better Auth as `Failed to parse state`).

**Fix:** Upgrade to `better-auth-firestore` v1.1 or later. Older versions issued a `where` + `orderBy` query that required a composite index; the adapter now sorts filtered queries in memory, so no index is needed. After upgrading, the error disappears and any previously created composite index can be removed.

If you cannot upgrade immediately, create the index from the URL in the error message, or generate it with:
```ts
import { generateIndexSetupUrl } from "better-auth-firestore";
const url = generateIndexSetupUrl(process.env.FIREBASE_PROJECT_ID!);
console.log(url); // Open this URL to create the index
```

### Error: `updateMany is not a function`, every sign-in returns 429, or `9 FAILED_PRECONDITION` on `rateLimit`

**Symptom:** With `rateLimit.storage: "database"`, auth routes return 500 with `TypeError: updateMany is not a function`, every request is rate limited even when the counter never rises, or production fails with `9 FAILED_PRECONDITION: The query requires an index` on the `rateLimit` collection.

**Fix:** Upgrade to v1.3 or later. The adapter implements Better Auth's `incrementOne` natively: the limiter's guards are evaluated in memory inside a Firestore transaction, so no composite index is needed anymore. (v1.2.x routed the limiter through a transactional `updateMany` fallback that pushed two inequality filters to Firestore and therefore required the `rateLimit` composite indexes.)

Note that Firestore emulators do **not** enforce composite indexes, so index failures only reproduce against a real Firestore instance.

### Error: `Adapter "firestore" must implement incrementOne for atomic guarded counter updates`

**Symptom:** After upgrading to Better Auth 1.7, rate-limited routes, organization invitations / team seats, device authorization, or two-factor verification throw this error.

**Fix:** Upgrade `better-auth-firestore` to v1.3 or later. Better Auth 1.7 made `incrementOne` a required adapter method and removed the fallback older adapter versions relied on. See [Upgrading to Better Auth 1.7](#upgrading-to-better-auth-17).

### Existing users can't sign in after upgrading to Better Auth 1.7

**Symptom:** Sign-up works, but accounts created before the upgrade fail to sign in (email/password reports invalid credentials; social sign-in reports the account as not linked, or links a duplicate account to the email-matched user).

**Fix:** Run `npx better-auth-firestore backfill-account-issuers --apply` once to stamp the `issuer` field 1.7 uses to look accounts up (dry run first without `--apply`). The adapter logs the same command at startup while documents are missing it. See [Upgrading to Better Auth 1.7](#upgrading-to-better-auth-17).

**If only your social users are affected and the backfill says there's nothing to do,** you ran it on adapter v1.3.0, which stamped `local:oauth:google` rather than the real `https://accounts.google.com` (same for `apple`, `facebook`, `line`). The field is present but wrong, so neither the startup warning nor the old command flags it. Upgrade the adapter and re-run the backfill — it repairs those documents. See [Upgrading to Better Auth 1.7](#upgrading-to-better-auth-17).

## FAQ

### Can I migrate from Auth.js / NextAuth without changing existing Firestore data?

Yes. `better-auth-firestore` is designed as a drop-in replacement for the Auth.js Firebase adapter with matching collection names and field shapes by default, so most projects do not need a Firestore data migration. See [Migration from Auth.js/NextAuth](#migration-from-authjsnextauth) for the adapter-specific details. The [AI Assistant Skill](#ai-assistant-skill) includes a migration guide for Cursor, Claude Code, and other agents.

### What's the difference between `better-auth-firestore` and `better-auth-firebase-auth`?

`better-auth-firestore` is a database adapter for storing Better Auth users, sessions, accounts, and verification tokens in Firestore through the Firebase Admin SDK. `better-auth-firebase-auth` is for Firebase Authentication provider integration such as Email/Password, Google sign-in, client/server token generation, and password reset flows. Use the Firestore adapter for data storage and the Firebase Auth plugin when you need Firebase Authentication features. Both packages have [AI Assistant Skills](#ai-assistant-skill) on [skills.sh](https://skills.sh).

### Which runtimes are supported?

This package supports any server-side Node.js runtime: Next.js on Vercel (the default serverless runtime), Cloud Functions, Cloud Run, and standalone Node.js. The only restriction is the Edge Runtime — if you explicitly set `export const runtime = 'edge'` on a route, the Firebase Admin SDK will not load. Standard Vercel deployments are fully supported. See [Runtime compatibility](#runtime-compatibility) for the full matrix. Agents should follow the runtime table in the [AI Assistant Skill](#ai-assistant-skill).

### Do I need a Firestore composite index for verification tokens?

No. Better Auth's verification-token lookup filters by `identifier` and orders by `createdAt`, which historically required a composite index. As of v1.1 the adapter applies the filter server-side and sorts the (small, per-identifier) result set in memory, so no composite index is required. See [Firestore Index (Optional)](#3-firestore-index-optional) for the optional tooling that remains available.

### Does the adapter support Better Auth 1.7?

Yes, from v1.3. The same release also works with Better Auth 1.6 (both are tested in CI). If you have existing users, run the account issuer backfill before deploying 1.7 — see [Upgrading to Better Auth 1.7](#upgrading-to-better-auth-17).

## AI Assistant Skill

The agent skill lives at [`skills/firestore-better-auth/SKILL.md`](./skills/firestore-better-auth/SKILL.md). It works with Cursor, Claude Code, Codex, Copilot, Windsurf, and [70+ other agents](https://skills.sh) via the [skills.sh](https://skills.sh) ecosystem.

The skill teaches AI assistants the correct setup, environment variable handling, and common gotchas. It also triggers when you ask about using Firestore with Better Auth, migrating from Auth.js/NextAuth, or troubleshooting `FIREBASE_PRIVATE_KEY` issues.

```bash
npx skills add yultyyev/better-auth-firestore
```

For LLM crawlers and AI search, see also [`llms.txt`](./llms.txt) at the repo root — a curated index of documentation, the skill file, and key setup facts.

Install works today from GitHub. The [skills.sh listing page](https://skills.sh/yultyyev/better-auth-firestore) and README badge appear once indexed — tracking [vercel-labs/skills#1601](https://github.com/vercel-labs/skills/issues/1601).

---

## Related Links

- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Better Auth Adapter Guide](https://www.better-auth.com/docs/guides/create-a-db-adapter)
- [llms.txt](./llms.txt) — Curated index for AI assistants and LLM crawlers
- [better-auth-firebase-auth](https://github.com/yultyyev/better-auth-firebase-auth) — Firebase Auth plugin (Phone OTP, Google, Email/Password)
- [Auth.js Firebase Adapter](https://authjs.dev/getting-started/adapters/firebase) (legacy, for reference)
- [Auth.js joins Better Auth](https://www.better-auth.com/blog/authjs-joins-better-auth) - Announcement

## Build

```bash
pnpm build
```

## Reporting issues

Found a bug? First make sure you're on the latest version, then [open an issue](https://github.com/yultyyev/better-auth-firestore/issues) with the package version and a minimal repro. Please redact secrets and PII (Firebase project IDs, `FIREBASE_PRIVATE_KEY`, tokens, and `create_composite` index URLs).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and code style.

## License

MIT.
