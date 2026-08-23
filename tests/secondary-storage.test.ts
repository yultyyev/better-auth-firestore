import { betterAuth } from "better-auth";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
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

// better-auth 1.7 made `getAndDelete` and `increment` required on
// `SecondaryStorage` (they were optional in 1.6). The helper implements
// both, and the tests below pin down the semantics better-auth relies on.
describe("Firestore secondaryStorage atomic primitives (required since better-auth 1.7)", () => {
	const db = initFirestore({ name: "test-ss-atomic", projectId: "test" });
	const KV = "ss_kv_atomic";
	const storage = firestoreSecondaryStorage(db, KV);

	afterEach(async () => {
		const snap = await db.collection(KV).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	});

	it("getAndDelete returns the value exactly once", async () => {
		await storage.set("token", "one-time", 60);

		const attempts = await Promise.all(
			Array.from({ length: 5 }, () => storage.getAndDelete("token")),
		);

		expect(attempts.filter((v) => v === "one-time")).toHaveLength(1);
		expect(attempts.filter((v) => v === null)).toHaveLength(4);
		expect(await storage.get("token")).toBeNull();
	});

	it("getAndDelete treats an expired key as absent (and clears it)", async () => {
		await db.collection(KV).doc("stale").set({
			value: "stale",
			expiresAt: Timestamp.fromMillis(Date.now() - 1_000),
		});

		expect(await storage.getAndDelete("stale")).toBeNull();
		expect((await db.collection(KV).doc("stale").get()).exists).toBe(false);
	});

	// Contending Firestore transactions retry with exponential backoff, so
	// even a handful take a few seconds in the emulator.
	it("increment counts atomically under concurrency", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => storage.increment("hits", 60)),
		);

		expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
		expect(await storage.get("hits")).toBe("5");
	}, 30_000);

	it("increment fixes the expiry at first creation and does not extend it", async () => {
		await storage.increment("window", 60);
		const first = (await db.collection(KV).doc("window").get()).data();
		await storage.increment("window", 60);
		const second = (await db.collection(KV).doc("window").get()).data();

		expect(second?.value).toBe("2");
		expect(second?.expiresAt.toMillis()).toBe(first?.expiresAt.toMillis());
	});

	it("stores keys containing `/` as flat documents", async () => {
		// better-auth's rate-limit keys embed the request path; Firestore
		// would otherwise read the slashes as a nested collection path.
		const key = "203.0.113.20|/sign-in/email";
		await storage.set(key, "v", 60);

		expect(await storage.get(key)).toBe("v");
		expect((await db.collection(KV).get()).size).toBe(1);
		await storage.delete(key);
		expect(await storage.get(key)).toBeNull();
		expect((await db.collection(KV).get()).size).toBe(0);
	});

	it("increment restarts the counter once the window has expired", async () => {
		await db.collection(KV).doc("expired").set({
			value: "7",
			expiresAt: Timestamp.fromMillis(Date.now() - 1_000),
		});

		expect(await storage.increment("expired", 60)).toBe(1);
	});
});

// End to end: the limiter's secondary-storage mode is built entirely on
// `increment`, and 1.7 throws at startup-time configuration if it's missing.
describe("better-auth with secondary-storage rate limiting", () => {
	const db = initFirestore({ name: "test-ss-rl", projectId: "test" });
	const RL_COLLECTIONS = {
		users: "ssrl_users",
		sessions: "ssrl_sessions",
		accounts: "ssrl_accounts",
		verificationTokens: "ssrl_verifications",
		kv: "ssrl_kv",
	};
	const MAX_ATTEMPTS = 3;

	const auth = betterAuth({
		database: firestoreAdapter({
			firestore: db,
			collections: {
				users: RL_COLLECTIONS.users,
				sessions: RL_COLLECTIONS.sessions,
				accounts: RL_COLLECTIONS.accounts,
				verificationTokens: RL_COLLECTIONS.verificationTokens,
			},
		}),
		secondaryStorage: firestoreSecondaryStorage(db, RL_COLLECTIONS.kv),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
		rateLimit: {
			enabled: true,
			storage: "secondary-storage",
			customRules: {
				"/sign-in/email": { max: MAX_ATTEMPTS, window: 60 },
			},
		},
	});

	afterEach(async () => {
		for (const name of Object.values(RL_COLLECTIONS)) {
			const snap = await db.collection(name).get();
			await Promise.all(snap.docs.map((d) => d.ref.delete()));
		}
	});

	it("rate limits after the threshold using the storage's increment", async () => {
		const email = `ssrl-${Date.now()}@example.com`;
		const password = "password1234";
		const signUp = await auth.api.signUpEmail({
			body: { email, password, name: "Limited" },
			asResponse: true,
		});
		expect(signUp.status).toBe(200);

		const statuses: number[] = [];
		for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
			const res = await auth.handler(
				new Request("http://localhost/api/auth/sign-in/email", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-forwarded-for": "203.0.113.20",
					},
					body: JSON.stringify({ email, password }),
				}),
			);
			statuses.push(res.status);
		}

		expect(statuses).not.toContain(500);
		expect(statuses.slice(0, MAX_ATTEMPTS).every((s) => s === 200)).toBe(true);
		expect(statuses.slice(MAX_ATTEMPTS).every((s) => s === 429)).toBe(true);

		const counters = await db.collection(RL_COLLECTIONS.kv).get();
		expect(counters.size).toBeGreaterThan(0);
	});
});
