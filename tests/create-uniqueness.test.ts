import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// better-auth's `create` is an INSERT: a row that already exists under the
// same id must make it fail, as it does in every SQL adapter and in MongoDB.
// Firestore's `set()` silently replaces the document instead, which turned
// every first-writer-wins reservation (`reserveVerificationValue` — SAML
// assertion and DPoP proof replay protection, the SIWE email claim, the 1.7
// unverified-account cleanup lock) into "everyone wins". Firestore also has
// no unique constraints, which the database-backed rate limiter relies on for
// `rateLimit.key`; the adapter restores that one by keying the model's
// documents by the key.

const COLLECTIONS = {
	users: "cu_users",
	sessions: "cu_sessions",
	accounts: "cu_accounts",
	verificationTokens: "cu_verifications",
};
// A dedicated collection so this file never races the other rate-limit suite.
const RATE_LIMIT_COLLECTION = "cu_rate_limit";

async function clearAll(db: Firestore) {
	for (const name of [...Object.values(COLLECTIONS), RATE_LIMIT_COLLECTION]) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

describe("create is an insert, not an upsert", () => {
	const db = initFirestore({
		name: "test-create-uniqueness",
		projectId: "test",
	});
	const MAX_ATTEMPTS = 3;

	const auth = betterAuth({
		database: firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
		rateLimit: {
			enabled: true,
			storage: "database",
			modelName: RATE_LIMIT_COLLECTION,
			customRules: {
				"/sign-in/email": { max: MAX_ATTEMPTS, window: 60 },
			},
		},
	});

	const verificationRow = (value: string) => ({
		identifier: "fixed-identifier",
		value,
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		updatedAt: new Date(),
	});

	afterEach(async () => {
		await clearAll(db);
	});

	it("reserveVerificationValue is first-writer-wins", async () => {
		const ctx = await auth.$context;
		const reserve = (value: string) =>
			ctx.internalAdapter.reserveVerificationValue({
				identifier: "saml-used-assertion:_abc",
				value,
				expiresAt: new Date(Date.now() + 60_000),
			});

		expect(await reserve("first")).toBe(true);
		expect(await reserve("second")).toBe(false);

		const rows = await db
			.collection(COLLECTIONS.verificationTokens)
			.where("identifier", "==", "saml-used-assertion:_abc")
			.get();
		expect(rows.size).toBe(1);
		expect(rows.docs[0]?.data().value).toBe("first");
	});

	it("a second create with the same id fails and leaves the document untouched", async () => {
		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "verification",
			data: { id: "fixed-id", ...verificationRow("first") },
			forceAllowId: true,
		});
		await expect(
			ctx.adapter.create({
				model: "verification",
				data: { id: "fixed-id", ...verificationRow("second") },
				forceAllowId: true,
			}),
		).rejects.toThrow();

		const doc = await db
			.collection(COLLECTIONS.verificationTokens)
			.doc("fixed-id")
			.get();
		expect(doc.data()?.value).toBe("first");
	});

	it("the same holds for a create inside a transaction", async () => {
		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "verification",
			data: { id: "fixed-id", ...verificationRow("first") },
			forceAllowId: true,
		});
		await expect(
			ctx.adapter.transaction(async (tx) => {
				await tx.create({
					model: "verification",
					data: { id: "fixed-id", ...verificationRow("second") },
					forceAllowId: true,
				});
			}),
		).rejects.toThrow();

		const doc = await db
			.collection(COLLECTIONS.verificationTokens)
			.doc("fixed-id")
			.get();
		expect(doc.data()?.value).toBe("first");
	});

	it("a create staged over a delete of the same id in one transaction replaces the document", async () => {
		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "verification",
			data: { id: "fixed-id", ...verificationRow("first") },
			forceAllowId: true,
		});
		await ctx.adapter.transaction(async (tx) => {
			await tx.delete({
				model: "verification",
				where: [{ field: "id", value: "fixed-id" }],
			});
			await tx.create({
				model: "verification",
				data: { id: "fixed-id", ...verificationRow("second") },
				forceAllowId: true,
			});
		});

		const doc = await db
			.collection(COLLECTIONS.verificationTokens)
			.doc("fixed-id")
			.get();
		expect(doc.data()?.value).toBe("second");
	});

	// The limiter reads the row for a key, creates one when it is missing and
	// treats a duplicate-key failure as "another request created it — re-read
	// and increment". Without a unique `key`, a burst of concurrent first
	// requests created one row per request, each with its own budget: 12
	// requests against `max: 3` were all allowed, and the next 24 as well.
	it("database rate limiting keeps one row per key under a concurrent first burst", async () => {
		const email = `rl-${Date.now()}@example.com`;
		await auth.api.signUpEmail({
			body: { email, password: "password1234", name: "Rate Limited" },
		});
		const request = () =>
			new Request("http://localhost/api/auth/sign-in/email", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-forwarded-for": "203.0.113.77",
				},
				body: JSON.stringify({ email, password: "wrong-password" }),
			});

		const burst = await Promise.all(
			Array.from({ length: 12 }, () => auth.handler(request())),
		);
		let allowed = burst.filter((r) => r.status !== 429).length;
		for (let i = 0; i < 5; i++) {
			if ((await auth.handler(request())).status !== 429) allowed++;
		}

		const rows = await db.collection(RATE_LIMIT_COLLECTION).get();
		expect(rows.size).toBe(1);
		expect(allowed).toBeLessThanOrEqual(MAX_ATTEMPTS);
		expect(allowed).toBeGreaterThan(0);
	}, 30_000);
});
