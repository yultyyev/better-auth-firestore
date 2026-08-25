import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { initFirestore } from "./firestore.js";
import type { NamingStrategy } from "./types.js";

// Better Auth 1.7 identifies an external account by the pair
// `(issuer, accountId)` and made `account.issuer` a required field. SQL
// users get the column from `npx auth migrate` plus a backfill from the
// upgrade guide; Firestore has no migration runner, so this helper stamps
// `issuer` onto existing account documents using the same rules 1.7 applies
// when it creates accounts — falling back to `issuers`/`resolveIssuer`
// rather than guessing for the handful of built-in providers whose real
// issuer isn't knowable offline. Rows that are never backfilled are
// invisible to 1.7's lookups — existing users can't sign in.
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
 * Issuer for an OAuth provider that doesn't publish one of its own — mirrors
 * `createOAuthAccountIssuer` in `@better-auth/core`. Most built-in social
 * providers fall into this case, but not all: see {@link KNOWN_OAUTH_ISSUERS}
 * and {@link UNRESOLVABLE_OAUTH_PROVIDERS} for the exceptions this module's
 * default resolution already accounts for.
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
	 * Explicit issuer per `providerId`. Required for built-in providers
	 * whose real issuer can't be guessed offline — `cognito`, `paybin`,
	 * `microsoft` (Entra ID) — and for any generic OAuth provider configured
	 * with discovery or a custom `accountIssuer` (Okta, Auth0, Keycloak, …).
	 * `apple`, `facebook`, `google`, and `line` resolve to their real issuer
	 * automatically; every other built-in provider gets the synthetic
	 * `local:oauth:<providerId>` issuer 1.7 assigns them when it has no
	 * `accountIssuer` of its own.
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
	/**
	 * Documents with no `providerId`, whose resolver returned nothing, or
	 * whose provider's real issuer isn't knowable offline (`cognito`,
	 * `paybin`, `microsoft`) — pass `issuers`/`resolveIssuer` for those.
	 */
	unresolved: string[];
	/**
	 * Credential accounts whose `accountId` was repaired to equal `userId`.
	 * 1.7 looks credential accounts up by `accountId === user.id`.
	 */
	credentialAccountIdsRepaired: number;
	/**
	 * Documents whose `issuer` this package's v1.3.0 backfill stamped with the
	 * synthetic `local:oauth:<providerId>` form for a provider that actually
	 * publishes a real one (`google`, `apple`, `facebook`, `line`), and which
	 * were re-stamped with the real issuer. Those accounts could not sign in
	 * on 1.7 until this ran. Empty for a deployment that never ran the v1.3.0
	 * backfill.
	 */
	legacyIssuersRepaired: { id: string; from: string; to: string }[];
	/**
	 * Documents the v1.3.0 backfill mis-stamped that were **not** repaired,
	 * because a correctly stamped document already claims their
	 * `(issuer, accountId)` pair — the user signed in during the outage and
	 * 1.7's email-linking branch wrote a fresh account row. Re-stamping the
	 * stale twin would collide on a pair 1.7 treats as unique, so it keeps
	 * its old issuer: inert, invisible to 1.7's lookups, and safe to delete
	 * at the operator's discretion.
	 */
	legacySupersededSkipped: { id: string; issuer: string; accountId: string }[];
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

/**
 * providerId -> issuer for built-in social providers whose `accountIssuer`
 * (in `@better-auth/core/social-providers`) is a fixed string, independent
 * of how the provider is configured. Verified against
 * `@better-auth/core@1.7.1`: `apple`, `facebook`, `google`, and `line` hard-code
 * these as literals; every other built-in provider either has no
 * `accountIssuer` at all (so 1.7 itself falls back to the synthetic
 * `local:oauth:<providerId>` form we mirror below) or one that can't be
 * guessed offline — see {@link UNRESOLVABLE_OAUTH_PROVIDERS}.
 */
const KNOWN_OAUTH_ISSUERS: Record<string, string> = {
	apple: "https://appleid.apple.com",
	facebook: "https://www.facebook.com",
	google: "https://accounts.google.com",
	line: "https://access.line.me",
};

/**
 * Providers that carry a real `accountIssuer` we cannot determine from a
 * `providerId` alone, because it depends on how the provider was configured
 * (or on the token itself). Left unresolved rather than stamped with a value
 * we know may be wrong — pass `--issuer` / `issuers` for them.
 *
 * Built-in social providers: `cognito` templates its issuer from
 * `region`/`userPoolId`, `paybin` from a configurable `issuer` option (it has
 * a hosted default, but a self-hosted deployment overrides it), and
 * `microsoft` — the built-in Entra ID provider's actual `id` — computes it
 * from the live token's `iss` claim.
 *
 * better-auth also ships generic-OAuth helpers with fixed `providerId`s that
 * always carry a real issuer: `okta` and `keycloak` (`accountIssuer: issuer`),
 * `auth0` (`https://<domain>/`), and `microsoft-entra-id` (no `accountIssuer`,
 * but a `discoveryUrl`, and the plugin resolves `accountIssuer ?? issuer` to
 * the discovered issuer).
 *
 * Deliberately NOT listed: `slack`. The generic-OAuth `slack` helper declares
 * `https://slack.com`, but the built-in social `slack` provider declares no
 * issuer and so genuinely resolves to the synthetic form. The two are
 * indistinguishable by `providerId`, and the built-in provider is the common
 * case, so `slack` keeps the synthetic default — pass `--issuer
 * slack=https://slack.com` if you use the generic-OAuth helper.
 */
const UNRESOLVABLE_OAUTH_PROVIDERS = new Set([
	// Built-in social providers.
	"cognito",
	"paybin",
	"microsoft",
	// Fixed-providerId generic-OAuth helpers.
	"okta",
	"auth0",
	"keycloak",
	"microsoft-entra-id",
]);

function defaultIssuerFor(providerId: string): string | undefined {
	if (providerId === CREDENTIAL_PROVIDER)
		return localAccountIssuer(CREDENTIAL_PROVIDER);
	if (providerId === SIWE_PROVIDER) return localAccountIssuer(SIWE_PROVIDER);
	if (providerId in KNOWN_OAUTH_ISSUERS) return KNOWN_OAUTH_ISSUERS[providerId];
	if (UNRESOLVABLE_OAUTH_PROVIDERS.has(providerId)) return undefined;
	return oauthAccountIssuer(providerId);
}

/**
 * True when a document's existing `issuer` is one this package's own v1.3.0
 * backfill wrote incorrectly: the synthetic `local:oauth:<providerId>` form
 * on a provider that publishes a fixed real issuer. Better Auth never writes
 * that pairing itself — 1.7 uses the real issuer — so it can only be the
 * legacy backfill's, and re-stamping it is safe. Anything else that's already
 * stamped is left alone: it may be a deliberate `issuers`/`resolveIssuer`
 * value, or one 1.7 wrote at runtime.
 */
function isLegacyMisstampedIssuer(
	providerId: string | undefined,
	issuer: string,
): boolean {
	if (!providerId) return false;
	if (!(providerId in KNOWN_OAUTH_ISSUERS)) return false;
	return issuer === oauthAccountIssuer(providerId);
}

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Stamps `account.issuer` onto existing account documents for the Better
 * Auth 1.7 identity model. Idempotent: documents that already carry an
 * issuer are skipped unless `overwrite` is set — except for issuers this
 * package's own v1.3.0 backfill provably got wrong, which are repaired and
 * reported as {@link BackfillAccountIssuersResult.legacyIssuersRepaired}
 * (see {@link isLegacyMisstampedIssuer}). Run it once, with authentication
 * writes paused, before deploying Better Auth 1.7 — and run it with
 * `dryRun: true` first to review the report.
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
		legacyIssuersRepaired: [],
		legacySupersededSkipped: [],
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

	// Documents the v1.3.0 backfill mis-stamped, held back until every other
	// document has been read so their repair target can be checked for an
	// existing claim.
	const pendingLegacy: {
		ref: FirebaseFirestore.DocumentReference;
		account: BackfillAccountRecord;
	}[] = [];

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

			// A document already carrying an issuer is normally left alone. The
			// exception is one our own v1.3.0 backfill provably mis-stamped:
			// leaving it would mean the operator re-runs the fixed command,
			// sees a clean report, and is still broken at sign-in. Those are
			// deferred to a second phase — the repair target may already be
			// claimed by another document, which we only know once every
			// document has been read.
			if (
				account.issuer !== undefined &&
				isLegacyMisstampedIssuer(account.providerId, account.issuer)
			) {
				pendingLegacy.push({ ref: doc.ref, account });
				continue;
			}

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

	// Phase two: repair what v1.3.0 mis-stamped, now that every pair claimed
	// by a document we are not rewriting is known. A user who signed in
	// during the outage self-healed through 1.7's email-linking branch and
	// already has a correctly stamped row for this `(issuer, accountId)`.
	// Re-stamping the stale twin would manufacture exactly the collision this
	// command tells operators to resolve by hand, so it is left as it is:
	// 1.7 never looks the synthetic issuer up, which makes the row inert.
	// Deleting it is the operator's call, not a migration's.
	let legacyBatch = db.batch();
	let legacyStaged = 0;
	for (const { ref, account } of pendingLegacy) {
		const issuer =
			options.resolveIssuer?.(account) ??
			(account.providerId ? options.issuers?.[account.providerId] : undefined) ??
			(account.providerId ? defaultIssuerFor(account.providerId) : undefined);
		if (!issuer) {
			result.unresolved.push(ref.id);
			continue;
		}

		const { accountId } = account;
		if (accountId !== undefined && byKey.has(JSON.stringify([issuer, accountId]))) {
			result.legacySupersededSkipped.push({ id: ref.id, issuer, accountId });
			result.skipped++;
			// The row keeps its old issuer, so report it under that.
			if (account.issuer !== undefined)
				track(account.issuer, accountId, ref.id);
			continue;
		}

		if (account.issuer !== undefined && issuer !== account.issuer)
			result.legacyIssuersRepaired.push({
				id: ref.id,
				from: account.issuer,
				to: issuer,
			});
		track(issuer, accountId, ref.id);
		result.updated++;
		if (!options.dryRun) {
			legacyBatch.update(ref, { [fields.issuer]: issuer });
			if (++legacyStaged >= batchSize) {
				await legacyBatch.commit();
				legacyBatch = db.batch();
				legacyStaged = 0;
			}
		}
	}
	if (legacyStaged > 0) await legacyBatch.commit();

	for (const [key, ids] of byKey) {
		if (ids.length < 2) continue;
		const [issuer, accountId] = JSON.parse(key) as [string, string];
		result.collisions.push({ issuer, accountId, ids });
	}
	return result;
}
