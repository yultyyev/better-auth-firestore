import { type Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * Firestore-backed secondaryStorage adapter for better-auth.
 *
 * Intended for tests and examples only — not recommended for production.
 * The point of secondaryStorage is to offload hot data from the primary DB
 * to a fast K/V store. Reusing Firestore defeats that.
 *
 * Implements the full `SecondaryStorage` contract, including the two
 * methods better-auth 1.7 made required: `getAndDelete` (atomic single-use
 * consume) and `increment` (atomic counter for secondary-storage-backed
 * rate limiting). Both run inside a Firestore transaction so concurrent
 * callers cannot double-consume a key or lose an increment.
 */
export function firestoreSecondaryStorage(
	db: Firestore,
	collection = "_kv",
) {
	const col = db.collection(collection);
	// Keys are used verbatim as document IDs, and better-auth's keys can
	// contain `/` (rate-limit keys embed the request path, e.g.
	// `203.0.113.20|/sign-in/email`). Firestore reads a slash as a path
	// separator, so an unencoded key would land in a nested subcollection —
	// or throw, for an odd number of segments.
	const doc = (key: string) => col.doc(encodeURIComponent(key));

	type Entry = { value: string; expiresAt: Timestamp | null };
	const isExpired = (entry: Entry) =>
		!!entry.expiresAt && entry.expiresAt.toMillis() < Date.now();

	return {
		get: async (key: string): Promise<string | null> => {
			const snap = await doc(key).get();
			if (!snap.exists) return null;
			const data = snap.data() as Entry | undefined;
			if (!data) return null;
			if (isExpired(data)) {
				await snap.ref.delete();
				return null;
			}
			return data.value;
		},
		set: async (key: string, value: string, ttl?: number) => {
			await doc(key).set({
				value,
				expiresAt: ttl
					? Timestamp.fromMillis(Date.now() + ttl * 1000)
					: null,
			});
		},
		delete: async (key: string) => {
			await doc(key).delete();
		},
		/**
		 * Reads and deletes `key` in one step. Two concurrent callers can't
		 * both observe the value: Firestore serializes the transaction against
		 * the document it read, so the loser re-runs and finds it gone.
		 */
		getAndDelete: async (key: string): Promise<string | null> => {
			const ref = doc(key);
			return db.runTransaction(async (tx) => {
				const snap = await tx.get(ref);
				if (!snap.exists) return null;
				const data = snap.data() as Entry | undefined;
				tx.delete(ref);
				if (!data || isExpired(data)) return null;
				return data.value;
			});
		},
		/**
		 * Increments the counter at `key` by one and returns the new value.
		 * The expiry is set only when the key is first created (or has
		 * expired), never extended — so the counter lives for a fixed window
		 * from its first hit, which is what the rate limiter expects.
		 */
		increment: async (key: string, ttl: number): Promise<number> => {
			const ref = doc(key);
			return db.runTransaction(async (tx) => {
				const snap = await tx.get(ref);
				const data = snap.exists ? (snap.data() as Entry | undefined) : undefined;
				if (!data || isExpired(data)) {
					tx.set(ref, {
						value: "1",
						expiresAt: Timestamp.fromMillis(Date.now() + ttl * 1000),
					});
					return 1;
				}
				const next = (Number(data.value) || 0) + 1;
				tx.update(ref, { value: String(next) });
				return next;
			});
		},
	};
}
