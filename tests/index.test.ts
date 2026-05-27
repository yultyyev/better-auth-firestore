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
				where: [
					{ field: "email", operator: "eq", value: "tx3@example.com" },
				],
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
					expires: new Date("2030-01-01T00:00:00.000Z"),
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
});
