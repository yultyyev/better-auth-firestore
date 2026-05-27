import {
	createAdapterFactory,
	type DBAdapterDebugLogOption,
} from "better-auth/adapters";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { initFirestore } from "./firestore.js";
import type { FirestoreAdapterConfig, NamingStrategy } from "./types.js";

type CollectionsOverride = NonNullable<FirestoreAdapterConfig["collections"]>;

type FieldMapper = {
	toDb: (field: string) => string;
	fromDb: (field: string) => string;
};

const MAP_TO_FIRESTORE: Record<string, string | undefined> = {
	userId: "user_id",
	sessionToken: "session_token",
	providerAccountId: "provider_account_id",
	emailVerified: "email_verified",
};

const MAP_FROM_FIRESTORE: Record<string, string | undefined> =
	Object.fromEntries(Object.entries(MAP_TO_FIRESTORE).map(([k, v]) => [v!, k]));

const identity = <T>(x: T) => x;

const DB_TO_CANONICAL_FIELD: Record<string, string> = {
	user_id: "userId",
	session_token: "sessionToken",
	provider_account_id: "providerAccountId",
	email_verified: "emailVerified",
};

function canonicalizeFieldName(field: string): string {
	return DB_TO_CANONICAL_FIELD[field] ?? field;
}

function mapFieldsFactory(preferSnakeCase?: boolean): FieldMapper {
	if (preferSnakeCase) {
		return {
			toDb: (field: string) => {
				const canonical = canonicalizeFieldName(field);
				return MAP_TO_FIRESTORE[canonical] ?? canonical;
			},
			fromDb: (field: string) => MAP_FROM_FIRESTORE[field] ?? field,
		};
	}
	return {
		toDb: (field: string) => canonicalizeFieldName(field),
		fromDb: (field: string) => MAP_FROM_FIRESTORE[field] ?? field,
	} as FieldMapper;
}

type WhereCondition = {
	field: string;
	operator?: string;
	value: any;
	connector?: "AND" | "OR";
};

/**
 * Firestore caps the `IN` operator at 30 comparison values. When a `where`
 * clause passes more than this, queries throw with
 * `INVALID_ARGUMENT: 'IN' supports up to 30 comparison values.`
 * We split oversized IN values into chunks of this size in both `deleteMany`
 * and the regular `findMany` path and merge results.
 * https://firebase.google.com/docs/firestore/query-data/queries#query_limitations
 */
const FIRESTORE_IN_CHUNK_SIZE = 30;

type OversizedInClause = WhereCondition & {
	operator: "in";
	value: readonly unknown[];
};

/**
 * Narrows a where clause to an `in` condition whose value array exceeds
 * Firestore's 30-value cap. Used by query methods to trigger chunked
 * sub-queries.
 */
function findOversizedInClause(
	where: WhereCondition[] | undefined,
): OversizedInClause | undefined {
	return (where ?? []).find(
		(w): w is OversizedInClause =>
			w.operator === "in" &&
			Array.isArray(w.value) &&
			w.value.length > FIRESTORE_IN_CHUNK_SIZE,
	);
}

function getChunkedWhereClauses(
	where: WhereCondition[] | undefined,
): (WhereCondition[] | undefined)[] {
	const oversized = findOversizedInClause(where);
	if (!oversized || !where) {
		return [where];
	}

	const chunkedClauses: WhereCondition[][] = [];
	for (let i = 0; i < oversized.value.length; i += FIRESTORE_IN_CHUNK_SIZE) {
		const chunk = oversized.value.slice(i, i + FIRESTORE_IN_CHUNK_SIZE);
		chunkedClauses.push(
			where.map((w) =>
				w === oversized ? { ...w, value: chunk as WhereCondition["value"] } : w,
			),
		);
	}

	return chunkedClauses;
}

function resolveDb(config?: FirestoreAdapterConfig | Firestore): Firestore {
	if (!config) return initFirestore();
	if ((config as Firestore).collection) return config as Firestore;
	const cfg = config as FirestoreAdapterConfig;
	if (cfg.firestore) return cfg.firestore;
	return initFirestore(cfg);
}

/**
 * Resolves collection names based on naming strategy and overrides.
 */
function resolveCollectionNames(
	namingStrategy?: NamingStrategy,
	overrides?: CollectionsOverride,
) {
	const snake = namingStrategy === "snake_case";
	return {
		users: overrides?.users ?? "users",
		sessions: overrides?.sessions ?? "sessions",
		accounts: overrides?.accounts ?? "accounts",
		verificationTokens:
			overrides?.verificationTokens ??
			(snake ? "verification_tokens" : "verificationTokens"),
	};
}

function convertTimestamp(value: any): any {
	if (value instanceof Timestamp) return value.toDate();
	if (Array.isArray(value)) return value.map(convertTimestamp);
	if (value && typeof value === "object" && value.constructor === Object) {
		const result: any = {};
		for (const [k, v] of Object.entries(value)) {
			result[k] = convertTimestamp(v);
		}
		return result;
	}
	return value;
}

function getCollectionRef(
	db: Firestore,
	model: string,
	collections: ReturnType<typeof resolveCollectionNames>,
) {
	const normalized = model.toLowerCase().replace(/s$/, "");
	if (normalized === "user") return db.collection(collections.users);
	if (normalized === "session") return db.collection(collections.sessions);
	if (normalized === "account") return db.collection(collections.accounts);
	if (normalized === "verificationtoken")
		return db.collection(collections.verificationTokens);
	return db.collection(model);
}

function applyWhereClause(
	query: FirebaseFirestore.Query,
	where?: WhereCondition[],
	mapper?: ReturnType<typeof mapFieldsFactory>,
): FirebaseFirestore.Query {
	if (!where || where.length === 0) return query;
	const mapperFn = mapper?.toDb || ((x: string) => x);

	if (where.length === 1) {
		const w = where[0];
		if (!w) return query;
		const fieldName = mapperFn(w.field);
		const op = w.operator || "eq";
		return applyOperator(query, fieldName, op, w.value);
	}

	const andConditions = where.filter(
		(w) => w.connector === "AND" || !w.connector,
	);
	// Filter out operators that need client-side processing (they'll be handled later)
	const firestoreConditions = andConditions.filter((w) => {
		const op = (w.operator || "eq") as string;
		return (
			op !== "notIn" &&
			op !== "not_in" &&
			op !== "endsWith" &&
			op !== "ends-with" &&
			op !== "ends_with" &&
			op !== "contains"
		);
	});
	let q = query;
	for (const w of firestoreConditions) {
		const fieldName = mapperFn(w.field);
		const op = w.operator || "eq";
		q = applyOperator(q, fieldName, op, w.value);
	}

	return q;
}

function applyOperator(
	query: FirebaseFirestore.Query,
	field: string,
	operator: string,
	value: any,
): FirebaseFirestore.Query {
	switch (operator) {
		case "eq":
		case "==":
			return query.where(field, "==", value);
		case "ne":
		case "!=":
			return query.where(field, "!=", value);
		case "in":
			return query.where(field, "in", Array.isArray(value) ? value : [value]);
		case "notIn":
		case "not_in":
			return query;
		case "contains":
		case "array-contains":
			// Only use array-contains if we're sure it's an array field
			// For string fields, we'll need client-side filtering
			return query.where(field, "array-contains", value);
		case "startsWith":
		case "starts-with":
		case "starts_with": {
			return query
				.where(field, ">=", value)
				.where(field, "<", value + "\uf8ff");
		}
		case "endsWith":
		case "ends-with":
		case "ends_with":
			return query;
		case "gt":
			return query.where(field, ">", value);
		case "gte":
			return query.where(field, ">=", value);
		case "lt":
			return query.where(field, "<", value);
		case "lte":
			return query.where(field, "<=", value);
		default:
			return query.where(field, "==", value);
	}
}

function isDocumentReferenceLike(value: unknown): value is { id: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof (value as { id: unknown }).id === "string" &&
		"path" in value &&
		typeof (value as { path: unknown }).path === "string"
	);
}

function normalizeSessionWriteData(data: Record<string, any>): Record<string, any> {
	const { user_id, session_token, ...rest } = data;
	const normalized: Record<string, any> = { ...rest };

	const userIdValue = normalized.userId ?? user_id;
	if (typeof userIdValue === "string") {
		normalized.userId = userIdValue;
	} else if (isDocumentReferenceLike(userIdValue)) {
		normalized.userId = userIdValue.id;
	}

	const sessionTokenValue = normalized.sessionToken ?? session_token;
	if (typeof sessionTokenValue === "string") {
		normalized.sessionToken = sessionTokenValue;
	}

	return normalized;
}

function normalizeWriteData(model: string, data: Record<string, any>): Record<string, any> {
	const normalizedModel = model.toLowerCase().replace(/s$/, "");
	if (normalizedModel !== "session") return data;
	return normalizeSessionWriteData(data);
}

/**
 * Build a Firestore-safe write payload from a normalized data object.
 *
 * - Maps app field names to their Firestore-side names via `mapper`.
 * - Skips `undefined` values. The Firestore Admin SDK rejects writes that
 *   contain `undefined` unless the client was initialized with
 *   `ignoreUndefinedProperties: true`, and better-auth routinely emits
 *   optional-undefined fields (e.g. `image` on email/password sign-up).
 *   Stripping here lets the adapter work with any user-supplied Firestore
 *   instance, not just ones we initialize.
 * - Routes a string `id` field out as `idOverride` so create callers can
 *   set it on the document reference instead of writing it into the body.
 *   For updates the caller can simply ignore `idOverride` — you cannot
 *   change a Firestore document ID by writing to a field.
 *
 * `null` is preserved deliberately: Firestore accepts null and callers may
 * use it to explicitly clear a field.
 */
function buildFirestoreWriteData(
	data: Record<string, any>,
	mapper: FieldMapper,
): { docData: Record<string, any>; idOverride: string | undefined } {
	const docData: Record<string, any> = {};
	let idOverride: string | undefined;
	for (const [k, v] of Object.entries(data)) {
		if (v === undefined) continue;
		if (k === "id") {
			if (typeof v === "string" && v) idOverride = v;
			continue;
		}
		docData[mapper.toDb(k)] = v;
	}
	return { docData, idOverride };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction write buffer (per-transaction)
// ─────────────────────────────────────────────────────────────────────────────
// Firestore requires every `transaction.get` to complete before any
// `transaction.set` / `update` / `delete`. Better-auth interleaves them
// freely — a typical sign-up runs `create(user)` → `findOne(session)` →
// `create(session)` inside one transaction. We satisfy Firestore's rule by
// deferring every staged write until after the user callback resolves;
// reads in the meantime overlay matching buffered docs so the callback
// observes its own writes (transactional read-your-writes semantics).
//
// Operations also merge in place: `create` + `update` on the same ref
// collapses to a single `set` at flush time, and `update` + `update`
// collapses to a single merged `update`. The buffer is constructed inside
// `runTransaction`, so Firestore's automatic retries on contention get a
// fresh buffer each pass.
//
// Read overlay is best-effort: `matchesWhere` covers the operators
// better-auth uses inside transactions (eq, ne, in, notIn, gt(e), lt(e),
// contains, startsWith, endsWith, plus AND/OR connectors). Exotic
// operators fall through to a real `transaction.get`, which won't see
// buffered docs of the same model — in practice better-auth never
// generates such clauses inside its tx callbacks.

type TxBufferOp = "create" | "update";

interface TxBufferEntry {
	op: TxBufferOp;
	model: string;
	ref: FirebaseFirestore.DocumentReference;
	/**
	 * Payload for flushing: full doc body (create) or update mask (update).
	 * Keys are db-side field names — ready to hand straight to
	 * `transaction.set` / `transaction.update`.
	 */
	docData: Record<string, any>;
	/**
	 * Full app-visible representation of the doc including `id`. Keys are
	 * canonical app-side field names. Used to overlay subsequent reads.
	 */
	appData: Record<string, any>;
}

class TxBuffer {
	private byPath = new Map<string, TxBufferEntry>();

	/** Stage a create. Returns the entry so the caller can read back `appData.id`. */
	stageCreate(
		model: string,
		ref: FirebaseFirestore.DocumentReference,
		docData: Record<string, any>,
		appNormalized: Record<string, any>,
	): TxBufferEntry {
		const entry: TxBufferEntry = {
			op: "create",
			model,
			ref,
			docData: { ...docData },
			appData: { ...appNormalized, id: ref.id },
		};
		this.byPath.set(ref.path, entry);
		return entry;
	}

	/**
	 * Stage an update on `ref`. If a prior entry exists for the same ref —
	 * regardless of whether it was a create or update — merge in place so
	 * the flush emits one combined write. `baseAppData` provides the
	 * pre-update fields needed to build a full app-visible state for
	 * subsequent read overlays.
	 */
	stageUpdate(
		model: string,
		ref: FirebaseFirestore.DocumentReference,
		updateDocData: Record<string, any>,
		updateAppData: Record<string, any>,
		baseAppData: Record<string, any>,
	): TxBufferEntry {
		const existing = this.byPath.get(ref.path);
		if (existing) {
			Object.assign(existing.docData, updateDocData);
			Object.assign(existing.appData, updateAppData);
			return existing;
		}
		const entry: TxBufferEntry = {
			op: "update",
			model,
			ref,
			docData: { ...updateDocData },
			appData: { ...baseAppData, ...updateAppData, id: ref.id },
		};
		this.byPath.set(ref.path, entry);
		return entry;
	}

	/** First buffered create for `model` whose appData satisfies `where`. */
	findCreateMatching(
		model: string,
		where: WhereCondition[] | undefined,
	): TxBufferEntry | undefined {
		for (const entry of this.byPath.values()) {
			if (entry.op !== "create" || entry.model !== model) continue;
			if (matchesWhere(entry.appData, where)) return entry;
		}
		return undefined;
	}

	/** Buffered entry (create or update) for a specific ref path, if any. */
	getByPath(refPath: string): TxBufferEntry | undefined {
		return this.byPath.get(refPath);
	}

	/** Replay every staged write onto the transaction in insertion order. */
	flush(transaction: Transaction): void {
		for (const entry of this.byPath.values()) {
			if (entry.op === "create") transaction.set(entry.ref, entry.docData);
			else transaction.update(entry.ref, entry.docData);
		}
	}
}

/**
 * Evaluates a where clause against an in-memory app-side doc. AND-within-
 * group, OR-between-groups (a new group starts at every `connector: "OR"`).
 * Unknown operators fall back to equality — see TxBuffer header for the
 * supported set.
 */
function matchesWhere(
	appData: Record<string, any>,
	where: WhereCondition[] | undefined,
): boolean {
	if (!where || where.length === 0) return true;
	const groups: WhereCondition[][] = [];
	let current: WhereCondition[] = [];
	for (const cond of where) {
		if (cond.connector === "OR" && current.length > 0) {
			groups.push(current);
			current = [cond];
		} else {
			current.push(cond);
		}
	}
	if (current.length > 0) groups.push(current);
	return groups.some((group) =>
		group.every((cond) => matchesCondition(appData, cond)),
	);
}

function matchesCondition(
	appData: Record<string, any>,
	cond: WhereCondition,
): boolean {
	const val = appData[cond.field];
	const op = (cond.operator || "eq") as string;
	switch (op) {
		case "eq":
		case "==":
			return val === cond.value;
		case "ne":
		case "!=":
			return val !== cond.value;
		case "in":
			return Array.isArray(cond.value)
				? cond.value.includes(val)
				: val === cond.value;
		case "notIn":
		case "not_in":
			return Array.isArray(cond.value)
				? !cond.value.includes(val)
				: val !== cond.value;
		case "gt":
			return val > cond.value;
		case "gte":
			return val >= cond.value;
		case "lt":
			return val < cond.value;
		case "lte":
			return val <= cond.value;
		case "contains":
		case "array-contains":
			if (Array.isArray(val)) return val.includes(cond.value);
			if (typeof val === "string") return val.includes(String(cond.value));
			return false;
		case "startsWith":
		case "starts-with":
		case "starts_with":
			return typeof val === "string" && val.startsWith(String(cond.value));
		case "endsWith":
		case "ends-with":
		case "ends_with":
			return typeof val === "string" && val.endsWith(String(cond.value));
		default:
			return val === cond.value;
	}
}

/**
 * Look up a single doc inside a transaction, mirroring the non-tx
 * findOne/update path. Special-cases `id eq value` to use `col.doc(id)`
 * because Firestore document IDs are metadata, not fields — they can't
 * be queried with `.where("id", ...)`. Returns undefined when nothing
 * matches.
 */
async function lookupTxDoc(
	transaction: Transaction,
	col: FirebaseFirestore.CollectionReference,
	where: WhereCondition[] | undefined,
	mapper: FieldMapper,
): Promise<FirebaseFirestore.DocumentSnapshot | undefined> {
	if (
		where &&
		where.length === 1 &&
		where[0]?.field === "id" &&
		(where[0]?.operator === "eq" || !where[0]?.operator)
	) {
		const docRef = col.doc(where[0].value as string);
		const snap = await transaction.get(docRef);
		return snap.exists ? snap : undefined;
	}
	for (const whereClause of getChunkedWhereClauses(where)) {
		const q = applyWhereClause(col, whereClause, mapper);
		const snap = await transaction.get(q.limit(1));
		if (snap.docs[0]) return snap.docs[0];
	}
	return undefined;
}

/** Convert a Firestore document body (db-side keys, Timestamps) to app shape. */
function dbDataToAppData(
	data: Record<string, any>,
	mapper: FieldMapper,
): Record<string, any> {
	const result: Record<string, any> = {};
	for (const [k, v] of Object.entries(data)) {
		if (k === "__name__") continue;
		result[mapper.fromDb(k)] = convertTimestamp(v);
	}
	return result;
}

export interface FirestoreAdapterOptions
	extends Omit<FirestoreAdapterConfig, "firestore"> {
	firestore?: Firestore;
	debugLogs?: DBAdapterDebugLogOption;
}

export const firestoreAdapter: (
	config?: FirestoreAdapterOptions | Firestore,
) => ReturnType<typeof createAdapterFactory> = (
	config: FirestoreAdapterOptions | Firestore = {},
) => {
	const db = resolveDb(config as any);
	const {
		namingStrategy = "default",
		collections: collectionsOverride = {},
		debugLogs = false,
	} = ((config as FirestoreAdapterOptions) && (config as any).collection
		? {}
		: (config as FirestoreAdapterOptions)) || {};

	const preferSnakeCase = namingStrategy === "snake_case";
	const collections = resolveCollectionNames(
		namingStrategy,
		collectionsOverride,
	);
	const mapper = mapFieldsFactory(preferSnakeCase);

	return createAdapterFactory({
		config: {
			adapterId: "firestore",
			adapterName: "Firestore Adapter",
			supportsJSON: true,
			supportsDates: true,
			supportsBooleans: true,
			supportsNumericIds: false,
			debugLogs,
			transaction: async (run) => {
				return await db.runTransaction(async (transaction: Transaction) => {
					const buffer = new TxBuffer();

					const txAdapter = {
						create: async ({ model, data }: any) => {
							const col = getCollectionRef(db, model, collections);
							const normalizedData = normalizeWriteData(model, data);
							const { docData, idOverride } = buildFirestoreWriteData(
								normalizedData,
								mapper,
							);
							const ref = idOverride ? col.doc(idOverride) : col.doc();
							const entry = buffer.stageCreate(
								model,
								ref,
								docData,
								normalizedData,
							);
							return { ...entry.appData };
						},
						update: async ({ model, where, update }: any) => {
							const col = getCollectionRef(db, model, collections);
							const normalizedUpdate = normalizeWriteData(model, update);
							const { docData: updateData } = buildFirestoreWriteData(
								normalizedUpdate,
								mapper,
							);

							// 1. Overlay: target may already be staged as a create in
							//    this same transaction. Mutate it in place so the flush
							//    emits one combined `set`.
							const stagedCreate = buffer.findCreateMatching(model, where);
							if (stagedCreate) {
								Object.assign(stagedCreate.docData, updateData);
								Object.assign(stagedCreate.appData, normalizedUpdate);
								return { ...stagedCreate.appData };
							}

							// 2. Otherwise read from Firestore (still safe — no writes
							//    have been flushed yet) to locate the target doc.
							const doc = await lookupTxDoc(
								transaction,
								col,
								where,
								mapper,
							);
							if (!doc) return null;

							// 3. Same ref may already have an update staged; merge.
							const existing = buffer.getByPath(doc.ref.path);
							if (existing) {
								Object.assign(existing.docData, updateData);
								Object.assign(existing.appData, normalizedUpdate);
								return { ...existing.appData };
							}

							// 4. Stage a fresh update.
							const baseAppData = dbDataToAppData(doc.data() ?? {}, mapper);
							const entry = buffer.stageUpdate(
								model,
								doc.ref,
								updateData,
								normalizedUpdate,
								baseAppData,
							);
							return { ...entry.appData };
						},
						findOne: async ({ model, where }: any) => {
							const col = getCollectionRef(db, model, collections);

							// 1. Overlay: return any matching staged create directly.
							const stagedCreate = buffer.findCreateMatching(model, where);
							if (stagedCreate) return { ...stagedCreate.appData };

							// 2. Real read.
							const doc = await lookupTxDoc(
								transaction,
								col,
								where,
								mapper,
							);
							if (!doc) return null;

							// 3. Layer any pending update on top of the snapshot.
							const staged = buffer.getByPath(doc.ref.path);
							if (staged) return { ...staged.appData };

							const data = doc.data();
							if (!data) return null;
							return { id: doc.id, ...dbDataToAppData(data, mapper) };
						},
					};

					const result = await run(txAdapter as any);
					buffer.flush(transaction);
					return result;
				});
			},
		},
		adapter: () => {
			return {
				create: async ({ model, data }) => {
					const col = getCollectionRef(db, model, collections);
					const normalizedData = normalizeWriteData(
						model,
						data as Record<string, any>,
					);
					const { docData, idOverride } = buildFirestoreWriteData(
						normalizedData,
						mapper,
					);
					const ref = idOverride ? col.doc(idOverride) : col.doc();
					if (debugLogs) {
						console.log(`[Firestore Adapter] CREATE ${model}:`, {
							input: data,
							docData,
							collection: collections,
							collectionRef: col.path,
							docId: ref.id,
						});
					}
					await ref.set(docData);
					const created = await ref.get();
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] CREATE ${model} - document exists after set:`,
							created.exists,
							"path:",
							created.ref.path,
						);
					}
					// Double-check by reading from the same ref
					if (debugLogs && created.exists) {
						const verifyDoc = await ref.get();
						console.log(
							`[Firestore Adapter] CREATE ${model} - verification read:`,
							verifyDoc.exists,
							"path:",
							verifyDoc.ref.path,
						);
					}
					const result: any = { id: created.id };
					const createdData = created.data();
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] CREATE ${model} - stored data:`,
							createdData,
						);
					}
					if (createdData) {
						for (const [k, v] of Object.entries(createdData)) {
							result[mapper.fromDb(k)] = convertTimestamp(v);
						}
					}
					if (debugLogs) {
						console.log(`[Firestore Adapter] CREATE ${model} - returning:`, {
							...normalizedData,
							...result,
						});
					}
					return { ...normalizedData, ...result };
				},
				update: async ({ model, where, update }) => {
					const col = getCollectionRef(db, model, collections);
					const normalizedUpdate = normalizeWriteData(
						model,
						update as Record<string, any>,
					);

					// Special case: if where clause is just "id eq value", use doc() instead of query
					if (
						where &&
						where.length === 1 &&
						where[0]?.field === "id" &&
						(where[0]?.operator === "eq" || !where[0]?.operator)
					) {
						const docId = where[0].value as string;
						const docRef = col.doc(docId);
						if (debugLogs) {
							console.log(`[Firestore Adapter] UPDATE ${model}:`, {
								where,
								update,
								"using direct doc lookup": docId,
							});
						}
						const doc = await docRef.get();
						if (!doc || !doc.exists) {
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] UPDATE ${model} - no document found by ID`,
								);
							}
							return null as any;
						}

						const { docData: updateData } = buildFirestoreWriteData(
							normalizedUpdate as Record<string, any>,
							mapper,
						);
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] UPDATE ${model} - updateData:`,
								updateData,
							);
						}
						await docRef.update(updateData);
						// Read the updated document to return full object
						const updated = await docRef.get();
						const result: any = { id: updated.id };
						const updatedData = updated.data();
						if (updatedData) {
							for (const [k, v] of Object.entries(updatedData)) {
								result[mapper.fromDb(k)] = convertTimestamp(v);
							}
						}
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] UPDATE ${model} - returning:`,
								result,
							);
						}
						return result;
					}

					if (debugLogs) {
						console.log(`[Firestore Adapter] UPDATE ${model}:`, {
							where,
							update,
							collection: collections,
						});
					}
					let doc: FirebaseFirestore.QueryDocumentSnapshot | undefined;
					for (const whereClause of getChunkedWhereClauses(where)) {
						const q = applyWhereClause(col, whereClause, mapper);
						const snap = await q.limit(1).get();
						doc = snap.docs[0];
						if (doc) break;
					}
					if (!doc) {
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] UPDATE ${model} - no document found`,
							);
						}
						return null as any;
					}

					const { docData: updateData } = buildFirestoreWriteData(
						normalizedUpdate as Record<string, any>,
						mapper,
					);
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] UPDATE ${model} - updateData:`,
							updateData,
						);
					}
					await doc.ref.update(updateData);
					// Read the updated document to return full object
					const updated = await doc.ref.get();
					const result: any = { id: updated.id };
					const updatedData = updated.data();
					if (updatedData) {
						for (const [k, v] of Object.entries(updatedData)) {
							result[mapper.fromDb(k)] = convertTimestamp(v);
						}
					}
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] UPDATE ${model} - returning:`,
							result,
						);
					}
					return result;
				},
				updateMany: async ({ model, where, update }) => {
					const col = getCollectionRef(db, model, collections);
					let count = 0;
					const seenDocIds = new Set<string>();
					const normalizedUpdate = normalizeWriteData(
						model,
						update as Record<string, any>,
					);
					const { docData: updateData } = buildFirestoreWriteData(
						normalizedUpdate,
						mapper,
					);
					for (const whereClause of getChunkedWhereClauses(where)) {
						const q = applyWhereClause(col, whereClause, mapper);
						const snap = await q.get();
						for (const d of snap.docs) {
							if (seenDocIds.has(d.id)) continue;
							seenDocIds.add(d.id);
							await d.ref.update(updateData);
							count++;
						}
					}
					return count;
				},
				delete: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);

					// Special case: if where clause is just "id eq value", use doc() instead of query
					if (
						where &&
						where.length === 1 &&
						where[0]?.field === "id" &&
						(where[0]?.operator === "eq" || !where[0]?.operator)
					) {
						const docId = where[0].value as string;
						const docRef = col.doc(docId);
						if (debugLogs) {
							console.log(`[Firestore Adapter] DELETE ${model}:`, {
								where,
								"using direct doc lookup": docId,
							});
						}
						const doc = await docRef.get();
						if (doc && doc.exists) {
							await docRef.delete();
						}
						return;
					}

					let doc: FirebaseFirestore.QueryDocumentSnapshot | undefined;
					for (const whereClause of getChunkedWhereClauses(where)) {
						const q = applyWhereClause(col, whereClause, mapper);
						const snap = await q.limit(1).get();
						doc = snap.docs[0];
						if (doc) break;
					}
					if (doc) await doc.ref.delete();
				},
				deleteMany: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);
					// Firestore's `IN` operator caps at 30 values. If a single where
					// clause carries more than 30 values, split into sub-queries and
					// sum the deletes so callers (e.g. better-auth's multi-session
					// `deleteSessions(tokens)`) don't blow up once they cross the cap.
					const oversized = findOversizedInClause(where);
					if (oversized) {
						let total = 0;
						for (
							let i = 0;
							i < oversized.value.length;
							i += FIRESTORE_IN_CHUNK_SIZE
						) {
							const chunk = oversized.value.slice(
								i,
								i + FIRESTORE_IN_CHUNK_SIZE,
							);
							const chunkedWhere = (where as WhereCondition[]).map((w) =>
								w === oversized
									? { ...w, value: chunk as WhereCondition["value"] }
									: w,
							);
							const cq = applyWhereClause(col, chunkedWhere, mapper);
							const csnap = await cq.get();
							for (const d of csnap.docs) {
								await d.ref.delete();
								total++;
							}
						}
						return total;
					}
					const q = applyWhereClause(col, where, mapper);
					const snap = await q.get();
					let count = 0;
					for (const d of snap.docs) {
						await d.ref.delete();
						count++;
					}
					return count;
				},
				findOne: async ({ model, where, select }) => {
					const col = getCollectionRef(db, model, collections);

					// Special case: if where clause is just "id eq value", use doc() instead of query
					// Firestore document IDs are metadata, not fields, so we can't query them with .where()
					if (
						where &&
						where.length === 1 &&
						where[0]?.field === "id" &&
						(where[0]?.operator === "eq" || !where[0]?.operator)
					) {
						const docId = where[0].value as string;
						const docRef = col.doc(docId);
						if (debugLogs) {
							console.log(`[Firestore Adapter] FINDONE ${model}:`, {
								where,
								select,
								collection: collections,
								collectionRef: col.path,
								"using direct doc lookup": docId,
								docPath: docRef.path,
							});
						}
						const doc = await docRef.get();
						if (!doc || !doc.exists) {
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] FINDONE ${model} - no document found by ID`,
									{ docId, docPath: docRef.path, collectionPath: col.path },
								);
							}
							return null as any;
						}
						const data = doc.data();
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - raw Firestore data:`,
								data,
							);
							console.log(
								`[Firestore Adapter] FINDONE ${model} - doc.id:`,
								doc.id,
							);
							console.log(
								`[Firestore Adapter] FINDONE ${model} - data keys:`,
								Object.keys(data || {}),
							);
						}
						if (!data || Object.keys(data).length === 0) return null as any;

						const result: any = { id: doc.id };
						for (const [k, v] of Object.entries(data)) {
							if (k === "__name__") continue;
							const fieldName = mapper.fromDb(k);
							const convertedValue = convertTimestamp(v);
							result[fieldName] = convertedValue;
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] FINDONE ${model} - mapped field:`,
									{
										dbField: k,
										appField: fieldName,
										rawValue: v,
										convertedValue,
									},
								);
							}
						}

						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - result before select:`,
								result,
							);
						}

						if (select && select.length > 0) {
							const selected: any = { id: doc.id };
							for (const field of select) {
								if (result[field] !== undefined) {
									selected[field] = result[field];
								}
							}
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] FINDONE ${model} - returning selected:`,
									selected,
								);
							}
							return selected;
						}

						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - returning result:`,
								result,
							);
						}
						return result;
					}

					if (debugLogs) {
						console.log(`[Firestore Adapter] FINDONE ${model}:`, {
							where,
							select,
							collection: collections,
						});
					}
					let snapshotSize = 0;
					let snapshotDocsLength = 0;
					let doc: FirebaseFirestore.QueryDocumentSnapshot | undefined;
					for (const whereClause of getChunkedWhereClauses(where)) {
						const q = applyWhereClause(col, whereClause, mapper);
						const snap = await q.limit(1).get();
						snapshotSize = snap.size;
						snapshotDocsLength = snap.docs.length;
						doc = snap.docs[0];
						if (doc) break;
					}
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - snapshot size:`,
							snapshotSize,
							"docs:",
							snapshotDocsLength,
						);
					}
					if (!doc || !doc.exists) {
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - no document found`,
							);
						}
						return null as any;
					}
					const data = doc.data();
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - raw Firestore data:`,
							data,
						);
						console.log(
							`[Firestore Adapter] FINDONE ${model} - doc.id:`,
							doc.id,
						);
						console.log(
							`[Firestore Adapter] FINDONE ${model} - data keys:`,
							Object.keys(data || {}),
						);
					}
					if (!data || Object.keys(data).length === 0) return null as any;

					const result: any = { id: doc.id };
					for (const [k, v] of Object.entries(data)) {
						if (k === "__name__") continue; // Skip Firestore internal fields
						const fieldName = mapper.fromDb(k);
						const convertedValue = convertTimestamp(v);
						result[fieldName] = convertedValue;
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - mapped field:`,
								{
									dbField: k,
									appField: fieldName,
									rawValue: v,
									convertedValue,
								},
							);
						}
					}

					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - result before select:`,
							result,
						);
					}

					if (select && select.length > 0) {
						const selected: any = { id: doc.id };
						for (const field of select) {
							if (result[field] !== undefined) {
								selected[field] = result[field];
							}
						}
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - returning selected:`,
								selected,
							);
						}
						return selected;
					}

					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - returning result:`,
							result,
						);
					}
					return result;
				},
				findMany: async ({ model, where, limit, offset, sortBy }) => {
					const col = getCollectionRef(db, model, collections);

					// Special handling for ID-based queries
					// Firestore document IDs are metadata, so we can't query them with .where()
					if (where && where.length > 0) {
						const idCondition = where.find((w) => w.field === "id");
						if (idCondition) {
							const op = (idCondition.operator || "eq") as string;

							// Handle "in" operator with IDs - fetch multiple documents directly
							if (op === "in") {
								const ids = (
									Array.isArray(idCondition.value)
										? idCondition.value
										: [idCondition.value]
								).filter((id): id is string => typeof id === "string");
								if (debugLogs) {
									console.log(
										`[Firestore Adapter] FINDMANY ${model} [using direct doc lookups for IDs]:`,
										{
											where,
											ids,
										},
									);
								}

								// Fetch all documents by ID
								const docPromises = ids.map((id) => col.doc(id).get());
								const docs = await Promise.all(docPromises);

								// Filter out non-existent documents and map to results
								let results = docs
									.filter((doc) => doc.exists)
									.map((doc) => {
										const data = doc.data();
										if (!data) return null;
										const result: any = { id: doc.id };
										for (const [k, v] of Object.entries(data)) {
											result[mapper.fromDb(k)] = convertTimestamp(v);
										}
										return result;
									})
									.filter((r) => r !== null) as any[];

								// Apply additional filtering for other conditions if any
								const otherConditions = where.filter((w) => w.field !== "id");
								if (otherConditions.length > 0) {
									results = results.filter((r: any) => {
										return otherConditions.every((cond) => {
											const value = r[cond.field];
											const condOp = (cond.operator || "eq") as string;
											if (condOp === "eq") return value === cond.value;
											return true;
										});
									});
								}

								// Apply sorting if needed
								if (sortBy?.field) {
									results.sort((a: any, b: any) => {
										const aVal = a[sortBy.field];
										const bVal = b[sortBy.field];
										const dir = sortBy.direction === "desc" ? -1 : 1;
										if (aVal < bVal) return -1 * dir;
										if (aVal > bVal) return 1 * dir;
										return 0;
									});
								}

								// Apply offset and limit
								if (offset) results = results.slice(offset);
								if (limit) results = results.slice(0, limit);

								return results;
							}

							// Handle "notIn" operator with IDs
							if (op === "notIn" || op === "not_in") {
								if (debugLogs) {
									console.log(
										`[Firestore Adapter] FINDMANY ${model} [handling notIn for IDs]:`,
										{
											where,
										},
									);
								}
								// Get all documents, then filter out the excluded IDs
								const excludedIds = Array.isArray(idCondition.value)
									? idCondition.value
									: [idCondition.value];
								const snap = await col.get();
								let results = snap.docs
									.filter((doc) => !excludedIds.includes(doc.id))
									.map((doc) => {
										const data = doc.data();
										const result: any = { id: doc.id };
										for (const [k, v] of Object.entries(data)) {
											result[mapper.fromDb(k)] = convertTimestamp(v);
										}
										return result;
									});

								// Apply other conditions
								const otherConditions = where.filter((w) => w.field !== "id");
								if (otherConditions.length > 0) {
									results = results.filter((r: any) => {
										return otherConditions.every((cond) => {
											const value = r[cond.field];
											const condOp = (cond.operator || "eq") as string;
											if (condOp === "eq") return value === cond.value;
											return true;
										});
									});
								}

								// Apply sorting
								if (sortBy?.field) {
									results.sort((a: any, b: any) => {
										const aVal = a[sortBy.field];
										const bVal = b[sortBy.field];
										const dir = sortBy.direction === "desc" ? -1 : 1;
										if (aVal < bVal) return -1 * dir;
										if (aVal > bVal) return 1 * dir;
										return 0;
									});
								}

								// Apply offset and limit
								if (offset) results = results.slice(offset);
								if (limit) results = results.slice(0, limit);

								return results as any[];
							}

							// Handle single ID "eq" - return array with single doc
							if ((op === "eq" || !op) && where.length === 1) {
								const docId = idCondition.value as string;
								const doc = await col.doc(docId).get();
								if (doc.exists) {
									const data = doc.data();
									if (data) {
										const result: any = { id: doc.id };
										for (const [k, v] of Object.entries(data)) {
											result[mapper.fromDb(k)] = convertTimestamp(v);
										}
										return [result];
									}
								}
								return [];
							}
						}
					}

					// Check for OR connectors - Firestore doesn't support OR natively
					const hasOrConnector = where?.some((w) => w.connector === "OR");

					if (hasOrConnector && where) {
						// Handle OR connectors by fetching each condition separately and merging
						const orGroups: WhereCondition[][] = [];
						let currentGroup: WhereCondition[] = [];

						for (const condition of where) {
							if (condition.connector === "OR" && currentGroup.length > 0) {
								orGroups.push([...currentGroup]);
								currentGroup = [condition];
							} else {
								currentGroup.push(condition);
							}
						}
						if (currentGroup.length > 0) {
							orGroups.push(currentGroup);
						}

						// Fetch results for each OR group
						const allResultsMap = new Map<string, any>();
						for (const group of orGroups) {
							let q = applyWhereClause(col, group, mapper);

							// Apply sorting before fetching
							if (sortBy?.field) {
								const fieldName = mapper.toDb(sortBy.field);
								const direction = sortBy.direction === "desc" ? "desc" : "asc";
								q = q.orderBy(fieldName, direction);
							}

							const snap = await q.get();
							snap.docs.forEach((d) => {
								const data = d.data();
								const result: any = { id: d.id };
								for (const [k, v] of Object.entries(data)) {
									result[mapper.fromDb(k)] = convertTimestamp(v);
								}
								// Use ID as key to deduplicate
								allResultsMap.set(d.id, result);
							});
						}

						let results = Array.from(allResultsMap.values());

						// Apply client-side filtering for operators not supported by Firestore
						const notInCondition = where?.find(
							(w) =>
								(w.operator as string) === "notIn" ||
								(w.operator as string) === "not_in",
						);
						if (notInCondition) {
							const fieldName = notInCondition.field;
							const arr = Array.isArray(notInCondition.value)
								? notInCondition.value
								: [notInCondition.value];
							results = results.filter((r: any) => !arr.includes(r[fieldName]));
						}

						const endsWithCondition = where?.find(
							(w) =>
								(w.operator as string) === "endsWith" ||
								(w.operator as string) === "ends-with" ||
								(w.operator as string) === "ends_with",
						);
						if (endsWithCondition) {
							const fieldName = endsWithCondition.field;
							results = results.filter((r: any) => {
								const value = r[fieldName]?.toString() || "";
								return value.endsWith(endsWithCondition.value);
							});
						}

						const containsCondition = where?.find(
							(w) => (w.operator as string) === "contains",
						);
						if (containsCondition) {
							const fieldName = containsCondition.field;
							const searchValue = containsCondition.value?.toString() || "";
							results = results.filter((r: any) => {
								const fieldValue = r[fieldName];
								// Check if field is an array - if so, use array includes
								if (Array.isArray(fieldValue)) {
									return fieldValue.includes(containsCondition.value);
								}
								// For strings, check if it contains the substring
								const stringValue = fieldValue?.toString() || "";
								return stringValue.includes(searchValue);
							});
						}

						// Apply sorting (if not already sorted)
						if (sortBy?.field) {
							results.sort((a: any, b: any) => {
								const aVal = a[sortBy.field];
								const bVal = b[sortBy.field];
								const dir = sortBy.direction === "desc" ? -1 : 1;
								if (aVal < bVal) return -1 * dir;
								if (aVal > bVal) return 1 * dir;
								return 0;
							});
						}

						// Apply offset and limit AFTER filtering
						if (offset) results = results.slice(offset);
						if (limit) results = results.slice(0, limit);

						return results as any[];
					}

					// Firestore's `IN` operator caps at 30 values. If a simple non-ID
					// `in` query carries more than 30 values, split into chunks and
					// merge the results. Any post-filter sort / offset / limit is
					// re-applied after the merge to preserve the caller-visible
					// ordering and pagination.
					const oversizedIn = findOversizedInClause(where);
					if (oversizedIn) {
						const merged = new Map<string, any>();
						for (
							let i = 0;
							i < oversizedIn.value.length;
							i += FIRESTORE_IN_CHUNK_SIZE
						) {
							const chunk = oversizedIn.value.slice(
								i,
								i + FIRESTORE_IN_CHUNK_SIZE,
							);
							const chunkedWhere = (where as WhereCondition[]).map((w) =>
								w === oversizedIn
									? { ...w, value: chunk as WhereCondition["value"] }
									: w,
							);
							let cq: FirebaseFirestore.Query = applyWhereClause(
								col,
								chunkedWhere,
								mapper,
							);
							if (sortBy?.field) {
								const fieldName = mapper.toDb(sortBy.field);
								const direction = sortBy.direction === "desc" ? "desc" : "asc";
								cq = cq.orderBy(fieldName, direction);
							}
							const csnap = await cq.get();
							for (const d of csnap.docs) {
								const data = d.data();
								const result: Record<string, any> = { id: d.id };
								for (const [k, v] of Object.entries(data)) {
									result[mapper.fromDb(k)] = convertTimestamp(v);
								}
								merged.set(d.id, result);
							}
						}
						let results = Array.from(merged.values());
						if (sortBy?.field) {
							results.sort((a, b) => {
								const aVal = a[sortBy.field];
								const bVal = b[sortBy.field];
								const dir = sortBy.direction === "desc" ? -1 : 1;
								if (aVal < bVal) return -1 * dir;
								if (aVal > bVal) return 1 * dir;
								return 0;
							});
						}
						if (offset) results = results.slice(offset);
						if (limit) results = results.slice(0, limit);
						return results as any[];
					}

					// Regular query path for non-ID queries
					let q: FirebaseFirestore.Query = applyWhereClause(col, where, mapper);

					const notInCondition = where?.find(
						(w) =>
							(w.operator as string) === "notIn" ||
							(w.operator as string) === "not_in",
					);
					const hasNotIn = !!notInCondition;
					const endsWithCondition = where?.find(
						(w) =>
							(w.operator as string) === "endsWith" ||
							(w.operator as string) === "ends-with" ||
							(w.operator as string) === "ends_with",
					);
					const hasEndsWith = !!endsWithCondition;
					const containsCondition = where?.find(
						(w) => (w.operator as string) === "contains",
					);
					const hasContains = !!containsCondition;

					// If we have client-side filtering, we need to fetch all then filter before offset/limit
					// Also, for "contains" on non-array fields, we need client-side filtering
					if (hasNotIn || hasEndsWith || hasContains) {
						// For contains on strings, don't apply the array-contains query - fetch all and filter
						// For contains on arrays, we can use Firestore's array-contains
						if (hasContains && containsCondition) {
							// Check if we should use array-contains or client-side filtering
							// For now, always do client-side filtering for contains to handle both cases
							// Remove the contains condition from the query
							const whereWithoutContains = where?.filter(
								(w) => w !== containsCondition,
							);
							q = applyWhereClause(col, whereWithoutContains, mapper);
						}

						if (sortBy?.field) {
							const fieldName = mapper.toDb(sortBy.field);
							const direction = sortBy.direction === "desc" ? "desc" : "asc";
							q = q.orderBy(fieldName, direction);
						}

						const snap = await q.get();
						let results = snap.docs.map((d) => {
							const data = d.data();
							const result: any = { id: d.id };
							for (const [k, v] of Object.entries(data)) {
								result[mapper.fromDb(k)] = convertTimestamp(v);
							}
							return result;
						});

						if (hasNotIn && notInCondition) {
							const fieldName = notInCondition.field;
							const arr = Array.isArray(notInCondition.value)
								? notInCondition.value
								: [notInCondition.value];
							results = results.filter((r: any) => !arr.includes(r[fieldName]));
						}

						if (hasEndsWith && endsWithCondition) {
							const fieldName = endsWithCondition.field;
							results = results.filter((r: any) => {
								const value = r[fieldName]?.toString() || "";
								return value.endsWith(endsWithCondition.value);
							});
						}

						if (hasContains && containsCondition) {
							const fieldName = containsCondition.field;
							const searchValue = containsCondition.value?.toString() || "";
							results = results.filter((r: any) => {
								const fieldValue = r[fieldName];
								// Check if field is an array - if so, use array includes
								if (Array.isArray(fieldValue)) {
									return fieldValue.includes(containsCondition.value);
								}
								// For strings, check if it contains the substring
								const stringValue = fieldValue?.toString() || "";
								return stringValue.includes(searchValue);
							});
						}

						// Apply sorting if not already sorted
						if (sortBy?.field) {
							results.sort((a: any, b: any) => {
								const aVal = a[sortBy.field];
								const bVal = b[sortBy.field];
								const dir = sortBy.direction === "desc" ? -1 : 1;
								if (aVal < bVal) return -1 * dir;
								if (aVal > bVal) return 1 * dir;
								return 0;
							});
						}

						// Apply offset and limit AFTER client-side filtering
						if (offset) results = results.slice(offset);
						if (limit) results = results.slice(0, limit);

						return results as any[];
					}

					// No client-side filtering needed - use Firestore offset/limit directly
					// Firestore requires orderBy before using offset
					if (offset && !sortBy?.field) {
						// If offset is provided but no sortBy, order by document ID for consistent results
						q = q.orderBy(FieldPath.documentId());
					} else if (sortBy?.field) {
						const fieldName = mapper.toDb(sortBy.field);
						const direction = sortBy.direction === "desc" ? "desc" : "asc";
						q = q.orderBy(fieldName, direction);
					}

					if (offset) q = q.offset(offset);
					if (limit) q = q.limit(limit);

					const snap = await q.get();
					const results = snap.docs.map((d) => {
						const data = d.data();
						const result: any = { id: d.id };
						for (const [k, v] of Object.entries(data)) {
							result[mapper.fromDb(k)] = convertTimestamp(v);
						}
						return result;
					});

					return results as any[];
				},
				count: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);

					// Special handling for ID-based queries
					if (where && where.length > 0) {
						const idCondition = where.find((w) => w.field === "id");
						if (idCondition) {
							const op = (idCondition.operator || "eq") as string;

							// Handle "in" operator with IDs
							if (op === "in") {
								const ids = (
									Array.isArray(idCondition.value)
										? idCondition.value
										: [idCondition.value]
								).filter((id): id is string => typeof id === "string");
								const docPromises = ids.map((id) => col.doc(id).get());
								const docs = await Promise.all(docPromises);
								let count = docs.filter((doc) => doc.exists).length;

								// Apply other conditions if any
								const otherConditions = where.filter((w) => w.field !== "id");
								if (otherConditions.length > 0) {
									// For ID queries, we'd need to check other conditions manually
									// This is a simplified version - full implementation might need more logic
									return count;
								}
								return count;
							}

							// Handle "notIn" operator with IDs
							if (op === "notIn" || op === "not_in") {
								const excludedIds = (
									Array.isArray(idCondition.value)
										? idCondition.value
										: [idCondition.value]
								).filter((id): id is string => typeof id === "string");
								const snap = await col.get();
								return snap.docs.filter((doc) => !excludedIds.includes(doc.id))
									.length;
							}

							// Handle single ID "eq"
							if ((op === "eq" || !op) && where.length === 1) {
								const docId = idCondition.value as string;
								const doc = await col.doc(docId).get();
								return doc.exists ? 1 : 0;
							}
						}
					}

					const notInCondition = where?.find(
						(w) =>
							(w.operator as string) === "notIn" ||
							(w.operator as string) === "not_in",
					);
					const whereClauses = getChunkedWhereClauses(where);
					if (notInCondition || whereClauses.length > 1) {
						const matchingIds = new Set<string>();
						for (const whereClause of whereClauses) {
							const q = applyWhereClause(col, whereClause, mapper);
							const snap = await q.get();
							for (const d of snap.docs) {
								if (notInCondition) {
									const fieldName = notInCondition.field;
									const arr = Array.isArray(notInCondition.value)
										? notInCondition.value
										: [notInCondition.value];
									const data = d.data();
									const value = data[mapper.toDb(fieldName)];
									if (arr.includes(value)) continue;
								}
								matchingIds.add(d.id);
							}
						}
						return matchingIds.size;
					}

					const q: FirebaseFirestore.Query = applyWhereClause(col, where, mapper);
					const snap = await q.count().get();
					return snap.data().count ?? 0;
				},
			};
		},
	});
};
