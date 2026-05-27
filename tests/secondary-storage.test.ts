import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";
import { firestoreSecondaryStorage } from "./helpers/firestore-secondary-storage";

const COLLECTIONS = {
	users: "ss_users",
	sessions: "ss_sessions",
	accounts: "ss_accounts",
	verificationTokens: "ss_verifications",
	kv: "ss_kv",
};

async function clearAll(db: Firestore) {
	for (const name of Object.values(COLLECTIONS)) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

describe("better-auth with Firestore secondaryStorage (regression for #24)", () => {
	const db = initFirestore({ name: "test-ss", projectId: "test" });

	const auth = betterAuth({
		database: firestoreAdapter({
			firestore: db,
			collections: {
				users: COLLECTIONS.users,
				sessions: COLLECTIONS.sessions,
				accounts: COLLECTIONS.accounts,
				verificationTokens: COLLECTIONS.verificationTokens,
			},
		}),
		secondaryStorage: firestoreSecondaryStorage(db, COLLECTIONS.kv),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
	});

	afterEach(async () => {
		await clearAll(db);
	});

	// The tx wrapper buffers writes during the user callback and flushes them
	// after the callback resolves, so Firestore's "all reads before all writes"
	// rule is honored even when better-auth interleaves create + findOne +
	// create inside one transaction (as `signUpEmail` does once
	// `secondaryStorage` is configured).
	it("signs up and signs in without violating Firestore txn read-before-write", async () => {
		const email = `u-${Date.now()}@example.com`;
		const password = "password1234";

		const signUp = await auth.api.signUpEmail({
			body: { email, password, name: "Repro User" },
			asResponse: true,
		});
		expect(signUp.status).toBe(200);

		const signIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(signIn.status).toBe(200);
	});
});
