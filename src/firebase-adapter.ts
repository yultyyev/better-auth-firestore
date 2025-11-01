import {
	createAdapterFactory,
	type DBAdapterDebugLogOption,
} from "better-auth/adapters";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { initFirestore } from "./firestore";
import type { FirestoreAdapterConfig, NamingStrategy } from "./types";

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

function mapFieldsFactory(preferSnakeCase?: boolean): FieldMapper {
	if (preferSnakeCase) {
		return {
			toDb: (field: string) => MAP_TO_FIRESTORE[field] ?? field,
			fromDb: (field: string) => MAP_FROM_FIRESTORE[field] ?? field,
		};
	}
	return { toDb: identity, fromDb: identity } as FieldMapper;
}

type WhereCondition = {
	field: string;
	operator?: string;
	value: any;
	connector?: "AND" | "OR";
};

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
	// Only suffix collection names in test mode (when using emulator) to isolate test suites
	const isTestMode = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
	const suffix = isTestMode ? (snake ? "_snake" : "_default") : "";
	return {
		users: overrides?.users ?? `users${suffix}`,
		sessions: overrides?.sessions ?? `sessions${suffix}`,
		accounts: overrides?.accounts ?? `accounts${suffix}`,
		verificationTokens:
			overrides?.verificationTokens ??
			(snake ? `verification_tokens${suffix}` : `verificationTokens${suffix}`),
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

export interface FirestoreAdapterOptions
	extends Omit<FirestoreAdapterConfig, "firestore"> {
	firestore?: Firestore;
	debugLogs?: DBAdapterDebugLogOption;
}

export const firestoreAdapter = (
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
					const txAdapter = {
						create: async ({ model, data }: any) => {
							const col = getCollectionRef(db, model, collections);
							let ref = col.doc();
							const docData: any = {};
							for (const [k, v] of Object.entries(data)) {
								if (k === "id" && v) {
									ref = col.doc(v as string);
									continue;
								}
								docData[mapper.toDb(k)] = v;
							}
							transaction.set(ref, docData);
							return { ...data, id: ref.id };
						},
						update: async ({ model, where, update }: any) => {
							const col = getCollectionRef(db, model, collections);
							const q = applyWhereClause(col, where, mapper);
							const snap = await transaction.get(q.limit(1));
							const doc = snap.docs[0];
							if (!doc) return null;
							const updateData: any = {};
							for (const [k, v] of Object.entries(update)) {
								updateData[mapper.toDb(k)] = v;
							}
							transaction.update(doc.ref, updateData);
							const existing = doc.data();
							const result: any = { id: doc.id };
							if (existing) {
								for (const [k, v] of Object.entries(existing)) {
									result[mapper.fromDb(k)] = v;
								}
							}
							return { ...result, ...update };
						},
						findOne: async ({ model, where }: any) => {
							const col = getCollectionRef(db, model, collections);
							const q = applyWhereClause(col, where, mapper);
							const snap = await transaction.get(q.limit(1));
							const doc = snap.docs[0];
							if (!doc) return null;
							const data = doc.data();
							if (!data) return null;
							const result: any = { id: doc.id };
							for (const [k, v] of Object.entries(data)) {
								result[mapper.fromDb(k)] = convertTimestamp(v);
							}
							return result;
						},
					};
					return run(txAdapter as any);
				});
			},
		},
		adapter: () => {
			return {
				create: async ({ model, data }) => {
					const col = getCollectionRef(db, model, collections);
					let ref = col.doc();
					const docData: any = {};
					for (const [k, v] of Object.entries(data)) {
						if (k === "id" && v) {
							ref = col.doc(v as string);
							continue;
						}
						docData[mapper.toDb(k)] = v;
					}
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
							...data,
							...result,
						});
					}
					return { ...data, ...result };
				},
				update: async ({ model, where, update }) => {
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

						const updateData: any = {};
						for (const [k, v] of Object.entries(
							update as Record<string, any>,
						)) {
							updateData[mapper.toDb(k)] = v;
						}
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

					const q = applyWhereClause(col, where, mapper);
					if (debugLogs) {
						console.log(`[Firestore Adapter] UPDATE ${model}:`, {
							where,
							update,
							collection: collections,
						});
					}
					const snap = await q.limit(1).get();
					const doc = snap.docs[0];
					if (!doc) {
						if (debugLogs) {
							console.log(
								`[Firestore Adapter] UPDATE ${model} - no document found`,
							);
						}
						return null as any;
					}

					const updateData: any = {};
					for (const [k, v] of Object.entries(update as Record<string, any>)) {
						updateData[mapper.toDb(k)] = v;
					}
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
					const q = applyWhereClause(col, where, mapper);
					const snap = await q.get();
					let count = 0;
					const updateData: any = {};
					for (const [k, v] of Object.entries(update)) {
						updateData[mapper.toDb(k)] = v;
					}
					for (const d of snap.docs) {
						await d.ref.update(updateData);
						count++;
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

					const q = applyWhereClause(col, where, mapper);
					const snap = await q.limit(1).get();
					const doc = snap.docs[0];
					if (doc) await doc.ref.delete();
				},
				deleteMany: async ({ model, where }) => {
					const col = getCollectionRef(db, model, collections);
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

					const q = applyWhereClause(col, where, mapper);
					if (debugLogs) {
						console.log(`[Firestore Adapter] FINDONE ${model}:`, {
							where,
							select,
							collection: collections,
						});
					}
					const snap = await q.limit(1).get();
					if (debugLogs) {
						console.log(
							`[Firestore Adapter] FINDONE ${model} - snapshot size:`,
							snap.size,
							"docs:",
							snap.docs.length,
						);
					}
					const doc = snap.docs[0];
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
									console.log(`[Firestore Adapter] FINDMANY ${model} [using direct doc lookups for IDs]:`, {
										where,
										ids,
									});
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
									console.log(`[Firestore Adapter] FINDMANY ${model} [handling notIn for IDs]:`, {
										where,
									});
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

					let q: FirebaseFirestore.Query = applyWhereClause(col, where, mapper);

					const notInCondition = where?.find(
						(w) =>
							(w.operator as string) === "notIn" ||
							(w.operator as string) === "not_in",
					);
					if (notInCondition) {
						const snap = await q.get();
						const fieldName = notInCondition.field;
						const arr = Array.isArray(notInCondition.value)
							? notInCondition.value
							: [notInCondition.value];
						return snap.docs.filter((d) => {
							const data = d.data();
							const value = data[mapper.toDb(fieldName)];
							return !arr.includes(value);
						}).length;
					}

					const snap = await q.count().get();
					return snap.data().count ?? 0;
				},
			};
		},
	});
};
