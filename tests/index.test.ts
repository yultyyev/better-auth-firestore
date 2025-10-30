import { runAdapterTest } from "better-auth/adapters/test";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

type Config = { namingStrategy: "snake_case" | "default" };

const configs: Config[] = [
	{ namingStrategy: "snake_case" },
	{ namingStrategy: "default" },
];

describe.each<Config>(configs)("Firestore adapter (%s)", (cfg: Config) => {
	const db = initFirestore({
		name: `test-${cfg.namingStrategy}`,
		projectId: "test",
	});

	return runAdapterTest({
		getAdapter: async (betterAuthOptions = {}) =>
			firestoreAdapter({
				firestore: db,
				namingStrategy: cfg.namingStrategy,
				debugLogs: false,
			})(betterAuthOptions as any),
	});
});
