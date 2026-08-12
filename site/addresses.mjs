/**
 * The donation addresses, and the arithmetic that proves they are not typos.
 *
 * ## Why this file does more than hold four strings
 *
 * A payment address is the one kind of content on this site where a single
 * wrong character is unrecoverable. There is no support desk, no chargeback and
 * no way to notice: the page looks right, the donor's wallet accepts it, and the
 * money goes to whoever happens to own the address that the typo spells. On a
 * site whose whole subject is people losing things to a plausible-looking
 * string, publishing an unchecked one would be indefensible.
 *
 * So each address is verified against its own checksum at build time. Base58Check
 * — which Tron and Litecoin both use — carries four bytes of SHA-256 over the
 * payload, so any realistic transcription error fails to decode. That is a real
 * proof, not a length check.
 *
 * What each check can and cannot catch is stated honestly beside it. The EVM
 * address is the weakest case and says so.
 */

import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58 to bytes. Returns undefined on any character outside the alphabet. */
function base58Decode(input) {
	let num = 0n;
	for (const ch of input) {
		const digit = B58.indexOf(ch);
		if (digit < 0) {
			return undefined;
		}
		num = num * 58n + BigInt(digit);
	}
	const bytes = [];
	while (num > 0n) {
		bytes.unshift(Number(num & 0xffn));
		num >>= 8n;
	}
	// Every leading '1' is a leading zero byte that the arithmetic above drops.
	for (const ch of input) {
		if (ch !== '1') break;
		bytes.unshift(0);
	}
	return Uint8Array.from(bytes);
}

const sha256 = (bytes) => Uint8Array.from(createHash('sha256').update(bytes).digest());

/**
 * Base58Check: the last four bytes are the first four of SHA-256(SHA-256(rest)).
 *
 * This is what makes a typo detectable. Change any character and the payload
 * changes, so the hash changes, so these four bytes no longer match.
 */
function base58CheckPayload(address) {
	const raw = base58Decode(address);
	if (!raw || raw.length < 5) {
		return undefined;
	}
	const payload = raw.subarray(0, raw.length - 4);
	const found = raw.subarray(raw.length - 4);
	const want = sha256(sha256(payload)).subarray(0, 4);
	for (let i = 0; i < 4; i++) {
		if (found[i] !== want[i]) return undefined;
	}
	return payload;
}

/** Each network, with the rule that decides whether an address is well formed. */
const NETWORKS = {
	tron: {
		label: 'Tron (TRC-20)',
		// 21 bytes: a 0x41 version byte and twenty of address.
		check: (a) => {
			const p = base58CheckPayload(a);
			return !!p && p.length === 21 && p[0] === 0x41 && a.startsWith('T');
		},
		proof: 'base58check — a changed character fails the SHA-256 checksum'
	},
	litecoin: {
		label: 'Litecoin',
		// 21 bytes: version 0x30 for a legacy L-address, then the hash160.
		check: (a) => {
			const p = base58CheckPayload(a);
			return !!p && p.length === 21 && p[0] === 0x30 && a.startsWith('L');
		},
		proof: 'base58check — a changed character fails the SHA-256 checksum'
	},
	solana: {
		label: 'Solana',
		// A raw ed25519 public key: 32 bytes, no checksum of any kind.
		check: (a) => {
			const raw = base58Decode(a);
			return !!raw && raw.length === 32;
		},
		proof: 'base58 decodes to exactly 32 bytes — catches a dropped or added character, but Solana addresses carry no checksum, so a swap of two valid characters cannot be detected here'
	},
	evm: {
		label: 'Polygon and BNB Smart Chain',
		// 20 bytes of hex. Lowercase, so EIP-55 case checksumming does not apply.
		check: (a) => /^0x[0-9a-f]{40}$/.test(a),
		proof: 'twenty bytes of lowercase hex — an all-lowercase address carries no EIP-55 checksum, so this confirms the shape only'
	}
};

/**
 * Where donations go.
 *
 * Transcribed once and then never retyped: anything that needs one of these
 * reads it from here, so there is a single place to be right.
 */
export const ADDRESSES = [
	{
		id: 'usdt-tron',
		asset: 'USDT',
		network: 'tron',
		chain: 'Tron (TRC-20)',
		note: 'Lowest fees of the four. Send only TRC-20 USDT.',
		address: 'TLXxDn2fqAobwDeALr68B3PnppRKJJxoqh'
	},
	{
		id: 'usdt-evm',
		asset: 'USDT',
		network: 'evm',
		chain: 'Polygon or BNB Smart Chain',
		note: 'The same address on both chains. Send only on Polygon or BSC — not Ethereum mainnet.',
		address: '0x769962fd970e9875fd4de0a42cff2b84a0af5bfd'
	},
	{
		id: 'usdt-solana',
		asset: 'USDT',
		network: 'solana',
		chain: 'Solana (SPL)',
		note: 'Send only SPL USDT on Solana.',
		address: '4K1zPaNaY69RDjumpjVxQWNivStdDtdnZYAZPjwPh9VG'
	},
	{
		id: 'ltc',
		asset: 'LTC',
		network: 'litecoin',
		chain: 'Litecoin',
		note: 'Native LTC, not a wrapped token on another chain.',
		address: 'Le6UH42caRf2neunBbft9dUZL2X6EVAnKj'
	}
];

/** Every address, checked. Returns a list of problems; empty means all sound. */
export function checkAddresses(list = ADDRESSES) {
	const problems = [];
	for (const entry of list) {
		const net = NETWORKS[entry.network];
		if (!net) {
			problems.push(`${entry.id}: unknown network "${entry.network}"`);
			continue;
		}
		if (!net.check(entry.address)) {
			problems.push(
				`${entry.id}: ${entry.address} is not a valid ${net.label} address (${net.proof})`
			);
		}
	}
	return problems;
}

export { NETWORKS, base58Decode, base58CheckPayload };
