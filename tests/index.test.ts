import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

type NamingStrategy = "snake_case" | "default";
type TestConfig = { namingStrategy: NamingStrategy };
type Adapter = ReturnType<ReturnType<typeof firestoreAdapter>>;

const configs: TestConfig[] = [
	{ namingStrategy: "snake_case" },
	{ namingStrategy: "default" },
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

		const collections =
			cfg.namingStrategy === "snake_case"
				? {
						users: "users_snake",
						sessions: "sessions_snake",
					}
				: {
						users: "users_default",
						sessions: "sessions_default",
					};

		const getAdapter = (): Adapter =>
			firestoreAdapter({
				firestore: db,
				namingStrategy: cfg.namingStrategy,
				debugLogs: false,
			})({});

		afterEach(async () => {
			await clearCollection(db, collections.users);
			await clearCollection(db, collections.sessions);
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
