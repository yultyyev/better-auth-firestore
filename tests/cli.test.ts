import type { Firestore } from "firebase-admin/firestore";
import { type CliIO, runCli } from "../src/cli";
import { initFirestore } from "../src/firestore";

// `npx better-auth-firestore backfill-account-issuers` — the one-command
// form of the Better Auth 1.7 account-issuer migration. Driven in-process;
// FIRESTORE_EMULATOR_HOST makes the CLI's own Admin app hit the emulator.

const ACCOUNTS = "cli_accounts";

function captureIO() {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIO = {
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
	};
	return {
		io,
		out,
		err,
		text: () => out.join("\n"),
		errors: () => err.join("\n"),
	};
}

async function clearCollection(db: Firestore, name: string) {
	const snap = await db.collection(name).get();
	await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

describe("backfill-account-issuers CLI", () => {
	const db = initFirestore({ name: "test-cli", projectId: "test" });
	const accounts = db.collection(ACCOUNTS);

	beforeAll(() => {
		// The CLI resolves the project like the adapter does; point it at the
		// emulator project the seeds live in.
		process.env.FIREBASE_PROJECT_ID = "test";
	});

	afterEach(async () => {
		await clearCollection(db, ACCOUNTS);
	});

	it("dry-runs by default: reports, writes nothing, exits 0", async () => {
		await accounts.doc("c1").set({
			providerId: "credential",
			accountId: "u1",
			userId: "u1",
		});
		await accounts.doc("g1").set({
			providerId: "google",
			accountId: "g-1",
			userId: "u1",
		});

		const { io, text } = captureIO();
		const code = await runCli(
			["backfill-account-issuers", "--collection", ACCOUNTS],
			io,
		);

		expect(code).toBe(0);
		expect(text()).toContain("Dry run over 2 account documents");
		expect(text()).toContain("would update: 2");
		expect(text()).toContain("local:credential  1");
		expect(text()).toContain("local:oauth:google  1");
		expect(text()).toContain("Nothing was written");
		expect((await accounts.doc("c1").get()).data()?.issuer).toBeUndefined();
	});

	it("--apply writes, honours --issuer and --naming-strategy, and is idempotent", async () => {
		await accounts.doc("okta").set({
			providerId: "okta",
			accountId: "00u1",
			user_id: "u1",
		});
		await accounts.doc("cred").set({
			providerId: "credential",
			accountId: "stale",
			user_id: "u2",
		});

		const first = captureIO();
		const code = await runCli(
			[
				"backfill-account-issuers",
				"--apply",
				"--collection",
				ACCOUNTS,
				"--naming-strategy",
				"snake_case",
				"--issuer",
				"okta=https://acme.okta.com",
			],
			first.io,
		);

		expect(code).toBe(0);
		expect(first.text()).toContain("Backfilled 2 account documents");
		expect(first.text()).toContain("updated: 2");
		expect(first.text()).toContain(
			"credential accountId repaired (set to userId): 1",
		);
		expect(first.text()).not.toContain("Nothing was written");
		expect((await accounts.doc("okta").get()).data()?.issuer).toBe(
			"https://acme.okta.com",
		);
		expect((await accounts.doc("cred").get()).data()).toMatchObject({
			issuer: "local:credential",
			accountId: "u2",
		});

		const second = captureIO();
		await runCli(
			["backfill-account-issuers", "--apply", "--collection", ACCOUNTS],
			second.io,
		);
		expect(second.text()).toContain("updated: 0   already stamped: 2");
	});

	it("exits 1 and lists collisions and unresolved documents", async () => {
		await accounts
			.doc("a")
			.set({ providerId: "github", accountId: "gh-1", userId: "u1" });
		await accounts
			.doc("b")
			.set({ providerId: "github", accountId: "gh-1", userId: "u2" });
		await accounts.doc("orphan").set({ accountId: "x", userId: "u3" });

		const { io, text } = captureIO();
		const code = await runCli(
			["backfill-account-issuers", "--collection", ACCOUNTS],
			io,
		);

		expect(code).toBe(1);
		expect(text()).toContain("unresolved: 1");
		expect(text()).toContain("    orphan");
		expect(text()).toContain("collisions");
		expect(text()).toContain("local:oauth:github / gh-1: a, b");
	});

	it("--json prints the full report", async () => {
		await accounts.doc("c1").set({
			providerId: "credential",
			accountId: "u1",
			userId: "u1",
		});

		const { io, text } = captureIO();
		const code = await runCli(
			["backfill-account-issuers", "--collection", ACCOUNTS, "--json"],
			io,
		);

		expect(code).toBe(0);
		expect(JSON.parse(text())).toMatchObject({
			apply: false,
			scanned: 1,
			updated: 1,
			byIssuer: { "local:credential": 1 },
			collisions: [],
		});
	});

	it("rejects bad usage with exit 2 before touching Firestore", async () => {
		const cases: string[][] = [
			[],
			["frobnicate"],
			["backfill-account-issuers", "extra"],
			["backfill-account-issuers", "--naming-strategy", "camelCase"],
			["backfill-account-issuers", "--issuer", "okta"],
			["backfill-account-issuers", "--batch-size", "0"],
			["backfill-account-issuers", "--bogus"],
		];
		for (const argv of cases) {
			const { io, errors } = captureIO();
			expect(await runCli(argv, io), argv.join(" ")).toBe(2);
			expect(errors(), argv.join(" ")).toMatch(
				/Usage: better-auth-firestore|--help/,
			);
		}

		const { io, text } = captureIO();
		expect(await runCli(["--help"], io)).toBe(0);
		expect(text()).toContain("backfill-account-issuers");
	});
});
