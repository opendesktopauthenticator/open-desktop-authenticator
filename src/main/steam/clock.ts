import { queryTimeOffset, SteamTimeError } from './time';
import type { CodeService } from '../codes/service';
import type { SteamTransportFactory } from '../net/transport';
import type { VaultService } from '../vault/service';

/**
 * Keeping the codes and confirmations on Steam's clock.
 *
 * One place owns the "have we asked yet / are we asking / apply the answer"
 * state, so unlock, code listing, and confirmation listing cannot each invent a
 * slightly different policy about failed syncs (the failure mode that permanently
 * silences the "clock unchecked" warning).
 */

export interface SteamClockOptions {
	codes: CodeService;
	vault: VaultService;
	transports: SteamTransportFactory;
	/** Injected for testability. Defaults to the wall clock. */
	now?: () => number;
}

/** Partition name used when the vault has no accounts to borrow a route from. */
const DIRECT_SYNC_ID = 'steam-clock-sync';

export class SteamClock {
	private readonly codes: CodeService;
	private readonly vault: VaultService;
	private readonly transports: SteamTransportFactory;
	private readonly now: () => number;
	/** Coalesce concurrent callers into one QueryTime. */
	private inFlight: Promise<void> | undefined;

	constructor(options: SteamClockOptions) {
		this.codes = options.codes;
		this.vault = options.vault;
		this.transports = options.transports;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Ensure Steam's clock has been checked at least once this process.
	 *
	 * Resolves whether or not the check succeeded. A failure leaves the codes
	 * service unverified — callers must not treat resolution as "the offset is
	 * good", only as "we tried". Success calls `setTimeOffset`; failure never does.
	 */
	ensureSynced(): Promise<void> {
		if (!this.codes.clockUnverified()) {
			return Promise.resolve();
		}
		if (this.inFlight) {
			return this.inFlight;
		}

		this.inFlight = this.run().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async run(): Promise<void> {
		if (!this.vault.isUnlocked()) {
			return;
		}

		// Prefer an account that already routes: the time query is itself Steam
		// traffic, and sending it from the machine's own address when every account
		// is configured to hide that address would be a quiet anonymity leak.
		const accounts = this.vault.read().accounts;
		const routed = accounts.find((account) => account.proxyUrl);
		const borrowed = routed ?? accounts[0];
		const steamId64 = borrowed?.steamId64 ?? DIRECT_SYNC_ID;
		const proxyUrl = borrowed?.proxyUrl;

		try {
			const transport = await this.transports.forAccount({ steamId64, proxyUrl });
			const offset = await queryTimeOffset(transport, this.now());
			this.codes.setTimeOffset(offset);
		} catch (err) {
			// Deliberately not writing zero. That would mark the clock "verified"
			// for a check that never happened (or failed), and the UI would stop
			// warning about the exact condition the user needs to know about.
			if (err instanceof SteamTimeError || err instanceof Error) {
				return;
			}
			return;
		} finally {
			// The synthetic direct partition is only a vehicle for the query. Drop
			// it so it does not look like an account session after unlock.
			if (!borrowed) {
				this.transports.forget(DIRECT_SYNC_ID);
			}
		}
	}
}
