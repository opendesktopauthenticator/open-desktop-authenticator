#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './redact';
import { importCommand } from './commands/import';
import { codeCommand } from './commands/code';
import { loginCommand } from './commands/login';
import { confirmationsCommand } from './commands/confirmations';
import { acceptCommand } from './commands/accept';

/**
 * Phase 0 spike CLI (§19).
 *
 * Purpose: prove that steam-session / steam-totp / steamcommunity behave the way
 * §10.4 assumes, on real accounts, before a single line of Electron is written.
 * This is reference code. It is not shipped and it is not the product.
 *
 * Disk writes: exactly one, and only to a file the user already pointed us at —
 * refreshed session tokens are written back into the source maFile (see
 * `writeback.ts`). The spike creates no store of its own. Disable with
 * SPIKE_NO_WRITEBACK=1.
 */

const USAGE = `
spike — Phase 0 loop test. Not the product; nothing here is shipped.

  spike import <maFile|dir> [...]      Parse maFiles and report what F2 would see
  spike code <account> [--watch]       Generate a Steam Guard code (no login needed)
  spike login <account>                Prove the login handshake; saves refreshed tokens
  spike confirmations <account>        List outstanding mobile confirmations
  spike accept <account> <id> [--deny] Act on one confirmation (irreversible)

<account> is a path to a .maFile, or — when SPIKE_MAFILE_DIR is set — an account
name or SteamID64 to look up inside that directory.

Environment (all optional, all from a gitignored .env):
  SPIKE_MAFILE_DIR          Folder containing .maFile files
  SPIKE_STEAM_PASSWORD      Password to use when one is needed
  SPIKE_PASSWORD_<ACCOUNT>  Per-account override (account name upper-cased)
  SPIKE_PROXY               Route this account's traffic via a proxy
                            http(s)://user:pass@host:port or socks5://…
  SPIKE_PROXY_<ACCOUNT>     Per-account proxy; wins over SPIKE_PROXY

A configured proxy covers BOTH the login and the confirmation traffic, or the
command refuses to run — a half-proxied session leaks your real IP on whatever
it does not cover. Use a proxy you trust: it sees every host you contact.

If no password variable is set, you are prompted; input is not echoed and never
stored (§11 S8).

Token write-back is ON by default. After a successful login the refreshed tokens
are written back into the maFile they came from (atomically, keeping a .bak), so
the password is only needed once the refresh token actually expires. That file
already holds your shared_secret and revocation_code, so nothing new is put on
disk — but the file IS modified. Set SPIKE_NO_WRITEBACK=1 to disable it.
`;

function loadDotEnv(): void {
	const envPath = resolve(__dirname, '..', '.env');
	if (!existsSync(envPath)) {
		return;
	}
	try {
		process.loadEnvFile(envPath);
	} catch (err) {
		log.warn(`could not read .env: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function main(): Promise<number> {
	loadDotEnv();

	const [command, ...args] = process.argv.slice(2);

	switch (command) {
		case 'import':
			return importCommand(args);
		case 'code':
			return codeCommand(args);
		case 'login':
			return loginCommand(args);
		case 'confirmations':
			return confirmationsCommand(args);
		case 'accept':
			return acceptCommand(args);
		case undefined:
		case '-h':
		case '--help':
		case 'help':
			process.stdout.write(USAGE);
			return 0;
		default:
			log.error(`unknown command: ${command}`);
			process.stdout.write(USAGE);
			return 2;
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err: unknown) => {
		// Errors go through the redaction wrapper too (§11 S4) — a Steam library
		// error can carry a URL with a token in the query string.
		log.error(err instanceof Error ? err.message : String(err));
		if (process.env.SPIKE_DEBUG === '1' && err instanceof Error && err.stack) {
			log.error(err.stack);
		}
		process.exitCode = 1;
	});
