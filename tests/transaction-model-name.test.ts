import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// `runWithTransaction` stores whatever the adapter's `transaction()` hands
// to its callback as the *current adapter* for the rest of that callback,
// and better-auth's internals and plugins then call it exactly like the
// top-level adapter: with schema model keys (`user`), unmapped field names
// and untransformed data, relying on the adapter factory for
// `modelName`/`fieldName` mapping, id generation, defaults and date
// conversion.
//
// The Firestore adapter used to hand `run()` its raw per-transaction
// adapter, which bypassed all of that. It only worked because better-auth's
// default `modelName` equals the model key — the moment a model name was
// customised, every write inside a transaction (sign-up runs entirely in
// one) silently went to the wrong collection, and the non-transactional
// path, which *was* mapped, could not find the rows afterwards.

const COLLECTIONS = {
	users: "txm_users",
	sessions: "txm_sessions",
	accounts: "txm_accounts",
	verificationTokens: "txm_verifications",
};

// Custom model names take precedence over the `collections` option — the
// factory hands the adapter the mapped name, and `getCollectionRef` uses it
// verbatim for anything it does not recognise as a core model.
const CUSTOM = {
	users: "custom_users",
	sessions: "custom_sessions",
	accounts: "custom_accounts",
};

async function clearAll(db: Firestore) {
	for (const name of [
		...Object.values(COLLECTIONS),
		...Object.values(CUSTOM),
	]) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

describe("transaction adapter honours the factory's model/field mapping", () => {
	const db = initFirestore({ name: "test-tx-model", projectId: "test" });

	afterEach(async () => {
		await clearAll(db);
	});

	it("creates and finds a `user` in its custom `modelName` collection inside a transaction", async () => {
		const adapter = firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		})({ user: { modelName: CUSTOM.users } }) as any;

		const observed = await adapter.transaction(async (tx: any) => {
			const created = await tx.create({
				model: "user",
				data: { email: "custom@example.com", name: "Custom" },
			});
			const byId = await tx.findOne({
				model: "user",
				where: [{ field: "id", value: created.id }],
			});
			const byEmail = await tx.findOne({
				model: "user",
				where: [{ field: "email", value: "custom@example.com" }],
			});
			return { created, byId, byEmail };
		});

		// Read-your-writes still holds through the factory wrapper …
		expect(observed.byId?.id).toBe(observed.created.id);
		expect(observed.byEmail?.name).toBe("Custom");

		// … and the factory's input transforms applied to the staged create:
		// better-auth's defaults, not Firestore's bare document.
		expect(typeof observed.created.id).toBe("string");
		expect(observed.created.emailVerified).toBe(false);
		expect(observed.created.createdAt).toBeInstanceOf(Date);
		expect(observed.created.updatedAt).toBeInstanceOf(Date);

		// The row landed in the custom collection, not the `collections.users`
		// override — the same place the non-transactional path would look.
		const custom = await db.collection(CUSTOM.users).get();
		expect(custom.size).toBe(1);
		expect(custom.docs[0]?.id).toBe(observed.created.id);
		expect(custom.docs[0]?.data()).toMatchObject({
			email: "custom@example.com",
			name: "Custom",
			emailVerified: false,
		});
		expect((await db.collection(COLLECTIONS.users).get()).size).toBe(0);

		const outside = await adapter.findOne({
			model: "user",
			where: [{ field: "id", value: observed.created.id }],
		});
		expect(outside?.email).toBe("custom@example.com");
	});

	it("maps a custom `fieldName` inside a transaction", async () => {
		const adapter = firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		})({ user: { fields: { email: "email_address" } } }) as any;

		const found = await adapter.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "mapped@example.com", name: "Mapped" },
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "email", value: "mapped@example.com" }],
			});
		});

		// The caller sees the schema key; Firestore holds the mapped column.
		expect(found?.email).toBe("mapped@example.com");
		const stored = await db.collection(COLLECTIONS.users).get();
		expect(stored.size).toBe(1);
		expect(stored.docs[0]?.data()).toMatchObject({
			email_address: "mapped@example.com",
		});
		expect(stored.docs[0]?.data()).not.toHaveProperty("email");
	});

	it("binds each adapter instance's transactions to its own options", async () => {
		// One `firestoreAdapter()` result can back several `betterAuth()`
		// instances. Each instance's transactions must map models with *its*
		// options — not whichever instance was initialised last.
		const database = firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		});
		const custom = database({ user: { modelName: CUSTOM.users } }) as any;
		const plain = database({}) as any;

		await custom.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "a@example.com", name: "A" },
			});
		});
		await plain.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "b@example.com", name: "B" },
			});
		});

		const inCustom = await db.collection(CUSTOM.users).get();
		const inDefault = await db.collection(COLLECTIONS.users).get();
		expect(inCustom.docs.map((d) => d.data().email)).toEqual(["a@example.com"]);
		expect(inDefault.docs.map((d) => d.data().email)).toEqual([
			"b@example.com",
		]);
	});

	it("honours `forceAllowId` inside a transaction (what `createWithHooks` relies on)", async () => {
		const adapter = firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		})({ user: { modelName: CUSTOM.users } }) as any;

		const created = await adapter.transaction(async (tx: any) => {
			return tx.create({
				model: "user",
				data: { id: "fixed-user-id", email: "fixed@example.com", name: "F" },
				forceAllowId: true,
			});
		});

		expect(created.id).toBe("fixed-user-id");
		const doc = await db.collection(CUSTOM.users).doc("fixed-user-id").get();
		expect(doc.exists).toBe(true);
		expect(doc.data()?.email).toBe("fixed@example.com");
	});
});

// End to end: sign-up runs `findUserByEmail` → `createUser` →
// `createAccount` → `createSession` inside one `runWithTransaction`, and
// sign-in then looks the user up through the non-transactional adapter. Both
// halves have to agree on where a custom-named model lives.
describe("better-auth sign-up with custom model names (transactional path)", () => {
	const db = initFirestore({ name: "test-tx-model-e2e", projectId: "test" });

	const auth = betterAuth({
		database: firestoreAdapter({
			firestore: db,
			collections: COLLECTIONS,
		}),
		user: { modelName: CUSTOM.users },
		session: { modelName: CUSTOM.sessions },
		account: { modelName: CUSTOM.accounts },
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
	});

	afterEach(async () => {
		await clearAll(db);
	});

	it("stores the user, account and session in the custom collections and can sign in afterwards", async () => {
		const email = `txm-${Date.now()}@example.com`;
		const password = "password1234";

		const signUp = await auth.api.signUpEmail({
			body: { email, password, name: "Custom Models" },
			asResponse: true,
		});
		expect(signUp.status).toBe(200);

		const users = await db.collection(CUSTOM.users).get();
		expect(users.size).toBe(1);
		expect(users.docs[0]?.data().email).toBe(email);
		expect((await db.collection(CUSTOM.accounts).get()).size).toBe(1);
		expect((await db.collection(CUSTOM.sessions).get()).size).toBe(1);

		// Nothing leaked into the `collections` overrides.
		for (const name of Object.values(COLLECTIONS)) {
			expect((await db.collection(name).get()).size).toBe(0);
		}

		const signIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(signIn.status).toBe(200);
	});
});
