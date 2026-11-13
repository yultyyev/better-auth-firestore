import { betterAuth } from "better-auth";
import type { Firestore } from "firebase-admin/firestore";
import { firestoreAdapter } from "../src";
import { initFirestore } from "../src/firestore";

// Better Auth 1.7.22 issues two where shapes this adapter used to send
// straight to Firestore, where they cannot work:
//
// - `{ field, operator: "eq", value: null }` (and `ne null`). The adapter
//   never writes `undefined`, so an optional field nobody set is *missing*
//   from the document, and Firestore's `== null` matches only fields that are
//   stored as null. `@better-auth/oauth-provider`'s `findConsent` looks
//   consents up with `referenceId == null` (every consent missed, so the user
//   was sent back to the consent screen forever); refresh-token rotation
//   guards its compare-and-swap with `revoked == null` (every refresh failed
//   and revoked the whole token family); device-code approval guards with
//   `userId == null`; `invalidateRefreshFamily` deletes with `refreshId != null`.
// - `id` conditions other than `eq`. The id is document metadata, not a
//   field, so `where("id", "!=", …)` matches nothing — and paired with
//   `createdAt <=` it is a multi-field inequality that needs a composite
//   index. `consumeVerificationValue` (password reset, magic links, OAuth
//   authorization codes) runs exactly that `deleteMany` inside its
//   transaction.
//
// Every assertion runs against the Firestore emulator, because the
// difference between a missing and a null field, and between a document id
// and a field named `id`, only exists there.

const COLLECTIONS = {
	users: "nq_users",
	sessions: "nq_sessions",
	accounts: "nq_accounts",
	verificationTokens: "nq_verifications",
};

const TOKEN_COLLECTION = "nq_tokens";

// One model with the optional fields the 1.7.22 call sites test for null:
// `referenceId` (oauthConsent), `revoked` / `refreshId` (oauthRefreshToken,
// oauthAccessToken) and `userId` + `status` (deviceCode).
const testSchemaPlugin = {
	id: "nq-test-schema",
	schema: {
		token: {
			modelName: TOKEN_COLLECTION,
			fields: {
				clientId: { type: "string", required: true },
				userId: { type: "string", required: false },
				referenceId: { type: "string", required: false },
				refreshId: { type: "string", required: false },
				status: { type: "string", required: false },
				revoked: { type: "date", required: false },
				createdAt: { type: "date", required: false },
			},
		},
	},
} as const;

async function clearAll(db: Firestore) {
	for (const name of [...Object.values(COLLECTIONS), TOKEN_COLLECTION]) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Wraps a Firestore instance so every `where()` the adapter sends to
 * Firestore is recorded as `field op`. Used to prove that the 1.7.22 where
 * shapes need no composite index: only equality filters leave the process.
 */
function recordingFirestore(db: Firestore, filters: string[]): Firestore {
	const wrapQuery = (q: any): any =>
		new Proxy(q, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function") return value;
				return (...args: any[]) => {
					if (prop === "where") filters.push(`${String(args[0])} ${args[1]}`);
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

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("`eq null` matches a missing field, `ne null` requires a value", () => {
	const db = initFirestore({ name: "test-null-conditions", projectId: "test" });
	const tokens = db.collection(TOKEN_COLLECTION);
	const adapter = firestoreAdapter({
		firestore: db,
		collections: COLLECTIONS,
	})({ plugins: [testSchemaPlugin] } as any) as any;

	/**
	 * Three rows for one client/user: `missing` has no `referenceId` (how the
	 * adapter stores an optional field nobody set, and how every consent
	 * written under 1.7.2 looks), `stored` holds an explicit null, `set` has a
	 * value.
	 */
	const seed = async () => {
		const missing = tokens.doc();
		const stored = tokens.doc();
		const set = tokens.doc();
		await missing.set({ clientId: "c1", userId: "u1" });
		await stored.set({ clientId: "c1", userId: "u1", referenceId: null });
		await set.set({ clientId: "c1", userId: "u1", referenceId: "org-1" });
		return { missing: missing.id, stored: stored.id, set: set.id };
	};

	const where = (operator: "eq" | "ne") => [
		{ field: "clientId", value: "c1" },
		{ field: "userId", value: "u1" },
		{ field: "referenceId", operator, value: null },
	];

	afterEach(async () => {
		await clearAll(db);
	});

	it("an optional field the caller left unset is not stored", async () => {
		const row = await adapter.create({
			model: "token",
			data: { clientId: "c1", userId: "u1" },
		});
		const raw = (await tokens.doc(row.id).get()).data() ?? {};
		expect("referenceId" in raw).toBe(false);
	});

	it("findOne, findMany and count (the oauth-provider findConsent shape)", async () => {
		const seeded = await seed();

		const consent = await adapter.findOne({
			model: "token",
			where: where("eq"),
		});
		expect([seeded.missing, seeded.stored]).toContain(consent?.id);
		expect(
			ids(await adapter.findMany({ model: "token", where: where("eq") })),
		).toEqual([seeded.missing, seeded.stored].sort());
		expect(await adapter.count({ model: "token", where: where("eq") })).toBe(2);

		expect(
			ids(await adapter.findMany({ model: "token", where: where("ne") })),
		).toEqual([seeded.set]);
		expect(await adapter.count({ model: "token", where: where("ne") })).toBe(1);
	});

	it("an undefined value behaves like null", async () => {
		const seeded = await seed();
		const rows = await adapter.findMany({
			model: "token",
			where: [
				{ field: "clientId", value: "c1" },
				{ field: "referenceId", value: undefined },
			],
		});
		expect(ids(rows)).toEqual([seeded.missing, seeded.stored].sort());
	});

	it("update, updateMany, delete, deleteMany and consumeOne", async () => {
		const seeded = await seed();

		expect(
			await adapter.updateMany({
				model: "token",
				where: where("eq"),
				update: { status: "touched" },
			}),
		).toBe(2);
		const touched = await adapter.findMany({
			model: "token",
			where: [{ field: "status", value: "touched" }],
		});
		expect(ids(touched)).toEqual([seeded.missing, seeded.stored].sort());

		const updated = await adapter.update({
			model: "token",
			where: where("ne"),
			update: { status: "only-set" },
		});
		expect(updated?.id).toBe(seeded.set);

		// `invalidateRefreshFamily` shape: deletes only the rows that carry a
		// value.
		expect(
			await adapter.deleteMany({ model: "token", where: where("ne") }),
		).toBe(1);
		expect((await tokens.doc(seeded.set).get()).exists).toBe(false);

		const consumed = await adapter.consumeOne({
			model: "token",
			where: where("eq"),
		});
		expect([seeded.missing, seeded.stored]).toContain(consumed?.id);

		await adapter.delete({ model: "token", where: where("eq") });
		expect(await adapter.count({ model: "token", where: where("eq") })).toBe(0);
	});

	it("incrementOne guards (refresh-token rotation and device-code approval shapes)", async () => {
		const refresh = tokens.doc();
		await refresh.set({ clientId: "c1", userId: "u1" });

		// oauth-provider rotates a refresh token with
		// `incrementOne([id, revoked == null], set: { revoked })`: the first call
		// wins, every later one must see the token as revoked.
		const rotate = () =>
			adapter.incrementOne({
				model: "token",
				where: [
					{ field: "id", value: refresh.id },
					{ field: "revoked", operator: "eq", value: null },
				],
				increment: {},
				set: { revoked: new Date() },
			});
		expect((await rotate())?.id).toBe(refresh.id);
		expect(await rotate()).toBeNull();

		// The device-authorization plugin binds the approving user with
		// `incrementOne([id, status == "pending", userId == null], set: { userId })`.
		const device = tokens.doc();
		await device.set({ clientId: "c1", status: "pending" });
		const approve = (userId: string) =>
			adapter.incrementOne({
				model: "token",
				where: [
					{ field: "id", value: device.id },
					{ field: "status", value: "pending" },
					{ field: "userId", operator: "eq", value: null },
				],
				increment: {},
				set: { userId },
			});
		expect((await approve("u1"))?.userId).toBe("u1");
		expect(await approve("u2")).toBeNull();
		expect((await device.get()).data()?.userId).toBe("u1");
	});

	it("inside a transaction, every method honours `eq null` / `ne null`", async () => {
		const seeded = await seed();

		await adapter.transaction(async (tx: any) => {
			expect([seeded.missing, seeded.stored]).toContain(
				(await tx.findOne({ model: "token", where: where("eq") }))?.id,
			);
			expect(
				ids(await tx.findMany({ model: "token", where: where("eq") })),
			).toEqual([seeded.missing, seeded.stored].sort());
			expect(await tx.count({ model: "token", where: where("ne") })).toBe(1);
			expect(
				await tx.updateMany({
					model: "token",
					where: where("eq"),
					update: { status: "tx" },
				}),
			).toBe(2);
			expect(
				(
					await tx.incrementOne({
						model: "token",
						where: [
							{ field: "id", value: seeded.missing },
							{ field: "revoked", operator: "eq", value: null },
						],
						increment: {},
						set: { revoked: new Date() },
					})
				)?.id,
			).toBe(seeded.missing);
			expect(await tx.deleteMany({ model: "token", where: where("ne") })).toBe(
				1,
			);
		});

		expect((await tokens.doc(seeded.set).get()).exists).toBe(false);
		expect((await tokens.doc(seeded.missing).get()).data()?.status).toBe("tx");
		expect((await tokens.doc(seeded.stored).get()).data()?.status).toBe("tx");
		expect(
			(await tokens.doc(seeded.missing).get()).data()?.revoked,
		).toBeTruthy();

		await adapter.transaction(async (tx: any) => {
			const consumed = await tx.consumeOne({
				model: "token",
				where: where("eq"),
			});
			expect([seeded.missing, seeded.stored]).toContain(consumed?.id);
			await tx.delete({ model: "token", where: where("eq") });
		});
		expect(await adapter.count({ model: "token", where: where("eq") })).toBe(0);
	});
});

describe("`id` conditions other than `eq` compare the document id", () => {
	const db = initFirestore({ name: "test-id-conditions", projectId: "test" });
	const tokens = db.collection(TOKEN_COLLECTION);
	const adapter = firestoreAdapter({
		firestore: db,
		collections: COLLECTIONS,
	})({ plugins: [testSchemaPlugin] } as any) as any;

	const seed = async () => {
		const refs = [tokens.doc(), tokens.doc(), tokens.doc()];
		await Promise.all(
			refs.map((ref, i) =>
				ref.set({
					clientId: "c1",
					createdAt: new Date(Date.UTC(2030, 0, i + 1)),
				}),
			),
		);
		return refs.map((ref) => ref.id) as [string, string, string];
	};

	afterEach(async () => {
		await clearAll(db);
	});

	it("consumeVerificationValue consumes the latest row and deletes the older ones (Better Auth 1.7.22)", async () => {
		const auth = betterAuth({
			database: firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
			secret: "test-secret-not-for-prod",
			baseURL: "http://localhost",
		});
		const ctx = await auth.$context;
		const identifier = "reset-password:nq-consume";
		const create = (value: string) =>
			ctx.internalAdapter.createVerificationValue({
				identifier,
				value,
				expiresAt: new Date(Date.now() + 60_000),
			});
		await create("older");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await create("latest");

		const consumed =
			await ctx.internalAdapter.consumeVerificationValue(identifier);
		expect(consumed?.value).toBe("latest");

		const left = await db
			.collection(COLLECTIONS.verificationTokens)
			.where("identifier", "==", identifier)
			.get();
		expect(left.size).toBe(0);
		expect(await ctx.internalAdapter.consumeVerificationValue(identifier)).toBe(
			null,
		);
	});

	it("`ne`, `not_in`, `in` and ranges on `id` work in every method", async () => {
		const [a, b, c] = await seed();
		const notA = [
			{ field: "clientId", value: "c1" },
			{ field: "id", operator: "ne", value: a },
		];

		expect(
			ids(await adapter.findMany({ model: "token", where: notA })),
		).toEqual([b, c].sort());
		expect(await adapter.count({ model: "token", where: notA })).toBe(2);
		expect(
			ids(
				await adapter.findMany({
					model: "token",
					where: [{ field: "id", operator: "not_in", value: [a, b] }],
				}),
			),
		).toEqual([c]);
		expect(
			await adapter.count({
				model: "token",
				where: [
					{ field: "id", operator: "in", value: [a, b] },
					{ field: "id", operator: "ne", value: b },
				],
			}),
		).toBe(1);
		const [lowest] = [a, b, c].sort();
		expect(
			await adapter.count({
				model: "token",
				where: [{ field: "id", operator: "gt", value: lowest }],
			}),
		).toBe(2);

		expect(
			(await adapter.findOne({ model: "token", where: notA }))?.id,
		).not.toBe(a);
		expect(
			await adapter.updateMany({
				model: "token",
				where: notA,
				update: { status: "not-a" },
			}),
		).toBe(2);
		expect((await tokens.doc(a).get()).data()?.status).toBeUndefined();

		// The consume cleanup shape: same identifier, not the latest row, created
		// no later than it.
		const cleanup = [
			{ field: "clientId", value: "c1" },
			{ field: "id", operator: "ne", value: c },
			{
				field: "createdAt",
				operator: "lte",
				value: new Date(Date.UTC(2030, 0, 3)),
			},
		];
		expect(await adapter.deleteMany({ model: "token", where: cleanup })).toBe(
			2,
		);
		expect(ids(await adapter.findMany({ model: "token", where: [] }))).toEqual([
			c,
		]);
	});

	it("inside a transaction, `id` conditions other than `eq` work in every method", async () => {
		const [a, b, c] = await seed();
		const notA = [
			{ field: "clientId", value: "c1" },
			{ field: "id", operator: "ne", value: a },
		];

		await adapter.transaction(async (tx: any) => {
			expect(ids(await tx.findMany({ model: "token", where: notA }))).toEqual(
				[b, c].sort(),
			);
			expect(
				ids(
					await tx.findMany({
						model: "token",
						where: [{ field: "id", operator: "in", value: [a, c] }],
					}),
				),
			).toEqual([a, c].sort());
			expect(await tx.count({ model: "token", where: notA })).toBe(2);
			expect((await tx.findOne({ model: "token", where: notA }))?.id).not.toBe(
				a,
			);
			expect(
				await tx.updateMany({
					model: "token",
					where: [{ field: "id", operator: "not_in", value: [a, b] }],
					update: { status: "only-c" },
				}),
			).toBe(1);
			expect(
				await tx.deleteMany({
					model: "token",
					where: [
						{ field: "clientId", value: "c1" },
						{ field: "id", operator: "ne", value: c },
						{
							field: "createdAt",
							operator: "lte",
							value: new Date(Date.UTC(2030, 0, 3)),
						},
					],
				}),
			).toBe(2);
		});

		expect((await tokens.doc(a).get()).exists).toBe(false);
		expect((await tokens.doc(b).get()).exists).toBe(false);
		expect((await tokens.doc(c).get()).data()?.status).toBe("only-c");
	});
});

describe("conditions checked in memory resolve configured field names", () => {
	const db = initFirestore({ name: "test-nq-fields", projectId: "test" });

	afterEach(async () => {
		await clearAll(db);
	});

	// `email_verified` is also one of the snake_case aliases the adapter
	// canonicalizes when it reads a document, so a row staged in a
	// transaction keeps the configured key while a row read from Firestore
	// carries the canonical one. A condition has to find the field in both.
	it("matches a field renamed to a snake_case alias, staged or stored", async () => {
		const auth = betterAuth({
			database: firestoreAdapter({ firestore: db, collections: COLLECTIONS }),
			user: { fields: { emailVerified: "email_verified" } },
			secret: "test-secret-not-for-prod",
			baseURL: "http://localhost",
		});
		const ctx = await auth.$context;
		const where = [
			{ field: "email", value: "alias@example.com" },
			{ field: "emailVerified", value: false },
		];

		const created = await ctx.adapter.transaction(async (tx) => {
			const user = await tx.create<{ id: string }>({
				model: "user",
				data: {
					name: "Alias",
					email: "alias@example.com",
					emailVerified: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			expect(
				(await tx.findOne<{ id: string }>({ model: "user", where }))?.id,
			).toBe(user.id);
			return user;
		});

		expect(
			(
				await ctx.adapter.findOne<{ id: string }>({
					model: "user",
					where: [{ field: "id", value: created.id }, ...where],
				})
			)?.id,
		).toBe(created.id);
	});
});

describe("the 1.7.22 where shapes need no composite index", () => {
	const db = initFirestore({ name: "test-nq-index", projectId: "test" });
	const filters: string[] = [];
	const adapter = firestoreAdapter({
		firestore: recordingFirestore(db, filters),
		collections: COLLECTIONS,
	})({ plugins: [testSchemaPlugin] } as any) as any;

	afterEach(async () => {
		await clearAll(db);
	});

	const sent = async (run: () => Promise<unknown>) => {
		filters.length = 0;
		await run();
		return [...filters];
	};

	it("sends only equality filters when a where list has one, and a lone range otherwise", async () => {
		const now = new Date();
		// consumeVerificationValue cleanup, inside its transaction.
		expect(
			await sent(() =>
				adapter.transaction((tx: any) =>
					tx.deleteMany({
						model: "verification",
						where: [
							{ field: "identifier", value: "x" },
							{ field: "id", operator: "ne", value: "latest" },
							{ field: "createdAt", operator: "lte", value: now },
						],
					}),
				),
			),
		).toEqual(["identifier =="]);
		// oauth-provider findConsent.
		expect(
			await sent(() =>
				adapter.findOne({
					model: "token",
					where: [
						{ field: "clientId", value: "c1" },
						{ field: "userId", value: "u1" },
						{ field: "referenceId", value: null },
					],
				}),
			),
		).toEqual(["clientId ==", "userId =="]);
		// oauth-provider invalidateRefreshFamily.
		expect(
			await sent(() =>
				adapter.deleteMany({
					model: "token",
					where: [
						{ field: "clientId", value: "c1" },
						{ field: "userId", value: "u1" },
						{ field: "refreshId", operator: "ne", value: null },
					],
				}),
			),
		).toEqual(["clientId ==", "userId =="]);
		// listSessions / endPreservedSessions: equality plus a range on another
		// field.
		expect(
			await sent(() =>
				adapter.findMany({
					model: "session",
					where: [
						{ field: "userId", value: "u1" },
						{ field: "expiresAt", operator: "gt", value: now },
					],
				}),
			),
		).toEqual(["userId =="]);
		expect(
			await sent(() =>
				adapter.updateMany({
					model: "session",
					where: [
						{ field: "token", value: "t1" },
						{ field: "expiresAt", operator: "gt", value: now },
					],
					update: { expiresAt: now },
				}),
			),
		).toEqual(["token =="]);
		// listSessions for several tokens.
		expect(
			await sent(() =>
				adapter.findMany({
					model: "session",
					where: [
						{ field: "token", operator: "in", value: ["t1", "t2"] },
						{ field: "expiresAt", operator: "gt", value: now },
					],
				}),
			),
		).toEqual(["token in"]);
		// The expired-verification sweep has no equality filter: one range on a
		// single field is served by Firestore's automatic index.
		expect(
			await sent(() =>
				adapter.deleteMany({
					model: "verification",
					where: [{ field: "expiresAt", operator: "lt", value: now }],
				}),
			),
		).toEqual(["expiresAt <"]);
	});
});
