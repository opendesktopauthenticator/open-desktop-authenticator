import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const main = withoutComments(
	readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
);

function construction(name: string): string {
	const start = main.indexOf(`new ${name}(`);
	if (start < 0) throw new Error(`${name} is not constructed in index.ts`);
	return main.slice(start, start + 900);
}

describe('system-aware Steam login wiring', () => {
	it('builds one factory from the real Electron networking adapter', () => {
		expect(main.match(/createSystemAwareLoginSessionFactory\(/g)).toHaveLength(1);
		expect(main.match(/createSystemLoginTransportFactory\(networking\)/g)).toHaveLength(1);
	});

	it.each(['ConfirmationsService', 'EnrollmentService', 'TransferService'])(
		'injects the same loginSession into %s',
		(name) => {
			expect(construction(name)).toMatch(/\bloginSession\s*[,}]/);
		}
	);
});
