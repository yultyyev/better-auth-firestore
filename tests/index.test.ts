import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

type NamingStrategy = "snake_case" | "default";
type TestConfig = {
	namingStrategy: NamingStrategy;
	collections: {
		users: string;
		sessions: string;
		accounts: string;
		verificationTokens: string;
	};
};
type Adapter = ReturnType<ReturnType<typeof firestoreAdapter>>;

const configs: TestConfig[] = [
	{
		namingStrategy: "snake_case",
		collections: {
			users: "test_users_snake",
			sessions: "test_sessions_snake",
			accounts: "test_accounts_snake",
			verificationTokens: "test_verification_tokens_snake",
		},
	},
	{
		namingStrategy: "default",
		collections: {
			users: "test_users_default",
			sessions: "test_sessions_default",
			accounts: "test_accounts_default",
			verificationTokens: "test_verificationTokens_default",
		},
	},
];

async function clearCollection(db: Firestore, collection: string) {
	const snapshot = await db.collection(collection).get();
	await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
}

describe.each<TestConfig>(
	configs,
)("Firestore adapter compatibility (%s)", (cfg: TestConfig) => {
	const db = initFirestore({
		name: `test-${cfg.namingStrategy}`,
		projectId: "test",
	});

	const getAdapter = (): Adapter =>
		firestoreAdapter({
			firestore: db,
			namingStrategy: cfg.namingStrategy,
			collections: cfg.collections,
			debugLogs: false,
		})({});

	afterEach(async () => {
		await clearCollection(db, cfg.collections.users);
		await clearCollection(db, cfg.collections.sessions);
	});

	it("creates and finds a user", async () => {
		const adapter = getAdapter() as any;
		const created = await adapter.create({
			model: "user",
			data: {
				id: "user_1",
				email: "user@example.com",
				name: "User",
			},
		});
		expect(created.id).toBeTruthy();

		const found = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});

		expect(found).toBeTruthy();
		expect(found.id).toBe(created.id);
		expect(found.email).toBe("user@example.com");
	});

	it("updates and counts records", async () => {
		const adapter = getAdapter() as any;
		const created = await adapter.create({
			model: "user",
			data: {
				id: "user_2",
				email: "before@example.com",
				name: "Before",
			},
		});

		const updated = await adapter.update({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
			update: { email: "after@example.com", name: "After" },
		});

		expect(updated).toBeTruthy();
		expect(updated.email).toBe("after@example.com");

		const count = await adapter.count({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});
		expect(count).toBe(1);
	});

	it("supports findMany sorting and delete", async () => {
		const adapter = getAdapter() as any;
		const createdA = await adapter.create({
			model: "user",
			data: { id: "a", email: "a@example.com", name: "A" },
		});
		const createdB = await adapter.create({
			model: "user",
			data: { id: "b", email: "b@example.com", name: "B" },
		});

		const users = await adapter.findMany({
			model: "user",
			where: [],
			sortBy: { field: "email", direction: "desc" },
		});
		expect(users).toHaveLength(2);
		expect(users[0]?.email).toBe("b@example.com");

		await adapter.delete({
			model: "user",
			where: [{ field: "id", operator: "eq", value: createdA.id }],
		});

		const remaining = await adapter.findMany({
			model: "user",
			where: [],
		});
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBe(createdB.id);
	});

	// Regression: verification-token lookups issue `where identifier ==` +
	// `sortBy createdAt desc`. That combination used to call Firestore's
	// `orderBy` on a filtered query, which requires a composite index and fails
	// in production with `9 FAILED_PRECONDITION: The query requires an index`.
	// The adapter now sorts filtered queries in memory, so no index is needed.
	it("findMany sorts a where-filtered query in memory (verification-token shape)", async () => {
		const adapter = getAdapter() as any;
		const col = cfg.collections.verificationTokens;
		await clearCollection(db, col);
		const identifier = "magic-link:index-regression@example.com";

		// Seed directly with fixed ids so we can assert ordering by id.
		// (adapter.create would route through Better Auth's schema, generate its
		// own ids, and drop non-schema fields — this test targets the adapter's
		// findMany query/sort path, not create transformation.)
		await db.collection(col).doc("vt_old").set({
			identifier,
			value: "old-token",
			createdAt: new Date("2030-01-01T00:00:00.000Z"),
			expiresAt: new Date("2030-01-01T01:00:00.000Z"),
		});
		await db.collection(col).doc("vt_new").set({
			identifier,
			value: "new-token",
			createdAt: new Date("2030-01-02T00:00:00.000Z"),
			expiresAt: new Date("2030-01-02T01:00:00.000Z"),
		});

		const latest = await adapter.findMany({
			model: "verification",
			where: [{ field: "identifier", operator: "eq", value: identifier }],
			sortBy: { field: "createdAt", direction: "desc" },
			limit: 1,
		});
		expect(latest).toHaveLength(1);
		expect(latest[0]?.id).toBe("vt_new");
		expect(latest[0]?.value).toBe("new-token");

		const ascending = await adapter.findMany({
			model: "verification",
			where: [{ field: "identifier", operator: "eq", value: identifier }],
			sortBy: { field: "createdAt", direction: "asc" },
		});
		expect(ascending.map((r: any) => r.id)).toEqual(["vt_old", "vt_new"]);

		const offsetResult = await adapter.findMany({
			model: "verification",
			where: [{ field: "identifier", operator: "eq", value: identifier }],
			sortBy: { field: "createdAt", direction: "desc" },
			offset: 1,
		});
		expect(offsetResult).toHaveLength(1);
		expect(offsetResult[0]?.id).toBe("vt_old");

		await clearCollection(db, col);
	});

	it("handles oversized non-ID in clauses across CRUD methods", async () => {
		const adapter = getAdapter() as any;
		const oversizedEmails = Array.from(
			{ length: 35 },
			(_, index) => `bulk_${index}@example.com`,
		);

		for (const [index, email] of oversizedEmails.entries()) {
			await adapter.create({
				model: "user",
				data: {
					id: `bulk_${index}`,
					email,
					name: `Bulk ${index}`,
				},
			});
		}

		const foundOne = await adapter.findOne({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
		});
		expect(foundOne).toBeTruthy();
		expect(oversizedEmails).toContain(foundOne.email);

		const updated = await adapter.update({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
			update: { name: "single-updated" },
		});
		expect(updated).toBeTruthy();
		expect(updated.name).toBe("single-updated");

		const updateManyCount = await adapter.updateMany({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
			update: { name: "bulk-updated" },
		});
		expect(updateManyCount).toBe(35);

		const count = await adapter.count({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
		});
		expect(count).toBe(35);

		await adapter.delete({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
		});

		const remainingAfterDelete = await adapter.count({
			model: "user",
			where: [{ field: "email", operator: "in", value: oversizedEmails }],
		});
		expect(remainingAfterDelete).toBe(34);
	});

	it("drops undefined fields on create and update without erroring", async () => {
		// Firestore's Admin SDK rejects writes containing `undefined` unless
		// `ignoreUndefinedProperties: true` is set on the client. better-auth
		// routinely emits optional-undefined fields (e.g. `image` on
		// email/password sign-up); the adapter must strip them so the write
		// goes through cleanly with any user-supplied Firestore instance.
		const adapter = getAdapter() as any;

		// Note: better-auth's adapter wrapper strips client-supplied `id` and
		// generates its own, so we don't pass one here.
		const created = await adapter.create({
			model: "user",
			data: {
				email: "undef@example.com",
				name: "Undef",
				image: undefined,
			},
		});
		expect(created.id).toBeTruthy();

		const found = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});
		expect(found).toBeTruthy();
		expect(found.email).toBe("undef@example.com");
		// undefined fields should not have been persisted
		expect(found.image).toBeUndefined();

		const updated = await adapter.update({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
			update: { name: "Undef2", image: undefined },
		});
		expect(updated).toBeTruthy();
		expect(updated.name).toBe("Undef2");
	});

	it("coerces session foreign keys to scalar ids on create", async () => {
		const adapter = getAdapter() as any;
		const userRef = db.collection(cfg.collections.users).doc("session_user_fk");
		await userRef.set({
			email: "session-user@example.com",
			name: "Session User",
		});

		const created = await adapter.create({
			model: "session",
			data: {
				userId: userRef,
				expires: new Date("2030-01-01T00:00:00.000Z"),
			},
		});
		expect(created.id).toBeTruthy();

		const rawDoc = await db
			.collection(cfg.collections.sessions)
			.doc(created.id)
			.get();
		const rawData = rawDoc.data();
		expect(rawData).toBeTruthy();
		expect(Object.values(rawData ?? {})).toContain("session_user_fk");
	});
});

describe("Emulator env does not alter default collection names", () => {
	const db = initFirestore({
		name: "test-emulator-collections",
		projectId: "test",
	});

	const expectedDefault = {
		users: "emulator_test_users",
		sessions: "emulator_test_sessions",
		accounts: "emulator_test_accounts",
		verificationTokens: "emulator_test_verificationTokens",
	};

	afterAll(async () => {
		for (const col of Object.values(expectedDefault)) {
			const snapshot = await db.collection(col).get();
			await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
		}
	});

	it("uses standard collection names even when FIRESTORE_EMULATOR_HOST is set", async () => {
		expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy();

		const adapter = firestoreAdapter({
			firestore: db,
			collections: expectedDefault,
			debugLogs: false,
		})({}) as any;

		const created = await adapter.create({
			model: "user",
			data: { email: "emu@test.com", name: "Emu" },
		});
		expect(created.id).toBeTruthy();

		const found = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});
		expect(found).toBeTruthy();
		expect(found.email).toBe("emu@test.com");
	});

	it("snake_case naming does not add suffixes from emulator env", async () => {
		const snakeCollections = {
			users: "emulator_test_users_sc",
			sessions: "emulator_test_sessions_sc",
			accounts: "emulator_test_accounts_sc",
			verificationTokens: "emulator_test_verification_tokens_sc",
		};

		const adapter = firestoreAdapter({
			firestore: db,
			namingStrategy: "snake_case",
			collections: snakeCollections,
			debugLogs: false,
		})({}) as any;

		const created = await adapter.create({
			model: "user",
			data: { email: "snake@test.com", name: "Snake" },
		});
		expect(created.id).toBeTruthy();

		const found = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});
		expect(found).toBeTruthy();
		expect(found.email).toBe("snake@test.com");

		// Cleanup
		await adapter.delete({
			model: "user",
			where: [{ field: "id", operator: "eq", value: created.id }],
		});
		for (const col of Object.values(snakeCollections)) {
			const snapshot = await db.collection(col).get();
			await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
		}
	});
});

describe("Transaction buffering (regression for #24)", () => {
	// All tests in this block use the same db + collection set. The tx
	// wrapper doesn't branch on naming strategy, so we only need to cover
	// one configuration here.
	const db = initFirestore({ name: "test-tx", projectId: "test" });
	const TX_COLLECTIONS = {
		users: "tx_users",
		sessions: "tx_sessions",
		accounts: "tx_accounts",
		verificationTokens: "tx_verificationTokens",
	};
	const adapter = firestoreAdapter({
		firestore: db,
		collections: TX_COLLECTIONS,
		debugLogs: false,
	})({}) as any;

	afterEach(async () => {
		for (const col of Object.values(TX_COLLECTIONS)) {
			const snap = await db.collection(col).get();
			await Promise.all(snap.docs.map((d) => d.ref.delete()));
		}
	});

	it("commits a create inside a transaction (the bare #24 trigger)", async () => {
		// Before the buffer refactor, this worked — only one Firestore op —
		// but it sets the baseline.
		const result = await adapter.transaction(async (tx: any) => {
			return tx.create({
				model: "user",
				data: { email: "tx1@example.com", name: "T1" },
			});
		});
		expect(result.id).toBeTruthy();

		const found = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: result.id }],
		});
		expect(found.email).toBe("tx1@example.com");
	});

	it("findOne after create returns the buffered doc (read-your-writes by id)", async () => {
		const observed = await adapter.transaction(async (tx: any) => {
			const created = await tx.create({
				model: "user",
				data: { email: "tx2@example.com", name: "T2" },
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "id", operator: "eq", value: created.id }],
			});
		});
		expect(observed).toBeTruthy();
		expect(observed.email).toBe("tx2@example.com");
	});

	it("findOne after create overlays by non-id field too", async () => {
		const observed = await adapter.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "tx3@example.com", name: "T3" },
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "tx3@example.com" }],
			});
		});
		expect(observed).toBeTruthy();
		expect(observed.name).toBe("T3");
	});

	it("create + update on the same buffered doc collapses to a single set on flush", async () => {
		const observed = await adapter.transaction(async (tx: any) => {
			const created = await tx.create({
				model: "user",
				data: { email: "tx4@example.com", name: "Original" },
			});
			return tx.update({
				model: "user",
				where: [{ field: "id", operator: "eq", value: created.id }],
				update: { name: "Modified" },
			});
		});
		expect(observed.name).toBe("Modified");
		expect(observed.email).toBe("tx4@example.com");

		// Persisted state reflects the merged write
		const persisted = await adapter.findOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: observed.id }],
		});
		expect(persisted.name).toBe("Modified");
		expect(persisted.email).toBe("tx4@example.com");
	});

	it("update + update on the same Firestore-resident doc merges into one update", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "tx5@example.com", name: "Seed" });

		await adapter.transaction(async (tx: any) => {
			await tx.update({
				model: "user",
				where: [{ field: "id", operator: "eq", value: seedRef.id }],
				update: { name: "Update1" },
			});
			await tx.update({
				model: "user",
				where: [{ field: "id", operator: "eq", value: seedRef.id }],
				update: { name: "Update2" },
			});
		});

		const persisted = await seedRef.get();
		expect(persisted.data()?.name).toBe("Update2");
		// Email from the seed should survive — update is partial, not replace
		expect(persisted.data()?.email).toBe("tx5@example.com");
	});

	it("findOne after update returns the merged state, not the pre-update snapshot", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "tx6@example.com", name: "Seed" });

		const observed = await adapter.transaction(async (tx: any) => {
			await tx.update({
				model: "user",
				where: [{ field: "id", operator: "eq", value: seedRef.id }],
				update: { name: "Modified" },
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "id", operator: "eq", value: seedRef.id }],
			});
		});
		expect(observed.name).toBe("Modified");
		expect(observed.email).toBe("tx6@example.com");
	});

	it("create(user) → findOne(session)[null] → create(session) — the actual #24 pattern", async () => {
		// This is the exact interleaving that triggered #24 once
		// secondaryStorage was wired in. With buffered writes, the findOne
		// runs first against Firestore (no writes flushed yet) and the two
		// creates flush after the callback resolves.
		await adapter.transaction(async (tx: any) => {
			const u = await tx.create({
				model: "user",
				data: { email: "tx7@example.com", name: "U" },
			});

			const existing = await tx.findOne({
				model: "session",
				where: [{ field: "userId", operator: "eq", value: u.id }],
			});
			expect(existing).toBeNull();

			await tx.create({
				model: "session",
				data: {
					userId: u.id,
					token: "tx7-session-token",
					expiresAt: new Date("2030-01-01T00:00:00.000Z"),
				},
			});
		});

		const users = await db.collection(TX_COLLECTIONS.users).get();
		const sessions = await db.collection(TX_COLLECTIONS.sessions).get();
		expect(users.size).toBe(1);
		expect(sessions.size).toBe(1);
	});

	it("throwing inside the callback aborts the transaction (no partial writes)", async () => {
		await expect(
			adapter.transaction(async (tx: any) => {
				await tx.create({
					model: "user",
					data: { email: "tx8@example.com", name: "Aborted" },
				});
				throw new Error("intentional");
			}),
		).rejects.toThrow("intentional");

		const users = await db.collection(TX_COLLECTIONS.users).get();
		expect(users.size).toBe(0);
	});

	// better-auth's magic-link plugin consumes a verification token inside
	// adapter.transaction(), calling txAdapter.findMany (locate the latest
	// token), txAdapter.consumeOne (read + delete atomically), and
	// txAdapter.deleteMany (expired-token cleanup) — none of which the
	// buffered tx adapter implemented, so every magic-link verify failed with
	// "txAdapter.findMany is not a function". These tests exercise those
	// three methods directly against the `user` model/collection (already
	// covered above) to isolate the tx-adapter behavior from model-name
	// resolution.
	it("findMany inside a transaction returns matching Firestore-resident docs, sorted and limited", async () => {
		const seedRef1 = db.collection(TX_COLLECTIONS.users).doc();
		const seedRef2 = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef1.set({
			email: "fm-shared@example.com",
			name: "old",
			createdAt: new Date("2030-01-01T00:00:00.000Z"),
		});
		await seedRef2.set({
			email: "fm-shared@example.com",
			name: "new",
			createdAt: new Date("2030-01-02T00:00:00.000Z"),
		});

		const results = await adapter.transaction(async (tx: any) => {
			return tx.findMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "fm-shared@example.com" },
				],
				sortBy: { field: "createdAt", direction: "desc" },
				limit: 1,
			});
		});
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("new");
	});

	it("findMany inside a transaction overlays a create staged earlier in the same transaction", async () => {
		const results = await adapter.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "fm-buffered@example.com", name: "Buffered" },
			});
			return tx.findMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "fm-buffered@example.com" },
				],
			});
		});
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Buffered");
	});

	it("consumeOne inside a transaction returns the doc and deletes it on flush", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "consume@example.com", name: "ToConsume" });

		const consumed = await adapter.transaction(async (tx: any) => {
			return tx.consumeOne({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "consume@example.com" },
				],
			});
		});
		expect(consumed?.name).toBe("ToConsume");

		const persisted = await seedRef.get();
		expect(persisted.exists).toBe(false);
	});

	it("consumeOne inside a transaction is invisible to a subsequent findOne in the same transaction", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "gone@example.com", name: "Gone" });

		const observedAfterConsume = await adapter.transaction(async (tx: any) => {
			await tx.consumeOne({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "gone@example.com" }],
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "gone@example.com" }],
			});
		});
		expect(observedAfterConsume).toBeNull();
	});

	// `updateMany` was missing from the tx adapter entirely. better-auth's
	// `incrementOne` fallback is `transaction(findMany + updateMany)`, so the
	// database-backed rate limiter threw `updateMany is not a function` and
	// every rate-limited auth route returned 500.
	it("updateMany inside a transaction updates all matching docs on flush", async () => {
		const seedRef1 = db.collection(TX_COLLECTIONS.users).doc();
		const seedRef2 = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef1.set({ email: "bulk@example.com", name: "before" });
		await seedRef2.set({ email: "bulk@example.com", name: "before" });

		const count = await adapter.transaction(async (tx: any) => {
			return tx.updateMany({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "bulk@example.com" }],
				update: { name: "after" },
			});
		});
		expect(count).toBe(2);

		const [after1, after2] = await Promise.all([
			seedRef1.get(),
			seedRef2.get(),
		]);
		expect(after1.data()?.name).toBe("after");
		expect(after2.data()?.name).toBe("after");
		// The update mask must not clobber untouched fields.
		expect(after1.data()?.email).toBe("bulk@example.com");
	});

	it("updateMany inside a transaction returns 0 when nothing matches", async () => {
		const count = await adapter.transaction(async (tx: any) => {
			return tx.updateMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "nobody@example.com" },
				],
				update: { name: "after" },
			});
		});
		// better-auth's incrementOne fallback reads a 0 here as "the CAS guard
		// failed", which is what makes the rate limiter reject a request.
		expect(count).toBe(0);
	});

	it("updateMany inside a transaction folds in creates staged earlier in the same transaction", async () => {
		const count = await adapter.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "staged-update@example.com", name: "before" },
			});
			return tx.updateMany({
				model: "user",
				where: [
					{
						field: "email",
						operator: "eq",
						value: "staged-update@example.com",
					},
				],
				update: { name: "after" },
			});
		});
		expect(count).toBe(1);

		const users = await db
			.collection(TX_COLLECTIONS.users)
			.where("email", "==", "staged-update@example.com")
			.get();
		expect(users.size).toBe(1);
		expect(users.docs[0]?.data().name).toBe("after");
	});

	// The subtle half of the rate-limiter bug. better-auth's `incrementOne`
	// fallback appends `{field: "id", operator: "eq"}` to its compare-and-swap
	// guard. Firestore document IDs are metadata, not fields, so routing that
	// through `.where("id", "==", ...)` matches nothing — updateMany returned 0,
	// the CAS was read as "someone else won the race", and the limiter denied
	// every single request while never incrementing the counter.
	//
	// The transaction adapter is factory-wrapped, so the guard has to use a
	// field the `user` schema knows about: `createdAt` stands in for the
	// limiter's numeric range check.
	it("updateMany inside a transaction resolves an `id` condition as a doc ref, not a field", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({
			email: "cas@example.com",
			name: "before",
			createdAt: new Date("2030-01-01T00:00:00.000Z"),
		});

		const count = await adapter.transaction(async (tx: any) => {
			return tx.updateMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "cas@example.com" },
					{
						field: "createdAt",
						operator: "lt",
						value: new Date("2031-01-01T00:00:00.000Z"),
					},
					{ field: "id", operator: "eq", value: seedRef.id },
				],
				update: { name: "after" },
			});
		});
		expect(count).toBe(1);

		const after = await seedRef.get();
		expect(after.data()?.name).toBe("after");
		// Untouched fields survive the update mask.
		expect(after.data()?.email).toBe("cas@example.com");
	});

	it("updateMany with an `id` condition still honours the other conditions", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({
			email: "cas2@example.com",
			name: "before",
			createdAt: new Date("2030-01-01T00:00:00.000Z"),
		});

		const count = await adapter.transaction(async (tx: any) => {
			return tx.updateMany({
				model: "user",
				where: [
					// Guard fails: the row was created in 2030, not before 2020.
					{
						field: "createdAt",
						operator: "lt",
						value: new Date("2020-01-01T00:00:00.000Z"),
					},
					{ field: "id", operator: "eq", value: seedRef.id },
				],
				update: { name: "after" },
			});
		});
		expect(count).toBe(0);

		const after = await seedRef.get();
		expect(after.data()?.name).toBe("before");
	});

	it("updateMany with an `id` condition returns 0 for a missing doc", async () => {
		const count = await adapter.transaction(async (tx: any) => {
			return tx.updateMany({
				model: "user",
				where: [{ field: "id", operator: "eq", value: "does-not-exist" }],
				update: { name: "after" },
			});
		});
		expect(count).toBe(0);
	});

	it("updateMany inside a transaction skips docs already staged for delete", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "deleted@example.com", name: "before" });

		const count = await adapter.transaction(async (tx: any) => {
			await tx.deleteMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "deleted@example.com" },
				],
			});
			return tx.updateMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "deleted@example.com" },
				],
				update: { name: "after" },
			});
		});
		expect(count).toBe(0);

		const after = await seedRef.get();
		expect(after.exists).toBe(false);
	});

	it("updateMany inside a transaction is visible to a later read in the same transaction", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "ryw@example.com", name: "before" });

		const observed = await adapter.transaction(async (tx: any) => {
			await tx.updateMany({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "ryw@example.com" }],
				update: { name: "after" },
			});
			return tx.findOne({
				model: "user",
				where: [{ field: "email", operator: "eq", value: "ryw@example.com" }],
			});
		});
		expect(observed.name).toBe("after");
	});

	it("deleteMany inside a transaction removes all matching docs on flush", async () => {
		const seedRef1 = db.collection(TX_COLLECTIONS.users).doc();
		const seedRef2 = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef1.set({ email: "expire@example.com", name: "a" });
		await seedRef2.set({ email: "expire@example.com", name: "b" });

		const count = await adapter.transaction(async (tx: any) => {
			return tx.deleteMany({
				model: "user",
				where: [
					{ field: "email", operator: "eq", value: "expire@example.com" },
				],
			});
		});
		expect(count).toBe(2);

		const remaining = await db
			.collection(TX_COLLECTIONS.users)
			.where("email", "==", "expire@example.com")
			.get();
		expect(remaining.size).toBe(0);
	});

	it("deleteMany inside a transaction removes buffered creates matching where", async () => {
		const count = await adapter.transaction(async (tx: any) => {
			await tx.create({
				model: "user",
				data: { email: "buffered-delete@example.com", name: "Buffered" },
			});
			return tx.deleteMany({
				model: "user",
				where: [
					{
						field: "email",
						operator: "eq",
						value: "buffered-delete@example.com",
					},
				],
			});
		});
		expect(count).toBe(1);

		const users = await db
			.collection(TX_COLLECTIONS.users)
			.where("email", "==", "buffered-delete@example.com")
			.get();
		expect(users.size).toBe(0);
	});

	it("consumeVerificationValue-style flow works on the verification model inside a transaction", async () => {
		const identifier = "magic-link:test@example.com";
		const oldRef = db.collection(TX_COLLECTIONS.verificationTokens).doc();
		const newRef = db.collection(TX_COLLECTIONS.verificationTokens).doc();
		await oldRef.set({
			identifier,
			value: "old-token",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			createdAt: new Date("2030-01-01T00:00:00.000Z"),
		});
		await newRef.set({
			identifier,
			value: "new-token",
			expiresAt: new Date("2030-01-02T00:00:00.000Z"),
			createdAt: new Date("2030-01-02T00:00:00.000Z"),
		});

		const consumed = await adapter.transaction(async (tx: any) => {
			const where = [
				{ field: "identifier", operator: "eq", value: identifier },
			];
			const latest = (
				await tx.findMany({
					model: "verification",
					where,
					sortBy: { field: "createdAt", direction: "desc" },
					limit: 1,
				})
			)[0];
			expect(latest?.value).toBe("new-token");
			const row = await tx.consumeOne({
				model: "verification",
				where: [{ field: "id", operator: "eq", value: latest.id }],
			});
			await tx.deleteMany({ model: "verification", where });
			return row;
		});

		expect(consumed?.value).toBe("new-token");

		const remaining = await db
			.collection(TX_COLLECTIONS.verificationTokens)
			.where("identifier", "==", identifier)
			.get();
		expect(remaining.size).toBe(0);
	});

	it("native consumeOne deletes a matching Firestore doc", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "native-consume@example.com", name: "Native" });

		const consumed = await adapter.consumeOne({
			model: "user",
			where: [
				{ field: "email", operator: "eq", value: "native-consume@example.com" },
			],
		});
		expect(consumed?.name).toBe("Native");
		expect((await seedRef.get()).exists).toBe(false);
	});

	it("throwing after consumeOne inside the callback aborts the transaction (doc survives)", async () => {
		const seedRef = db.collection(TX_COLLECTIONS.users).doc();
		await seedRef.set({ email: "abort@example.com", name: "Abort" });

		await expect(
			adapter.transaction(async (tx: any) => {
				await tx.consumeOne({
					model: "user",
					where: [
						{ field: "email", operator: "eq", value: "abort@example.com" },
					],
				});
				throw new Error("intentional");
			}),
		).rejects.toThrow("intentional");

		const persisted = await seedRef.get();
		expect(persisted.exists).toBe(true);
	});
});

// The non-transactional `updateMany` carried the same latent flaw as the tx
// one: `id` routed through `.where("id", "==", ...)` matches nothing, because
// Firestore document IDs are metadata rather than a field. Nothing in
// better-auth exercised this path during the rate-limiter incident, but the
// silent no-op is identical.
describe("Non-transactional updateMany with an `id` condition", () => {
	const db = initFirestore({ name: "test-um", projectId: "test" });
	const UM_COLLECTIONS = {
		users: "um_users",
		sessions: "um_sessions",
		accounts: "um_accounts",
		verificationTokens: "um_verificationTokens",
	};
	const adapter = firestoreAdapter({
		firestore: db,
		collections: UM_COLLECTIONS,
	})({}) as any;

	afterEach(async () => {
		for (const col of Object.values(UM_COLLECTIONS)) {
			const snap = await db.collection(col).get();
			await Promise.all(snap.docs.map((d) => d.ref.delete()));
		}
	});

	it("resolves the `id` condition as a doc ref", async () => {
		const ref = db.collection(UM_COLLECTIONS.users).doc();
		await ref.set({ email: "um@example.com", name: "before" });

		const count = await adapter.updateMany({
			model: "user",
			where: [{ field: "id", operator: "eq", value: ref.id }],
			update: { name: "after" },
		});
		expect(count).toBe(1);
		expect((await ref.get()).data()?.name).toBe("after");
	});

	it("still honours the other conditions alongside `id`", async () => {
		const ref = db.collection(UM_COLLECTIONS.users).doc();
		await ref.set({ email: "um2@example.com", name: "before" });

		const count = await adapter.updateMany({
			model: "user",
			where: [
				// Guard fails: the row's email is um2@, not someone-else@.
				{ field: "email", operator: "eq", value: "someone-else@example.com" },
				{ field: "id", operator: "eq", value: ref.id },
			],
			update: { name: "after" },
		});
		expect(count).toBe(0);
		expect((await ref.get()).data()?.name).toBe("before");
	});
});
