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

describe("better-auth with Firestore secondaryStorage (repro for #24)", () => {
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

	// `it.fails` until #24 is resolved: today better-auth's signUpEmail calls
	// `createSession` (which does a `findOne` read) inside the same transaction
	// where `create(user)` has already done a `transaction.set` — Firestore
	// rejects with "transactions require all reads to be executed before all
	// writes." When the tx wrapper is refactored to buffer writes and overlay
	// reads, this test will start passing and `it.fails` will itself fail,
	// signaling that the modifier should be removed.
	it.fails(
		"signs up and signs in without violating Firestore txn read-before-write",
		async () => {
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
		},
	);
});
