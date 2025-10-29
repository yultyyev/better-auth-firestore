import type { AppOptions } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import type { DBAdapterDebugLogOption } from "better-auth/adapters";

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
}

export interface InternalNormalizedConfig {
  firestore: Firestore;
  preferSnakeCase: boolean;
  collections: Required<Required<FirestoreAdapterConfig>["collections"]>;
}


