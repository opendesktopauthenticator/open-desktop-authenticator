import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';

function archivesBelow(root) {
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		throw new Error(`Application package tree does not exist or is not a directory: ${root}`);
	}
	const found = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name === 'app.asar') found.push(path);
		}
	};
	visit(root);
	return found.sort();
}

const inputs = process.argv.slice(2);
const archives =
	inputs[0] === '--tree'
		? inputs.length === 2
			? archivesBelow(resolve(inputs[1]))
			: (() => {
					throw new Error('Usage: verify-packaged-license.mjs --tree <package-directory>');
				})()
		: inputs;
if (archives.length === 0) {
	throw new Error('No application ASAR was supplied; refusing a vacuous licence check.');
}

const expected = readFileSync(resolve('LICENSE'));
const copyright = 'Copyright (c) 2026 MASTERPANEL LLC';
const grant = 'Permission is hereby granted, free of charge, to any person obtaining a copy';

for (const archive of archives) {
	const path = resolve(archive);
	if (!existsSync(path)) throw new Error(`Application ASAR does not exist: ${path}`);
	const entries = listPackage(path).map((entry) => entry.replaceAll('\\', '/'));
	if (!entries.includes('/LICENSE')) {
		throw new Error(`${path} has no first-party LICENSE at the application archive root.`);
	}
	const actual = extractFile(path, 'LICENSE');
	if (!actual.equals(expected)) {
		throw new Error(`${path} does not carry the repository's exact first-party LICENSE.`);
	}
	const text = actual.toString('utf8');
	if (!text.includes(copyright) || !text.includes(grant)) {
		throw new Error(`${path} is missing the project's copyright or MIT permission grant.`);
	}
	console.log(`first-party licence verified: ${path}`);
}
