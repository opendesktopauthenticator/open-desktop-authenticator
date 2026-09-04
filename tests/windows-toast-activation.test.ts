import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildWindowsToastXml,
	issueWindowsToastActivation,
	WINDOWS_TOAST_ACTIVATOR_CLSID,
	WindowsToastActivationRouter,
	type WindowsToastActivation,
	type WindowsToastCipher
} from '../src/main/confirmations/windows-toast-activation';

const ID = '76561198000000001';
const OTHER_ID = '76561198000000002';
const PREFIX = 'type=click&oda=';

/**
 * A reversible test double with a non-identity representation. Its purpose is
 * to prove the codec calls the encryption boundary, not to imitate DPAPI.
 */
class TestCipher implements WindowsToastCipher {
	available = true;
	throwOnEncrypt = false;
	throwOnDecrypt = false;
	encryptedSize: number | undefined;
	readonly encrypted: string[] = [];
	readonly ciphertexts: Buffer[] = [];
	readonly decrypted: Buffer[] = [];

	isEncryptionAvailable(): boolean {
		return this.available;
	}

	encryptString(plainText: string): Buffer {
		if (this.throwOnEncrypt) {
			throw new Error('encrypt failed');
		}
		this.encrypted.push(plainText);
		const result =
			this.encryptedSize !== undefined
				? Buffer.alloc(this.encryptedSize, 0x5a)
				: Buffer.from([...Buffer.from(plainText, 'utf8')].reverse().map((byte) => byte ^ 0xa5));
		this.ciphertexts.push(Buffer.from(result));
		return result;
	}

	decryptString(encrypted: Buffer): string {
		this.decrypted.push(Buffer.from(encrypted));
		if (this.throwOnDecrypt) {
			throw new Error('decrypt failed');
		}
		return Buffer.from([...encrypted].reverse().map((byte) => byte ^ 0xa5)).toString('utf8');
	}
}

const fixedRandom =
	(byte: number) =>
	(size: number): Buffer =>
		Buffer.alloc(size, byte);

function requiredActivation(
	cipher: WindowsToastCipher = new TestCipher(),
	steamId64 = ID,
	random = fixedRandom(1)
): WindowsToastActivation {
	const activation = issueWindowsToastActivation(steamId64, cipher, random);
	expect(activation, 'the test could not issue its activation').toBeDefined();
	return activation as WindowsToastActivation;
}

function argumentsForPlainText(cipher: WindowsToastCipher, plainText: string): string {
	return PREFIX + cipher.encryptString(plainText).toString('base64url');
}

function argumentsForPayload(cipher: WindowsToastCipher, payload: Record<string, unknown>): string {
	return argumentsForPlainText(cipher, JSON.stringify(payload));
}

const payload = (
	nonce = '11'.repeat(16),
	steamId64 = ID
): { v: 1; nonce: string; steamId64: string } => ({ v: 1, nonce, steamId64 });

describe('Windows toast activation issuance', () => {
	it('crosses a fresh process-local router with only an opaque launch argument', () => {
		const cipher = new TestCipher();
		const activation = requiredActivation(cipher);

		expect(cipher.encrypted).toHaveLength(1);
		expect(cipher.encrypted[0]).toContain(ID);
		expect(Object.keys(activation)).toEqual(['launchArguments']);
		expect(activation.launchArguments).toMatch(/^type=click&oda=[A-Za-z0-9_-]+$/);
		expect(activation.launchArguments).not.toContain(ID);
		expect(Buffer.from(activation.launchArguments.slice(PREFIX.length), 'base64url')).toEqual(
			cipher.ciphertexts[0]
		);

		const activate = vi.fn();
		const afterRestart = new WindowsToastActivationRouter({ cipher, activate });
		expect(afterRestart.handle(activation.launchArguments)).toBe(true);
		expect(activate).toHaveBeenCalledWith(ID);
	});

	it('gives separate toasts for one account separate event identities', () => {
		const cipher = new TestCipher();
		let next = 0;
		const random = (size: number): Buffer => Buffer.alloc(size, ++next);
		const first = requiredActivation(cipher, ID, random);
		const second = requiredActivation(cipher, ID, random);
		expect(first.launchArguments).not.toBe(second.launchArguments);

		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });
		expect(router.handle(first.launchArguments)).toBe(true);
		expect(router.handle(second.launchArguments)).toBe(true);
		expect(activate).toHaveBeenCalledTimes(2);
	});

	it('fails closed instead of exposing an id when encryption is unavailable or fails', () => {
		const unavailable = new TestCipher();
		unavailable.available = false;
		expect(issueWindowsToastActivation(ID, unavailable, fixedRandom(1))).toBeUndefined();
		expect(unavailable.encrypted).toEqual([]);

		const failing = new TestCipher();
		failing.throwOnEncrypt = true;
		expect(issueWindowsToastActivation(ID, failing, fixedRandom(1))).toBeUndefined();
	});

	it('refuses invalid accounts, malformed randomness and an oversized ciphertext', () => {
		const cipher = new TestCipher();
		expect(issueWindowsToastActivation('123', cipher, fixedRandom(1))).toBeUndefined();
		expect(cipher.encrypted).toEqual([]);
		expect(issueWindowsToastActivation(ID, cipher, () => Buffer.alloc(15))).toBeUndefined();

		cipher.encryptedSize = 1_025;
		expect(issueWindowsToastActivation(ID, cipher, fixedRandom(1))).toBeUndefined();
	});
});

describe('Windows toast activation decoding and duplicate suppression', () => {
	it('routes one activation once when both Electron paths deliver it', () => {
		const cipher = new TestCipher();
		const activation = requiredActivation(cipher);
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });

		expect(router.handle(activation.launchArguments)).toBe(true);
		expect(router.handle(activation.launchArguments)).toBe(false);
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it('deduplicates the nonce rather than only the ciphertext or account', () => {
		const cipher = new TestCipher();
		const nonce = '22'.repeat(16);
		const canonical = argumentsForPayload(cipher, payload(nonce));
		const reordered = argumentsForPlainText(cipher, JSON.stringify({ steamId64: ID, nonce, v: 1 }));
		expect(canonical).not.toBe(reordered);

		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });
		expect(router.handle(canonical)).toBe(true);
		expect(router.handle(reordered)).toBe(false);
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it('does not mark a hand-off that threw, so the same user action can retry', () => {
		const cipher = new TestCipher();
		const activation = requiredActivation(cipher);
		const activate = vi.fn().mockImplementationOnce(() => {
			throw new Error('receiver not ready');
		});
		const router = new WindowsToastActivationRouter({ cipher, activate });

		expect(router.handle(activation.launchArguments)).toBe(false);
		expect(router.handle(activation.launchArguments)).toBe(true);
		expect(activate).toHaveBeenCalledTimes(2);
	});

	it('reserves the nonce before a synchronous hand-off can re-enter', () => {
		const cipher = new TestCipher();
		const activation = requiredActivation(cipher);
		let reenter = (_arguments: string): boolean => {
			throw new Error('router is not ready');
		};
		const activate = vi.fn((_steamId64: string): undefined => {
			expect(reenter(activation.launchArguments)).toBe(false);
			return undefined;
		});
		const router = new WindowsToastActivationRouter({ cipher, activate });
		reenter = router.handle.bind(router);

		expect(router.handle(activation.launchArguments)).toBe(true);
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it('does not let a nested different activation evict its in-flight caller', () => {
		const cipher = new TestCipher();
		const first = argumentsForPayload(cipher, payload('01'.repeat(16), ID));
		const second = argumentsForPayload(cipher, payload('02'.repeat(16), OTHER_ID));
		let route = (_arguments: string): boolean => {
			throw new Error('router is not ready');
		};
		let nestedSecond: boolean | undefined;
		let repeatedFirst: boolean | undefined;
		const calls: string[] = [];
		const activate = (steamId64: string): undefined => {
			calls.push(steamId64);
			if (calls.length === 1) {
				nestedSecond = route(second);
				repeatedFirst = route(first);
			}
			return undefined;
		};
		const router = new WindowsToastActivationRouter({ cipher, activate, handledLimit: 1 });
		route = router.handle.bind(router);

		expect(router.handle(first)).toBe(true);
		expect(nestedSecond).toBe(true);
		expect(repeatedFirst).toBe(false);
		expect(calls).toEqual([ID, OTHER_ID]);
	});

	it('rejects an asynchronous hand-off at compile time', () => {
		type Activate = ConstructorParameters<typeof WindowsToastActivationRouter>[0]['activate'];
		expectTypeOf<() => Promise<undefined>>().not.toMatchTypeOf<Activate>();
	});

	it('bounds remembered event identities and evicts the oldest', () => {
		const cipher = new TestCipher();
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate, handledLimit: 2 });
		const first = argumentsForPayload(cipher, payload('01'.repeat(16), ID));
		const second = argumentsForPayload(cipher, payload('02'.repeat(16), ID));
		const third = argumentsForPayload(cipher, payload('03'.repeat(16), OTHER_ID));

		expect(router.handle(first)).toBe(true);
		expect(router.handle(second)).toBe(true);
		expect(router.handle(third)).toBe(true);
		expect(router.handle(first), 'the oldest identity was retained beyond the bound').toBe(true);
		expect(activate).toHaveBeenCalledTimes(4);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'refuses an invalid handled-identity bound: %s',
		(handledLimit) => {
			expect(
				() =>
					new WindowsToastActivationRouter({
						cipher: new TestCipher(),
						activate: vi.fn(),
						handledLimit
					})
			).toThrow(/positive safe integer/);
		}
	);

	it('rejects foreign, appended, non-base64url, noncanonical and oversized arguments early', () => {
		const cipher = new TestCipher();
		const cases = [
			'',
			'type=action&oda=abc',
			`${PREFIX}abc&extra=1`,
			`${PREFIX}abc=`,
			`${PREFIX}a*b`,
			`${PREFIX}_x`, // same byte as canonical `_w`, but with non-zero trailing bits
			PREFIX + 'a'.repeat(5_463)
		];
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });

		for (const arguments_ of cases) {
			expect(router.handle(arguments_)).toBe(false);
		}
		expect(cipher.decrypted, 'malformed metadata reached the decryption boundary').toEqual([]);
		expect(activate).not.toHaveBeenCalled();
	});

	it('rejects decryption failures, malformed JSON and oversized plaintext', () => {
		const failing = new TestCipher();
		failing.throwOnDecrypt = true;
		const failingRouter = new WindowsToastActivationRouter({
			cipher: failing,
			activate: vi.fn()
		});
		expect(failingRouter.handle(argumentsForPayload(failing, payload()))).toBe(false);

		const cipher = new TestCipher();
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });
		expect(router.handle(argumentsForPlainText(cipher, '{'))).toBe(false);
		expect(router.handle(argumentsForPlainText(cipher, 'x'.repeat(513)))).toBe(false);
		expect(activate).not.toHaveBeenCalled();
	});

	it.each([
		['wrong version', { ...payload(), v: 2 }],
		['missing member', { v: 1, nonce: '11'.repeat(16) }],
		['extra member', { ...payload(), accountName: 'trader' }],
		['uppercase nonce', payload('AA'.repeat(16))],
		['short nonce', payload('11')],
		['non-Steam id', payload('11'.repeat(16), '12345678901234567')],
		['numeric id', { ...payload(), steamId64: 76561198000000000 }]
	])('rejects a payload with a %s', (_name, candidate) => {
		const cipher = new TestCipher();
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });
		expect(router.handle(argumentsForPayload(cipher, candidate))).toBe(false);
		expect(activate).not.toHaveBeenCalled();
	});

	it('refuses to decrypt while the platform encryption boundary is unavailable', () => {
		const cipher = new TestCipher();
		const arguments_ = argumentsForPayload(cipher, payload());
		cipher.available = false;
		const activate = vi.fn();
		const router = new WindowsToastActivationRouter({ cipher, activate });

		expect(router.handle(arguments_)).toBe(false);
		expect(cipher.decrypted).toEqual([]);
		expect(activate).not.toHaveBeenCalled();
	});
});

describe('Windows toast XML', () => {
	it('carries escaped title, body, logo URI and opaque launch metadata', () => {
		const cipher = new TestCipher();
		const activation = requiredActivation(cipher);
		const xml = buildWindowsToastXml({
			title: `Account & <danger> "'`,
			body: `One <item> & its "owner's"`,
			activation,
			iconUri: `file:///C:/A&B/'logo'.png?variant="square"`
		});

		expect(xml).toContain('<toast launch="type=click&amp;oda=');
		expect(xml).toContain('<visual><binding template="ToastGeneric">');
		expect(xml).toContain('<text>Account &amp; &lt;danger&gt; &quot;&apos;</text>');
		expect(xml).toContain('<text>One &lt;item&gt; &amp; its &quot;owner&apos;s&quot;</text>');
		expect(xml).toContain(
			'<image id="1" placement="appLogoOverride" hint-crop="none" ' +
				'src="file:///C:/A&amp;B/&apos;logo&apos;.png?variant=&quot;square&quot;"/>'
		);
		expect(xml.match(/<text>/g)).toHaveLength(2);
		expect(xml).not.toContain(ID);
	});

	it('still produces a complete clickable toast when no icon URI is available', () => {
		const activation = requiredActivation();
		const xml = buildWindowsToastXml({ title: 'Account', body: 'Needs you', activation });

		expect(xml).toMatch(/^<toast launch=/);
		expect(xml).toContain('<text>Account</text><text>Needs you</text>');
		expect(xml).not.toContain('<image');
		expect(xml).toMatch(/<\/binding><\/visual><\/toast>$/);
	});

	it('keeps the largest accepted activation inside the platform envelope with normal copy', () => {
		const cipher = new TestCipher();
		cipher.encryptedSize = 1_024;
		const activation = requiredActivation(cipher);
		const xml = buildWindowsToastXml({
			title: 'Confirmation waiting',
			body: 'Open Desktop Authenticator to review it.',
			activation,
			iconUri: 'file:///C:/Program%20Files/Open%20Desktop%20Authenticator/notification.png'
		});

		expect(Buffer.byteLength(xml, 'utf8')).toBeLessThanOrEqual(5 * 1_024);
	});

	it('rejects a toast whose escaped UTF-8 XML exceeds the Windows 5 KiB limit', () => {
		const activation = requiredActivation();
		expect(() =>
			buildWindowsToastXml({
				title: '🔒'.repeat(1_300),
				body: 'Needs you',
				activation
			})
		).toThrow(/5 KiB platform limit/);
	});

	it('replaces characters XML 1.0 cannot represent without damaging Unicode', () => {
		const activation = requiredActivation();
		const xml = buildWindowsToastXml({
			title: `bad\0\ud800\ufffe title`,
			body: 'valid supplementary \u{1F512}',
			activation
		});

		expect(xml).toContain('<text>bad��� title</text>');
		expect(xml).toContain('<text>valid supplementary 🔒</text>');
		expect(xml).not.toContain('\0');
		expect(xml).not.toContain('\ud800');
		expect(xml).not.toContain('\ufffe');
	});

	it.each([`type=click&steamId64=${ID}`, `${PREFIX}a`, `${PREFIX}_x`, `${PREFIX}abc&extra=1`])(
		'refuses launch metadata that did not come from the opaque issuer: %s',
		(launchArguments) => {
			expect(() =>
				buildWindowsToastXml({
					title: 'Account',
					body: 'Needs you',
					activation: { launchArguments } as unknown as WindowsToastActivation
				})
			).toThrow(/invalid Windows toast activation arguments/);
		}
	);

	it('refuses a copied issuer brand when the opaque launch argument was replaced', () => {
		const activation = requiredActivation();
		const forged = {
			...activation,
			launchArguments: PREFIX + Buffer.from(ID).toString('base64url')
		};

		expect(() =>
			buildWindowsToastXml({
				title: 'Account',
				body: 'Needs you',
				activation: forged
			})
		).toThrow(/invalid Windows toast activation arguments/);
	});

	it.each([
		['title', { title: ID, body: 'Needs you' }],
		['body', { title: 'Account', body: `Review ${ID}` }],
		['icon URI', { title: 'Account', body: 'Needs you', iconUri: `file:///C:/${ID}.png` }]
	])('refuses a plaintext SteamID in the Windows toast %s', (_field, display) => {
		const activation = requiredActivation();
		expect(() => buildWindowsToastXml({ ...display, activation })).toThrow(/plaintext SteamID/);
	});

	it('exports the pinned canonical product CLSID', () => {
		expect(WINDOWS_TOAST_ACTIVATOR_CLSID).toBe('FB72EFDC-FEA0-44CD-9DD5-FFCFBEDBF734');
		expect(WINDOWS_TOAST_ACTIVATOR_CLSID).toMatch(
			/^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
		);
	});
});

describe('production Windows activation wiring', () => {
	const main = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
		''
	);

	it('uses a stable activator only for installed Windows builds', () => {
		expect(main).toMatch(
			/const persistentWindowsToastActivation\s*=\s*process\.platform === 'win32'\s*&&\s*portableDir === undefined/
		);
		expect(main).toMatch(
			/if \(persistentWindowsToastActivation\)\s*\{\s*app\.setToastActivatorCLSID\(WINDOWS_TOAST_ACTIVATOR_CLSID\)/
		);
	});

	it('places opaque launch metadata in each persistent Windows toast', () => {
		const start = main.indexOf('const notifier = new ConfirmationNotifier(');
		const end = main.indexOf('const autoConfirm = new AutoConfirmEngine(', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const host = main.slice(start, end);
		expect(host).toMatch(/issueWindowsToastActivation\(steamId64,\s*safeStorage\)/);
		expect(host).toMatch(/options\.toastXml\s*=\s*buildWindowsToastXml/);
		expect(host).toMatch(/windowsToastActivations\.handle\(activation\.launchArguments\)/);
		expect(host).toMatch(/else\s*\{\s*onClick\?\.\(\)/);
	});

	it('routes Action Center and cold-start activation through the same nonce router', () => {
		const ready = main.slice(main.indexOf('app.whenReady().then('));
		expect(ready).toMatch(/Notification\.handleActivation\(\(details\)\s*=>/);
		expect(ready).toMatch(
			/if \(details\.type === 'click'\)\s*\{\s*windowsToastActivations\.handle\(details\.arguments\)/
		);
	});
});
