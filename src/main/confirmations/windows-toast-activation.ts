import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { steamId64Schema } from '../../shared/vault-schema';

/**
 * Windows uses this identity to reconnect an Action Center activation to the
 * application's COM server. It is product identity, not a secret, and must
 * remain stable across upgrades. The AppX manifest has to carry the same value.
 */
export const WINDOWS_TOAST_ACTIVATOR_CLSID = 'FB72EFDC-FEA0-44CD-9DD5-FFCFBEDBF734';

const ACTIVATION_PREFIX = 'type=click&oda=';
const NONCE_BYTES = 16;
/*
 * Windows limits the entire toast XML document to 5 KiB. Keep opaque launch
 * metadata well below that envelope so normal title, body and icon values have
 * room; `buildWindowsToastXml` performs the authoritative final byte check.
 */
const MAX_CIPHERTEXT_BYTES = 1_024;
const MAX_ENCODED_BYTES = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3);
const MAX_PLAINTEXT_CHARS = 512;
const MAX_TOAST_XML_BYTES = 5 * 1_024;
const DEFAULT_HANDLED_LIMIT = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ACTIVATION_BRAND: unique symbol = Symbol('WindowsToastActivation');
const issuedActivations = new WeakMap<object, string>();

const payloadSchema = z
	.object({
		v: z.literal(1),
		nonce: z.string().regex(/^[0-9a-f]{32}$/),
		steamId64: steamId64Schema
	})
	.strict();

type ActivationPayload = z.infer<typeof payloadSchema>;

/** The synchronous part of Electron's `safeStorage` API used by this module. */
export interface WindowsToastCipher {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

export interface WindowsToastActivation {
	/** The value placed in the toast's `launch` attribute, before XML escaping. */
	readonly launchArguments: string;
	/** Only `issueWindowsToastActivation` can construct a value accepted by the XML builder. */
	readonly [ACTIVATION_BRAND]: true;
}

export interface WindowsToastXmlOptions {
	title: string;
	body: string;
	activation: WindowsToastActivation;
	/** A `file:///` URI for the existing square notification logo. */
	iconUri?: string;
}

type RandomBytes = (size: number) => Buffer;

/**
 * Create opaque, restart-safe launch arguments for one notification.
 *
 * This deliberately uses the synchronous safeStorage API. Notification
 * construction is synchronous today; introducing an await here would let a
 * vault lock interleave between the poll's final guard and `Notification.show`,
 * raising a disclosure after the lock. The payload is tiny and this runs only
 * when a toast has already earned a user-visible interruption.
 *
 * `undefined` is fail-closed for persistence. The caller may still show the
 * ordinary in-process notification, but must never fall back to a plaintext
 * SteamID in Windows metadata.
 */
export function issueWindowsToastActivation(
	steamId64: string,
	cipher: WindowsToastCipher,
	random: RandomBytes = randomBytes
): WindowsToastActivation | undefined {
	if (!steamId64Schema.safeParse(steamId64).success) {
		return undefined;
	}

	try {
		if (!cipher.isEncryptionAvailable()) {
			return undefined;
		}

		const nonceBytes = random(NONCE_BYTES);
		if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== NONCE_BYTES) {
			return undefined;
		}

		const payload: ActivationPayload = {
			v: 1,
			nonce: nonceBytes.toString('hex'),
			steamId64
		};
		const encrypted = cipher.encryptString(JSON.stringify(payload));
		if (
			!Buffer.isBuffer(encrypted) ||
			encrypted.length === 0 ||
			encrypted.length > MAX_CIPHERTEXT_BYTES
		) {
			return undefined;
		}

		const activation = Object.freeze({
			launchArguments: ACTIVATION_PREFIX + encrypted.toString('base64url'),
			[ACTIVATION_BRAND]: true as const
		});
		issuedActivations.set(activation, steamId64);
		return activation;
	} catch {
		return undefined;
	}
}

const validXmlCodePoint = (codePoint: number): boolean =>
	codePoint === 0x09 ||
	codePoint === 0x0a ||
	codePoint === 0x0d ||
	(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
	(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
	(codePoint >= 0x10000 && codePoint <= 0x10ffff);

/** Escape both XML text and attribute values and replace characters XML 1.0 rejects. */
function escapeXml(value: string): string {
	let escaped = '';
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || !validXmlCodePoint(codePoint)) {
			escaped += '\uFFFD';
			continue;
		}
		switch (character) {
			case '&':
				escaped += '&amp;';
				break;
			case '<':
				escaped += '&lt;';
				break;
			case '>':
				escaped += '&gt;';
				break;
			case "'":
				escaped += '&apos;';
				break;
			case '"':
				escaped += '&quot;';
				break;
			default:
				escaped += character;
		}
	}
	return escaped;
}

function encodedCiphertext(arguments_: string): string | undefined {
	if (!arguments_.startsWith(ACTIVATION_PREFIX)) {
		return undefined;
	}
	const encoded = arguments_.slice(ACTIVATION_PREFIX.length);
	if (encoded.length === 0 || encoded.length > MAX_ENCODED_BYTES || !BASE64URL.test(encoded)) {
		return undefined;
	}
	return encoded;
}

/**
 * Build the complete XML because Electron's `toastXml` replaces title, body and
 * icon rather than augmenting them.
 */
export function buildWindowsToastXml(options: WindowsToastXmlOptions): string {
	const steamId64 = issuedActivations.get(options.activation);
	if (
		steamId64 === undefined ||
		encodedCiphertext(options.activation.launchArguments) === undefined
	) {
		throw new Error('invalid Windows toast activation arguments');
	}

	const image = options.iconUri
		? `<image id="1" placement="appLogoOverride" hint-crop="none" src="${escapeXml(options.iconUri)}"/>`
		: '';
	const xml =
		`<toast launch="${escapeXml(options.activation.launchArguments)}">` +
		`<visual><binding template="ToastGeneric">` +
		`<text>${escapeXml(options.title)}</text>` +
		`<text>${escapeXml(options.body)}</text>` +
		image +
		`</binding></visual></toast>`;
	if (Buffer.byteLength(xml, 'utf8') > MAX_TOAST_XML_BYTES) {
		throw new Error('Windows toast XML exceeds the 5 KiB platform limit');
	}
	if (xml.includes(steamId64)) {
		throw new Error('Windows toast XML must not contain a plaintext SteamID');
	}
	return xml;
}

function decodeWindowsToastActivation(
	arguments_: string,
	cipher: WindowsToastCipher
): ActivationPayload | undefined {
	const encoded = encodedCiphertext(arguments_);
	if (encoded === undefined) {
		return undefined;
	}

	try {
		if (!cipher.isEncryptionAvailable()) {
			return undefined;
		}
		const encrypted = Buffer.from(encoded, 'base64url');
		if (
			encrypted.length === 0 ||
			encrypted.length > MAX_CIPHERTEXT_BYTES ||
			encrypted.toString('base64url') !== encoded
		) {
			return undefined;
		}

		const plainText = cipher.decryptString(encrypted);
		if (plainText.length === 0 || plainText.length > MAX_PLAINTEXT_CHARS) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(plainText);
		const payload = payloadSchema.safeParse(parsed);
		return payload.success ? payload.data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The one sink for both Electron activation paths:
 *
 * - a live `Notification` instance's `click` event; and
 * - `Notification.handleActivation`, including a cold start.
 *
 * Windows/Electron can deliver one user action through both paths. The encrypted
 * payload's random nonce makes that one action idempotent without treating the
 * SteamID itself as an event identity.
 */
export class WindowsToastActivationRouter {
	private readonly cipher: WindowsToastCipher;
	private readonly activate: (steamId64: string) => undefined;
	private readonly handledLimit: number;
	private readonly handled = new Set<string>();
	private readonly handling = new Set<string>();

	constructor(options: {
		cipher: WindowsToastCipher;
		/** Synchronous by contract: reserve, hand off, then either commit or roll back. */
		activate: (steamId64: string) => undefined;
		handledLimit?: number;
	}) {
		const handledLimit = options.handledLimit ?? DEFAULT_HANDLED_LIMIT;
		if (!Number.isSafeInteger(handledLimit) || handledLimit < 1) {
			throw new RangeError('handled Windows toast limit must be a positive safe integer');
		}
		this.cipher = options.cipher;
		this.activate = options.activate;
		this.handledLimit = handledLimit;
	}

	/** @returns true only when this call caused a new account activation. */
	handle(arguments_: string): boolean {
		const payload = decodeWindowsToastActivation(arguments_, this.cipher);
		if (
			payload === undefined ||
			this.handled.has(payload.nonce) ||
			this.handling.has(payload.nonce)
		) {
			return false;
		}

		/*
		 * Reserve before the callback. `activate` reveals and pushes synchronously,
		 * and a callback supplied by an adapter must not be able to re-enter this
		 * method and route the same OS action a second time. In-flight reservations
		 * are separate from the bounded completed history: a nested different event
		 * must not evict its caller before the caller has finished.
		 */
		this.handling.add(payload.nonce);
		try {
			this.activate(payload.steamId64);
		} catch {
			// A failed hand-off was not handled; a later delivery may retry it.
			return false;
		} finally {
			this.handling.delete(payload.nonce);
		}

		this.handled.add(payload.nonce);
		while (this.handled.size > this.handledLimit) {
			const oldest = this.handled.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.handled.delete(oldest);
		}
		return true;
	}
}
