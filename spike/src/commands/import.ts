import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as SteamTotp from 'steam-totp';
import { MaFileError, parseMaFile, type ParsedMaFile } from '../mafile';
import { log, mask } from '../redact';

/**
 * `import` — validate maFiles and report what a real importer would find.
 *
 * The spike does not store anything. This command answers one question: "would
 * F2's parser survive the founder's actual files?" Everything it prints is
 * non-secret metadata plus masked fingerprints. It makes no network calls.
 */

function expandTargets(targets: string[]): string[] {
	const files: string[] = [];
	for (const target of targets) {
		const abs = resolve(target);
		let stats;
		try {
			stats = statSync(abs);
		} catch {
			log.error(`${abs}: no such file or directory`);
			continue;
		}
		if (stats.isDirectory()) {
			const found = readdirSync(abs)
				.filter((f) => /\.maFile$/i.test(f))
				.map((f) => join(abs, f));
			if (found.length === 0) {
				log.warn(`${abs}: directory contains no .maFile files`);
			}
			files.push(...found);
		} else {
			files.push(abs);
		}
	}
	return files;
}

function reportOne(parsed: ParsedMaFile): void {
	log.info(`  account name    : ${parsed.accountName}`);
	log.info(
		`  steamID64       : ${parsed.steamId64 ?? '(none - resolve at first login)'}${
			parsed.steamIdSource ? `  [from ${parsed.steamIdSource}]` : ''
		}`
	);
	log.info(`  shared_secret   : ${mask(parsed.sharedSecret)}`);
	log.info(`  identity_secret : ${mask(parsed.identitySecret)}`);
	log.info(
		`  revocation code : ${parsed.revocationCode ? `present (${parsed.revocationCode.length} chars)` : 'ABSENT'}`
	);
	log.info(`  refresh token   : ${parsed.refreshToken ? 'present' : 'absent'}`);
	log.info(`  proxy in file   : ${parsed.proxy ? 'present' : 'absent'}`);

	// §10.4: confirm our device-ID story against the ecosystem helper.
	if (parsed.steamId64) {
		const derived = SteamTotp.getDeviceID(parsed.steamId64);
		if (parsed.deviceId) {
			const matches = parsed.deviceId === derived;
			log.info(
				`  device_id       : ${parsed.deviceId}\n` +
					`                    derived: ${derived}  -> ${matches ? 'MATCH' : 'DIFFERENT'}`
			);
			if (!matches) {
				log.info(
					'                    (steamcommunity derives this itself for confirmations, so the\n' +
						'                     stored value is not used at request time - see §10.4 findings.)'
				);
			}
		} else {
			log.info(`  device_id       : absent; would derive ${derived}`);
		}
	} else if (parsed.deviceId) {
		log.info(`  device_id       : ${parsed.deviceId} (cannot verify without a SteamID)`);
	}

	for (const warning of parsed.warnings) {
		log.warn(`  ${warning}`);
	}
}

export async function importCommand(args: string[]): Promise<number> {
	if (args.length === 0) {
		log.error('usage: spike import <maFile|directory> [...]');
		return 2;
	}

	const files = expandTargets(args);
	if (files.length === 0) {
		log.error('nothing to import.');
		return 1;
	}

	log.info(`Parsing ${files.length} file(s).\n`);

	let imported = 0;
	let failed = 0;
	let missingRevocation = 0;
	const seenSteamIds = new Map<string, string>();

	for (const file of files) {
		log.info(`-- ${file}`);
		try {
			const parsed = parseMaFile(file);
			reportOne(parsed);

			if (!parsed.revocationCode) {
				missingRevocation++;
			}
			if (parsed.steamId64) {
				const previous = seenSteamIds.get(parsed.steamId64);
				if (previous) {
					log.warn(`  DUPLICATE: same SteamID already seen in ${previous}`);
				} else {
					seenSteamIds.set(parsed.steamId64, file);
				}
			}
			imported++;
		} catch (err) {
			failed++;
			log.error(`  ${err instanceof MaFileError ? err.message : String(err)}`);
		}
		log.blank();
	}

	log.info('-- Summary');
	log.info(`  parsed OK          : ${imported}`);
	log.info(`  failed             : ${failed}`);
	log.info(`  unique SteamIDs    : ${seenSteamIds.size}`);
	log.info(`  no revocation code : ${missingRevocation}`);
	log.blank();
	log.info(
		'The spike stored nothing. In the real app each of these would now go through\n' +
			'the forced revocation-code backup ceremony before being marked active (§11 S12).'
	);

	return failed > 0 ? 1 : 0;
}
