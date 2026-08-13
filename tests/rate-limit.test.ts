import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

const COLLECTIONS = {
	users: "rl_users",
	sessions: "rl_sessions",
	accounts: "rl_accounts",
	verificationTokens: "rl_verifications",
};

// better-auth stores database-backed rate limit counters here.
const RATE_LIMIT_COLLECTION = "rateLimit";

async function clearAll(db: Firestore) {
	for (const name of [...Object.values(COLLECTIONS), RATE_LIMIT_COLLECTION]) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

// Regression for the production incident where every rate-limited auth route
// returned 500 with `TypeError: updateMany is not a function`.
//
// better-auth's rate limiter calls `adapter.incrementOne`. We don't implement
// it natively, so @better-auth/core falls back to
// `transaction(findMany + updateMany)` — and the tx adapter had no
// `updateMany`. Nothing in the suite exercised `rateLimit.storage: "database"`,
// so the gap only surfaced in production.
describe("better-auth with database-backed rate limiting", () => {
	const db = initFirestore({ name: "test-rl", projectId: "test" });

	const MAX_ATTEMPTS = 3;

	const auth = betterAuth({
		database: firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		}),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
		rateLimit: {
			enabled: true,
			storage: "database",
			customRules: {
				"/sign-in/email": { max: MAX_ATTEMPTS, window: 60 },
			},
		},
	});

	afterEach(async () => {
		await clearAll(db);
	});

	// Rate limiting lives in the request pipeline, not in the direct
	// `auth.api.*` server calls — so this drives `auth.handler` with real
	// Request objects, which is exactly what the Next.js handler does in
	// production.
	const signInRequest = (
		email: string,
		password: string,
		ip: string,
	): Request =>
		new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": ip,
			},
			body: JSON.stringify({ email, password }),
		});

	it("does not 500 on a rate-limited route, and rate limits after the threshold", async () => {
		const email = `rl-${Date.now()}@example.com`;
		const password = "password1234";

		const signUp = await auth.api.signUpEmail({
			body: { email, password, name: "Rate Limited" },
			asResponse: true,
		});
		expect(signUp.status).toBe(200);

		const statuses: number[] = [];
		for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
			const res = await auth.handler(
				signInRequest(email, password, "203.0.113.10"),
			);
			statuses.push(res.status);
		}

		// The bug: every one of these was a 500.
		expect(statuses).not.toContain(500);
		// The limiter still has to actually limit — a no-op that never throws
		// would pass the assertion above while silently disabling protection.
		expect(statuses).toContain(429);
		expect(statuses.slice(0, MAX_ATTEMPTS).every((s) => s === 200)).toBe(true);
	});

	it("persists the counter to Firestore rather than memory", async () => {
		const email = `rl2-${Date.now()}@example.com`;
		const password = "password1234";

		await auth.api.signUpEmail({
			body: { email, password, name: "Counter" },
			asResponse: true,
		});
		const res = await auth.handler(
			signInRequest(email, password, "203.0.113.11"),
		);
		expect(res.status).toBe(200);

		const snap = await db.collection(RATE_LIMIT_COLLECTION).get();
		expect(snap.size).toBeGreaterThan(0);
		const row = snap.docs[0]?.data();
		expect(typeof row?.count).toBe("number");
		expect(typeof row?.lastRequest).toBe("number");
	});
});
