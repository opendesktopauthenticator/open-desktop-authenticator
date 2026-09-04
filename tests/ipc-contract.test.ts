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

describe('vault adoption authentication', () => {
	const request = IPC_CONTRACT[CHANNELS.vaultAdopt].request;

	it('requires the existing vault passphrase and rejects extra fields', () => {
		expect(
			request.safeParse({ passphrase: 'a sufficiently long existing passphrase' }).success
		).toBe(true);
		expect(request.safeParse({}).success).toBe(false);
		expect(
			request.safeParse({
				passphrase: 'a sufficiently long existing passphrase',
				path: 'C:\\untrusted\\chosen-by-renderer.json'
			}).success
		).toBe(false);
	});
});

describe('response validation', () => {
	const valid = {
		productName: 'Open Desktop Authenticator',
		version: '0.0.0',
		company: 'MASTERPANEL LLC',
		companyShort: 'MASTERPANEL',
		companyWebsite: 'https://masterspanel.com',
		website: 'https://opendesktopauthenticator.com',
		repository: 'https://github.com/opendesktopauthenticator/open-desktop-authenticator',
		brandingUnresolved: true,
		platform: 'win32' as const,
		installedFromStore: false,
		notificationsAvailable: true,
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

			/*
			 * Three channels legitimately return a revocation code, so injecting one
			 * there proves nothing. Every OTHER secret must still be stripped from
			 * them — the exception is one field on three channels, not a hole.
			 *
			 * It read "one field on one channel" and listed one, because the two
			 * transfer channels had invalid samples and were skipped entirely. See
			 * the enumeration below for why a transfer shows the code.
			 */
			const revealsRevocationCode: string[] = [
				CHANNELS.revocationReveal,
				CHANNELS.transferComplete,
				CHANNELS.transferRetryPersist
			];
			const injected = { ...SECRETS };
			if (revealsRevocationCode.includes(channel)) {
				delete (injected as Partial<typeof SECRETS>).revocationCode;
			}

			/*
			 * **The clean sample has to be valid, and that is now asserted.**
			 *
			 * Only the *contaminated* response may be rejected — that is a channel
			 * refusing a secret, which is the outcome this check is happy with. A
			 * sample that cannot parse on its own is a different thing entirely: it
			 * means this channel is silently skipped, and the skip is invisible
			 * because the test still passes.
			 *
			 * That is not hypothetical. Adding two required fields to
			 * `vaultStatusResponse` left its sample short of them, and the
			 * secret-stripping check for that channel stopped running without a
			 * single assertion failing.
			 */
			const clean = response.safeParse(sampleResponse(channel));
			expect(
				clean.success,
				`${channel}: the sample response is not valid, so this channel is not being checked`
			).toBe(true);

			// Build a minimal valid response, then contaminate it.
			const parsed = response.safeParse({ ...sampleResponse(channel), ...injected });

			if (!parsed.success) {
				// Rejecting the contaminated one outright is an acceptable outcome:
				// the secret did not get through.
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
					autoConfirm: {
						marketListings: false,
						trades: false,
						pollIntervalSeconds: 15,
						notify: { enabled: false, detail: 'full' }
					},
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
					autoConfirm: {
						marketListings: false,
						trades: false,
						pollIntervalSeconds: 15,
						notify: { enabled: false, detail: 'full' }
					}
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
			unreadable: 0,
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

	/**
	 * §11 S2 exception (a), enumerated.
	 *
	 * **This said "exactly one channel" and named one, and it was wrong.** A
	 * transfer ends by showing the user the revocation code Steam issued for the
	 * authenticator it just moved — that is the ceremony, and `transfer:complete`
	 * and `transfer:retryPersist` both return it in their schemas. The assertion
	 * did not notice because both samples were invalid, so `safeParse` failed and
	 * the filter skipped them: a check counting channels, blind to two of the
	 * three it was counting.
	 *
	 * Enumerated rather than loosened. Each of these shows a code the user is
	 * being told to write down, at the moment they are told to; a fourth would
	 * still be a finding, which is what this test is for.
	 */
	it('reveals a revocation code on exactly these channels, by design', () => {
		const revealing = Object.values(CHANNELS).filter((channel) => {
			const parsed = IPC_CONTRACT[channel].response.safeParse({
				...sampleResponse(channel),
				revocationCode: 'R12345'
			});
			return parsed.success && values(parsed.data).includes('R12345');
		});
		expect(revealing.sort()).toEqual(
			[CHANNELS.revocationReveal, CHANNELS.transferComplete, CHANNELS.transferRetryPersist].sort()
		);
	});
});

/** A minimal response that satisfies each channel's schema. */
function sampleResponse(channel: string): Record<string, unknown> {
	switch (channel) {
		/*
		 * Empty is the valid, ordinary answer: `steamId64` is optional because
		 * "nothing is waiting" is what this returns almost every time it is asked.
		 */
		case CHANNELS.takePendingConfirmations:
			return {};
		case CHANNELS.appInfo:
			return {
				productName: 'x',
				version: '0.0.0',
				company: 'MASTERPANEL LLC',
				// These four were missing, so this channel's secret-stripping check
				// had been skipped in silence — see the assertion that now catches it.
				companyShort: 'MASTERPANEL',
				companyWebsite: 'https://example.invalid',
				website: 'https://example.invalid',
				repository: 'https://example.invalid/repo',
				brandingUnresolved: true,
				platform: 'win32',
				installedFromStore: false,
				notificationsAvailable: true,
				attribution: { mckay: 'a', valve: 'b' },
				security: { sandbox: true, contextIsolation: true, nodeIntegration: false }
			};
		case CHANNELS.vaultStatus:
			return {
				exists: true,
				unlocked: false,
				msUntilAutoLock: null,
				requireProxies: false,
				updateCheck: true,
				backupAvailable: false
			};
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
		case CHANNELS.settingsGet:
			return {
				requireProxies: false,
				autoLockMinutes: 10,
				clipboardClearSeconds: 30,
				updateCheck: true
			};
		case CHANNELS.updateCheck:
			return { state: 'upToDate' };
		case CHANNELS.transferAuthenticate:
			return { state: 'authenticated', steamId64: '76561198000000001', accountName: 'trader' };
		case CHANNELS.transferStartChallenge:
			return { sent: true, shape: 'json' };
		case CHANNELS.transferComplete:
		case CHANNELS.transferRetryPersist:
			return {
				steamId64: '76561198000000001',
				accountName: 'trader',
				revocationCode: 'R12345',
				timeOffsetSeconds: 0
			};
		case CHANNELS.transferCancel:
			return {};
		case CHANNELS.enrollBegin:
		case CHANNELS.enrollEmailCode:
			return { state: 'needsEmailCode' };
		case CHANNELS.enrollRetryPersist:
			return {
				state: 'enrolled',
				steamId64: '76561198000000001',
				accountName: 'trader'
			};
		case CHANNELS.enrollActivate:
			return { state: 'activated' };
		case CHANNELS.accountExport:
			return { state: 'saved', fileName: 'a.maFile' };
		case CHANNELS.accountRecover:
			return { state: 'cancelled' };
		case CHANNELS.accountOpenBrowser:
			return { signInRequired: false };
		case CHANNELS.vaultAdopt:
			return { state: 'cancelled' };
		case CHANNELS.importUnlock:
			return { cancelled: false, candidates: [], rejected: [] };
		case CHANNELS.activityList:
			// Populated for the same reason the import and confirmation samples are:
			// an empty array cannot carry a leaked field.
			return {
				entries: [
					{
						steamId64: '76561198000000001',
						entry: { kind: 'failed', at: '2026-08-01T00:00:00.000Z', reason: 'a reason' }
					}
				],
				urgent: false,
				seq: 0
			};
		case CHANNELS.activityAcknowledge:
			return { ok: true, urgent: false };
		case CHANNELS.codeCopy:
			return { code: 'X45RP', clipboardClearsInSeconds: 30 };
		case CHANNELS.confirmationsList:
			// Populated, not empty: an empty array cannot carry a leaked field, so
			// the secret-stripping checks would pass without testing anything.
			return {
				signInRequired: false,
				unreadable: 0,
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
		pollIntervalSeconds: 15,
		notify: { enabled: false, detail: 'full' }
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
