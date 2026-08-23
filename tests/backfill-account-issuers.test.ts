import { readFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
	backfillAccountIssuers,
	firestoreAdapter,
	localAccountIssuer,
	oauthAccountIssuer,
} from "../src";
import { initFirestore } from "../src/firestore";

// Better Auth 1.7 identifies accounts by `(issuer, accountId)`. Documents
// written by earlier versions have no `issuer`, and Firestore has no
// `auth migrate`, so `backfillAccountIssuers` is the upgrade path.

const BETTER_AUTH_VERSION = JSON.parse(
	readFileSync(
		new URL("../node_modules/better-auth/package.json", import.meta.url),
		"utf8",
	),
).version as string;
const [major, minor] = BETTER_AUTH_VERSION.split(".").map(Number);
// `issuer` is only consulted by lookups from 1.7 onwards; on 1.6 a legacy
// document signs in regardless.
const LOOKUPS_REQUIRE_ISSUER = major > 1 || (major === 1 && minor >= 7);

async function clearCollection(db: Firestore, name: string) {
	const snap = await db.collection(name).get();
	await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

describe("backfillAccountIssuers", () => {
	const db = initFirestore({ name: "test-backfill", projectId: "test" });
	const ACCOUNTS = "bf_accounts";
	const accounts = db.collection(ACCOUNTS);

	afterEach(async () => {
		await clearCollection(db, ACCOUNTS);
	});

	it("mirrors better-auth's issuer encoding", () => {
		expect(localAccountIssuer("credential")).toBe("local:credential");
		expect(oauthAccountIssuer("github")).toBe("local:oauth:github");
		expect(oauthAccountIssuer("team/github")).toBe("local:oauth:team%2Fgithub");
	});

	it("stamps the 1.7 default issuer per provider and leaves stamped docs alone", async () => {
		await accounts.doc("cred").set({
			providerId: "credential",
			accountId: "user-1",
			userId: "user-1",
		});
		await accounts.doc("google").set({
			providerId: "google",
			accountId: "g-123",
			userId: "user-1",
		});
		await accounts.doc("siwe").set({
			providerId: "siwe",
			accountId: "0xabc:1",
			userId: "user-2",
		});
		await accounts.doc("slash").set({
			providerId: "team/github",
			accountId: "gh-1",
			userId: "user-3",
		});
		await accounts.doc("done").set({
			providerId: "github",
			accountId: "gh-2",
			userId: "user-4",
			issuer: "https://already.example",
		});

		const result = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});

		expect(result).toMatchObject({
			scanned: 5,
			updated: 4,
			skipped: 1,
			unresolved: [],
			credentialAccountIdsRepaired: 0,
			collisions: [],
		});
		expect(result.byIssuer).toEqual({
			"local:credential": 1,
			"local:oauth:google": 1,
			"local:siwe": 1,
			"local:oauth:team%2Fgithub": 1,
			"https://already.example": 1,
		});
		expect((await accounts.doc("cred").get()).data()?.issuer).toBe(
			"local:credential",
		);
		expect((await accounts.doc("google").get()).data()?.issuer).toBe(
			"local:oauth:google",
		);
		expect((await accounts.doc("siwe").get()).data()?.issuer).toBe(
			"local:siwe",
		);
		expect((await accounts.doc("slash").get()).data()?.issuer).toBe(
			"local:oauth:team%2Fgithub",
		);
		expect((await accounts.doc("done").get()).data()?.issuer).toBe(
			"https://already.example",
		);

		// Second run is a no-op.
		const again = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});
		expect(again).toMatchObject({ scanned: 5, updated: 0, skipped: 5 });
	});

	it("honours `issuers` overrides and a custom resolver, in that order of precedence", async () => {
		await accounts.doc("okta").set({
			providerId: "okta",
			accountId: "00u1",
			userId: "user-1",
		});
		await accounts.doc("custom").set({
			providerId: "legacy",
			accountId: "l-1",
			userId: "user-2",
		});
		await accounts.doc("fallback").set({
			providerId: "github",
			accountId: "gh-1",
			userId: "user-3",
		});

		const result = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
			issuers: { okta: "https://acme.okta.com" },
			resolveIssuer: (account) =>
				account.providerId === "legacy" ? "https://legacy.example" : null,
		});

		expect(result.updated).toBe(3);
		expect((await accounts.doc("okta").get()).data()?.issuer).toBe(
			"https://acme.okta.com",
		);
		expect((await accounts.doc("custom").get()).data()?.issuer).toBe(
			"https://legacy.example",
		);
		expect((await accounts.doc("fallback").get()).data()?.issuer).toBe(
			"local:oauth:github",
		);
	});

	it("repairs credential accountIds, reports unresolved docs and collisions, and respects dryRun", async () => {
		await accounts.doc("cred-bad").set({
			providerId: "credential",
			accountId: "stale-value",
			userId: "user-1",
		});
		await accounts.doc("no-provider").set({ accountId: "x", userId: "user-2" });
		await accounts.doc("dup-a").set({
			providerId: "github",
			accountId: "gh-1",
			userId: "user-3",
		});
		await accounts.doc("dup-b").set({
			providerId: "github",
			accountId: "gh-1",
			userId: "user-4",
		});

		const dry = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
			dryRun: true,
		});
		expect(dry).toMatchObject({
			scanned: 4,
			updated: 3,
			unresolved: ["no-provider"],
			credentialAccountIdsRepaired: 1,
			collisions: [
				{ issuer: "local:oauth:github", accountId: "gh-1", ids: ["dup-a", "dup-b"] },
			],
		});
		// dryRun wrote nothing.
		expect((await accounts.doc("cred-bad").get()).data()).toEqual({
			providerId: "credential",
			accountId: "stale-value",
			userId: "user-1",
		});

		const real = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});
		expect(real.updated).toBe(3);
		expect((await accounts.doc("cred-bad").get()).data()).toMatchObject({
			issuer: "local:credential",
			accountId: "user-1",
		});
	});

	it("reads the snake_case user reference and paginates in small batches", async () => {
		for (let i = 0; i < 5; i++) {
			await accounts.doc(`c${i}`).set({
				providerId: "credential",
				accountId: "wrong",
				user_id: `user-${i}`,
			});
		}

		const result = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
			namingStrategy: "snake_case",
			batchSize: 2,
		});

		expect(result).toMatchObject({
			scanned: 5,
			updated: 5,
			credentialAccountIdsRepaired: 5,
			collisions: [],
		});
		for (let i = 0; i < 5; i++) {
			expect((await accounts.doc(`c${i}`).get()).data()).toMatchObject({
				issuer: "local:credential",
				accountId: `user-${i}`,
			});
		}
	});
});

describe("backfillAccountIssuers end to end", () => {
	const db = initFirestore({ name: "test-backfill-e2e", projectId: "test" });
	const COLLECTIONS = {
		users: "bfe_users",
		sessions: "bfe_sessions",
		accounts: "bfe_accounts",
		verificationTokens: "bfe_verifications",
	};

	const auth = betterAuth({
		database: firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
	});

	afterEach(async () => {
		for (const name of Object.values(COLLECTIONS)) {
			await clearCollection(db, name);
		}
	});

	it("makes a pre-1.7 credential account sign in again", async () => {
		const email = `bf-${Date.now()}@example.com`;
		const password = "password1234";
		const signUp = await auth.api.signUpEmail({
			body: { email, password, name: "Legacy" },
			asResponse: true,
		});
		expect(signUp.status).toBe(200);

		// Turn the account into what a 1.6 deployment left behind.
		const accounts = await db.collection(COLLECTIONS.accounts).get();
		expect(accounts.size).toBe(1);
		await Promise.all(
			accounts.docs.map((d) => d.ref.update({ issuer: FieldValue.delete() })),
		);

		const before = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		if (LOOKUPS_REQUIRE_ISSUER) {
			// 1.7 can no longer find the credential account.
			expect(before.status).not.toBe(200);
		}

		const result = await backfillAccountIssuers({
			firestore: db,
			collection: COLLECTIONS.accounts,
		});
		expect(result).toMatchObject({ scanned: 1, updated: 1, collisions: [] });
		expect(result.byIssuer).toEqual({ "local:credential": 1 });

		const after = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(after.status).toBe(200);
	});
});
