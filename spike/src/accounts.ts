import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MaFileError, parseMaFile, type ParsedMaFile } from './mafile';

/**
 * Resolving "which account" without a secret store.
 *
 * The spike deliberately keeps NO copy of any secret. There is no vault here
 * (that is F1, milestone 0.1) and no plaintext account database either — writing
 * one would mean the throwaway spike scatters shared_secrets across the disk.
 *
 * So an "account" is just a maFile the founder already has. It can be named as:
 *   - a path:          code ./76561199999999999.maFile
 *   - an account name: code myaccount        (needs SPIKE_MAFILE_DIR)
 *   - a SteamID64:     code 76561199999999999 (needs SPIKE_MAFILE_DIR)
 *
 * Secrets live in that file and in memory. Nothing is copied anywhere.
 */

function looksLikePath(arg: string): boolean {
	return arg.includes('/') || arg.includes('\\') || /\.maFile$/i.test(arg);
}

function maFileDir(): string | undefined {
	const dir = process.env.SPIKE_MAFILE_DIR;
	if (!dir) {
		return undefined;
	}
	const abs = resolve(dir);
	if (!existsSync(abs) || !statSync(abs).isDirectory()) {
		throw new Error(`SPIKE_MAFILE_DIR points at ${abs}, which is not a directory.`);
	}
	return abs;
}

export function resolveAccount(arg: string): ParsedMaFile {
	if (looksLikePath(arg)) {
		const abs = resolve(arg);
		if (!existsSync(abs)) {
			throw new Error(`no such file: ${abs}`);
		}
		return parseMaFile(abs);
	}

	const dir = maFileDir();
	if (!dir) {
		throw new Error(
			`"${arg}" is not a path, and SPIKE_MAFILE_DIR is not set. ` +
				'Either pass the path to a .maFile, or set SPIKE_MAFILE_DIR to the folder holding them.'
		);
	}

	// Fast path: <dir>/<arg>.maFile
	const direct = join(dir, `${arg}.maFile`);
	if (existsSync(direct)) {
		return parseMaFile(direct);
	}

	// Slow path: parse each maFile and match on account_name or SteamID64.
	const candidates = readdirSync(dir).filter((f) => /\.maFile$/i.test(f));
	const needle = arg.toLowerCase();
	const unreadable: string[] = [];

	for (const file of candidates) {
		let parsed: ParsedMaFile;
		try {
			parsed = parseMaFile(join(dir, file));
		} catch (err) {
			// A malformed file in the folder must not stop us finding a good one.
			unreadable.push(file + (err instanceof MaFileError ? ` (${err.message})` : ''));
			continue;
		}
		if (parsed.accountName.toLowerCase() === needle || parsed.steamId64 === arg) {
			return parsed;
		}
	}

	const extra =
		unreadable.length > 0
			? ` ${unreadable.length} file(s) in that folder could not be parsed.`
			: '';
	throw new Error(
		`no maFile in ${dir} matches "${arg}" (searched ${candidates.length} file(s) by account name and SteamID).${extra}`
	);
}
