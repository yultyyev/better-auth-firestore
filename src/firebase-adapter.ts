import { createHash } from "node:crypto";
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

/** The better-auth schema handed to the adapter creator by the factory. */
type AdapterSchema = Parameters<AdapterFactoryOptions["adapter"]>[0]["schema"];

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
	mode?: "sensitive" | "insensitive";
};

/**
 * Firestore caps the `IN` operator at 30 comparison values. When a `where`
 * clause passes more than this, queries throw with
 * `INVALID_ARGUMENT: 'IN' supports up to 30 comparison values.`
 * `queryServer` splits an oversized IN into chunks of this size and merges
 * the results.
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

const OPERATOR_ALIASES: Record<string, string> = {
	"==": "eq",
	"!=": "ne",
	notIn: "not_in",
	startsWith: "starts_with",
	"starts-with": "starts_with",
	endsWith: "ends_with",
	"ends-with": "ends_with",
	"array-contains": "contains",
};

/** A condition's operator in Better Auth's spelling (`eq` when omitted). */
function operatorOf(cond: WhereCondition): string {
	const op = cond.operator ?? "eq";
	return OPERATOR_ALIASES[op] ?? op;
}

/**
 * Adds one condition to a Firestore query. Only the operators `planGroup`
 * hands to Firestore reach this; every other operator is evaluated in memory.
 */
function applyOperator(
	query: FirebaseFirestore.Query,
	field: string,
	operator: string,
	value: any,
): FirebaseFirestore.Query {
	switch (operator) {
		case "eq":
			return query.where(field, "==", value);
		case "in":
			return query.where(field, "in", value);
		case "starts_with":
			return query
				.where(field, ">=", value)
				.where(field, "<", value + "\uf8ff");
		case "gt":
			return query.where(field, ">", value);
		case "gte":
			return query.where(field, ">=", value);
		case "lt":
			return query.where(field, "<", value);
		case "lte":
			return query.where(field, "<=", value);
		default:
			throw new Error(
				`[better-auth-firestore] operator "${operator}" is evaluated in memory, not by Firestore`,
			);
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

/**
 * Firestore enforces no unique constraints, but better-auth's database-backed
 * rate limiter relies on `rateLimit.key` being unique: it inserts a row for a
 * key it has not seen and treats a duplicate-key failure as "another request
 * created it — re-read and increment". Without the constraint, a burst of
 * concurrent first requests creates one row per request, each with its own
 * budget, and the limit is multiplied by the size of the burst. Keying that
 * model's documents by a hash of `key` and inserting with `create()` (which
 * fails on an existing document) restores the constraint. The rate limiter
 * never looks the row up by id.
 */
function uniqueKeyDocId(
	schema: AdapterSchema | undefined,
	model: string,
	docData: Record<string, any>,
	mapper: FieldMapper,
): string | undefined {
	const rateLimit = schema?.rateLimit;
	if (!rateLimit || rateLimit.modelName !== model) return undefined;
	const key = docData[mapper.toDb(rateLimit.fields.key?.fieldName ?? "key")];
	if (typeof key !== "string" || key === "") return undefined;
	return createHash("sha256").update(key).digest("hex");
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
// collapses to a single `create` at flush time, and `update` + `update`
// collapses to a single merged `update`. A create is flushed with
// `transaction.create`, which fails when the document already exists —
// better-auth's create is an INSERT, and its first-writer-wins reservations
// depend on a duplicate id failing (see the non-tx `create`). The buffer is
// constructed inside `runTransaction`, so Firestore's automatic retries on
// contention get a fresh buffer each pass.
//
// Reads overlay the buffer (see `txMatches` in the transaction adapter):
// staged creates are matched in memory with `matchesWhere`, documents read
// from Firestore are replaced by their staged state and re-checked, and
// staged deletes hide them. A staged update that makes a document match a
// where clause its stored fields do not satisfy is not found — better-auth
// never reads a row back by a field it changed in the same transaction.

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
	/**
	 * A create staged over a delete of the same ref in this transaction. The
	 * document still exists in Firestore until the flush, so it has to be
	 * replaced with `set` rather than inserted with `create`.
	 */
	replacesExisting?: boolean;
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
			replacesExisting: this.byPath.get(ref.path)?.op === "delete",
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

	/** Buffered creates for `model` whose appData satisfies `where`. */
	createsMatching(
		model: string,
		where: WhereCondition[] | undefined,
	): TxBufferWriteEntry[] {
		const entries: TxBufferWriteEntry[] = [];
		for (const entry of this.byPath.values()) {
			if (entry.op !== "create" || entry.model !== model) continue;
			if (matchesWhere(entry.appData, where)) entries.push(entry);
		}
		return entries;
	}

	/** Stage a delete on `ref`, discarding any prior create/update for the same path. */
	stageDelete(model: string, ref: FirebaseFirestore.DocumentReference): void {
		this.byPath.set(ref.path, { op: "delete", model, ref });
	}

	/** Buffered entry (create, update, or delete) for a specific ref path, if any. */
	getByPath(refPath: string): TxBufferEntry | undefined {
		return this.byPath.get(refPath);
	}

	/** Replay every staged write onto the transaction in insertion order. */
	flush(transaction: Transaction): void {
		for (const entry of this.byPath.values()) {
			if (entry.op === "create") {
				if (entry.replacesExisting) transaction.set(entry.ref, entry.docData);
				else transaction.create(entry.ref, entry.docData);
			} else if (entry.op === "update")
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
 * Evaluates a where clause against an in-memory app-side row. AND-within-
 * group, OR-between-groups (a new group starts at every `connector: "OR"`).
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

const isNullish = (value: unknown): value is null | undefined =>
	value === null || value === undefined;

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
	if (isNullish(left) || isNullish(right)) return false;
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

/**
 * Evaluates one condition against an app-side row, with the SQL null
 * semantics Better Auth's adapter contract (and its conformance suite)
 * expects:
 *
 * - A field the document does not have reads as null. The adapter never
 *   writes `undefined`, so an optional field nobody set is missing, not null.
 * - `eq null` is IS NULL and `ne null` is IS NOT NULL; a null element of an
 *   `in` list matches a null field; an `undefined` value means null.
 * - Every other comparison is false for a null field: `ne "x"`, `not_in`,
 *   ranges and the string operators only match fields that have a value.
 * - `mode: "insensitive"` compares strings case-insensitively (never `id`).
 * - `id` is the document id.
 */
function matchesCondition(
	appData: Record<string, any>,
	cond: WhereCondition,
): boolean {
	// A row read from Firestore carries canonical field names; a row staged
	// in a transaction keeps the names the factory mapped the data to.
	const val =
		cond.field in appData
			? appData[cond.field]
			: appData[canonicalizeFieldName(cond.field)];
	const insensitive = cond.mode === "insensitive" && cond.field !== "id";
	const norm = (value: unknown) => {
		const c = comparable(value);
		return insensitive && typeof c === "string" ? c.toLowerCase() : c;
	};
	const equals = (target: unknown) =>
		isNullish(target)
			? isNullish(val)
			: !isNullish(val) && norm(val) === norm(target);
	const list = (): unknown[] =>
		Array.isArray(cond.value) ? cond.value : [cond.value];
	const op = operatorOf(cond);
	switch (op) {
		case "eq":
			return equals(cond.value);
		case "ne":
			return isNullish(cond.value)
				? !isNullish(val)
				: !isNullish(val) && !equals(cond.value);
		case "in":
			return list().some(equals);
		case "not_in":
			return !isNullish(val) && !list().some(equals);
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return compareRelational(val, cond.value, op);
		case "contains":
			if (Array.isArray(val))
				return val.some((item) => norm(item) === norm(cond.value));
			return (
				typeof val === "string" &&
				String(norm(val)).includes(String(norm(cond.value)))
			);
		case "starts_with":
			return (
				typeof val === "string" &&
				String(norm(val)).startsWith(String(norm(cond.value)))
			);
		case "ends_with":
			return (
				typeof val === "string" &&
				String(norm(val)).endsWith(String(norm(cond.value)))
			);
		default:
			return equals(cond.value);
	}
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
// Reading a where clause
// ─────────────────────────────────────────────────────────────────────────────
// Every method, plain and transactional, finds its documents through
// `readMatches`, so a where clause means the same thing everywhere. Each OR
// group is planned on its own (`planGroup`):
//
// - An `id` `eq` / `in` condition reads those documents directly. The id is
//   document metadata, not a field: `where("id", …)` matches nothing.
// - Firestore evaluates only what its automatic single-field indexes serve,
//   so no consumer has to create a composite index: the group's equality
//   filters if it has any, otherwise its range filters on one field. An
//   equality next to a range on another field (`identifier == … AND
//   createdAt <= …`, `userId == … AND expiresAt > …`), or ranges on two
//   fields, would need one.
// - Everything else is checked in memory by `matchesCondition` on the
//   documents Firestore returns: the remaining ranges, every other `id`
//   condition (`ne`, `not_in`, ranges — compared with the document id),
//   comparisons with null (Firestore's `== null` misses a field that was
//   never written), `ne`, `not_in`, `contains`, `ends_with` and
//   case-insensitive conditions.
//
// Better Auth narrows every query by an id or an equality on a key, so the
// in-memory part sees a handful of documents. A group with no equality and
// no range reads the whole collection.

interface GroupPlan {
	/** Documents to read by id; the rest of the group is checked in memory. */
	docIds?: string[];
	/** Conditions Firestore evaluates. Empty: read the whole collection. */
	server: WhereCondition[];
	/** Conditions checked in memory on every document Firestore returns. */
	memory: WhereCondition[];
}

const isRangeOperator = (op: string): boolean =>
	op === "gt" ||
	op === "gte" ||
	op === "lt" ||
	op === "lte" ||
	op === "starts_with";

/** Plans one AND group, or returns `null` when it cannot match a document. */
function planGroup(group: WhereCondition[]): GroupPlan | null {
	const pin = group.find(
		(w) =>
			w.field === "id" && (operatorOf(w) === "eq" || operatorOf(w) === "in"),
	);
	if (pin) {
		const values: unknown[] = Array.isArray(pin.value)
			? pin.value
			: [pin.value];
		const docIds = [
			...new Set(
				values.filter((v): v is string => typeof v === "string" && v !== ""),
			),
		];
		// Every document has a non-empty string id.
		if (docIds.length === 0) return null;
		return { docIds, server: [], memory: group.filter((w) => w !== pin) };
	}

	const serverSafe = (w: WhereCondition) =>
		w.field !== "id" && w.mode !== "insensitive";
	const equality: WhereCondition[] = [];
	for (const w of group) {
		const op = operatorOf(w);
		if (op === "in") {
			if (Array.isArray(w.value) && w.value.length === 0) return null;
			// One `in` per query keeps Firestore's disjunction limit out of reach.
			if (
				serverSafe(w) &&
				Array.isArray(w.value) &&
				!w.value.some(isNullish) &&
				!equality.some((e) => operatorOf(e) === "in")
			)
				equality.push(w);
		} else if (op === "eq" && serverSafe(w) && !isNullish(w.value)) {
			equality.push(w);
		}
	}
	if (equality.length > 0)
		return {
			server: equality,
			memory: group.filter((w) => !equality.includes(w)),
		};

	const ranges = group.filter((w) => {
		const op = operatorOf(w);
		return (
			serverSafe(w) &&
			isRangeOperator(op) &&
			!isNullish(w.value) &&
			(op !== "starts_with" || typeof w.value === "string")
		);
	});
	const field = ranges[0]?.field;
	const server = ranges.filter((w) => w.field === field);
	return { server, memory: group.filter((w) => !server.includes(w)) };
}

/** How `readMatches` reads: plainly, or inside a Firestore transaction. */
interface DocReader {
	query(
		query: FirebaseFirestore.Query,
	): Promise<FirebaseFirestore.QueryDocumentSnapshot[]>;
	byRef(
		refs: FirebaseFirestore.DocumentReference[],
	): Promise<FirebaseFirestore.DocumentSnapshot[]>;
}

const plainReader = (db: Firestore): DocReader => ({
	query: async (query) => (await query.get()).docs,
	byRef: async (refs) => (refs.length > 0 ? db.getAll(...refs) : []),
});

const transactionReader = (transaction: Transaction): DocReader => ({
	query: async (query) => (await transaction.get(query)).docs,
	byRef: async (refs) => (refs.length > 0 ? transaction.getAll(...refs) : []),
});

function buildQuery(
	query: FirebaseFirestore.Query,
	conditions: WhereCondition[],
	mapper: FieldMapper,
): FirebaseFirestore.Query {
	let q = query;
	for (const w of conditions)
		q = applyOperator(q, mapper.toDb(w.field), operatorOf(w), w.value);
	return q;
}

/** Runs the Firestore half of a plan, splitting an oversized `in`. */
async function queryServer(
	reader: DocReader,
	col: FirebaseFirestore.CollectionReference,
	conditions: WhereCondition[],
	mapper: FieldMapper,
	limit: number | undefined,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
	const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
	for (const chunk of getChunkedWhereClauses(conditions)) {
		let q = buildQuery(col, chunk ?? [], mapper);
		if (limit !== undefined) q = q.limit(limit - docs.length);
		docs.push(...(await reader.query(q)));
		if (limit !== undefined && docs.length >= limit) break;
	}
	return docs;
}

/** A document that satisfies a where clause. */
interface Match {
	ref: FirebaseFirestore.DocumentReference;
	/** `id` plus the document's fields under their app-side names. */
	row: Record<string, any>;
}

/**
 * What the transaction adapter has staged for a document: its staged row
 * (re-checked against the whole group), `null` when it is staged for
 * deletion, `undefined` when nothing is staged.
 */
type ReadOverlay = (
	ref: FirebaseFirestore.DocumentReference,
) => Record<string, any> | null | undefined;

/**
 * Every document that satisfies `where`, each once, in the order Firestore
 * returns them; with `limit`, only the first ones.
 */
async function readMatches(
	reader: DocReader,
	col: FirebaseFirestore.CollectionReference,
	where: WhereCondition[] | undefined,
	mapper: FieldMapper,
	options: { limit?: number; overlay?: ReadOverlay } = {},
): Promise<Match[]> {
	const { limit, overlay } = options;
	const groups = where && where.length > 0 ? splitOrGroups(where) : [[]];
	const matches = new Map<string, Match>();
	for (const group of groups) {
		const plan = planGroup(group);
		if (!plan) continue;
		// Firestore may stop early only when it decides the whole match.
		const serverLimit =
			groups.length === 1 && plan.memory.length === 0 && !overlay
				? limit
				: undefined;
		const snaps = plan.docIds
			? await reader.byRef(plan.docIds.map((id) => col.doc(id)))
			: await queryServer(reader, col, plan.server, mapper, serverLimit);
		for (const snap of snaps) {
			if (!snap.exists || matches.has(snap.ref.path)) continue;
			const staged = overlay?.(snap.ref);
			if (staged === null) continue;
			const row = staged
				? { ...staged }
				: { id: snap.id, ...dbDataToAppData(snap.data() ?? {}, mapper) };
			const conditions = staged ? group : plan.memory;
			if (!conditions.every((cond) => matchesCondition(row, cond))) continue;
			matches.set(snap.ref.path, { ref: snap.ref, row });
			if (limit !== undefined && matches.size >= limit)
				return Array.from(matches.values());
		}
	}
	return Array.from(matches.values());
}

/**
 * The Firestore query that decides `where` on its own (one AND group,
 * nothing left for memory, no direct id reads, no oversized `in`), or
 * `undefined`. Only such a query can be counted, sorted or paged by
 * Firestore.
 */
function exactServerQuery(
	col: FirebaseFirestore.CollectionReference,
	where: WhereCondition[] | undefined,
	mapper: FieldMapper,
): { query: FirebaseFirestore.Query; hasRange: boolean } | undefined {
	const groups = where && where.length > 0 ? splitOrGroups(where) : [[]];
	const [group] = groups;
	if (groups.length !== 1 || !group) return undefined;
	const plan = planGroup(group);
	if (!plan || plan.docIds || plan.memory.length > 0) return undefined;
	if (findOversizedInClause(plan.server)) return undefined;
	return {
		query: buildQuery(col, plan.server, mapper),
		hasRange: plan.server.some((w) => isRangeOperator(operatorOf(w))),
	};
}

/** Sorts rows in memory, the way `findMany` does wherever Firestore can't. */
function sortRows(
	rows: Record<string, any>[],
	sortBy: { field: string; direction: "asc" | "desc" } | undefined,
): Record<string, any>[] {
	if (!sortBy?.field) return rows;
	const dir = sortBy.direction === "desc" ? -1 : 1;
	return [...rows].sort((a, b) => {
		const aVal = a[sortBy.field];
		const bVal = b[sortBy.field];
		if (aVal < bVal) return -1 * dir;
		if (aVal > bVal) return 1 * dir;
		return 0;
	});
}

/** Applies a `select` list: the selected fields that are set, plus `id`. */
function selectFields(
	row: Record<string, any>,
	select: string[] | undefined,
): Record<string, any> {
	if (!select || select.length === 0) return row;
	const selected: Record<string, any> = { id: row.id };
	for (const field of select) {
		if (row[field] !== undefined) selected[field] = row[field];
	}
	return selected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarded single-row mutation (`incrementOne`)
// ─────────────────────────────────────────────────────────────────────────────
// better-auth uses `incrementOne` as its compare-and-swap primitive: the
// `where` clause is both selector and guard (`count < max`, `lockedUntil <=
// now`, `revoked == null`, `status == "pending"`, …) and the row is mutated
// only while the guard still holds. Since 1.7 the adapter must provide it
// natively — the factory's `transaction(findMany + updateMany)` fallback is
// gone.
//
// Firestore has no conditional update, so we run a transaction: read the
// first row that satisfies the guard (`readMatches`), write once. Firestore
// serializes the transaction against concurrent writes to the rows it read,
// which gives the same "at most one row, only while the guard holds"
// semantics as `UPDATE … WHERE … RETURNING *`. As everywhere, only the
// equality part of the guard reaches Firestore, so the limiter's `key == …
// AND lastRequest > … AND count < …` needs no composite index.

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
	const directReader = plainReader(db);

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
		schema: AdapterSchema | undefined,
	): CustomAdapter => {
		const reader = transactionReader(transaction);
		const overlay: ReadOverlay = (ref) => {
			const staged = buffer.getByPath(ref.path);
			if (!staged) return undefined;
			return staged.op === "delete" ? null : staged.appData;
		};

		/**
		 * Rows that satisfy `where` in this transaction: staged creates first
		 * (Firestore can't see them until the flush), then Firestore documents
		 * with their staged writes applied and staged deletes left out.
		 */
		const txMatches = async (
			model: string,
			where: WhereCondition[] | undefined,
			limit?: number,
		): Promise<Match[]> => {
			const matches: Match[] = buffer
				.createsMatching(model, where)
				.map((entry) => ({ ref: entry.ref, row: { ...entry.appData } }));
			if (limit !== undefined && matches.length >= limit)
				return matches.slice(0, limit);
			const staged = new Set(matches.map((m) => m.ref.path));
			const col = getCollectionRef(db, model, collections);
			for (const match of await readMatches(reader, col, where, mapper, {
				limit,
				overlay,
			})) {
				if (!staged.has(match.ref.path)) matches.push(match);
			}
			return limit === undefined ? matches : matches.slice(0, limit);
		};

		const txFindMany = async ({
			model,
			where,
			limit,
			offset,
			sortBy,
		}: any): Promise<any[]> => {
			let results = sortRows(
				(await txMatches(model, where)).map((m) => m.row),
				sortBy,
			);
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
				const uniqueId = uniqueKeyDocId(schema, model, docData, mapper);
				const ref = uniqueId
					? col.doc(uniqueId)
					: idOverride
						? col.doc(idOverride)
						: col.doc();
				const entry = buffer.stageCreate(model, ref, docData, normalizedData);
				return { ...entry.appData };
			},
			// Stages the update, merged into whatever is already staged for the
			// document (a create stays a create), so the flush emits one write.
			update: async ({ model, where, update }: any): Promise<any> => {
				const normalizedUpdate = normalizeWriteData(model, update);
				const { docData: updateData } = buildFirestoreWriteData(
					normalizedUpdate,
					mapper,
				);
				const [match] = await txMatches(model, where, 1);
				if (!match) return null;
				const entry = buffer.stageUpdate(
					model,
					match.ref,
					updateData,
					normalizedUpdate,
					match.row,
				);
				return { ...entry.appData };
			},
			findOne: async ({ model, where }: any): Promise<any> => {
				const [match] = await txMatches(model, where, 1);
				return match ? { ...match.row } : null;
			},
			findMany: txFindMany,
			// `runWithTransaction` hands the factory-wrapped form of this
			// object to plugins as the current adapter, so it has to expose
			// the full `CustomAdapter` surface — the organization plugin
			// counts members inside its transactions.
			count: async ({ model, where }: any) => {
				return (await txMatches(model, where)).length;
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
				const normalizedUpdate = normalizeWriteData(model, update);
				const { docData: updateData } = buildFirestoreWriteData(
					normalizedUpdate,
					mapper,
				);
				const matches = await txMatches(model, where);
				for (const match of matches) {
					buffer.stageUpdate(
						model,
						match.ref,
						updateData,
						normalizedUpdate,
						match.row,
					);
				}
				return matches.length;
			},
			// `consumeVerificationValue` runs its cleanup through this:
			// `identifier ==`, `id != latest`, `createdAt <= latest.createdAt`.
			deleteMany: async ({ model, where }: any) => {
				const matches = await txMatches(model, where);
				for (const match of matches) buffer.stageDelete(model, match.ref);
				return matches.length;
			},
			// Single-doc variant of `deleteMany`: `deleteWithHooks` and the
			// organization plugin call `delete` on the current adapter
			// inside transactions.
			delete: async ({ model, where }: any) => {
				const [match] = await txMatches(model, where, 1);
				if (match) buffer.stageDelete(model, match.ref);
			},
			// Transactional `incrementOne` (see the section header above
			// `buildIncrementPatch`). The enclosing Firestore transaction
			// already provides atomicity, so this only has to find the first
			// row that satisfies the guard and fold the patch into the buffer
			// so the flush emits one write per ref.
			incrementOne: async ({
				model,
				where,
				increment,
				set,
			}: any): Promise<any> => {
				const patch = buildIncrementPatch(model, increment, set, mapper);
				const [match] = await txMatches(model, where, 1);
				if (!match) return null;
				const { docData, appPatch } = applyIncrementPatch(match.row, patch);
				const entry = buffer.stageUpdate(
					model,
					match.ref,
					docData,
					appPatch,
					match.row,
				);
				return { ...entry.appData };
			},
			consumeOne: async ({ model, where }: any): Promise<any> => {
				const [match] = await txMatches(model, where, 1);
				if (!match) return null;
				buffer.stageDelete(model, match.ref);
				return match.row;
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
		adapter: ({ schema }) => {
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
					const uniqueId = uniqueKeyDocId(schema, model, docData, mapper);
					const ref = uniqueId
						? col.doc(uniqueId)
						: idOverride
							? col.doc(idOverride)
							: col.doc();
					if (debugLogs) {
						console.log(`[Firestore Adapter] CREATE ${model}:`, {
							input: data,
							docData,
							collection: collections,
							collectionRef: col.path,
							docId: ref.id,
						});
					}
					// `create`, not `set`: an existing document must make the insert
					// fail, as it does in every SQL adapter and in MongoDB. better-auth's
					// first-writer-wins reservations (`reserveVerificationValue`: SAML
					// assertion and DPoP proof replay protection, the SIWE email claim,
					// the 1.7 unverified-account cleanup lock) create with a
					// deterministic id and treat a duplicate-id failure as "someone else
					// got there first"; `set` let every caller win.
					await ref.create(docData);
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
					if (debugLogs) {
						console.log(`[Firestore Adapter] UPDATE ${model}:`, {
							where,
							update,
							collectionRef: col.path,
						});
					}
					const [match] = await readMatches(directReader, col, where, mapper, {
						limit: 1,
					});
					if (!match) {
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] UPDATE ${model} - no document found`,
							);
						}
						return null as any;
					}

					const { docData: updateData } = buildFirestoreWriteData(
						normalizedUpdate,
						mapper,
					);
					await match.ref.update(updateData);
					// Read the updated document to return full object
					const updated = await match.ref.get();
					const result = {
						id: updated.id,
						...dbDataToAppData(updated.data() ?? {}, mapper),
					};
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] UPDATE ${model} - returning:`,
							result,
						);
					}
					return result as any;
				},
				updateMany: async ({ model, where, update }) => {
					const col = getCollectionRef(db, model, collections);
					const normalizedUpdate = normalizeWriteData(
						model,
						update as Record<string, any>,
					);
					const { docData: updateData } = buildFirestoreWriteData(
						normalizedUpdate,
						mapper,
					);
					const matches = await readMatches(directReader, col, where, mapper);
					for (const match of matches) await match.ref.update(updateData);
					return matches.length;
				},
				delete: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);
					const [match] = await readMatches(directReader, col, where, mapper, {
						limit: 1,
					});
					if (match) await match.ref.delete();
				},
				deleteMany: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);
					const matches = await readMatches(directReader, col, where, mapper);
					for (const match of matches) await match.ref.delete();
					return matches.length;
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
						const [match] = await readMatches(
							transactionReader(transaction),
							col,
							where,
							mapper,
							{ limit: 1 },
						);
						if (!match) return null;
						transaction.delete(match.ref);
						return match.row as T;
					});
				},
				// Native guarded counter mutation — required by better-auth 1.7,
				// preferred over the transaction fallback by 1.6. See the section
				// header above `buildIncrementPatch` for the design.
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
						const [match] = await readMatches(
							transactionReader(transaction),
							col,
							where,
							mapper,
							{ limit: 1 },
						);
						if (!match) {
							if (debugLogs) {
								console.log(
									`[Firestore Adapter] INCREMENTONE ${model} - guard matched no document`,
								);
							}
							return null;
						}
						const { docData, appData } = applyIncrementPatch(match.row, patch);
						if (Object.keys(docData).length > 0) {
							transaction.update(match.ref, docData);
						}
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] INCREMENTONE ${model} - returning:`,
								appData,
							);
						}
						return appData as T;
					});
				},
				findOne: async ({ model, where, select }) => {
					const col = getCollectionRef(db, model, collections);
					if (debugLogs) {
						console.log(`[Firestore Adapter] FINDONE ${model}:`, {
							where,
							select,
							collectionRef: col.path,
						});
					}
					const [match] = await readMatches(directReader, col, where, mapper, {
						limit: 1,
					});
					// A document without a single field is not a row.
					if (!match || Object.keys(match.row).length <= 1) {
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] FINDONE ${model} - no document found`,
							);
						}
						return null as any;
					}
					const result = selectFields(match.row, select);
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - returning:`,
							result,
						);
					}
					return result as any;
				},
				findMany: async ({ model, where, limit, offset, sortBy }) => {
					const col = getCollectionRef(db, model, collections);

					// Firestore sorts and pages natively only when it decides the
					// whole where clause and the sort needs no composite index: a
					// sort without a filter, or a filter without a sort (paged by
					// document id; a range filter orders by its own field, so it
					// takes a limit but no offset). A filtered and sorted query —
					// the verification-token lookup (`identifier ==` ordered by
					// `createdAt desc`) — is narrowed by Firestore and sorted here.
					const exact = exactServerQuery(col, where, mapper);
					const filtered = !!(where && where.length > 0);
					if (
						exact &&
						!(sortBy?.field && filtered) &&
						!(exact.hasRange && offset)
					) {
						let q = exact.query;
						if (sortBy?.field) {
							q = q.orderBy(
								mapper.toDb(sortBy.field),
								sortBy.direction === "desc" ? "desc" : "asc",
							);
						} else if (offset) {
							q = q.orderBy(FieldPath.documentId());
						}
						if (offset) q = q.offset(offset);
						if (limit) q = q.limit(limit);
						const snap = await q.get();
						return snap.docs.map((d) => ({
							id: d.id,
							...dbDataToAppData(d.data(), mapper),
						})) as any[];
					}

					let results = sortRows(
						(await readMatches(directReader, col, where, mapper)).map(
							(m) => m.row,
						),
						sortBy,
					);
					if (offset) results = results.slice(offset);
					if (limit) results = results.slice(0, limit);
					return results as any[];
				},
				count: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);
					const exact = exactServerQuery(col, where, mapper);
					if (exact) {
						const snap = await exact.query.count().get();
						return snap.data().count ?? 0;
					}
					return (await readMatches(directReader, col, where, mapper)).length;
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
							adapter: ({ schema }) =>
								createTransactionAdapter(transaction, buffer, schema),
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
