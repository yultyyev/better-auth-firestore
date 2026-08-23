import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { initFirestore } from "./firestore.js";
import type { NamingStrategy } from "./types.js";

// Better Auth 1.7 identifies an external account by the pair
// `(issuer, accountId)` and made `account.issuer` a required field. SQL
// users get the column from `npx auth migrate` plus a backfill from the
// upgrade guide; Firestore has no migration runner, so this helper stamps
// `issuer` onto existing account documents using the same rules 1.7 applies
// when it creates accounts. Rows that are never backfilled are invisible to
// 1.7's lookups — existing users can't sign in.
//
// https://better-auth.com/docs/guides/1-7-upgrade-guide

/**
 * Issuer for a "local" authentication method — mirrors
 * `createLocalAccountIssuer` in `@better-auth/core`.
 */
export function localAccountIssuer(providerId: string): string {
	return `local:${encodeURIComponent(providerId)}`;
}

/**
 * Issuer for an OAuth provider that doesn't publish one of its own
 * (every built-in social provider) — mirrors `createOAuthAccountIssuer` in
 * `@better-auth/core`.
 */
export function oauthAccountIssuer(providerId: string): string {
	return `local:oauth:${encodeURIComponent(providerId)}`;
}

/** Account document as seen by the backfill, with canonical field names. */
export interface BackfillAccountRecord {
	id: string;
	providerId: string | undefined;
	accountId: string | undefined;
	userId: string | undefined;
	issuer: string | undefined;
	/** The raw document data, for custom resolvers. */
	data: Record<string, unknown>;
}

export interface BackfillAccountIssuersOptions {
	/** Firestore instance. Defaults to `initFirestore()` (the default app). */
	firestore?: Firestore;
	/**
	 * Accounts collection name. Defaults to `accounts`, matching the
	 * adapter's default; pass the same override you give `firestoreAdapter`.
	 */
	collection?: string;
	/**
	 * The naming strategy passed to `firestoreAdapter`. Under `snake_case`
	 * the adapter stores the user reference as `user_id`.
	 */
	namingStrategy?: NamingStrategy;
	/** Field-name overrides, applied after `namingStrategy`. */
	fields?: {
		providerId?: string;
		accountId?: string;
		userId?: string;
		issuer?: string;
	};
	/**
	 * Explicit issuer per `providerId`, for providers that confirm a real
	 * issuer: Google One Tap (`https://accounts.google.com`), generic OAuth
	 * providers configured with discovery or `accountIssuer` (Okta, Auth0,
	 * Keycloak, Entra ID, …). Unlisted OAuth providers get the synthetic
	 * `local:oauth:<providerId>` issuer that 1.7 assigns them.
	 */
	issuers?: Record<string, string>;
	/**
	 * Full control: return the issuer for an account, or `null`/`undefined`
	 * to fall back to `issuers` and the built-in rules.
	 */
	resolveIssuer?: (account: BackfillAccountRecord) => string | null | undefined;
	/** Re-stamp documents that already carry an issuer. Default `false`. */
	overwrite?: boolean;
	/** Compute the report without writing anything. Default `false`. */
	dryRun?: boolean;
	/** Documents per read page / write batch (1–500). Default `500`. */
	batchSize?: number;
}

export interface BackfillAccountIssuersResult {
	/** Documents read. */
	scanned: number;
	/** Documents written (or that would be, under `dryRun`). */
	updated: number;
	/** Documents left alone because they already had an issuer. */
	skipped: number;
	/** Documents with no `providerId`, or whose resolver returned nothing. */
	unresolved: string[];
	/**
	 * Credential accounts whose `accountId` was repaired to equal `userId`.
	 * 1.7 looks credential accounts up by `accountId === user.id`.
	 */
	credentialAccountIdsRepaired: number;
	/** Number of documents per issuer, after the backfill. */
	byIssuer: Record<string, number>;
	/**
	 * `(issuer, accountId)` pairs shared by more than one document. 1.7
	 * treats the pair as unique — resolve these by hand before upgrading.
	 */
	collisions: { issuer: string; accountId: string; ids: string[] }[];
}

const CREDENTIAL_PROVIDER = "credential";
const SIWE_PROVIDER = "siwe";

function defaultIssuerFor(providerId: string): string {
	if (providerId === CREDENTIAL_PROVIDER)
		return localAccountIssuer(CREDENTIAL_PROVIDER);
	if (providerId === SIWE_PROVIDER) return localAccountIssuer(SIWE_PROVIDER);
	return oauthAccountIssuer(providerId);
}

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Stamps `account.issuer` onto existing account documents for the Better
 * Auth 1.7 identity model. Idempotent: documents that already carry an
 * issuer are skipped unless `overwrite` is set. Run it once, with
 * authentication writes paused, before deploying Better Auth 1.7 — and run
 * it with `dryRun: true` first to review the report.
 */
export async function backfillAccountIssuers(
	options: BackfillAccountIssuersOptions = {},
): Promise<BackfillAccountIssuersResult> {
	const db = options.firestore ?? initFirestore();
	const snake = options.namingStrategy === "snake_case";
	const fields = {
		providerId: options.fields?.providerId ?? "providerId",
		accountId: options.fields?.accountId ?? "accountId",
		userId: options.fields?.userId ?? (snake ? "user_id" : "userId"),
		issuer: options.fields?.issuer ?? "issuer",
	};
	const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 500);
	const col = db.collection(options.collection ?? "accounts");

	const result: BackfillAccountIssuersResult = {
		scanned: 0,
		updated: 0,
		skipped: 0,
		unresolved: [],
		credentialAccountIdsRepaired: 0,
		byIssuer: {},
		collisions: [],
	};
	// JSON-encoded (issuer, accountId) -> document ids, for the collision report.
	const byKey = new Map<string, string[]>();
	const track = (issuer: string, accountId: string | undefined, id: string) => {
		result.byIssuer[issuer] = (result.byIssuer[issuer] ?? 0) + 1;
		if (accountId === undefined) return;
		const key = JSON.stringify([issuer, accountId]);
		const ids = byKey.get(key);
		if (ids) ids.push(id);
		else byKey.set(key, [id]);
	};

	let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
	for (;;) {
		let query = col.orderBy(FieldPath.documentId()).limit(batchSize);
		if (last) query = query.startAfter(last);
		const page = await query.get();
		if (page.empty) break;

		const batch = db.batch();
		let staged = 0;
		for (const doc of page.docs) {
			result.scanned++;
			const data = doc.data();
			const account: BackfillAccountRecord = {
				id: doc.id,
				providerId: asString(data[fields.providerId]),
				accountId: asString(data[fields.accountId]),
				userId: asString(data[fields.userId]),
				issuer: asString(data[fields.issuer]),
				data,
			};

			if (account.issuer && !options.overwrite) {
				result.skipped++;
				track(account.issuer, account.accountId, doc.id);
				continue;
			}

			const issuer =
				options.resolveIssuer?.(account) ??
				(account.providerId
					? options.issuers?.[account.providerId]
					: undefined) ??
				(account.providerId ? defaultIssuerFor(account.providerId) : undefined);
			if (!issuer) {
				result.unresolved.push(doc.id);
				continue;
			}

			const update: Record<string, unknown> = { [fields.issuer]: issuer };
			let accountId = account.accountId;
			if (
				account.providerId === CREDENTIAL_PROVIDER &&
				account.userId &&
				account.accountId !== account.userId
			) {
				update[fields.accountId] = account.userId;
				accountId = account.userId;
				result.credentialAccountIdsRepaired++;
			}

			track(issuer, accountId, doc.id);
			result.updated++;
			if (!options.dryRun) {
				batch.update(doc.ref, update);
				staged++;
			}
		}
		if (staged > 0) await batch.commit();

		last = page.docs[page.docs.length - 1];
		if (page.size < batchSize) break;
	}

	for (const [key, ids] of byKey) {
		if (ids.length < 2) continue;
		const [issuer, accountId] = JSON.parse(key) as [string, string];
		result.collisions.push({ issuer, accountId, ids });
	}
	return result;
}
