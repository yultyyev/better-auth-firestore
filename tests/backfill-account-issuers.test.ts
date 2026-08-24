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
			"https://accounts.google.com": 1,
			"local:siwe": 1,
			"local:oauth:team%2Fgithub": 1,
			"https://already.example": 1,
		});
		expect((await accounts.doc("cred").get()).data()?.issuer).toBe(
			"local:credential",
		);
		expect((await accounts.doc("google").get()).data()?.issuer).toBe(
			"https://accounts.google.com",
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

	it("resolves the real issuer for providers that publish one, and refuses to guess for the rest", async () => {
		// google/apple/facebook/line hard-code a real `accountIssuer` in
		// @better-auth/core's provider factories — 1.7 never assigns them the
		// synthetic `local:oauth:<providerId>` form, so backfilling them with
		// it would leave those accounts permanently unfindable after upgrading.
		// This is the regression test for that bug: it asserts the resolved
		// key actually matches what 1.7 looks accounts up by, not just that
		// the migration runs without error.
		const REAL_ISSUER_PROVIDERS: Record<string, string> = {
			google: "https://accounts.google.com",
			apple: "https://appleid.apple.com",
			facebook: "https://www.facebook.com",
			line: "https://access.line.me",
		};
		for (const providerId of Object.keys(REAL_ISSUER_PROVIDERS)) {
			await accounts
				.doc(providerId)
				.set({ providerId, accountId: `${providerId}-1`, userId: "user-1" });
		}

		// cognito's issuer is templated from the `region`/`userPoolId` passed
		// to the provider, paybin's from a configurable `issuer` option, and
		// microsoft's (the built-in Entra ID provider's id) is computed from
		// the live token's `iss` claim — none are guessable from `providerId`
		// alone, so stamping the synthetic form for them would be silently
		// wrong. They must come back unresolved rather than guessed.
		const UNRESOLVABLE_PROVIDERS = ["cognito", "paybin", "microsoft"];
		for (const providerId of UNRESOLVABLE_PROVIDERS) {
			await accounts
				.doc(providerId)
				.set({ providerId, accountId: `${providerId}-1`, userId: "user-1" });
		}

		const result = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});

		expect(result.updated).toBe(Object.keys(REAL_ISSUER_PROVIDERS).length);
		expect(result.unresolved.sort()).toEqual([...UNRESOLVABLE_PROVIDERS].sort());
		for (const [providerId, issuer] of Object.entries(REAL_ISSUER_PROVIDERS)) {
			expect((await accounts.doc(providerId).get()).data()?.issuer).toBe(
				issuer,
			);
		}
		for (const providerId of UNRESOLVABLE_PROVIDERS) {
			expect((await accounts.doc(providerId).get()).data()?.issuer).toBeUndefined();
		}

		// The caller can still resolve them explicitly, same as any other
		// provider with a real but unguessable issuer (Okta, Auth0, ...).
		// Entra ID's real `iss` carries the user's own tenant GUID — there is
		// no `common` issuer — which is exactly why it can't be guessed here.
		const ENTRA_TENANT_ISSUER =
			"https://login.microsoftonline.com/9122040d-6c67-4c5b-b112-36a304b66dad/v2.0";
		const resolved = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
			issuers: {
				cognito: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123",
				paybin: "https://idp.paybin.io",
				microsoft: ENTRA_TENANT_ISSUER,
			},
		});
		expect(resolved.unresolved).toEqual([]);
		expect((await accounts.doc("microsoft").get()).data()?.issuer).toBe(
			ENTRA_TENANT_ISSUER,
		);
	});

	// The bug this module got wrong was a claim ABOUT THE DEPENDENCY, so the
	// regression test has to ask the dependency rather than restate our own
	// table back to itself. Constructing every provider twice with different
	// options separates an issuer that is a fixed property of the provider
	// (must be stamped) from one derived from configuration (must not be
	// guessed) — no issuer literal is hardcoded here.
	it.skipIf(!LOOKUPS_REQUIRE_ISSUER)(
		"stamps exactly what the installed better-auth would look accounts up by",
		async () => {
			const { socialProviders } = (await import(
				"better-auth/social-providers"
			)) as { socialProviders: Record<string, (o: never) => unknown> };

			const OPTIONS_A = {
				clientId: "id",
				clientSecret: "secret",
				region: "us-east-1",
				userPoolId: "pool-a",
				domain: "a.example",
				issuer: "https://a.example",
				tenantId: "tenant-a",
			};
			const OPTIONS_B = {
				clientId: "id",
				clientSecret: "secret",
				region: "eu-west-1",
				userPoolId: "pool-b",
				domain: "b.example",
				issuer: "https://b.example",
				tenantId: "tenant-b",
			};
			const issuerOf = (factory: (o: never) => unknown, options: object) =>
				(factory(options as never) as { accountIssuer?: unknown })
					.accountIssuer;

			const fixed = new Map<string, string>();
			const configDependent: string[] = [];
			const none: string[] = [];
			for (const factory of Object.values(socialProviders)) {
				const a = issuerOf(factory, OPTIONS_A);
				const b = issuerOf(factory, OPTIONS_B);
				const id = (factory(OPTIONS_A as never) as { id: string }).id;
				if (a === undefined) none.push(id);
				else if (typeof a === "string" && a === b) fixed.set(id, a);
				else configDependent.push(id);
			}
			// Guard against the enumeration silently going empty.
			expect(fixed.size).toBeGreaterThan(0);
			expect(configDependent.length).toBeGreaterThan(0);
			expect(none.length).toBeGreaterThan(0);

			const ids = [...fixed.keys(), ...configDependent, ...none];
			await Promise.all(
				ids.map((id) =>
					accounts.doc(id).set({
						providerId: id,
						accountId: `${id}-1`,
						userId: `u-${id}`,
					}),
				),
			);

			const result = await backfillAccountIssuers({
				firestore: db,
				collection: ACCOUNTS,
			});

			for (const [id, issuer] of fixed) {
				expect(
					(await accounts.doc(id).get()).data()?.issuer,
					`${id} must be stamped with the issuer better-auth declares`,
				).toBe(issuer);
			}
			for (const id of configDependent) {
				expect(
					result.unresolved,
					`${id}'s issuer depends on configuration — it must not be guessed`,
				).toContain(id);
			}
			for (const id of none) {
				expect(
					(await accounts.doc(id).get()).data()?.issuer,
					`${id} declares no issuer, so 1.7 uses the synthetic form`,
				).toBe(oauthAccountIssuer(id));
			}
		},
	);

	it("repairs issuers the v1.3.0 backfill stamped wrong, without touching deliberate ones", async () => {
		// What a deployment that ran adapter v1.3.0's backfill is left with:
		// providers that publish a real issuer got the synthetic form instead,
		// so 1.7 can't find them and those users can't sign in. Re-running the
		// fixed command must repair them — the skip-if-stamped rule would
		// otherwise report a clean run and leave them broken.
		await accounts.doc("google").set({
			providerId: "google",
			accountId: "g-1",
			userId: "user-1",
			issuer: "local:oauth:google",
		});
		await accounts.doc("apple").set({
			providerId: "apple",
			accountId: "a-1",
			userId: "user-2",
			issuer: "local:oauth:apple",
		});
		// Must be left alone: a synthetic issuer is genuinely correct here.
		await accounts.doc("github").set({
			providerId: "github",
			accountId: "gh-1",
			userId: "user-3",
			issuer: "local:oauth:github",
		});
		// Must be left alone: a deliberate issuer for a provider that has one.
		await accounts.doc("okta").set({
			providerId: "okta",
			accountId: "00u1",
			userId: "user-4",
			issuer: "https://acme.okta.com",
		});

		const dry = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
			dryRun: true,
		});
		expect(dry.legacyIssuersRepaired).toEqual([
			{ id: "apple", from: "local:oauth:apple", to: "https://appleid.apple.com" },
			{
				id: "google",
				from: "local:oauth:google",
				to: "https://accounts.google.com",
			},
		]);
		expect(dry.skipped).toBe(2);
		// dryRun still wrote nothing.
		expect((await accounts.doc("google").get()).data()?.issuer).toBe(
			"local:oauth:google",
		);

		const real = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});
		expect(real.legacyIssuersRepaired).toHaveLength(2);
		expect((await accounts.doc("google").get()).data()?.issuer).toBe(
			"https://accounts.google.com",
		);
		expect((await accounts.doc("apple").get()).data()?.issuer).toBe(
			"https://appleid.apple.com",
		);
		expect((await accounts.doc("github").get()).data()?.issuer).toBe(
			"local:oauth:github",
		);
		expect((await accounts.doc("okta").get()).data()?.issuer).toBe(
			"https://acme.okta.com",
		);

		// Idempotent: a second run finds nothing left to repair.
		const again = await backfillAccountIssuers({
			firestore: db,
			collection: ACCOUNTS,
		});
		expect(again.legacyIssuersRepaired).toEqual([]);
		expect(again.skipped).toBe(4);
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
