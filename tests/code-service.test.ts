import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeService } from '../src/main/codes/service';
import { ClipboardCourier, type Clipboard } from '../src/main/codes/clipboard';
import { generateGuardCode } from '../src/main/codes/totp';
import { VaultLockedError, VaultService } from '../src/main/vault/service';
import type { Account } from '../src/shared/vault-schema';

/**
 * Codes as the application serves them, and the clipboard rules around them.
 *
 * Stubbed to the accepted scrypt floor like the other vault suites; the shipping
 * parameters are asserted in `vault-crypto.test.ts`.
 */
vi.mock('../src/shared/vault-format', async () => {
	const actual = await vi.importActual<typeof import('../src/shared/vault-format')>(
		'../src/shared/vault-format'
	);
	return {
		...actual,
		SCRYPT_DEFAULTS: Object.freeze({ ...actual.MINIMUM_SCRYPT, maxmem: 256 * 1024 * 1024 })
	};
});

const PASS = 'a sufficiently long passphrase';
const SECRET = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
/** 1 700 000 010 is a multiple of 30 — the start of a window. */
const NOW_MS = 1_700_000_010_000;

let dir: string;
let clock: number;
let vault: VaultService;
let codes: CodeService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'code-service-'));
	clock = NOW_MS;
	vault = new VaultService({ file: join(dir, 'vault.json'), now: () => clock });
	await vault.create(PASS);
	codes = new CodeService(vault, { now: () => clock });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function account(overrides: Partial<Account> = {}): Account {
	return {
		steamId64: '76561198000000001',
		accountName: 'trader',
		sharedSecret: SECRET,
		identitySecret: 'aWRlbnRpdHk=',
		status: 'active',
		addedAt: '2026-08-01T00:00:00.000Z',
		autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
		...overrides
	};
}

async function store(...accounts: Account[]): Promise<void> {
	await vault.mutate((draft) => {
		draft.accounts.push(...accounts);
	});
}

describe('CodeService', () => {
	it('requires an unlocked vault', () => {
		vault.lock();
		expect(() => codes.all()).toThrow(VaultLockedError);
	});

	it('generates a code for every account', async () => {
		await store(
			account(),
			account({ steamId64: '76561198000000002', accountName: 'second', sharedSecret: SECRET })
		);

		const { codes: generated, failures } = codes.all();

		expect(failures).toEqual([]);
		expect(generated).toHaveLength(2);
		expect(generated[0]?.code).toBe(generateGuardCode(SECRET, NOW_MS / 1000));
		expect(generated[0]?.secondsRemaining).toBe(30);
		expect(generated[0]?.accountName).toBe('trader');
	});

	it('reports a damaged secret without hiding every other account', async () => {
		await store(
			account({ steamId64: '76561198000000001', sharedSecret: 'not base64 at all!!' }),
			account({ steamId64: '76561198000000002', accountName: 'fine' })
		);

		const { codes: generated, failures } = codes.all();

		expect(generated).toHaveLength(1);
		expect(generated[0]?.accountName).toBe('fine');
		expect(failures).toHaveLength(1);
		expect(failures[0]?.steamId64).toBe('76561198000000001');
	});

	it('returns one account by id and refuses an unknown one', async () => {
		await store(account());

		expect(codes.for('76561198000000001').code).toBe(generateGuardCode(SECRET, NOW_MS / 1000));
		expect(() => codes.for('76561198000000009')).toThrow(/no such account/);
	});

	it('never returns the shared secret alongside the code', async () => {
		await store(account());
		expect(JSON.stringify(codes.all())).not.toContain(SECRET);
		expect(JSON.stringify(codes.for('76561198000000001'))).not.toContain(SECRET);
	});

	describe('the clock', () => {
		it('starts unverified, because nothing has asked Steam', () => {
			expect(codes.clockUnverified()).toBe(true);
		});

		it('applies a measured offset', async () => {
			await store(account());
			const local = codes.for('76561198000000001').code;

			// A machine one minute slow: two windows behind.
			codes.setTimeOffset(60);

			expect(codes.clockUnverified()).toBe(false);
			expect(codes.for('76561198000000001').code).toBe(
				generateGuardCode(SECRET, NOW_MS / 1000 + 60)
			);
			expect(codes.for('76561198000000001').code).not.toBe(local);
		});

		it('rejects a nonsense offset rather than silently skewing every code', () => {
			expect(() => codes.setTimeOffset(Number.NaN)).toThrow(RangeError);
			expect(() => codes.setTimeOffset(Number.POSITIVE_INFINITY)).toThrow(RangeError);
			expect(codes.clockUnverified()).toBe(true);
		});

		it('rejects an offset too large to be a clock skew', () => {
			// Finite was not enough: a huge negative offset drives Steam-corrected
			// time below zero, which nothing downstream can turn back into a sensible
			// code or countdown. Real offsets are seconds.
			expect(() => codes.setTimeOffset(-2_000_000_000)).toThrow(RangeError);
			expect(() => codes.setTimeOffset(86_401)).toThrow(RangeError);
			expect(codes.clockUnverified()).toBe(true);

			// A plausible skew is still accepted.
			codes.setTimeOffset(-45);
			expect(codes.clockUnverified()).toBe(false);
		});

		it('counts the window down as the clock advances', async () => {
			await store(account());
			expect(codes.clockUnverified()).toBe(true);
			clock += 11_000;
			// Derived from the same corrected time the code was, so the two cannot
			// disagree about which window they are in.
			expect(codes.for('76561198000000001').secondsRemaining).toBe(19);
		});
	});
});

/** A clipboard that records what happened to it. */
function fakeClipboard(initial = ''): Clipboard & { contents: string; cleared: number } {
	return {
		contents: initial,
		cleared: 0,
		readText(): string {
			return this.contents;
		},
		writeText(text: string): void {
			this.contents = text;
		},
		clear(): void {
			this.contents = '';
			this.cleared++;
		}
	};
}

describe('ClipboardCourier', () => {
	/** Captures the scheduled callback instead of waiting for a real timer. */
	function courier(clipboard: Clipboard): {
		courier: ClipboardCourier;
		fire: () => void;
		cancelled: number;
	} {
		let scheduled: (() => void) | undefined;
		const state = { cancelled: 0 };
		const instance = new ClipboardCourier({
			clipboard,
			setTimer: (callback) => {
				scheduled = callback;
				return { unref: () => undefined } as unknown as NodeJS.Timeout;
			},
			clearTimer: () => {
				state.cancelled++;
				scheduled = undefined;
			}
		});
		return {
			courier: instance,
			fire: () => scheduled?.(),
			get cancelled(): number {
				return state.cancelled;
			}
		};
	}

	it('writes the code and clears it when the timer fires', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(clipboard.contents).toBe('X45RP');
		expect(c.hasPendingClear()).toBe(true);

		fire();
		expect(clipboard.contents).toBe('');
		expect(clipboard.cleared).toBe(1);
	});

	it('does NOT clear something the user copied afterwards', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		// The user copies a paragraph. Wiping it would be data loss caused by a
		// security feature.
		clipboard.writeText('a long message the user is about to paste');

		fire();
		expect(clipboard.contents).toBe('a long message the user is about to paste');
		expect(clipboard.cleared).toBe(0);
	});

	it('supersedes a pending clear rather than stacking timers', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		c.copy('Q9JC4', 30_000);
		expect(clipboard.contents).toBe('Q9JC4');

		fire();
		expect(clipboard.contents).toBe('');
		expect(clipboard.cleared).toBe(1);
	});

	it('clears on demand, for lock and quit', () => {
		const clipboard = fakeClipboard();
		const { courier: c } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(c.clearIfOurs()).toBe(true);
		expect(clipboard.contents).toBe('');
		expect(c.hasPendingClear()).toBe(false);
	});

	it('does nothing on demand when nothing of ours is there', () => {
		const clipboard = fakeClipboard('someone else was here');
		const { courier: c } = courier(clipboard);

		expect(c.clearIfOurs()).toBe(false);
		expect(clipboard.contents).toBe('someone else was here');
	});

	it('does not clear twice for one copy', () => {
		const clipboard = fakeClipboard();
		const { courier: c, fire } = courier(clipboard);

		c.copy('X45RP', 30_000);
		expect(c.clearIfOurs()).toBe(true);

		// The lock cleared it; a late timer must not then wipe whatever the user
		// copied next.
		clipboard.writeText('something new');
		fire();
		expect(clipboard.contents).toBe('something new');
	});

	it('cancels without touching the clipboard', () => {
		const clipboard = fakeClipboard();
		const { courier: c } = courier(clipboard);

		c.copy('X45RP', 30_000);
		c.cancel();
		expect(clipboard.contents).toBe('X45RP');
		expect(c.hasPendingClear()).toBe(false);
	});
});
