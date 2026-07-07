# better-auth-firestore

[![npm version](https://img.shields.io/npm/v/better-auth-firestore.svg)](https://www.npmjs.com/package/better-auth-firestore)
[![CI](https://github.com/yultyyev/better-auth-firestore/actions/workflows/release.yml/badge.svg)](https://github.com/yultyyev/better-auth-firestore/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![skills.sh](https://skills.sh/b/yultyyev/better-auth-firestore)](https://skills.sh/yultyyev/better-auth-firestore)

> **Note:** If you're using `@yultyyev/better-auth-firestore`, please migrate to `better-auth-firestore`. The scoped package is deprecated. See [Migration from Scoped Package](#migration-from-scoped-package) below.

**Firestore (Firebase Admin SDK) adapter for Better Auth.** A drop-in replacement for the Auth.js Firebase adapter with matching data shape.

- **Install:** `pnpm add better-auth-firestore firebase-admin better-auth`
- **Docs:** [Quickstart](#quick-start) • [Options](#options) • [Migration](#migration-from-authjsnextauth) • [Emulator](#using-the-firestore-emulator)
- **Example:** See [`/examples/minimal`](./examples/minimal) for a complete Next.js App Router example
- **AI skill:** [Cursor, Claude Code, Codex & 70+ agents](#ai-assistant-skill) — `npx skills add yultyyev/better-auth-firestore` • [llms.txt](./llms.txt)

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

### 3. Create Required Firestore Index

The adapter requires a composite index on the `verification` collection. Choose one of the following methods:

**Option A: Create via Firebase Console (Recommended)**

You can generate a direct link that pre-fills the index creation form:

```ts
import { generateIndexSetupUrl } from "better-auth-firestore";

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

1. Copy `firestore.indexes.json` from `node_modules/better-auth-firestore/` to your project root
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

### Better Auth versions

| Better Auth | Status | Notes |
|---|---|---|
| `^1.5.0` | ✅ Recommended | Uses the latest API and security fixes. |
| `^1.4.18` | ✅ Supported | Backward-compatible for existing projects. |

> **For older projects:** if your app still uses older Better Auth patterns (`createAuth` + `adapter`), this adapter remains compatible, but new projects should use `betterAuth` + `database`.

### Runtime compatibility

| Runtime | Supported | Notes |
|---|---|---|
| Node 18+ | ✅ | Recommended |
| Next.js on Vercel (Node.js runtime) | ✅ | Default serverless runtime — fully supported |
| Cloud Functions / Cloud Run | ✅ | Provide `FIREBASE_*` creds |
| Vercel Edge Runtime (`runtime = 'edge'`) | ❌ | Firebase Admin SDK requires Node.js |
| Cloudflare Workers | ❌ | Firebase Admin SDK requires Node.js |

> **Vercel works.** The ❌ above applies only if you explicitly set `export const runtime = 'edge'` on a route. The default Node.js serverless runtime on Vercel is fully supported.

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

## Migration from Scoped Package

If you're currently using `@yultyyev/better-auth-firestore`, migrate to `better-auth-firestore`:

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

### Error: Missing or insufficient permissions / Index required

**Symptom:** Queries on verification tokens fail with errors about missing index or insufficient permissions.

**Fix:** Create the required composite index on the `verification` collection. See [Firebase Setup - Step 3](#3-create-required-firestore-index) for detailed instructions.

You can generate a direct link using:
```ts
import { generateIndexSetupUrl } from "better-auth-firestore";
const url = generateIndexSetupUrl(process.env.FIREBASE_PROJECT_ID!);
console.log(url); // Open this URL to create the index
```

The [AI Assistant Skill](#ai-assistant-skill) documents index fields and `generateIndexSetupUrl` for agent-driven setup.

## FAQ

### Can I migrate from Auth.js / NextAuth without changing existing Firestore data?

Yes. `better-auth-firestore` is designed as a drop-in replacement for the Auth.js Firebase adapter with matching collection names and field shapes by default, so most projects do not need a Firestore data migration. See [Migration from Auth.js/NextAuth](#migration-from-authjsnextauth) for the adapter-specific details. The [AI Assistant Skill](#ai-assistant-skill) includes a migration guide for Cursor, Claude Code, and other agents.

### What's the difference between `better-auth-firestore` and `better-auth-firebase-auth`?

`better-auth-firestore` is a database adapter for storing Better Auth users, sessions, accounts, and verification tokens in Firestore through the Firebase Admin SDK. `better-auth-firebase-auth` is for Firebase Authentication provider integration such as Email/Password, Google sign-in, client/server token generation, and password reset flows. Use the Firestore adapter for data storage and the Firebase Auth plugin when you need Firebase Authentication features. Both packages have [AI Assistant Skills](#ai-assistant-skill) on [skills.sh](https://skills.sh).

### Which runtimes are supported?

This package supports any server-side Node.js runtime: Next.js on Vercel (the default serverless runtime), Cloud Functions, Cloud Run, and standalone Node.js. The only restriction is the Edge Runtime — if you explicitly set `export const runtime = 'edge'` on a route, the Firebase Admin SDK will not load. Standard Vercel deployments are fully supported. See [Runtime compatibility](#runtime-compatibility) for the full matrix. Agents should follow the runtime table in the [AI Assistant Skill](#ai-assistant-skill).

### Why is a Firestore composite index required for verification tokens?

Better Auth verification token lookups require a Firestore query pattern that depends on a composite index. Without that index, verification-related queries can fail with a missing index error or insufficient permissions message. See [Create Required Firestore Index](#3-create-required-firestore-index) for the exact fields and setup options. The [AI Assistant Skill](#ai-assistant-skill) documents index creation and `generateIndexSetupUrl`.

## AI Assistant Skill

The agent skill lives at [`skills/firestore-better-auth/SKILL.md`](./skills/firestore-better-auth/SKILL.md). It works with Cursor, Claude Code, Codex, Copilot, Windsurf, and [70+ other agents](https://skills.sh) via the [skills.sh](https://skills.sh) ecosystem.

The skill teaches AI assistants the correct setup, required Firestore index, environment variable handling, and common gotchas. It also triggers when you ask about using Firestore with Better Auth, migrating from Auth.js/NextAuth, or troubleshooting `FIREBASE_PRIVATE_KEY` issues.

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

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and code style.

## License

MIT.
