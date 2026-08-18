import { describe, expect, it, vi } from 'vitest';
import { continueTransfer, TransferApiError } from '../src/main/steam/transfer-api';
import { encodeContinueRequest } from '../src/main/steam/transfer-proto';
import type { SteamRequest, SteamResponse } from '../src/main/confirmations/client';

/*
 * The call that rotates the authenticator.
 *
 * By the time it returns, the user's phone has stopped being their
 * authenticator and the only copy of the replacement is what came back. The
 * tests here are about that asymmetry: what is sent must be exactly right, what
 * comes back must survive intact, and a lost reply must never be reported as a
 * failure.
 */

const TOKEN = 'jwt-goes-here';

/** A response Steam could plausibly send, built from the encoder's own schema. */
function replacementBody(): Buffer {
	const secret = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x7f]);
	const token = Buffer.concat([
		Buffer.from([0x0a, secret.length]),
		secret,
		Buffer.from([0x1a, 0x06]),
		Buffer.from('R98765', 'utf8'),
		Buffer.from([0x42, 0x03, 0x10, 0x20, 0x30]),
		(() => {
			const b = Buffer.alloc(9);
			b[0] = 0x61;
			b.writeBigUInt64LE(76561198000000001n, 1);
			return b;
		})()
	]);
	return Buffer.concat([Buffer.from([0x08, 0x01]), Buffer.from([0x12, token.length]), token]);
}

function transportReturning(response: Partial<SteamResponse>): {
	transport: (request: SteamRequest) => Promise<SteamResponse>;
	seen: SteamRequest[];
} {
	const seen: SteamRequest[] = [];
	const transport = vi.fn((request: SteamRequest) => {
		seen.push(request);
		return Promise.resolve({ status: 200, text: '', ...response });
	});
	return { transport, seen };
}

describe('submitting the texted code', () => {
	it('sends the encoded request as base64 in the form field', async () => {
		const { transport, seen } = transportReturning({
			text: replacementBody().toString('latin1')
		});
		await continueTransfer(transport, TOKEN, '12345');
		expect(seen[0]?.body?.get('input_protobuf_encoded')).toBe(
			encodeContinueRequest('12345').toString('base64')
		);
	});

	/*
	 * The transport reads bodies as UTF-8 by default, which for a body of random
	 * secret bytes replaces most of them with U+FFFD — silently, and the result
	 * still looks like a string. This flag is the only thing standing between a
	 * successful transfer and a stored secret that generates wrong codes forever.
	 */
	it('asks for the response bytes to be left alone', async () => {
		const { transport, seen } = transportReturning({
			text: replacementBody().toString('latin1')
		});
		await continueTransfer(transport, TOKEN, '12345');
		expect(seen[0]?.binary).toBe(true);
	});

	it('recovers secrets containing bytes that are not valid UTF-8', async () => {
		const { transport } = transportReturning({ text: replacementBody().toString('latin1') });
		const result = await continueTransfer(transport, TOKEN, '12345');
		expect(result.success).toBe(true);
		expect(result.replacementToken?.sharedSecret).toBe(
			Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x7f]).toString('base64')
		);
		expect(result.replacementToken?.revocationCode).toBe('R98765');
		expect(result.replacementToken?.steamId64).toBe('76561198000000001');
	});

	it('calls Steam exactly once', async () => {
		const { transport, seen } = transportReturning({
			text: replacementBody().toString('latin1')
		});
		await continueTransfer(transport, TOKEN, '12345');
		expect(seen).toHaveLength(1);
	});

	it('explains a refusal in words rather than a number', async () => {
		const { transport } = transportReturning({ status: 429, eresult: 84 });
		await expect(continueTransfer(transport, TOKEN, '12345')).rejects.toThrow(/rate-limiting/);
	});

	it('carries the status on the error', async () => {
		const { transport } = transportReturning({ status: 401, eresult: 15 });
		const err = await continueTransfer(transport, TOKEN, '12345').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TransferApiError);
		expect((err as TransferApiError).status).toBe(401);
	});

	/*
	 * A reply that cannot be decoded must not be reported as "it did not happen".
	 * Steam may already have rotated the authenticator.
	 */
	it('throws rather than reporting failure when the reply is unreadable', async () => {
		const { transport } = transportReturning({ text: 'ÿÿÿÿ' });
		await expect(continueTransfer(transport, TOKEN, '12345')).rejects.toThrow();
	});
});
