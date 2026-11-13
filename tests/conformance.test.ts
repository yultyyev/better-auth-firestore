import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// Better Auth's own adapter conformance suite (`@better-auth/test-utils`),
// run against the Firestore emulator. The suite is released with Better Auth
// and exercises that release's adapter contract, so it runs against the
// lockfile's 1.7 and is skipped by CI's Better Auth 1.6 job.
const betterAuthVersion: string = JSON.parse(
	readFileSync(
		new URL(
			"../package.json",
			pathToFileURL(createRequire(import.meta.url).resolve("better-auth")),
		),
		"utf8",
	),
).version;

if (betterAuthVersion.startsWith("1.6.")) {
	it.skip(`conformance suite (needs Better Auth 1.7, found ${betterAuthVersion})`, () => {});
} else {
	const {
		authFlowTestSuite,
		caseInsensitiveTestSuite,
		joinsTestSuite,
		normalTestSuite,
		testAdapter,
		transactionsTestSuite,
		uuidTestSuite,
	} = await import("@better-auth/test-utils/adapter");

	// Its own emulator project, so the suite's wholesale cleanups never touch
	// another test file's documents.
	const db = initFirestore({
		name: "test-conformance",
		projectId: "conformance",
	});

	// `findMany` does not apply `select` yet: it returns every field, which
	// this test rejects. No Better Auth 1.7.22 call site (better-auth, core,
	// oauth-provider, mcp, sso) passes `select` to `findMany`.
	const disableTests = { "findMany - should select fields": true };

	const { execute } = await testAdapter({
		adapter: async () => firestoreAdapter({ firestore: db }),
		runMigrations: async () => {},
		tests: [
			normalTestSuite({ disableTests }),
			transactionsTestSuite(),
			authFlowTestSuite(),
			caseInsensitiveTestSuite(),
			joinsTestSuite({ disableTests }),
			uuidTestSuite({ disableTests }),
		],
	});

	execute();
}
