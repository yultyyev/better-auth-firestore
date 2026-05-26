import { type Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * Firestore-backed secondaryStorage adapter for better-auth.
 *
 * Intended for tests and examples only — not recommended for production.
 * The point of secondaryStorage is to offload hot data from the primary DB
 * to a fast K/V store. Reusing Firestore defeats that.
 */
export function firestoreSecondaryStorage(
	db: Firestore,
	collection = "_kv",
) {
	const col = db.collection(collection);
	return {
		get: async (key: string): Promise<string | null> => {
			const snap = await col.doc(key).get();
			if (!snap.exists) return null;
			const data = snap.data() as
				| { value: string; expiresAt: Timestamp | null }
				| undefined;
			if (!data) return null;
			if (data.expiresAt && data.expiresAt.toMillis() < Date.now()) {
				await snap.ref.delete();
				return null;
			}
			return data.value;
		},
		set: async (key: string, value: string, ttl?: number) => {
			await col.doc(key).set({
				value,
				expiresAt: ttl
					? Timestamp.fromMillis(Date.now() + ttl * 1000)
					: null,
			});
		},
		delete: async (key: string) => {
			await col.doc(key).delete();
		},
	};
}
