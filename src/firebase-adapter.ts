import {
	type AdapterFactoryConfig,
	type AdapterFactoryOptions,
	type CustomAdapter,
	createAdapterFactory,
	type DBAdapterDebugLogOption,
} from "better-auth/adapters";
import { getAuthTables } from "better-auth/db";
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
	if (normalized === "verification" || normalized === "verificationtoken")
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

function normalizeSessionWriteData(
	data: Record<string, any>,
): Record<string, any> {
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

function normalizeWriteData(
	model: string,
	data: Record<string, any>,
): Record<string, any> {
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

interface TxBufferWriteEntry {
	op: "create" | "update";
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

interface TxBufferDeleteEntry {
	op: "delete";
	model: string;
	ref: FirebaseFirestore.DocumentReference;
}

type TxBufferEntry = TxBufferWriteEntry | TxBufferDeleteEntry;

class TxBuffer {
	private byPath = new Map<string, TxBufferEntry>();

	/** Stage a create. Returns the entry so the caller can read back `appData.id`. */
	stageCreate(
		model: string,
		ref: FirebaseFirestore.DocumentReference,
		docData: Record<string, any>,
		appNormalized: Record<string, any>,
	): TxBufferWriteEntry {
		const entry: TxBufferWriteEntry = {
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
	): TxBufferWriteEntry {
		const existing = this.byPath.get(ref.path);
		if (existing && existing.op !== "delete") {
			Object.assign(existing.docData, updateDocData);
			Object.assign(existing.appData, updateAppData);
			return existing;
		}
		const entry: TxBufferWriteEntry = {
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
	): TxBufferWriteEntry | undefined {
		for (const entry of this.byPath.values()) {
			if (entry.op !== "create" || entry.model !== model) continue;
			if (matchesWhere(entry.appData, where)) return entry;
		}
		return undefined;
	}

	/** Stage a delete on `ref`, discarding any prior create/update for the same path. */
	stageDelete(model: string, ref: FirebaseFirestore.DocumentReference): void {
		this.byPath.set(ref.path, { op: "delete", model, ref });
	}

	/** True if `ref` has a delete staged. */
	isDeleted(refPath: string): boolean {
		const entry = this.byPath.get(refPath);
		return !!entry && entry.op === "delete";
	}

	/** Buffered entry (create, update, or delete) for a specific ref path, if any. */
	getByPath(refPath: string): TxBufferEntry | undefined {
		return this.byPath.get(refPath);
	}

	/** All buffered entries, for scanning staged creates by model. */
	values(): IterableIterator<TxBufferEntry> {
		return this.byPath.values();
	}

	/** Replay every staged write onto the transaction in insertion order. */
	flush(transaction: Transaction): void {
		for (const entry of this.byPath.values()) {
			if (entry.op === "create") transaction.set(entry.ref, entry.docData);
			else if (entry.op === "update")
				transaction.update(entry.ref, entry.docData);
			else transaction.delete(entry.ref);
		}
	}
}

/**
 * Splits a where clause into its OR groups: AND-within-group, OR-between-
 * groups (a new group starts at every `connector: "OR"`).
 */
function splitOrGroups(where: WhereCondition[]): WhereCondition[][] {
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
	return groups;
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
	return splitOrGroups(where).some((group) =>
		group.every((cond) => matchesCondition(appData, cond)),
	);
}

/**
 * Normalizes a value for in-memory comparison: Dates compare by instant
 * (Firestore hands Timestamps back as fresh Date objects, so `===` would
 * never match), everything else as-is.
 */
function comparable(value: unknown): unknown {
	return value instanceof Date ? value.getTime() : value;
}

/**
 * Relational comparison with SQL/Firestore semantics: a missing or null
 * field never satisfies a range guard. Plain JS would coerce `null` to 0
 * and let e.g. `lockedUntil <= now` pass for a row that was never locked.
 */
function compareRelational(
	left: unknown,
	right: unknown,
	op: "gt" | "gte" | "lt" | "lte",
): boolean {
	if (left === null || left === undefined) return false;
	if (right === null || right === undefined) return false;
	const a = comparable(left) as any;
	const b = comparable(right) as any;
	switch (op) {
		case "gt":
			return a > b;
		case "gte":
			return a >= b;
		case "lt":
			return a < b;
		case "lte":
			return a <= b;
	}
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
			return comparable(val) === comparable(cond.value);
		case "ne":
		case "!=":
			return comparable(val) !== comparable(cond.value);
		case "in":
			return Array.isArray(cond.value)
				? cond.value.map(comparable).includes(comparable(val))
				: comparable(val) === comparable(cond.value);
		case "notIn":
		case "not_in":
			return Array.isArray(cond.value)
				? !cond.value.map(comparable).includes(comparable(val))
				: comparable(val) !== comparable(cond.value);
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return compareRelational(val, cond.value, op);
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

/**
 * Splits an `id` equality condition out of a where clause.
 *
 * Firestore document IDs are metadata, not fields, so `where("id", "==", …)`
 * silently matches nothing. Callers must resolve the doc by ref and evaluate
 * the remaining conditions themselves — see `lookupTxDoc` for the
 * single-condition version of the same problem.
 */
function splitIdEqCondition(where: WhereCondition[] | undefined): {
	id?: string;
	rest: WhereCondition[] | undefined;
} {
	if (!where || where.length === 0) return { rest: where };
	const idCond = where.find(
		(w) => w.field === "id" && (w.operator === "eq" || !w.operator),
	);
	if (!idCond || typeof idCond.value !== "string") return { rest: where };
	const rest = where.filter((w) => w !== idCond);
	return { id: idCond.value, rest: rest.length > 0 ? rest : undefined };
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

// ─────────────────────────────────────────────────────────────────────────────
// Guarded single-row mutation (`incrementOne`)
// ─────────────────────────────────────────────────────────────────────────────
// better-auth uses `incrementOne` as its compare-and-swap primitive: the
// `where` clause is both selector and guard (`count < max`, `lockedUntil <=
// now`, `status == "pending"`, …) and the row is mutated only while the
// guard still holds. Since 1.7 the adapter must provide it natively — the
// factory's `transaction(findMany + updateMany)` fallback is gone.
//
// Firestore has no conditional update, so we run a transaction: read the
// candidate rows, evaluate the guard in memory, write once. Firestore
// serializes the transaction against concurrent writes to the rows it read,
// which gives the same "at most one row, only while the guard holds"
// semantics as `UPDATE … WHERE … RETURNING *`.
//
// Only equality filters (`eq` / `in`) are sent to Firestore; every other
// operator is evaluated in memory. Equality-only queries are served by
// Firestore's automatic single-field indexes, whereas mixing an equality on
// one field with a range on another (exactly the limiter's `key == … AND
// lastRequest > … AND count < …`) would demand a composite index from every
// consumer. Every better-auth caller selects by `id` or a unique key, so the
// equality prefix narrows the read to a single document in practice; a
// where clause with no equality condition at all falls back to scanning
// the collection.

const isEqualityOperator = (operator: string | undefined): boolean =>
	operator === undefined ||
	operator === "eq" ||
	operator === "==" ||
	operator === "in";

/**
 * Reads every existing document that could satisfy `where`, inside
 * `transaction`, using only equality filters (see the section header).
 * Callers still have to apply the full `where` with `matchesWhere`. Results
 * are deduplicated across OR groups and oversized `in` chunks.
 */
async function collectGuardCandidates(
	transaction: Transaction,
	col: FirebaseFirestore.CollectionReference,
	where: WhereCondition[] | undefined,
	mapper: FieldMapper,
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
	const byPath = new Map<string, FirebaseFirestore.DocumentSnapshot>();
	const add = (snap: FirebaseFirestore.DocumentSnapshot) => {
		if (snap.exists && !byPath.has(snap.ref.path))
			byPath.set(snap.ref.path, snap);
	};

	const groups = where && where.length > 0 ? splitOrGroups(where) : [[]];
	for (const group of groups) {
		// Document IDs are metadata, not fields: an `id` equality resolves to
		// direct reads and the rest of the group is checked in memory.
		const idCond = group.find(
			(w) => w.field === "id" && isEqualityOperator(w.operator),
		);
		if (idCond) {
			const ids = (
				Array.isArray(idCond.value) ? idCond.value : [idCond.value]
			).filter((id): id is string => typeof id === "string" && id !== "");
			if (ids.length === 0) continue;
			const snaps = await transaction.getAll(...ids.map((id) => col.doc(id)));
			for (const snap of snaps) add(snap);
			continue;
		}

		const serverSide = group
			.filter((w) => w.field !== "id" && isEqualityOperator(w.operator))
			.map((w): WhereCondition => ({ ...w, connector: "AND" }));
		for (const chunk of getChunkedWhereClauses(
			serverSide.length > 0 ? serverSide : undefined,
		)) {
			const snap = await transaction.get(applyWhereClause(col, chunk, mapper));
			for (const doc of snap.docs) add(doc);
		}
	}
	return Array.from(byPath.values());
}

interface IncrementPatch {
	/** Absolute assignments, db-side keys — ready for `transaction.update`. */
	setDocData: Record<string, any>;
	/** Absolute assignments, app-side keys — merged into the returned row. */
	setAppData: Record<string, any>;
	increments: { appField: string; dbField: string; delta: number }[];
}

function buildIncrementPatch(
	model: string,
	increment: Record<string, number> | undefined,
	set: Record<string, unknown> | undefined,
	mapper: FieldMapper,
): IncrementPatch {
	const normalizedSet = normalizeWriteData(
		model,
		(set ?? {}) as Record<string, any>,
	);
	const { docData: setDocData } = buildFirestoreWriteData(
		normalizedSet,
		mapper,
	);
	const setAppData: Record<string, any> = {};
	for (const [k, v] of Object.entries(normalizedSet)) {
		if (v === undefined || k === "id") continue;
		setAppData[mapper.fromDb(mapper.toDb(k))] = v;
	}
	const increments = Object.entries(increment ?? {}).map(([field, delta]) => {
		const dbField = mapper.toDb(field);
		return { appField: mapper.fromDb(dbField), dbField, delta };
	});
	return { setDocData, setAppData, increments };
}

/**
 * Computes the post-mutation state of one row. A counter that is missing or
 * non-numeric starts from 0 — matching the behaviour of the 1.6 fallback,
 * which the two-factor lockout relies on for rows created before the
 * counter field existed.
 */
function applyIncrementPatch(
	current: Record<string, any>,
	patch: IncrementPatch,
): {
	/** Changed fields only, db-side keys. */
	docData: Record<string, any>;
	/** Changed fields only, app-side keys. */
	appPatch: Record<string, any>;
	/** Full row after the mutation, app-side keys. */
	appData: Record<string, any>;
} {
	const docData: Record<string, any> = { ...patch.setDocData };
	const appPatch: Record<string, any> = { ...patch.setAppData };
	for (const { appField, dbField, delta } of patch.increments) {
		const base = typeof current[appField] === "number" ? current[appField] : 0;
		appPatch[appField] = base + delta;
		docData[dbField] = base + delta;
	}
	return { docData, appPatch, appData: { ...current, ...appPatch } };
}

export interface FirestoreAdapterOptions
	extends Omit<FirestoreAdapterConfig, "firestore"> {
	firestore?: Firestore;
	debugLogs?: DBAdapterDebugLogOption;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup migration check
// ─────────────────────────────────────────────────────────────────────────────
// Better Auth 1.7 looks accounts up by `(issuer, accountId)`; documents
// written by earlier versions have no `issuer`, so their users silently get
// "invalid credentials" after an upgrade. Firestore has no migration runner
// to refuse the upgrade, so the adapter does what Better Auth itself does
// for misconfiguration: warn once at startup, naming the fix. Two aggregation
// reads (total vs. documents that have the field — Firestore excludes
// documents missing a field from `orderBy` on it), run in the background
// when the adapter is first bound to a `betterAuth()` instance.

const issuerChecksStarted = new Set<string>();

async function warnIfAccountsLackIssuer(
	db: Firestore,
	options: Parameters<typeof getAuthTables>[0],
	namingStrategy: NamingStrategy,
	collections: ReturnType<typeof resolveCollectionNames>,
	mapper: FieldMapper,
	warn: (message: string) => void,
): Promise<void> {
	const account = getAuthTables(options).account;
	const issuerField = account?.fields.issuer?.fieldName;
	// Better Auth < 1.7 has no issuer field — nothing to migrate.
	if (!account || !issuerField) return;

	const col = getCollectionRef(db, account.modelName, collections);
	if (issuerChecksStarted.has(col.path)) return;
	issuerChecksStarted.add(col.path);

	const [total, stamped] = await Promise.all([
		col.count().get(),
		col.orderBy(mapper.toDb(issuerField)).count().get(),
	]);
	const missing = total.data().count - stamped.data().count;
	if (missing <= 0) return;

	const flags = [
		col.id !== "accounts" ? ` --collection ${col.id}` : "",
		namingStrategy === "snake_case" ? " --naming-strategy snake_case" : "",
	].join("");
	warn(
		`[better-auth-firestore] ${missing} of ${total.data().count} documents in "${col.path}" have no "${issuerField}" field. ` +
			"Better Auth 1.7 looks accounts up by (issuer, accountId), so those users cannot sign in until it is backfilled. " +
			`Run: npx better-auth-firestore backfill-account-issuers${flags} --apply ` +
			"(dry run without --apply). See README → Upgrading to Better Auth 1.7. Set migrationChecks: false to silence this check.",
	);
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
		migrationChecks = true,
	} = ((config as FirestoreAdapterOptions) && (config as any).collection
		? {}
		: (config as FirestoreAdapterOptions)) || {};

	const preferSnakeCase = namingStrategy === "snake_case";
	const collections = resolveCollectionNames(
		namingStrategy,
		collectionsOverride,
	);
	const mapper = mapFieldsFactory(preferSnakeCase);

	// ───────────────────────────────────────────────────────────────────────
	// Transaction adapter
	// ───────────────────────────────────────────────────────────────────────
	// The `CustomAdapter` that serves one Firestore transaction. It receives
	// exactly what the plain adapter receives — the factory has already mapped
	// `model` to its configured `modelName`, cleaned the `where` clause and
	// transformed the data — and stages every write in `buffer`, which the
	// caller flushes onto `transaction` once the user callback resolves.
	const createTransactionAdapter = (
		transaction: Transaction,
		buffer: TxBuffer,
	): CustomAdapter => {
		// Subset of the non-tx `findMany` path: no OR-split queries or
		// direct `id` lookups. better-auth's tx callbacks (e.g.
		// consumeVerificationValue) only issue simple equality filters.
		const txFindMany = async ({
			model,
			where,
			limit,
			offset,
			sortBy,
		}: any): Promise<any[]> => {
			const col = getCollectionRef(db, model, collections);
			const byPath = new Map<string, Record<string, any>>();

			// 1. Real reads (chunked for oversized `in` clauses), overlaying
			//    any staged update and dropping any staged delete.
			for (const whereClause of getChunkedWhereClauses(where)) {
				const q = applyWhereClause(col, whereClause, mapper);
				const snap = await transaction.get(q);
				for (const doc of snap.docs) {
					if (buffer.isDeleted(doc.ref.path)) continue;
					const staged = buffer.getByPath(doc.ref.path);
					if (staged && staged.op !== "delete") {
						byPath.set(doc.ref.path, { ...staged.appData });
						continue;
					}
					const data = doc.data();
					if (!data) continue;
					byPath.set(doc.ref.path, {
						id: doc.id,
						...dbDataToAppData(data, mapper),
					});
				}
			}

			// 2. Overlay: staged creates in this transaction that match `where`.
			for (const entry of buffer.values()) {
				if (entry.op !== "create" || entry.model !== model) continue;
				if (!byPath.has(entry.ref.path) && matchesWhere(entry.appData, where)) {
					byPath.set(entry.ref.path, { ...entry.appData });
				}
			}

			let results = Array.from(byPath.values());
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
			if (limit !== undefined) results = results.slice(0, limit);
			return results;
		};

		return {
			create: async ({ model, data }: any): Promise<any> => {
				const col = getCollectionRef(db, model, collections);
				const normalizedData = normalizeWriteData(model, data);
				const { docData, idOverride } = buildFirestoreWriteData(
					normalizedData,
					mapper,
				);
				const ref = idOverride ? col.doc(idOverride) : col.doc();
				const entry = buffer.stageCreate(model, ref, docData, normalizedData);
				return { ...entry.appData };
			},
			update: async ({ model, where, update }: any): Promise<any> => {
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
				const doc = await lookupTxDoc(transaction, col, where, mapper);
				if (!doc) return null;

				// 3. Same ref may already have an update staged; merge.
				//    (A staged delete is skipped — falls through to stage a
				//    fresh update below, mirroring "not currently buffered".)
				const existing = buffer.getByPath(doc.ref.path);
				if (existing && existing.op !== "delete") {
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
			findOne: async ({ model, where }: any): Promise<any> => {
				const col = getCollectionRef(db, model, collections);

				// 1. Overlay: return any matching staged create directly.
				const stagedCreate = buffer.findCreateMatching(model, where);
				if (stagedCreate) return { ...stagedCreate.appData };

				// 2. Real read.
				const doc = await lookupTxDoc(transaction, col, where, mapper);
				if (!doc) return null;

				// 3. A pending delete makes this doc invisible.
				if (buffer.isDeleted(doc.ref.path)) return null;

				// 4. Layer any pending update on top of the snapshot.
				const staged = buffer.getByPath(doc.ref.path);
				if (staged && staged.op !== "delete") return { ...staged.appData };

				const data = doc.data();
				if (!data) return null;
				return { id: doc.id, ...dbDataToAppData(data, mapper) };
			},
			findMany: txFindMany,
			// `runWithTransaction` hands the factory-wrapped form of this
			// object to plugins as the current adapter, so it has to expose
			// the full `CustomAdapter` surface — the organization plugin
			// counts members inside its transactions.
			count: async ({ model, where }: any) => {
				return (await txFindMany({ model, where })).length;
			},
			// Mirrors the non-tx `updateMany`, but stages every write in the
			// buffer so reads later in the same transaction observe them and
			// the flush emits one write per ref.
			//
			// Before better-auth 1.7, adapters without a native
			// `incrementOne` fell back to `transaction(findMany +
			// updateMany)` — the path the database-backed rate limiter took
			// to count a request. Without this method that fallback threw
			// `updateMany is not a function` and every rate-limited route
			// 500'd. 1.7 removed the fallback (see `incrementOne` below),
			// but `updateManyWithHooks` still reaches this inside
			// transactions.
			//
			// Returns the number of affected docs.
			updateMany: async ({ model, where, update }: any) => {
				const col = getCollectionRef(db, model, collections);
				const normalizedUpdate = normalizeWriteData(model, update);
				const { docData: updateData } = buildFirestoreWriteData(
					normalizedUpdate,
					mapper,
				);
				let count = 0;
				const seenPaths = new Set<string>();

				/** Merge into an existing staged write, or stage a fresh one. */
				const applyTo = (
					ref: FirebaseFirestore.DocumentReference,
					baseAppData: Record<string, any>,
				) => {
					const existing = buffer.getByPath(ref.path);
					if (existing && existing.op !== "delete") {
						Object.assign(existing.docData, updateData);
						Object.assign(existing.appData, normalizedUpdate);
					} else {
						buffer.stageUpdate(
							model,
							ref,
							updateData,
							normalizedUpdate,
							baseAppData,
						);
					}
					count++;
				};

				// `id` can't go through a Firestore query — it's document
				// metadata, not a field. better-auth's `incrementOne` fallback
				// appends exactly such a condition to its compare-and-swap
				// guard, so without this branch every increment matched zero
				// docs and the rate limiter denied every request.
				const { id: idFilter, rest } = splitIdEqCondition(where);
				if (idFilter) {
					const ref = col.doc(idFilter);
					if (buffer.isDeleted(ref.path)) return 0;
					const staged = buffer.getByPath(ref.path);
					if (staged && staged.op !== "delete") {
						if (matchesWhere(staged.appData, rest)) applyTo(ref, {});
						return count;
					}
					const snap = await transaction.get(ref);
					if (!snap.exists) return 0;
					const appData = {
						id: snap.id,
						...dbDataToAppData(snap.data() ?? {}, mapper),
					};
					if (matchesWhere(appData, rest)) applyTo(ref, appData);
					return count;
				}

				// 1. Real reads (chunked for oversized `in` clauses). A staged
				//    delete hides the doc; an existing staged write merges in
				//    place, mirroring step 3 of the single-doc `update`.
				for (const whereClause of getChunkedWhereClauses(where)) {
					const q = applyWhereClause(col, whereClause, mapper);
					const snap = await transaction.get(q);
					for (const doc of snap.docs) {
						if (seenPaths.has(doc.ref.path) || buffer.isDeleted(doc.ref.path))
							continue;
						seenPaths.add(doc.ref.path);
						applyTo(doc.ref, dbDataToAppData(doc.data() ?? {}, mapper));
					}
				}

				// 2. Staged creates are invisible to Firestore queries until
				//    flush, so fold them in by hand. Mutating in place keeps
				//    the entry a `create`, so the flush still emits one `set`.
				for (const entry of buffer.values()) {
					if (entry.op !== "create" || entry.model !== model) continue;
					if (seenPaths.has(entry.ref.path) || buffer.isDeleted(entry.ref.path))
						continue;
					if (!matchesWhere(entry.appData, where)) continue;
					seenPaths.add(entry.ref.path);
					Object.assign(entry.docData, updateData);
					Object.assign(entry.appData, normalizedUpdate);
					count++;
				}

				return count;
			},
			deleteMany: async ({ model, where }: any) => {
				const col = getCollectionRef(db, model, collections);
				let count = 0;
				const seenPaths = new Set<string>();
				for (const whereClause of getChunkedWhereClauses(where)) {
					const q = applyWhereClause(col, whereClause, mapper);
					const snap = await transaction.get(q);
					for (const doc of snap.docs) {
						if (seenPaths.has(doc.ref.path) || buffer.isDeleted(doc.ref.path))
							continue;
						seenPaths.add(doc.ref.path);
						buffer.stageDelete(model, doc.ref);
						count++;
					}
				}
				// Staged creates are invisible to Firestore queries until flush.
				for (const entry of buffer.values()) {
					if (entry.op !== "create" || entry.model !== model) continue;
					if (seenPaths.has(entry.ref.path) || buffer.isDeleted(entry.ref.path))
						continue;
					if (!matchesWhere(entry.appData, where)) continue;
					seenPaths.add(entry.ref.path);
					buffer.stageDelete(model, entry.ref);
					count++;
				}
				return count;
			},
			// Single-doc variant of `deleteMany`: `deleteWithHooks` and the
			// organization plugin call `delete` on the current adapter
			// inside transactions.
			delete: async ({ model, where }: any) => {
				const col = getCollectionRef(db, model, collections);
				const stagedCreate = buffer.findCreateMatching(model, where);
				if (stagedCreate) {
					buffer.stageDelete(model, stagedCreate.ref);
					return;
				}
				const doc = await lookupTxDoc(transaction, col, where, mapper);
				if (!doc || buffer.isDeleted(doc.ref.path)) return;
				buffer.stageDelete(model, doc.ref);
			},
			// Transactional `incrementOne` (see the section header above
			// `collectGuardCandidates`). The enclosing Firestore transaction
			// already provides atomicity, so this only has to find the first
			// row that satisfies the guard — staged creates first, then real
			// reads overlaid with staged updates — and fold the patch into
			// the buffer so the flush emits one write per ref.
			incrementOne: async ({
				model,
				where,
				increment,
				set,
			}: any): Promise<any> => {
				const col = getCollectionRef(db, model, collections);
				const patch = buildIncrementPatch(model, increment, set, mapper);

				const stagedCreate = buffer.findCreateMatching(model, where);
				if (stagedCreate) {
					const { docData, appPatch } = applyIncrementPatch(
						stagedCreate.appData,
						patch,
					);
					Object.assign(stagedCreate.docData, docData);
					Object.assign(stagedCreate.appData, appPatch);
					return { ...stagedCreate.appData };
				}

				const candidates = await collectGuardCandidates(
					transaction,
					col,
					where,
					mapper,
				);
				for (const snap of candidates) {
					if (buffer.isDeleted(snap.ref.path)) continue;
					const staged = buffer.getByPath(snap.ref.path);
					const current =
						staged && staged.op !== "delete"
							? staged.appData
							: {
									id: snap.id,
									...dbDataToAppData(snap.data() ?? {}, mapper),
								};
					if (!matchesWhere(current, where)) continue;
					const { docData, appPatch } = applyIncrementPatch(current, patch);
					if (staged && staged.op !== "delete") {
						Object.assign(staged.docData, docData);
						Object.assign(staged.appData, appPatch);
						return { ...staged.appData };
					}
					const entry = buffer.stageUpdate(
						model,
						snap.ref,
						docData,
						appPatch,
						current,
					);
					return { ...entry.appData };
				}
				return null;
			},
			consumeOne: async ({ model, where }: any): Promise<any> => {
				const col = getCollectionRef(db, model, collections);
				const stagedCreate = buffer.findCreateMatching(model, where);
				if (stagedCreate) {
					buffer.stageDelete(model, stagedCreate.ref);
					return { ...stagedCreate.appData };
				}
				const doc = await lookupTxDoc(transaction, col, where, mapper);
				if (!doc || buffer.isDeleted(doc.ref.path)) return null;
				const staged = buffer.getByPath(doc.ref.path);
				const appData =
					staged && staged.op !== "delete"
						? { ...staged.appData }
						: (() => {
								const data = doc.data();
								return data
									? { id: doc.id, ...dbDataToAppData(data, mapper) }
									: null;
							})();
				if (!appData) return null;
				buffer.stageDelete(model, doc.ref);
				return appData;
			},
		};
	};

	// Shared by the plain adapter and by the factory wrapped around each
	// transaction adapter (see `transaction` below).
	const factoryConfig = {
		adapterId: "firestore",
		adapterName: "Firestore Adapter",
		supportsJSON: true,
		supportsDates: true,
		supportsBooleans: true,
		supportsNumericIds: false,
		debugLogs,
	} satisfies Omit<AdapterFactoryConfig, "transaction">;

	// The plain (non-transactional) custom adapter — the `adapter` half of
	// the factory options. `config` is assembled per instance below so that
	// `transaction` can close over that instance's better-auth options.
	const customAdapter = {
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

					// Same metadata-not-a-field constraint the tx path handles: an
					// `id` condition has to resolve to a doc ref, with the remaining
					// conditions checked in memory.
					const { id: idFilter, rest } = splitIdEqCondition(where);
					if (idFilter) {
						const snap = await col.doc(idFilter).get();
						if (!snap.exists) return 0;
						const appData = {
							id: snap.id,
							...dbDataToAppData(snap.data() ?? {}, mapper),
						};
						if (!matchesWhere(appData, rest)) return 0;
						await snap.ref.update(updateData);
						return 1;
					}

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
				consumeOne: async <T>({
					model,
					where,
				}: {
					model: string;
					where: WhereCondition[];
				}) => {
					const col = getCollectionRef(db, model, collections);
					return await db.runTransaction(async (transaction) => {
						const doc = await lookupTxDoc(transaction, col, where, mapper);
						if (!doc) return null;
						const data = doc.data();
						if (!data) return null;
						const appData = {
							id: doc.id,
							...dbDataToAppData(data, mapper),
						};
						transaction.delete(doc.ref);
						return appData as T;
					});
				},
				// Native guarded counter mutation — required by better-auth 1.7,
				// preferred over the transaction fallback by 1.6. See the section
				// header above `collectGuardCandidates` for the design.
				incrementOne: async <T>({
					model,
					where,
					increment,
					set,
				}: {
					model: string;
					where: WhereCondition[];
					increment: Record<string, number>;
					set?: Record<string, unknown> | undefined;
				}) => {
					const col = getCollectionRef(db, model, collections);
					const patch = buildIncrementPatch(model, increment, set, mapper);
					if (debugLogs) {
						console.log(`[Firestore Adapter] INCREMENTONE ${model}:`, {
							where,
							increment,
							set,
						});
					}
					return await db.runTransaction(async (transaction) => {
						const candidates = await collectGuardCandidates(
							transaction,
							col,
							where,
							mapper,
						);
						for (const snap of candidates) {
							const current = {
								id: snap.id,
								...dbDataToAppData(snap.data() ?? {}, mapper),
							};
							if (!matchesWhere(current, where)) continue;
							const { docData, appData } = applyIncrementPatch(current, patch);
							if (Object.keys(docData).length > 0) {
								transaction.update(snap.ref, docData);
							}
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] INCREMENTONE ${model} - returning:`,
									appData,
								);
							}
							return appData as T;
						}
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] INCREMENTONE ${model} - guard matched no document`,
							);
						}
						return null;
					});
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
							// Results are merged and sorted in memory below, so we skip
							// Firestore's orderBy to avoid composite-index requirements.
							const q = applyWhereClause(col, group, mapper);
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
							// Results are merged and sorted in memory below, so we skip
							// Firestore's orderBy to avoid composite-index requirements.
							const cq: FirebaseFirestore.Query = applyWhereClause(
								col,
								chunkedWhere,
								mapper,
							);
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

						// Results are filtered and sorted in memory below, so we skip
						// Firestore's orderBy to avoid composite-index requirements.
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

					// No client-side filtering needed.
					//
					// When a query pairs a `where` filter with a `sortBy` on a
					// different field, Firestore demands a composite index — this is
					// exactly the verification-token lookup better-auth performs
					// (`identifier ==` ordered by `createdAt desc`). Instead of
					// forcing every consumer to provision that index, we let
					// Firestore apply the filter server-side (covered by automatic
					// single-field indexes) and sort the already-narrowed matches in
					// memory. This mirrors the transaction `findMany` path.
					const hasWhereFilter = !!(where && where.length > 0);
					if (sortBy?.field && hasWhereFilter) {
						const filteredSnap = await q.get();
						let ordered = filteredSnap.docs.map((d) => {
							const data = d.data();
							const result: any = { id: d.id };
							for (const [k, v] of Object.entries(data)) {
								result[mapper.fromDb(k)] = convertTimestamp(v);
							}
							return result;
						});
						ordered.sort((a: any, b: any) => {
							const aVal = a[sortBy.field];
							const bVal = b[sortBy.field];
							const dir = sortBy.direction === "desc" ? -1 : 1;
							if (aVal < bVal) return -1 * dir;
							if (aVal > bVal) return 1 * dir;
							return 0;
						});
						if (offset) ordered = ordered.slice(offset);
						if (limit) ordered = ordered.slice(0, limit);
						return ordered as any[];
					}

					// No filter (or no sort): a lone `orderBy`/offset is served by an
					// automatic single-field index, so Firestore can page natively.
					// Firestore requires orderBy before using offset.
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

					const q: FirebaseFirestore.Query = applyWhereClause(
						col,
						where,
						mapper,
					);
					const snap = await q.count().get();
					return snap.data().count ?? 0;
				},
			};
		},
	} satisfies Pick<AdapterFactoryOptions, "adapter">;

	// One factory per `betterAuth()` instance, bound to that instance's
	// options: `transaction` needs them to wrap its per-transaction adapter in
	// a factory with the same schema, id generation and model/field-name
	// mapping as the plain adapter — the approach `@better-auth/mongo-adapter`
	// takes, minus its shared mutable options.
	return (options) => {
		if (migrationChecks) {
			// Best effort and off the request path: a failed check (no
			// permission for aggregations, offline emulator) must not affect
			// authentication.
			warnIfAccountsLackIssuer(
				db,
				options,
				namingStrategy,
				collections,
				mapper,
				(message) => console.warn(message),
			).catch(() => undefined);
		}
		return createAdapterFactory({
			...customAdapter,
			config: {
				...factoryConfig,
				// `runWithTransaction` stores whatever `run` receives as the
				// current adapter for the rest of the callback, and better-auth
				// internals and plugins then call it exactly like the top-level
				// adapter: with schema model keys (`user`), unmapped field names
				// and untransformed data, relying on the factory for
				// `modelName`/`fieldName` mapping, id generation, defaults and
				// date/JSON conversion. Handing `run` the raw custom adapter
				// skipped all of that — harmless while every `modelName` equalled
				// its model key, but silently targeting the wrong collection the
				// moment one was customised. So each transaction gets its own
				// factory-wrapped adapter, with `transaction: false` so nested
				// `transaction()` calls run as-is on the same Firestore
				// transaction.
				transaction: async (run) => {
					return await db.runTransaction(async (transaction: Transaction) => {
						const buffer = new TxBuffer();
						const txAdapter = createAdapterFactory({
							config: { ...factoryConfig, transaction: false },
							adapter: () => createTransactionAdapter(transaction, buffer),
						})(options);
						const result = await run(txAdapter);
						buffer.flush(transaction);
						return result;
					});
				},
			},
		})(options);
	};
};
