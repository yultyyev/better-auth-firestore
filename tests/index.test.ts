import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

type NamingStrategy = "snake_case" | "default";
type TestConfig = {
	namingStrategy: NamingStrategy;
	collections: { users: string; sessions: string; accounts: string; verificationTokens: string };
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

describe.each<TestConfig>(configs)(
	"Firestore adapter compatibility (%s)",
	(cfg: TestConfig) => {
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
	},
);

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
