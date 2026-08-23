import type { DBAdapterDebugLogOption } from "better-auth/adapters";
import type { AppOptions } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";

export type NamingStrategy = "snake_case" | "default";

export interface FirestoreCollectionsOverride {
	users?: string;
	sessions?: string;
	accounts?: string;
	verificationTokens?: string;
}

export interface FirestoreAdapterConfig extends AppOptions {
	name?: string;
	firestore?: Firestore;
	namingStrategy?: NamingStrategy;
	collections?: FirestoreCollectionsOverride;
	debugLogs?: DBAdapterDebugLogOption;
	/**
	 * On startup, warn once (via `console.warn`) when the Better Auth version
	 * in use expects `account.issuer` but existing account documents lack it —
	 * the symptom is that pre-1.7 users cannot sign in. Costs two aggregation
	 * reads per process. Default `true`.
	 */
	migrationChecks?: boolean;
}

export interface InternalNormalizedConfig {
	firestore: Firestore;
	preferSnakeCase: boolean;
	collections: Required<Required<FirestoreAdapterConfig>["collections"]>;
}
