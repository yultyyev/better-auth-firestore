import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// better-auth 1.7 made `incrementOne` a required adapter method and removed
// the `transaction(findMany + updateMany)` fallback that 1.6 used when an
// adapter didn't implement it. These tests pin down the native
// implementation's contract: `where` is both selector and guard, the row is
// mutated atomically only while the guard holds, and the updated row (or
// null) comes back.

const COLLECTIONS = {
	users: "inc_users",
	sessions: "inc_sessions",
	accounts: "inc_accounts",
	verificationTokens: "inc_verifications",
};

// A throwaway model so the guards can exercise number, date, and string
// fields through the real adapter factory (which validates models and
// drops `set` fields that aren't in the schema). Its `modelName` differs
// from the model key on purpose: every call below uses the key (`counter`)
// and must land in the mapped collection — inside transactions too, where
// `runWithTransaction` hands better-auth whatever our `transaction()`
// passes to its callback. A raw, unwrapped adapter there would have written
// to a `counter` collection instead.
const COUNTER_COLLECTION = "inc_counters";
const testSchemaPlugin = {
	id: "inc-test-schema",
	schema: {
		counter: {
			modelName: COUNTER_COLLECTION,
			fields: {
				key: { type: "string", required: true },
				count: { type: "number", required: false },
				lastRequest: { type: "number", required: false },
				lockedUntil: { type: "date", required: false },
				status: { type: "string", required: false },
			},
		},
	},
} as const;

const OPTIONS = { plugins: [testSchemaPlugin] };

// Note: the suite deliberately stays out of better-auth's shared `rateLimit`
// collection — `rate-limit.test.ts` runs in parallel against it.
async function clearAll(db: Firestore) {
	for (const name of [...Object.values(COLLECTIONS), COUNTER_COLLECTION]) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Wraps a Firestore instance so every `where()` operator the adapter sends
 * to Firestore is recorded. Used to prove the composite-index claim: only
 * equality filters leave the process, everything else is checked in memory.
 */
function recordingFirestore(db: Firestore, operators: string[]): Firestore {
	const wrapQuery = (q: any): any =>
		new Proxy(q, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function") return value;
				return (...args: any[]) => {
					if (prop === "where") operators.push(String(args[1]));
					const out = value.apply(target, args);
					return out && typeof out === "object" && "where" in out
						? wrapQuery(out)
						: out;
				};
			},
		});
	return new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			return (...args: any[]) => {
				const out = value.apply(target, args);
				return prop === "collection" ? wrapQuery(out) : out;
			};
		},
	}) as Firestore;
}

describe("incrementOne (native guarded counter mutation)", () => {
	const db = initFirestore({ name: "test-inc", projectId: "test" });
	const counters = db.collection(COUNTER_COLLECTION);

	const adapter = firestoreAdapter({
		firestore: db,
		collections: COLLECTIONS,
	})(OPTIONS as any) as any;

	afterEach(async () => {
		await clearAll(db);
	});

	it("increments a counter and applies `set` in one step, returning the updated row", async () => {
		await counters.doc("c1").set({ key: "c1", count: 1, status: "open" });

		const updated = await adapter.incrementOne({
			model: "counter",
			where: [{ field: "key", value: "c1" }],
			increment: { count: 1 },
			set: { status: "touched" },
		});

		expect(updated).toMatchObject({ id: "c1", count: 2, status: "touched" });
		const stored = (await counters.doc("c1").get()).data();
		expect(stored).toMatchObject({ key: "c1", count: 2, status: "touched" });
	});

	it("returns null and leaves the row untouched when the guard does not hold", async () => {
		await counters.doc("c2").set({ key: "c2", count: 3 });

		const result = await adapter.incrementOne({
			model: "counter",
			where: [
				{ field: "key", value: "c2" },
				{ field: "count", operator: "lt", value: 3 },
			],
			increment: { count: 1 },
		});

		expect(result).toBeNull();
		expect((await counters.doc("c2").get()).data()?.count).toBe(3);
	});

	it("treats a missing counter field as 0", async () => {
		// A row written before the counter existed — the two-factor lockout
		// relies on this for records that predate the column.
		await counters.doc("c3").set({ key: "c3" });

		const updated = await adapter.incrementOne({
			model: "counter",
			where: [{ field: "key", value: "c3" }],
			increment: { count: 1 },
		});

		expect(updated.count).toBe(1);
		expect((await counters.doc("c3").get()).data()?.count).toBe(1);
	});

	it("selects by `id` and still enforces the remaining guard", async () => {
		await counters.doc("c4").set({ key: "c4", count: 5 });

		const blocked = await adapter.incrementOne({
			model: "counter",
			where: [
				{ field: "id", value: "c4" },
				{ field: "count", operator: "lt", value: 5 },
			],
			increment: { count: 1 },
		});
		expect(blocked).toBeNull();

		const released = await adapter.incrementOne({
			model: "counter",
			where: [
				{ field: "id", value: "c4" },
				{ field: "count", operator: "gte", value: 2 },
			],
			increment: { count: -2 },
		});
		expect(released.count).toBe(3);
		expect((await counters.doc("c4").get()).data()?.count).toBe(3);
	});

	it("returns null for an `id` that does not exist", async () => {
		const result = await adapter.incrementOne({
			model: "counter",
			where: [{ field: "id", value: "missing" }],
			increment: { count: 1 },
		});
		expect(result).toBeNull();
	});

	it("compares date guards by instant and never matches a null field", async () => {
		const past = new Date(Date.now() - 60_000);
		await counters.doc("locked").set({ key: "locked", lockedUntil: past });
		await counters.doc("never").set({ key: "never", lockedUntil: null });

		// The expired lock is cleared …
		const cleared = await adapter.incrementOne({
			model: "counter",
			where: [
				{ field: "key", value: "locked" },
				{ field: "lockedUntil", operator: "lte", value: new Date() },
			],
			increment: {},
			set: { count: 0, lockedUntil: null },
		});
		expect(cleared).toMatchObject({ key: "locked", count: 0 });
		expect((await counters.doc("locked").get()).data()?.lockedUntil).toBeNull();

		// … but a row that was never locked must not satisfy `lockedUntil <=
		// now` (plain JS would coerce null to 0 and let it through).
		const untouched = await adapter.incrementOne({
			model: "counter",
			where: [
				{ field: "key", value: "never" },
				{ field: "lockedUntil", operator: "lte", value: new Date() },
			],
			increment: { count: 1 },
		});
		expect(untouched).toBeNull();
		expect((await counters.doc("never").get()).data()?.count).toBeUndefined();
	});

	it("sends only equality filters to Firestore, so the rate limiter needs no composite index", async () => {
		const operators: string[] = [];
		const recording = firestoreAdapter({
			firestore: recordingFirestore(db, operators),
			collections: COLLECTIONS,
		})(OPTIONS as any) as any;

		const now = Date.now();
		await counters
			.doc("rl1")
			.set({ key: "rl1", count: 1, lastRequest: now - 1_000 });

		// The exact shape better-auth's database rate limiter uses for the
		// in-window increment: one equality plus two range guards on other
		// fields. Pushed to Firestore as-is, that query needs a composite
		// index (`key`, `count`, `lastRequest`).
		const updated = await recording.incrementOne({
			model: "counter",
			where: [
				{ field: "key", value: "rl1" },
				{ field: "lastRequest", operator: "gt", value: now - 60_000 },
				{ field: "count", operator: "lt", value: 3 },
			],
			increment: { count: 1 },
			set: { lastRequest: now },
		});

		expect(updated).toMatchObject({ key: "rl1", count: 2, lastRequest: now });
		expect(operators).toEqual(["=="]);

		// Selecting by `id` issues no query at all — the doc is read directly.
		operators.length = 0;
		await counters.doc("c5").set({ key: "c5", count: 0 });
		await recording.incrementOne({
			model: "counter",
			where: [
				{ field: "id", value: "c5" },
				{ field: "count", operator: "lt", value: 10 },
			],
			increment: { count: 1 },
		});
		expect(operators).toEqual([]);
	});

	// Contending Firestore transactions retry with exponential backoff, so
	// even a handful take a few seconds in the emulator.
	it("serializes concurrent increments on the same row", async () => {
		await counters.doc("c6").set({ key: "c6", count: 0 });

		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				adapter.incrementOne({
					model: "counter",
					where: [
						{ field: "key", value: "c6" },
						{ field: "count", operator: "lt", value: 4 },
					],
					increment: { count: 1 },
				}),
			),
		);

		// Exactly four attempts win the guard; the rest observe it closed.
		expect(results.filter(Boolean)).toHaveLength(4);
		expect(results.filter((r) => r === null)).toHaveLength(2);
		expect((await counters.doc("c6").get()).data()?.count).toBe(4);
	}, 30_000);
});

describe("incrementOne / delete / count inside a transaction", () => {
	// `runWithTransaction` hands the (factory-wrapped) tx adapter to plugins
	// as the current adapter, so it needs the same atomic primitives — and
	// they have to cooperate with the write buffer (read-your-writes, one
	// write per ref at flush).
	const db = initFirestore({ name: "test-inc-tx", projectId: "test" });
	const counters = db.collection(COUNTER_COLLECTION);

	const adapter = firestoreAdapter({
		firestore: db,
		collections: COLLECTIONS,
	})(OPTIONS as any) as any;

	afterEach(async () => {
		await clearAll(db);
	});

	it("increments a row created earlier in the same transaction", async () => {
		const observed = await adapter.transaction(async (tx: any) => {
			const created = await tx.create({
				model: "counter",
				data: { key: "t1", count: 0 },
			});
			return tx.incrementOne({
				model: "counter",
				where: [{ field: "id", value: created.id }],
				increment: { count: 1 },
				set: { status: "seen" },
			});
		});

		expect(observed).toMatchObject({ key: "t1", count: 1, status: "seen" });
		const stored = (await counters.doc(observed.id).get()).data();
		expect(stored).toMatchObject({ key: "t1", count: 1, status: "seen" });
	});

	it("stages the increment so later reads in the transaction observe it, and commits it", async () => {
		await counters.doc("t2").set({ key: "t2", count: 1 });

		const seen = await adapter.transaction(async (tx: any) => {
			const first = await tx.incrementOne({
				model: "counter",
				where: [{ field: "key", value: "t2" }],
				increment: { count: 1 },
			});
			const second = await tx.incrementOne({
				model: "counter",
				where: [
					{ field: "key", value: "t2" },
					{ field: "count", operator: "lt", value: 5 },
				],
				increment: { count: 1 },
			});
			const read = await tx.findOne({
				model: "counter",
				where: [{ field: "key", value: "t2" }],
			});
			return { first: first.count, second: second.count, read: read.count };
		});

		expect(seen).toEqual({ first: 2, second: 3, read: 3 });
		expect((await counters.doc("t2").get()).data()?.count).toBe(3);
	});

	it("returns null without staging anything when the guard does not hold", async () => {
		await counters.doc("t3").set({ key: "t3", count: 3 });

		const result = await adapter.transaction(async (tx: any) => {
			return tx.incrementOne({
				model: "counter",
				where: [
					{ field: "key", value: "t3" },
					{ field: "count", operator: "lt", value: 3 },
				],
				increment: { count: 1 },
			});
		});

		expect(result).toBeNull();
		expect((await counters.doc("t3").get()).data()?.count).toBe(3);
	});

	it("does not resurrect a row deleted earlier in the transaction", async () => {
		await counters.doc("t4").set({ key: "t4", count: 1 });

		const result = await adapter.transaction(async (tx: any) => {
			await tx.deleteMany({
				model: "counter",
				where: [{ field: "key", value: "t4" }],
			});
			return tx.incrementOne({
				model: "counter",
				where: [{ field: "key", value: "t4" }],
				increment: { count: 1 },
			});
		});

		expect(result).toBeNull();
		expect((await counters.doc("t4").get()).exists).toBe(false);
	});

	it("`delete` removes a single row at commit and hides it from later reads", async () => {
		await counters.doc("t5").set({ key: "t5", count: 1 });

		const readBack = await adapter.transaction(async (tx: any) => {
			await tx.delete({
				model: "counter",
				where: [{ field: "key", value: "t5" }],
			});
			return tx.findOne({
				model: "counter",
				where: [{ field: "key", value: "t5" }],
			});
		});

		expect(readBack).toBeNull();
		expect((await counters.doc("t5").get()).exists).toBe(false);
	});

	it("`count` includes staged creates and excludes staged deletes", async () => {
		await counters.doc("t6a").set({ key: "t6", count: 1 });
		await counters.doc("t6b").set({ key: "t6", count: 2 });

		const counted = await adapter.transaction(async (tx: any) => {
			const before = await tx.count({
				model: "counter",
				where: [{ field: "key", value: "t6" }],
			});
			await tx.create({ model: "counter", data: { key: "t6", count: 3 } });
			await tx.delete({
				model: "counter",
				where: [{ field: "id", value: "t6a" }],
			});
			const after = await tx.count({
				model: "counter",
				where: [{ field: "key", value: "t6" }],
			});
			return { before, after };
		});

		expect(counted).toEqual({ before: 2, after: 2 });
		const remaining = await counters.where("key", "==", "t6").get();
		expect(remaining.size).toBe(2);
		expect(remaining.docs.map((d) => d.id)).not.toContain("t6a");
	});
});
