# better-auth-firestore

Firestore (Firebase Admin SDK) adapter for Better Auth. Drop-in replacement for the Auth.js/NextAuth Firebase adapter with matching data shape to ease migration.

- Better Auth guide: https://www.better-auth.com/docs/guides/create-a-db-adapter
- Auth.js Firebase adapter docs: https://authjs.dev/getting-started/adapters/firebase#installation
- Auth.js Firebase adapter source: https://github.com/nextauthjs/next-auth/tree/main/packages/adapter-firebase

## Installation

```bash
pnpm add better-auth-firestore firebase-admin better-auth
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

## Migration from Auth.js/NextAuth

If you're migrating from the Auth.js Firebase adapter, you can use your existing collection names by overriding them:

```ts
// If you were using Auth.js with custom collection names
firestoreAdapter({
	firestore,
	collections: {
		accounts: "authjs_accounts", // or whatever name you were using
		// ... other overrides
	},
});
```

The adapter maintains the same data shape, so your existing data will work without migration scripts.

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

## Build

```bash
pnpm build
```

## License

MIT.
