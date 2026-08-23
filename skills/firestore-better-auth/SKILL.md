---
name: firestore-better-auth
version: 1.1.0
description: >-
  Use Firestore as the database adapter for Better Auth (Firebase Admin SDK).
  Use when storing Better Auth users, sessions, accounts, and verification
  tokens in Firestore, migrating from Auth.js/NextAuth Firebase adapter to
  Better Auth, setting up Better Auth with a Firebase/Firestore backend,
  upgrading a Firestore-backed app to Better Auth 1.7 (account issuer
  backfill), or troubleshooting Firestore index errors, incrementOne errors,
  and FIREBASE_PRIVATE_KEY issues.
---

# Firestore Adapter for Better Auth

`better-auth-firestore` is the Firestore database adapter for [Better Auth](https://better-auth.com). It stores users, sessions, accounts, and verification tokens in Firestore using the Firebase Admin SDK.

**Package:** `better-auth-firestore` — [GitHub](https://github.com/yultyyev/better-auth-firestore) · [npm](https://www.npmjs.com/package/better-auth-firestore)

---

## Install

```bash
pnpm add better-auth-firestore firebase-admin better-auth
```

---

## Minimal setup

```ts
import { firestoreAdapter } from "better-auth-firestore";
import { betterAuth } from "better-auth";
import { getFirestore } from "firebase-admin/firestore";

export const auth = betterAuth({
  database: firestoreAdapter({ firestore: getFirestore() }),
});
```

---

## Full setup with credentials

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

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `firestore` | `Firestore` | `getFirestore()` | Firebase Admin Firestore instance |
| `namingStrategy` | `"default" \| "snake_case"` | `"default"` | Collection naming convention |
| `collections` | `object` | see below | Override individual collection names |
| `debugLogs` | `boolean` | `false` | Enable verbose query logging |

**Default collection names:**
- `users` → `"users"`
- `sessions` → `"sessions"`
- `accounts` → `"accounts"`
- `verificationTokens` → `"verificationTokens"` (default) or `"verification_tokens"` (snake_case)

---

## Firestore composite index — not required (v1.1+)

No composite index is required. The adapter never combines a `where` filter with a Firestore `orderBy`: it applies the filter server-side and sorts the results in memory. Verification-token lookups (`identifier ==` ordered by `createdAt desc`) work with Firestore's automatic single-field indexes alone. As of v1.3 the same holds for `rateLimit.storage: "database"`: the native `incrementOne` sends only equality filters to Firestore and checks the limiter's range guards in memory inside a transaction.

**If sign-in fails with `9 FAILED_PRECONDITION: The query requires an index`** (Better Auth may surface this as `Failed to parse state`), you are on an older version. **Upgrade to v1.1 or later** — do not create the index. Any composite index created for a previous version can be removed afterward.

**Optional tooling** (only for advanced setups that query the verification collection directly, outside the adapter): `generateIndexSetupUrl(projectId, databaseId?, collectionName?)` and `getIndexConfig(collectionName?)`, plus the bundled `firestore.indexes.json`. These default to the `verificationTokens` collection (use `verification_tokens` for the snake_case strategy).

---

## Upgrading to Better Auth 1.7

Better Auth 1.7 needs adapter **v1.3+** (it made `incrementOne` a required adapter method; older adapters throw `Adapter "firestore" must implement incrementOne for atomic guarded counter updates` on rate limiting, organization invitations, device authorization, and two-factor). v1.3 also works with Better Auth 1.6, so upgrade the adapter first.

1.7 identifies accounts by `(issuer, accountId)` and stores `issuer` on every account. Existing Firestore documents don't have it, and Firestore has no `npx auth migrate` — **existing users cannot sign in after upgrading until the field is backfilled**:

```ts
import { backfillAccountIssuers } from "better-auth-firestore";

// Dry run first — review `byIssuer`, `unresolved`, and `collisions`.
console.log(await backfillAccountIssuers({ firestore, dryRun: true }));

// Then, with authentication writes paused:
await backfillAccountIssuers({
  firestore,
  // collection / namingStrategy: match the adapter config
  // issuers: { okta: "https://acme.okta.com" } — only for providers with a real issuer;
  // built-in social providers get `local:oauth:<providerId>` automatically.
});
```

Order: adapter → v1.3, run the backfill, then `better-auth` → 1.7. Full details: https://better-auth.com/docs/guides/1-7-upgrade-guide

---

## Environment variables

```bash
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**Important:** `FIREBASE_PRIVATE_KEY` often arrives with literal `\n` strings in env vars. Always replace them:

```ts
privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n")
```

---

## Migration from Auth.js / NextAuth Firebase adapter

`better-auth-firestore` uses the same collection names and field shapes as the Auth.js Firebase adapter by default — it is a drop-in replacement.

```ts
// Before (Auth.js)
import { FirestoreAdapter } from "@auth/firebase-adapter";

// After (Better Auth)
import { firestoreAdapter } from "better-auth-firestore";

export const auth = betterAuth({
  database: firestoreAdapter({ firestore }),
});
```

No Firestore data migration needed. Same `users`, `sessions`, `accounts`, and `verificationTokens` collections.

---

## Using with the Firebase Auth plugin

To also use Firebase Authentication (Phone OTP, Google Sign-In, Email/Password), combine with `better-auth-firebase-auth`:

```ts
import { firestoreAdapter } from "better-auth-firestore";
import { firebaseAuthPlugin } from "better-auth-firebase-auth/server";

export const auth = betterAuth({
  database: firestoreAdapter({ firestore }),
  plugins: [firebaseAuthPlugin({ firebaseAdminAuth: getAuth() })],
});
```

---

## Firestore Emulator (local development & tests)

```bash
# Start emulator
docker run -d --rm -p 8080:8080 google/cloud-sdk:emulators \
  gcloud beta emulators firestore start --host-port=0.0.0.0:8080

# Set env and start dev server
FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm dev

# Run tests
FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm vitest run
```

No credentials or service account needed when using the emulator.

---

## Runtime support

| Runtime | Supported |
|---|---|
| Node 18+ | ✅ |
| Next.js on Vercel (Node.js runtime) | ✅ Recommended |
| Cloud Functions / Cloud Run | ✅ |
| Vercel Edge Runtime (`runtime = 'edge'`) | ❌ Admin SDK requires Node.js |
| Cloudflare Workers | ❌ Admin SDK requires Node.js |

**Note:** Vercel deploys work fine — the restriction is only when you explicitly opt into the Edge Runtime (`export const runtime = 'edge'`). The default Node.js serverless runtime on Vercel is fully supported.

---

## Common mistakes

- **`The query requires an index` on verification tokens** — You're on a version older than v1.1. Upgrade `better-auth-firestore`; the adapter now sorts filtered queries in memory and needs no composite index.
- **`The query requires an index` on `rateLimit`** — You're on a version older than v1.3. Upgrade; the native `incrementOne` needs no composite index. Do not create the index.
- **`Adapter "firestore" must implement incrementOne`** — Better Auth 1.7 with an adapter older than v1.3. Upgrade `better-auth-firestore`.
- **Existing users can't sign in after moving to Better Auth 1.7** — The `account.issuer` backfill was not run. Run `backfillAccountIssuers` (see above).
- **FIREBASE_PRIVATE_KEY with literal `\n`** — Always call `.replace(/\\n/g, "\n")` on the key before passing to `cert()`.
- **Using at edge runtime** — Firebase Admin SDK does not run on Vercel Edge or Cloudflare Workers. Use Node.js runtimes only.
- **Deprecated scoped package** — Use `better-auth-firestore` (unscoped). The `@yultyyev/better-auth-firestore` package is deprecated.

---

## Reporting issues

If behavior still looks like a library bug after checking the mistakes above:

1. First confirm the project is on the **latest version** — many reports (e.g. the composite-index error) are already fixed.
2. Only file an issue when the **user explicitly asks** — never open one autonomously.
3. **Redact secrets and PII** before filing: Firebase project IDs, `FIREBASE_PRIVATE_KEY`, tokens, and any `create_composite` index URL (it encodes the project path). Include the package version and a minimal repro instead.

Issues: https://github.com/yultyyev/better-auth-firestore/issues
