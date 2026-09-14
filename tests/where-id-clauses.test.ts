import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// Firestore document IDs are metadata, not fields, so `where("id", "==", …)`
// matches nothing. better-auth pairs an `id` clause with other conditions and
// expects every clause to be honoured — `consumeOne` on a device code
// (`id`, `clientId`, `status`), the organization plugin's `findTeamById`
// (`id`, `organizationId`), `findMany` with `id in […]` plus a range. Only
// `updateMany` and `incrementOne` used to resolve the id by ref and check the
// rest in memory; every other method either matched nothing or ignored the
// remaining clauses.

const COLLECTIONS = {
	users: "wi_users",
	sessions: "wi_sessions",
	accounts: "wi_accounts",
	verificationTokens: "wi_verifications",
};

async function clearAll(db: Firestore) {
	for (const name of Object.values(COLLECTIONS)) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

describe("where clauses that combine `id` with other conditions", () => {
	const db = initFirestore({ name: "test-where-id", projectId: "test" });

	const auth = betterAuth({
		database: firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
		emailAndPassword: { enabled: true },
		secret: "test-secret-not-for-prod",
		baseURL: "http://localhost",
	});

	const create = async (
		identifier: string,
		value: string,
		expiresInMs = 60_000,
	) => {
		const ctx = await auth.$context;
		return ctx.adapter.create<{ id: string }>({
			model: "verification",
			data: {
				identifier,
				value,
				expiresAt: new Date(Date.now() + expiresInMs),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
	};

	afterEach(async () => {
		await clearAll(db);
	});

	it("consumeOne matches only when every clause holds (device-code shape)", async () => {
		const ctx = await auth.$context;
		const row = await create("device-code", "approved");
		const where = (value: string) => [
			{ field: "id", value: row.id },
			{ field: "identifier", value: "device-code" },
			{ field: "value", value },
		];

		expect(
			await ctx.adapter.consumeOne({
				model: "verification",
				where: where("pending"),
			}),
		).toBeNull();
		expect(
			(
				await ctx.adapter.consumeOne<{ id: string }>({
					model: "verification",
					where: where("approved"),
				})
			)?.id,
		).toBe(row.id);
		expect(
			await ctx.adapter.findOne({
				model: "verification",
				where: [{ field: "id", value: row.id }],
			}),
		).toBeNull();
	});

	it("findOne, count, findMany, update and delete honour the extra clause", async () => {
		const ctx = await auth.$context;
		const row = await create("team-shape", "v");
		const miss = [
			{ field: "id", value: row.id },
			{ field: "identifier", value: "other-org" },
		];
		const hit = [
			{ field: "id", value: row.id },
			{ field: "identifier", value: "team-shape" },
		];

		expect(
			await ctx.adapter.findOne({ model: "verification", where: miss }),
		).toBeNull();
		expect(
			await ctx.adapter.count({ model: "verification", where: miss }),
		).toBe(0);
		expect(
			await ctx.adapter.findMany({ model: "verification", where: miss }),
		).toEqual([]);
		expect(
			await ctx.adapter.update({
				model: "verification",
				where: miss,
				update: { value: "changed" },
			}),
		).toBeNull();
		await ctx.adapter.delete({ model: "verification", where: miss });
		expect(
			await ctx.adapter.deleteMany({ model: "verification", where: miss }),
		).toBe(0);

		expect(
			(
				await ctx.adapter.findOne<{ id: string }>({
					model: "verification",
					where: hit,
				})
			)?.id,
		).toBe(row.id);
		expect(await ctx.adapter.count({ model: "verification", where: hit })).toBe(
			1,
		);
		expect(
			(
				await ctx.adapter.findMany<{ id: string }>({
					model: "verification",
					where: hit,
				})
			).map((r) => r.id),
		).toEqual([row.id]);
		expect(
			(
				await ctx.adapter.update<{ value: string }>({
					model: "verification",
					where: hit,
					update: { value: "changed" },
				})
			)?.value,
		).toBe("changed");
		expect(
			await ctx.adapter.deleteMany({ model: "verification", where: hit }),
		).toBe(1);
		expect(
			await ctx.adapter.findOne({
				model: "verification",
				where: [{ field: "id", value: row.id }],
			}),
		).toBeNull();
	});

	it("delete with an extra clause removes the document only when it matches", async () => {
		const ctx = await auth.$context;
		const row = await create("delete-shape", "v");
		await ctx.adapter.delete({
			model: "verification",
			where: [
				{ field: "id", value: row.id },
				{ field: "identifier", value: "other" },
			],
		});
		expect(
			await ctx.adapter.findOne({
				model: "verification",
				where: [{ field: "id", value: row.id }],
			}),
		).not.toBeNull();
		await ctx.adapter.delete({
			model: "verification",
			where: [
				{ field: "id", value: row.id },
				{ field: "identifier", value: "delete-shape" },
			],
		});
		expect(
			await ctx.adapter.findOne({
				model: "verification",
				where: [{ field: "id", value: row.id }],
			}),
		).toBeNull();
	});

	it("findMany and count with `id in` apply every operator of the remaining clauses", async () => {
		const ctx = await auth.$context;
		const live = await create("live", "v", 60_000);
		const expired = await create("expired", "v", -60_000);
		const where = [
			{ field: "id", operator: "in" as const, value: [live.id, expired.id] },
			{ field: "expiresAt", operator: "gt" as const, value: new Date() },
		];
		expect(
			(
				await ctx.adapter.findMany<{ id: string }>({
					model: "verification",
					where,
				})
			).map((r) => r.id),
		).toEqual([live.id]);
		expect(await ctx.adapter.count({ model: "verification", where })).toBe(1);
	});

	it("inside a transaction, findOne, update, delete and consumeOne honour the extra clause", async () => {
		const ctx = await auth.$context;
		const row = await create("tx-shape", "v");
		const miss = [
			{ field: "id", value: row.id },
			{ field: "identifier", value: "other" },
		];
		const hit = [
			{ field: "id", value: row.id },
			{ field: "identifier", value: "tx-shape" },
		];
		await ctx.adapter.transaction(async (tx) => {
			expect(
				await tx.findOne({ model: "verification", where: miss }),
			).toBeNull();
			expect(
				await tx.update({
					model: "verification",
					where: miss,
					update: { value: "x" },
				}),
			).toBeNull();
			expect(
				await tx.consumeOne({ model: "verification", where: miss }),
			).toBeNull();
			expect(
				(
					await tx.findOne<{ id: string }>({
						model: "verification",
						where: hit,
					})
				)?.id,
			).toBe(row.id);
			expect(
				(
					await tx.consumeOne<{ id: string }>({
						model: "verification",
						where: hit,
					})
				)?.id,
			).toBe(row.id);
		});
		expect(
			await ctx.adapter.findOne({
				model: "verification",
				where: [{ field: "id", value: row.id }],
			}),
		).toBeNull();
	});
});
