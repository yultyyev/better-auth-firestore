import { readFileSync } from "node:fs";
import type { Firestore } from "firebase-admin/firestore";
import type { MockInstance } from "vitest";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// The adapter warns once at startup when Better Auth expects
// `account.issuer` but existing account documents lack it — the silent
// "existing users can't sign in" failure after a 1.7 upgrade.

const BETTER_AUTH_VERSION = JSON.parse(
	readFileSync(
		new URL("../node_modules/better-auth/package.json", import.meta.url),
		"utf8",
	),
).version as string;
const [major, minor] = BETTER_AUTH_VERSION.split(".").map(Number);
const SCHEMA_HAS_ISSUER = major > 1 || (major === 1 && minor >= 7);

function collectionsFor(prefix: string) {
	return {
		users: `${prefix}_users`,
		sessions: `${prefix}_sessions`,
		accounts: `${prefix}_accounts`,
		verificationTokens: `${prefix}_verifications`,
	};
}

async function clearCollection(db: Firestore, name: string) {
	const snap = await db.collection(name).get();
	await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

describe("startup account-issuer migration check", () => {
	const db = initFirestore({ name: "test-migration-check", projectId: "test" });
	let warn: MockInstance<typeof console.warn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	const warnings = () =>
		warn.mock.calls
			.map((call: unknown[]) => String(call[0]))
			.filter((message: string) => message.includes("[better-auth-firestore]"));

	it("warns once, naming the exact command, when account documents lack an issuer", async () => {
		const collections = collectionsFor("mc1");
		await db.collection(collections.accounts).doc("legacy").set({
			providerId: "credential",
			accountId: "u1",
			userId: "u1",
		});
		await db.collection(collections.accounts).doc("stamped").set({
			providerId: "google",
			accountId: "g1",
			userId: "u2",
			issuer: "local:oauth:google",
		});

		const factory = firestoreAdapter({ firestore: db, collections });
		factory({});
		factory({}); // a second instance on the same collection must not warn again

		if (SCHEMA_HAS_ISSUER) {
			await vi.waitFor(() => expect(warnings()).toHaveLength(1));
			expect(warnings()[0]).toContain('1 of 2 documents in "mc1_accounts"');
			expect(warnings()[0]).toContain(
				"npx better-auth-firestore backfill-account-issuers --collection mc1_accounts --apply",
			);
		} else {
			// Better Auth 1.6 has no issuer field: nothing to check.
			await new Promise((r) => setTimeout(r, 300));
			expect(warnings()).toHaveLength(0);
		}
		await clearCollection(db, collections.accounts);
	});

	it("stays silent when every account is stamped, and when disabled", async () => {
		const stamped = collectionsFor("mc2");
		await db.collection(stamped.accounts).doc("a").set({
			providerId: "credential",
			accountId: "u1",
			userId: "u1",
			issuer: "local:credential",
		});
		firestoreAdapter({ firestore: db, collections: stamped })({});

		const disabled = collectionsFor("mc3");
		await db.collection(disabled.accounts).doc("legacy").set({
			providerId: "credential",
			accountId: "u1",
			userId: "u1",
		});
		firestoreAdapter({
			firestore: db,
			collections: disabled,
			migrationChecks: false,
		})({});

		await new Promise((r) => setTimeout(r, 500));
		expect(warnings()).toHaveLength(0);
		await clearCollection(db, stamped.accounts);
		await clearCollection(db, disabled.accounts);
	});

	it("mentions the naming strategy flag for snake_case deployments", async () => {
		const collections = collectionsFor("mc4");
		await db.collection(collections.accounts).doc("legacy").set({
			providerId: "credential",
			accountId: "u1",
			user_id: "u1",
		});
		firestoreAdapter({
			firestore: db,
			collections,
			namingStrategy: "snake_case",
		})({});

		if (SCHEMA_HAS_ISSUER) {
			await vi.waitFor(() => expect(warnings()).toHaveLength(1));
			expect(warnings()[0]).toContain("--naming-strategy snake_case");
		}
		await clearCollection(db, collections.accounts);
	});
});
