import { describe, expect, it } from 'vitest';
import {
	CHANNELS,
	IPC_CONTRACT,
	accountsListResponse,
	appInfoResponse,
	codesListResponse,
	confirmationsListResponse,
	importReportResponse,
	matchesTradesAck,
	TRADES_ACK
} from '../src/shared/ipc';

/**
 * The IPC surface is the renderer's entire reach into the main process, so its
 * shape is a security property (§11 S6) and §24.3 requires founder sign-off to
 * change it. These tests make an unreviewed change fail CI.
 */

describe('contract completeness', () => {
	it('declares a schema for every channel', () => {
		for (const channel of Object.values(CHANNELS)) {
			expect(IPC_CONTRACT[channel], `${channel} has no contract entry`).toBeDefined();
			expect(IPC_CONTRACT[channel].request).toBeDefined();
			expect(IPC_CONTRACT[channel].response).toBeDefined();
		}
	});

	it('has no contract entry without a corresponding channel', () => {
		const declared = new Set<string>(Object.values(CHANNELS));
		for (const key of Object.keys(IPC_CONTRACT)) {
			expect(declared.has(key), `${key} is in the contract but not in CHANNELS`).toBe(true);
		}
	});

	it('uses namespaced channel names, never a wildcard', () => {
		for (const channel of Object.values(CHANNELS)) {
			expect(channel).toMatch(/^[a-z]+:[a-zA-Z]+$/);
			expect(channel).not.toContain('*');
		}
	});
});

describe('request validation', () => {
	const { request } = IPC_CONTRACT[CHANNELS.appInfo];

	it('accepts the empty request it declares', () => {
		expect(request.safeParse({}).success).toBe(true);
	});

	it('rejects unexpected properties rather than ignoring them', () => {
		// Strict mode matters: a handler must never silently receive a field the
		// contract does not describe.
		expect(request.safeParse({ injected: 'value' }).success).toBe(false);
	});

	it('rejects hostile shapes', () => {
		for (const hostile of [null, 'string', 42, [], () => {}, { __proto__: { polluted: true } }]) {
			const result = request.safeParse(hostile);
			if (result.success) {
				// An empty object is the only legal value; a prototype-only object
				// parses to {} which is fine, but must not pollute.
				expect(Object.keys(result.data as object)).toHaveLength(0);
			}
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe('response validation', () => {
	const valid = {
		productName: 'Open Desktop Authenticator',
		version: '0.0.0',
		company: 'MASTERPANEL LLC',
		brandingUnresolved: true,
		platform: 'win32' as const,
		attribution: { mckay: 'a', valve: 'b' },
		security: { sandbox: true, contextIsolation: true, nodeIntegration: false }
	};

	it('accepts a well-formed response', () => {
		expect(appInfoResponse.safeParse(valid).success).toBe(true);
	});

	it('accepts any platform string rather than failing on an unknown one', () => {
		// Deliberate: platform is display-only. An enum of supported platforms would
		// turn "running somewhere unsupported" into a hard IPC error on the About
		// screen instead of a label the user can read.
		expect(appInfoResponse.safeParse({ ...valid, platform: 'freebsd' }).success).toBe(true);
	});

	it('still requires platform to be a string', () => {
		expect(appInfoResponse.safeParse({ ...valid, platform: 42 }).success).toBe(false);
		expect(appInfoResponse.safeParse({ ...valid, platform: null }).success).toBe(false);
	});

	it('rejects a response missing a declared field', () => {
		const { security: _omitted, ...withoutSecurity } = valid;
		expect(appInfoResponse.safeParse(withoutSecurity).success).toBe(false);
	});
});

describe('S2 — no long-term secret has a path to the renderer', () => {
	/**
	 * Behavioural, not a source grep.
	 *
	 * The previous version searched `ipc.ts` for a fixed list of names — and that
	 * list never contained `revocationCode`, so it would have waved through the
	 * first outbound secret the contract ever gained. This drives the real
	 * schemas instead: a handler that returns a secret has it **stripped** before
	 * the router forwards anything, because zod objects drop unknown keys.
	 */
	const SECRETS = {
		sharedSecret: 'LEAKED',
		identitySecret: 'LEAKED',
		shared_secret: 'LEAKED',
		identity_secret: 'LEAKED',
		refreshToken: 'LEAKED',
		passphrase: 'LEAKED',
		password: 'LEAKED',
		revocationCode: 'LEAKED',
		proxyUrl: 'LEAKED'
	};

	/** Every string value reachable in a parsed response. */
	function values(node: unknown, found: string[] = []): string[] {
		if (typeof node === 'string') {
			found.push(node);
		} else if (Array.isArray(node)) {
			node.forEach((item) => values(item, found));
		} else if (node && typeof node === 'object') {
			Object.values(node).forEach((item) => values(item, found));
		}
		return found;
	}

	it('strips injected secrets from every response except the sanctioned one', () => {
		for (const channel of Object.values(CHANNELS)) {
			const { response } = IPC_CONTRACT[channel];

			// The reveal channel legitimately returns a revocation code, so injecting
			// one there proves nothing. Every OTHER secret must still be stripped
			// from it — the exception is one field on one channel, not a hole.
			const injected = { ...SECRETS };
			if (channel === CHANNELS.revocationReveal) {
				delete (injected as Partial<typeof SECRETS>).revocationCode;
			}

			// Build a minimal valid response, then contaminate it.
			const parsed = response.safeParse({ ...sampleResponse(channel), ...injected });

			if (!parsed.success) {
				// Rejecting outright is also an acceptable outcome.
				continue;
			}
			const leaked = values(parsed.data).filter((v) => v === 'LEAKED');
			expect(leaked, `${channel} forwarded an injected secret`).toEqual([]);
		}
	});

	it('strips secrets injected into an account summary', () => {
		// The listing is the response most likely to grow a secret by accident,
		// since it is built from full account records.
		const parsed = accountsListResponse.parse({
			accounts: [
				{
					steamId64: '76561198000000001',
					accountName: 'trader',
					status: 'active',
					hasRevocationCode: true,
					hasProxy: false,
					routing: 'off',
					autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 },
					...SECRETS
				}
			]
		});
		expect(values(parsed)).not.toContain('LEAKED');
	});

	it('carries a redacted proxy in the routing fields, never a usable one', () => {
		// `routedVia` and `routingProblem` are the newest outbound strings, and the
		// value behind them is a URL that can contain a proxy operator's password.
		// The main process is what redacts; this asserts the shape it must send.
		const parsed = accountsListResponse.parse({
			accounts: [
				{
					steamId64: '76561198000000001',
					accountName: 'trader',
					status: 'active',
					hasRevocationCode: true,
					hasProxy: true,
					routing: 'blocked',
					routedVia: 'socks5://***:***@10.0.0.1:1080',
					routingProblem: 'this connection would be made directly instead',
					autoConfirm: { marketListings: false, trades: false, pollIntervalSeconds: 15 }
				}
			]
		});

		const serialised = JSON.stringify(parsed);
		expect(serialised).toContain('***:***@');
		// A real credential would have to have been put here by the sender; the
		// point of the assertion is that nothing in the schema invites one.
		expect(serialised).not.toMatch(/socks5:\/\/[^*@]+:[^*@]+@/);
	});

	it('strips secrets injected into an import candidate', () => {
		// Import candidates are built from freshly-parsed maFiles, which hold every
		// secret an account has. The summary is the only thing standing between
		// that and the renderer, so it gets the same treatment as the account list.
		const parsed = importReportResponse.parse({
			cancelled: false,
			candidates: [
				{
					stagingId: 'staging-id',
					sourceName: 'a.maFile',
					accountName: 'trader',
					steamId64: '76561198000000001',
					hasRevocationCode: true,
					hasProxy: true,
					hasSession: true,
					importable: true,
					warnings: [],
					...SECRETS
				}
			],
			rejected: []
		});
		expect(values(parsed)).not.toContain('LEAKED');
	});

	it('never lets a shared secret ride along with a Steam Guard code', () => {
		// Codes DO cross to the renderer — they have to be readable. The secret
		// that generates them must not follow, and a code response is built from
		// account records that hold one.
		const parsed = codesListResponse.parse({
			codes: [
				{
					steamId64: '76561198000000001',
					accountName: 'trader',
					code: 'X45RP',
					secondsRemaining: 30,
					...SECRETS
				}
			],
			failures: [],
			clockUnverified: false,
			...SECRETS
		});
		expect(values(parsed)).not.toContain('LEAKED');
		expect(values(parsed)).toContain('X45RP');
	});

	it('never lets a confirmation carry the nonce that would let the renderer act', () => {
		// The nonce is the credential half of approving a confirmation. Only the id
		// crosses, so the UI can act on what it was shown and nothing else — and
		// the schema is what makes that true rather than a convention in one mapper.
		const parsed = confirmationsListResponse.parse({
			signInRequired: false,
			confirmations: [
				{
					id: '11',
					type: 2,
					typeName: 'Trade',
					securityCritical: false,
					hasIcon: false,
					autoConfirmable: true,
					nonce: 'LEAKED-NONCE',
					...SECRETS
				}
			]
		});

		expect(values(parsed)).not.toContain('LEAKED');
		expect(values(parsed)).not.toContain('LEAKED-NONCE');
		expect(JSON.stringify(parsed)).not.toContain('nonce');
	});

	it('carries a passphrase only INBOUND, never in a response', () => {
		// S2 governs what the renderer receives. A typed passphrase must travel
		// inbound or nothing can be unlocked; it must never come back.
		for (const channel of Object.values(CHANNELS)) {
			const parsed = IPC_CONTRACT[channel].response.safeParse({
				...sampleResponse(channel),
				passphrase: 'LEAKED'
			});
			if (parsed.success) {
				expect(values(parsed.data), `${channel} echoed a passphrase`).not.toContain('LEAKED');
			}
		}
	});

	it('reveals a revocation code on exactly one channel, by design', () => {
		// §11 S2 exception (a). If a second channel ever returns one, this fails —
		// which is the point: the exception has to stay deliberate and singular.
		const revealing = Object.values(CHANNELS).filter((channel) => {
			const parsed = IPC_CONTRACT[channel].response.safeParse({
				...sampleResponse(channel),
				revocationCode: 'R12345'
			});
			return parsed.success && values(parsed.data).includes('R12345');
		});
		expect(revealing).toEqual([CHANNELS.revocationReveal]);
	});
});

/** A minimal response that satisfies each channel's schema. */
function sampleResponse(channel: string): Record<string, unknown> {
	switch (channel) {
		case CHANNELS.appInfo:
			return {
				productName: 'x',
				version: '0.0.0',
				company: 'MASTERPANEL LLC',
				brandingUnresolved: true,
				platform: 'win32',
				attribution: { mckay: 'a', valve: 'b' },
				security: { sandbox: true, contextIsolation: true, nodeIntegration: false }
			};
		case CHANNELS.vaultStatus:
			return { exists: true, unlocked: false, msUntilAutoLock: null, backupAvailable: false };
		case CHANNELS.accountsList:
			return { accounts: [] };
		case CHANNELS.importScan:
			// A populated candidate, not an empty list: an empty array cannot carry a
			// leaked field, so the secret-stripping checks would pass vacuously.
			return {
				cancelled: false,
				candidates: [
					{
						stagingId: 'staging-id',
						sourceName: 'a.maFile',
						accountName: 'trader',
						hasRevocationCode: true,
						hasProxy: false,
						hasSession: false,
						importable: true,
						warnings: []
					}
				],
				rejected: []
			};
		case CHANNELS.importCommit:
			return {
				outcomes: [{ stagingId: 'staging-id', accountName: 'trader', result: 'imported' }]
			};
		case CHANNELS.codesList:
			return {
				codes: [
					{
						steamId64: '76561198000000001',
						accountName: 'trader',
						code: 'X45RP',
						secondsRemaining: 30
					}
				],
				failures: [],
				clockUnverified: true
			};
		case CHANNELS.codeCopy:
			return { code: 'X45RP', clipboardClearsInSeconds: 30 };
		case CHANNELS.confirmationsList:
			// Populated, not empty: an empty array cannot carry a leaked field, so
			// the secret-stripping checks would pass without testing anything.
			return {
				signInRequired: false,
				confirmations: [
					{
						id: '11',
						type: 2,
						typeName: 'Trade',
						headline: 'A trade',
						summary: ['You give: a knife'],
						securityCritical: false,
						hasIcon: false,
						autoConfirmable: true
					}
				]
			};
		case CHANNELS.revocationReveal:
			return { revocationCode: 'R12345' };
		default:
			return { ok: true };
	}
}

/**
 * The typed acknowledgement for automatic trade confirmation.
 *
 * The *contract* only carries the field. Whether it is required depends on
 * whether trades are being turned on, which needs the account's current
 * setting — so the gate lives in the handler, and `vault-ipc` covers it.
 *
 * A first attempt enforced it here on `trades === true` alone, which made every
 * later edit impossible: once trades were on, the screen correctly stopped
 * asking for an acknowledgement, and the contract then refused the save. These
 * tests exist so that shape cannot come back.
 */
describe('the trades acknowledgement field', () => {
	const { request } = IPC_CONTRACT[CHANNELS.accountSetAutoConfirm];
	const base = {
		steamId64: '76561198000000001',
		marketListings: false,
		pollIntervalSeconds: 15
	};

	it('is optional, because only the handler knows if this is a transition', () => {
		expect(request.safeParse({ ...base, trades: true }).success).toBe(true);
		expect(request.safeParse({ ...base, trades: false }).success).toBe(true);
	});

	it('is carried through when supplied', () => {
		const parsed = request.safeParse({
			...base,
			trades: true,
			tradesAcknowledgement: TRADES_ACK
		});
		expect(parsed.success && parsed.data.tradesAcknowledgement).toBe(TRADES_ACK);
	});

	it('matches the phrase however it is cased, padded or spaced', () => {
		// A person typing two words is not deciding how many spaces go between
		// them. Refusing that reads as the feature being broken.
		for (const typed of [TRADES_ACK, 'approve trades', '  Approve  Trades  ', 'APPROVE	TRADES']) {
			expect(matchesTradesAck(typed), typed).toBe(true);
		}
	});

	it('does not match anything else', () => {
		for (const typed of [undefined, '', 'approve', 'APPROVETRADES', 'approve trade', 'yes']) {
			expect(matchesTradesAck(typed), String(typed)).toBe(false);
		}
	});
});
