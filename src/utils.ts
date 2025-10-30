import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";

export type FieldMapper = {
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

export function mapFieldsFactory(preferSnakeCase?: boolean): FieldMapper {
	if (preferSnakeCase) {
		return {
			toDb: (field: string) => MAP_TO_FIRESTORE[field] ?? field,
			fromDb: (field: string) => MAP_FROM_FIRESTORE[field] ?? field,
		};
	}
	return { toDb: identity, fromDb: identity } as FieldMapper;
}

export function getConverter<Document extends Record<string, any>>(options: {
	excludeId?: boolean;
	preferSnakeCase?: boolean;
}) {
	const mapper = mapFieldsFactory(options?.preferSnakeCase);

	return {
		toFirestore(object: Document) {
			const document: Record<string, unknown> = {};
			for (const key in object) {
				if (key === "id") continue;
				const value = object[key];
				if (value !== undefined) {
					document[mapper.toDb(key)] = value as unknown;
				}
			}
			return document;
		},
		fromFirestore(
			snapshot: FirebaseFirestore.QueryDocumentSnapshot<Document>,
		): Document {
			const document = snapshot.data()!;
			const object: Record<string, unknown> = {};
			if (!options?.excludeId) object.id = snapshot.id;
			for (const key in document) {
				let value: any = (document as any)[key];
				if (value instanceof Timestamp) value = value.toDate();
				object[mapper.fromDb(key)] = value;
			}
			return object as Document;
		},
	} satisfies FirebaseFirestore.FirestoreDataConverter<Document>;
}

export async function getOneDoc<T>(
	querySnapshot: FirebaseFirestore.Query<T>,
): Promise<T | null> {
	const querySnap = await querySnapshot.limit(1).get();
	return querySnap.docs[0]?.data() ?? null;
}

export async function getDoc<T>(
	docRef: FirebaseFirestore.DocumentReference<T>,
): Promise<T | null> {
	const docSnap = await docRef.get();
	return docSnap.data() ?? null;
}

export async function deleteDocs<T>(
	querySnapshot: FirebaseFirestore.Query<T>,
): Promise<void> {
	const querySnap = await querySnapshot.get();
	for (const doc of querySnap.docs) {
		await doc.ref.delete();
	}
}

export function collectionsFactory(
	db: Firestore,
	preferSnakeCase = false,
	collections: {
		users: string;
		sessions: string;
		accounts: string;
		verificationTokens: string;
	},
) {
	return {
		users: db
			.collection(collections.users)
			.withConverter(getConverter<any>({ preferSnakeCase })),
		sessions: db
			.collection(collections.sessions)
			.withConverter(getConverter<any>({ preferSnakeCase })),
		accounts: db
			.collection(collections.accounts)
			.withConverter(getConverter<any>({ preferSnakeCase })),
		verification_tokens: db
			.collection(collections.verificationTokens)
			.withConverter(getConverter<any>({ preferSnakeCase, excludeId: true })),
	};
}
