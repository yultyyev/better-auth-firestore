---
name: firestore-better-auth
description: >-
  Use Firestore as the database adapter for Better Auth (Firebase Admin SDK).
  Use when storing Better Auth users, sessions, accounts, and verification
  tokens in Firestore, migrating from Auth.js/NextAuth Firebase adapter to
  Better Auth, setting up Better Auth with a Firebase/Firestore backend, or
  troubleshooting Firestore index errors and FIREBASE_PRIVATE_KEY issues.
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

## Required Firestore composite index

The adapter requires a composite index on the `verification` collection for token lookups. Without it, Better Auth sign-in verification will fail.

**Quick setup — generate the Firebase Console URL:**

```ts
import { generateIndexSetupUrl } from "better-auth-firestore";
const url = generateIndexSetupUrl(process.env.FIREBASE_PROJECT_ID!);
console.log(url); // Open to auto-fill the index form
```

**Or deploy via CLI:**

Copy `firestore.indexes.json` from `node_modules/better-auth-firestore/` to your project root, then:

```bash
firebase deploy --only firestore:indexes
```

**Index fields:**
- Collection: `verification`
- `identifier` (Ascending)
- `createdAt` (Descending)
- `__name__` (Descending)
- Query scope: Collection

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
| Next.js App Router (server) | ✅ |
| Cloud Functions / Cloud Run | ✅ |
| Vercel Edge / CF Workers | ❌ (Admin SDK not supported at edge) |

---

## Common mistakes

- **Missing Firestore composite index** — Verification token queries fail with "index required" or "insufficient permissions". Run `generateIndexSetupUrl` to get the setup link.
- **FIREBASE_PRIVATE_KEY with literal `\n`** — Always call `.replace(/\\n/g, "\n")` on the key before passing to `cert()`.
- **Using at edge runtime** — Firebase Admin SDK does not run on Vercel Edge or Cloudflare Workers. Use Node.js runtimes only.
- **Deprecated scoped package** — Use `better-auth-firestore` (unscoped). The `@yultyyev/better-auth-firestore` package is deprecated.
