/**
 * Minimal ambient declarations for the two McKay libraries that ship no types.
 *
 * These are deliberately narrow: they describe only the surface the spike uses.
 * They are NOT a general-purpose typing effort — Phase 1 wraps these libraries
 * in `/src/main/steam/` and the wrapper is where real types live (§10.4).
 */

declare module 'steam-totp' {
	/** Generate a 5-character Steam Guard code. */
	export function generateAuthCode(sharedSecret: string | Buffer, timeOffset?: number): string;
	/** Alias of generateAuthCode. */
	export function getAuthCode(sharedSecret: string | Buffer, timeOffset?: number): string;
	/** Generate a base64 confirmation key for a given unix time and tag. */
	export function getConfirmationKey(
		identitySecret: string | Buffer,
		time: number,
		tag: string
	): string;
	/** Current unix time, optionally corrected by an offset in seconds. */
	export function time(timeOffset?: number): number;
	/** Query Steam for the local clock's offset, in seconds. */
	export function getTimeOffset(
		callback: (err: Error | null, offset: number, latency: number) => void
	): void;
	/** Derive the SDA-compatible `android:<uuid>` device ID from a SteamID. */
	export function getDeviceID(steamID: string | { getSteamID64(): string }): string;
}

declare module '@doctormckay/stdlib' {
	import type { Agent } from 'node:http';
	/**
	 * Only the proxy-agent factory is used, and only for HTTP(S) proxies —
	 * SOCKS goes through socks-proxy-agent. This is the same call steam-session
	 * makes internally for its own `httpProxy` option.
	 */
	const Stdlib: {
		HTTP: {
			getProxyAgent(secure: boolean, proxyUrl: string): Agent;
		};
	};
	export = Stdlib;
}

declare module 'request' {
	/**
	 * We use exactly one thing from `request`: building a pre-configured
	 * instance to hand to steamcommunity. Everything else is steamcommunity's
	 * business, not ours.
	 *
	 * Note `request` has been deprecated since 2020; it is here only because
	 * steamcommunity depends on it (finding F-05).
	 */
	interface RequestStatic {
		defaults(options: Record<string, unknown>): unknown;
	}
	const Request: RequestStatic;
	export = Request;
}

declare module 'steamcommunity' {
	import { EventEmitter } from 'events';

	export interface SteamIDLike {
		getSteamID64(): string;
	}

	export interface CConfirmation {
		id: string;
		/** 2 = Trade, 3 = MarketListing. See SteamCommunity.ConfirmationType. */
		type: number;
		/** Trade offer ID for trades, listing ID for market listings. */
		creator: string;
		/** Per-confirmation nonce, required to respond. Not a TOTP key. */
		key: string;
		title: string;
		receiving: string;
		sending: string;
		time: string;
		timestamp: Date;
		icon: string;
		offerID: string | null;
	}

	export interface ConfirmationKeyArg {
		tag: string;
		key: string;
	}

	export interface SteamCommunityOptions {
		/** Bind outbound requests to a local IP. The only routing knob it offers natively. */
		localAddress?: string;
		/**
		 * A pre-configured `request` instance. This is the ONLY way to make
		 * steamcommunity honour a proxy — see src/proxy.ts.
		 */
		request?: unknown;
	}

	class SteamCommunity extends EventEmitter {
		constructor(options?: SteamCommunityOptions);
		steamID: SteamIDLike | null;
		setCookies(cookies: string[]): void;
		setMobileAppAccessToken(token: string): void;
		getConfirmations(
			time: number,
			key: string | ConfirmationKeyArg,
			callback: (err: Error | null, confirmations: CConfirmation[]) => void
		): void;
		respondToConfirmation(
			confID: string | string[],
			confKey: string | string[],
			time: number,
			key: string | ConfirmationKeyArg,
			accept: boolean,
			callback: (err: Error | null) => void
		): void;
	}

	namespace SteamCommunity {
		const ConfirmationType: {
			Trade: 2;
			MarketListing: 3;
			[k: string]: unknown;
		};
	}

	export = SteamCommunity;
}
