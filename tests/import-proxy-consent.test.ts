import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../src/shared/ipc';
import { __resetRouterForTests, setTrustedSender } from '../src/main/ipc/router';
import { registerImportHandlers } from '../src/main/import/ipc';
import { ImportService, type StagedFile } from '../src/main/import/service';
import { VaultService } from '../src/main/vault/service';
import { ProxyConsent, type ProxyConsentRequest } from '../src/main/net/proxy-consent';
import { newAutoConfirm, type Account } from '../src/shared/vault-schema';

/**
 * **Importing a maFile was the fourth way a proxy destination reached the vault,
 * and the only one that never asked.**
 *
 * `ProxyConsent` exists because the renderer must not be able to open an
 * outbound channel on its own say-so: an endpoint the user was never shown then
 * carries every later Steam request for that account, including the sign-in
 * password and the Guard code. `accountSetProxy`, `enrollmentBegin` and
 * `transferAuthenticate` all go through it. Ticking "also route this account
 * through the proxy saved in the file" did not — and import is the worst place
 * to miss, because the address was chosen by whoever wrote the maFile rather
 * than by the user, and the screen cannot even display it: a proxy URL usually
 * embeds a password, so `ImportCandidate` carries `hasProxy` and not the URL.
 *
 * Everything below is asserted through the real IPC handler against a real
 * vault on disk, so "nothing was written" means the file on disk, not a flag.
 */

/** Stubbed to the accepted scrypt floor, like the other vault suites. */
vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
		removeHandler: (channel: string): boolean => handlers.delete(channel)
	},
	// The picker is never opened here — every test stages files directly, because
	// what is under test is what happens between the selection and the write.
	dialog: {
		showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
			Promise.resolve({ canceled: true, filePaths: [] })
	},
	BrowserWindow: { getFocusedWindow: (): undefined => undefined, getAllWindows: () => [] }
}));

const PASS = 'a sufficiently long passphrase';
/** Twenty bytes, base64 — the shape Steam actually issues. */
const SECRET = 'ASNFZ4mrze8BI0VniavN7wEjRWc=';
const IDENTITY = 'ICEiIyQlJicoKSorLC0uLzAxMjM=';

/**
 * Credentials in the address on purpose. They are the half of a proxy URL that
 * must never reach the renderer, and the half a compromised renderer would use
 * as the payload — so every assertion about what crosses IPC has something to
 * actually look for.
 */
const PROXY = 'http://user:hunter2@10.0.0.9:8080';
const PROXY_ENDPOINT = '10.0.0.9:8080';
const OTHER_PROXY = 'http://user:hunter2@10.0.0.250:8080';

const STEAM_ID = '76561198000000001';
const OTHER_STEAM_ID = '76561198000000002';

let dir: string;
let vault: VaultService;
let imports: ImportService;
/** The import service's clock, so a dialog can be made to take a long time. */
let clock: number;

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const TTL_MS = 60_000;

beforeEach(async () => {
	__resetRouterForTests();
	handlers.clear();
	setTrustedSender(() => true);

	dir = mkdtempSync(join(tmpdir(), 'import-proxy-consent-'));
	vault = new VaultService({ file: join(dir, 'vault.json') });
	await vault.create(PASS);
	clock = NOW;
	imports = new ImportService(vault, {
		now: () => clock,
		monotonicNow: () => clock,
		ttlMs: TTL_MS
	});
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Register the handlers with a consent that records what it was asked. */
function arm(options: { approve?: boolean; whileAsking?: () => void } = {}): {
	asked: ProxyConsentRequest[];
} {
	const asked: ProxyConsentRequest[] = [];
	registerImportHandlers(
		imports,
		new ProxyConsent({
			ask: (request) => {
				asked.push(request);
				// A consent dialog is a modal window in front of a person. Whatever
				// this does is what the world got up to while they were reading it.
				options.whileAsking?.();
				return Promise.resolve(options.approve ?? true);
			}
		})
	);
	return { asked };
}

function file(
	overrides: {
		name?: string;
		steamId64?: string;
		accountName?: string;
		proxy?: string;
	} = {}
): StagedFile {
	// The SteamID is carried by the top-level `steamid` string only. Writing it
	// into `Session.SteamID` the way SDA does means writing a JSON *number*, and
	// a SteamID64 does not survive one — both fixtures then round to the same
	// account and every case below silently becomes a duplicate test.
	return {
		name: overrides.name ?? 'a.maFile',
		text: JSON.stringify({
			shared_secret: SECRET,
			identity_secret: IDENTITY,
			account_name: overrides.accountName ?? 'trader',
			revocation_code: 'R12345',
			steamid: overrides.steamId64 ?? STEAM_ID,
			...(overrides.proxy === undefined ? {} : { Session: { proxy: overrides.proxy } })
		})
	};
}

/** Stage files and return their staging ids, in the order they were given. */
function stage(files: StagedFile[]): string[] {
	const report = imports.stage(files);
	if (report.candidates.length !== files.length) {
		throw new Error(`only ${report.candidates.length} staged: ${JSON.stringify(report.rejected)}`);
	}
	return report.candidates.map((candidate) => candidate.stagingId);
}

/** Drive the real `import:commit` handler, schema validation and all. */
function commit(
	selections: { stagingId: string; replaceExisting?: boolean; adoptProxy?: boolean }[]
): Promise<unknown> {
	const handler = handlers.get(CHANNELS.importCommit);
	if (!handler) {
		throw new Error('import:commit was never registered');
	}
	return handler(
		{ senderFrame: { url: 'file:///app/out/renderer/index.html' } },
		{
			selections: selections.map((selection) => ({
				stagingId: selection.stagingId,
				replaceExisting: selection.replaceExisting ?? false,
				adoptProxy: selection.adoptProxy ?? false
			}))
		}
	);
}

function storedAccount(steamId64 = STEAM_ID): Account | undefined {
	return vault.read().accounts.find((account) => account.steamId64 === steamId64);
}

describe('adopting the proxy saved inside a maFile', () => {
	it('is put to the user, named by host and port, before anything is written', async () => {
		const { asked } = arm();
		const [id] = stage([file({ proxy: PROXY })]);

		await commit([{ stagingId: id as string, adoptProxy: true }]);

		expect(
			asked,
			'a proxy endpoint from a maFile was adopted without anyone being shown it'
		).toHaveLength(1);
		expect(asked[0]?.endpoint).toBe(PROXY_ENDPOINT);
		expect(asked[0]?.accountName, 'the dialog cannot say whose traffic this is').toBe('trader');
		expect(asked[0]?.reason).toBe('route');
		expect(storedAccount()?.proxyUrl, 'an approved proxy was not stored').toBe(PROXY);
	});

	/*
	 * **The strong half of the guarantee.** A stored proxy is used by the next
	 * poll, the next confirmation fetch and the next browser window, so a refusal
	 * that left the account in the vault with that address would have refused
	 * nothing. Asked before `commit`, so the vault is never even opened for
	 * writing — the account does not appear at all.
	 */
	it('leaves the vault completely untouched when the answer is no', async () => {
		const { asked } = arm({ approve: false });
		const [id] = stage([file({ proxy: PROXY })]);

		await expect(commit([{ stagingId: id as string, adoptProxy: true }])).rejects.toThrow(
			/not approved/
		);

		expect(asked).toHaveLength(1);
		expect(
			vault.read().accounts,
			'a refused proxy import wrote the account anyway, so the next request uses that address'
		).toHaveLength(0);
	});

	/*
	 * An SDA folder is routinely twenty accounts behind one proxy. Twenty
	 * identical dialogs is not twenty decisions — it is one decision and nineteen
	 * lessons in clicking Allow, which is how the gate stops working on the
	 * dialog that matters.
	 */
	it('asks once for one address, however many files carry it', async () => {
		const { asked } = arm();
		const ids = stage([
			file({ name: 'a.maFile', steamId64: STEAM_ID, accountName: 'one', proxy: PROXY }),
			file({ name: 'b.maFile', steamId64: OTHER_STEAM_ID, accountName: 'two', proxy: PROXY })
		]);

		await commit(ids.map((stagingId) => ({ stagingId, adoptProxy: true })));

		expect(asked, 'the same address was put to the user once per file').toHaveLength(1);
		expect(storedAccount(STEAM_ID)?.proxyUrl).toBe(PROXY);
		expect(storedAccount(OTHER_STEAM_ID)?.proxyUrl).toBe(PROXY);
	});

	it('asks separately for each distinct address', async () => {
		const { asked } = arm();
		const ids = stage([
			file({ name: 'a.maFile', steamId64: STEAM_ID, accountName: 'one', proxy: PROXY }),
			file({ name: 'b.maFile', steamId64: OTHER_STEAM_ID, accountName: 'two', proxy: OTHER_PROXY })
		]);

		await commit(ids.map((stagingId) => ({ stagingId, adoptProxy: true })));

		expect(asked.map((request) => request.endpoint).sort()).toEqual([
			'10.0.0.250:8080',
			PROXY_ENDPOINT
		]);
	});

	/**
	 * **The credentials are part of the destination, and nothing pinned that.**
	 *
	 * The dedupe key is the whole address, which is right — and a verifier showed
	 * that reducing it to the host alone left every import suite green. That is
	 * the same hole `ProxyConsent` itself had and the same reason it is a hole: a
	 * maFile's username and password go to the proxy operator on the next
	 * authentication, so two files sharing a host but not a credential are two
	 * things to agree to, not one. Asking once would adopt the second silently.
	 */
	it('asks again for the same host with different credentials', async () => {
		const { asked } = arm();
		const ids = stage([
			file({
				name: 'a.maFile',
				steamId64: STEAM_ID,
				accountName: 'one',
				proxy: 'http://alice:one@10.0.0.9:8080'
			}),
			file({
				name: 'b.maFile',
				steamId64: OTHER_STEAM_ID,
				accountName: 'two',
				proxy: 'http://alice:two@10.0.0.9:8080'
			})
		]);

		await commit(ids.map((stagingId) => ({ stagingId, adoptProxy: true })));

		expect(
			asked,
			'two different credentials for one host were treated as one destination, so the second ' +
				'was adopted without anyone being shown it'
		).toHaveLength(2);
	});

	it('asks nothing when the file has a proxy and the user did not adopt it', async () => {
		const { asked } = arm();
		const [id] = stage([file({ proxy: PROXY })]);

		await commit([{ stagingId: id as string, adoptProxy: false }]);

		expect(asked, 'a dialog with no decision in it teaches people to click Allow').toHaveLength(0);
		expect(storedAccount()?.proxyUrl).toBeUndefined();
		expect(storedAccount()?.accountName, 'declining the proxy blocked the import itself').toBe(
			'trader'
		);
	});

	/*
	 * Re-importing an account that already routes through this exact address
	 * introduces no destination, so there is nothing to put to anybody. Checked
	 * against the vault here rather than left to `ProxyConsent`'s unlock-time
	 * seeding: a rule that only holds because something else ran first is a rule
	 * waiting for a refactor.
	 */
	it('asks nothing when the account already routes through that same address', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				steamId64: STEAM_ID,
				accountName: 'trader',
				sharedSecret: SECRET,
				identitySecret: IDENTITY,
				status: 'active',
				addedAt: '2026-08-01T00:00:00.000Z',
				autoConfirm: newAutoConfirm(),
				proxyUrl: PROXY
			});
		});

		const { asked } = arm();
		const [id] = stage([file({ proxy: PROXY })]);

		await commit([{ stagingId: id as string, replaceExisting: true, adoptProxy: true }]);

		expect(asked).toHaveLength(0);
		expect(storedAccount()?.proxyUrl).toBe(PROXY);
	});

	it('asks when a replace would move the account onto a different address', async () => {
		await vault.mutate((draft) => {
			draft.accounts.push({
				steamId64: STEAM_ID,
				accountName: 'trader',
				sharedSecret: SECRET,
				identitySecret: IDENTITY,
				status: 'active',
				addedAt: '2026-08-01T00:00:00.000Z',
				autoConfirm: newAutoConfirm(),
				proxyUrl: OTHER_PROXY
			});
		});

		const { asked } = arm({ approve: false });
		const [id] = stage([file({ proxy: PROXY })]);

		await expect(
			commit([{ stagingId: id as string, replaceExisting: true, adoptProxy: true }])
		).rejects.toThrow(/not approved/);

		expect(asked[0]?.endpoint).toBe(PROXY_ENDPOINT);
		expect(
			storedAccount()?.proxyUrl,
			'a refused move rewrote the account onto the new address anyway'
		).toBe(OTHER_PROXY);
	});

	/*
	 * **The staging is checked again after the dialog, not only before it.**
	 *
	 * The gate is a modal OS window, and a person can leave one sitting for as
	 * long as they like — which is exactly how long the staged plaintext then has
	 * to outlive its TTL. The whole reason that TTL exists is that abandoned
	 * secrets must not wait in memory for somebody who has walked away, so a
	 * commit that validated the staging *before* raising the dialog and then
	 * trusted that answer would write files whose expiry had already been
	 * declared — and it would do it on an approval given by whoever came back to
	 * the machine.
	 */
	it('refuses the whole commit when the staging expires while the dialog is up', async () => {
		const { asked } = arm({ whileAsking: () => (clock += TTL_MS * 2) });
		const [id] = stage([file({ proxy: PROXY })]);

		await expect(
			commit([{ stagingId: id as string, adoptProxy: true }]),
			'the import was written on a staging that had already expired'
		).rejects.toThrow(/took too long/);

		expect(asked).toHaveLength(1);
		expect(vault.read().accounts).toHaveLength(0);
	});

	/*
	 * The address exists in the main process only. It reaches `ProxyConsent`,
	 * which is drawn by the main process in a window the renderer cannot read —
	 * and it must not travel back out over IPC on the way.
	 */
	it('never returns the address, or its credentials, to the renderer', async () => {
		arm();
		const [id] = stage([file({ proxy: PROXY })]);

		const result = await commit([{ stagingId: id as string, adoptProxy: true }]);

		const serialised = JSON.stringify(result);
		expect(serialised).not.toContain('hunter2');
		expect(serialised).not.toContain('10.0.0.9');
	});
});
