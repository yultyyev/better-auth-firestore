# better-auth-firestore

[![npm version](https://img.shields.io/npm/v/@yultyyev/better-auth-firestore.svg)](https://www.npmjs.com/package/@yultyyev/better-auth-firestore)
[![CI](https://github.com/yultyyev/better-auth-firestore/actions/workflows/release.yml/badge.svg)](https://github.com/yultyyev/better-auth-firestore/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

**Firestore (Firebase Admin SDK) adapter for Better Auth.** A drop-in replacement for the Auth.js Firebase adapter with matching data shape.

- **Install:** `pnpm add @yultyyev/better-auth-firestore firebase-admin better-auth`
- **Docs:** [Quickstart](#quick-start) • [Options](#options) • [Migration](#migration-from-authjsnextauth) • [Emulator](#testing-with-firestore-emulator)
- **Example:** See [`/examples/minimal`](./examples/minimal) for a complete Next.js App Router example

---

## Related: Firebase Auth Plugin

For Firebase Authentication integration with Better Auth, see **[better-auth-firebase-auth](https://github.com/yultyyev/better-auth-firebase-auth)**. It provides:

- Firebase Authentication provider support (Email/Password, Google, etc.)
- Client-side or server-side token generation
- Password reset functionality
- Full TypeScript support

Use `better-auth-firebase-auth` for authentication and `@yultyyev/better-auth-firestore` for data storage.

---

## Installation

# npm

```bash
npm install @yultyyev/better-auth-firestore firebase-admin better-auth
```

# pnpm

```bash
pnpm add @yultyyev/better-auth-firestore firebase-admin better-auth
```

# yarn

```bash
yarn add @yultyyev/better-auth-firestore firebase-admin better-auth
```

# bun

```bash
bun add @yultyyev/better-auth-firestore firebase-admin better-auth
```

### Minimal usage

```ts
import { firestoreAdapter } from "@yultyyev/better-auth-firestore";
import { createAuth } from "better-auth";
import { getFirestore } from "firebase-admin/firestore";

export const auth = createAuth({
  adapter: firestoreAdapter({ firestore: getFirestore() })
});
```

## Quick start

```ts
import { betterAuth } from "better-auth";
import { firestoreAdapter, initFirestore } from "@yultyyev/better-auth-firestore";
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

### 3. Create Required Firestore Index

The adapter requires a composite index on the `verification` collection. Choose one of the following methods:

**Option A: Create via Firebase Console (Recommended)**

You can generate a direct link that pre-fills the index creation form:

```ts
import { generateIndexSetupUrl } from "@yultyyev/better-auth-firestore";

// Generate the URL (pre-fills the form automatically)
const url = generateIndexSetupUrl(
  process.env.FIREBASE_PROJECT_ID!,
  "(default)", // or your database ID if using a named database
  "verification" // or your custom collection name
);

console.log("Open this URL to create the index:", url);
```

Or manually:
1. Open: `https://console.firebase.google.com/project/YOUR_PROJECT_ID/firestore/indexes`
2. Click "Create Index"
3. Configure:
   - **Collection ID:** `verification`
   - **Fields:**
     - `identifier` (Ascending)
     - `createdAt` (Descending)
     - `__name__` (Descending)
   - **Query scope:** Collection
4. Click "Create" and wait for the index to build (usually a few minutes)

**Option B: Use firestore.indexes.json Template**

1. Copy `firestore.indexes.json` from `node_modules/@yultyyev/better-auth-firestore/` to your project root
2. (Optional) Update collection name if using custom `collections.verificationTokens`
3. Deploy: `firebase deploy --only firestore:indexes`

> **Note:** If you're using a custom collection name for verification tokens (via `collections.verificationTokens`), replace `verification` with your custom collection name in the index configuration.

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
});
```

**Default collection names:**
- `users`: "users"
- `sessions`: "sessions"
- `accounts`: "accounts"
- `verificationTokens`: "verification_tokens" (snake_case) or "verificationTokens" (default)

### Debug logging

```ts
firestoreAdapter({
  firestore,
  debugLogs: true, // Enable verbose logging
});
```

## Compatibility

| Runtime | Supported | Notes |
|---|---|---|
| Node 18+ | ✅ | Recommended |
| Next.js (App Router) | ✅ | Server routes only |
| Cloud Functions / Cloud Run | ✅ | Provide `FIREBASE_*` creds |
| Vercel Edge / CF Workers | ❌ | Firestore Admin SDK not supported at Edge runtime |

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
> **Note:** The `verification` collection requires a composite index on `identifier` (ASC), `createdAt` (DESC), `__name__` (DESC). See [Firebase Setup - Step 3](#3-create-required-firestore-index) for setup instructions.

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
import { firestoreAdapter } from "@yultyyev/better-auth-firestore";

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
import { firestoreAdapter } from "@yultyyev/better-auth-firestore";
import { createAuth } from "better-auth";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

export const auth = createAuth({
  adapter: firestoreAdapter({ firestore: getFirestore(app) }),
});
```

## Testing with Firestore Emulator

```bash
# start emulator (example)
docker run -d --rm \
	--name auth-firestore \
	-p 8080:8080 \
	google/cloud-sdk:emulators gcloud beta emulators firestore start \
	--host-port=0.0.0.0:8080

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

### Error: Requests hang on local dev

**Symptom:** Firebase Admin SDK requests hang or time out during local development.

**Fix:** Use the Firestore Emulator and set `FIRESTORE_EMULATOR_HOST=localhost:8080` before running your app. See [Testing with Firestore Emulator](#testing-with-firestore-emulator) for setup instructions.

### Error: Missing or insufficient permissions / Index required

**Symptom:** Queries on verification tokens fail with errors about missing index or insufficient permissions.

**Fix:** Create the required composite index on the `verification` collection. See [Firebase Setup - Step 3](#3-create-required-firestore-index) for detailed instructions.

You can generate a direct link using:
```ts
import { generateIndexSetupUrl } from "@yultyyev/better-auth-firestore";
const url = generateIndexSetupUrl(process.env.FIREBASE_PROJECT_ID!);
console.log(url); // Open this URL to create the index
```

## Related Links

- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Better Auth Adapter Guide](https://www.better-auth.com/docs/guides/create-a-db-adapter)
- [Auth.js Firebase Adapter](https://authjs.dev/getting-started/adapters/firebase) (legacy, for reference)
- [Auth.js joins Better Auth](https://www.better-auth.com/blog/authjs-joins-better-auth) - Announcement

## Build

```bash
pnpm build
```

## License

MIT.
