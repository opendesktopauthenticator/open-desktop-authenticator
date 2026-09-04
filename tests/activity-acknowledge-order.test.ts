import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * When the activity screen clears the alert.
 *
 * The acknowledgement lived in an effect of its own, declared *above* the load
 * effect — so React ran it first and the alert was cleared before the list had
 * even been requested. A load that failed, a load still in flight, or a user
 * pressing Back straight away all cleared it anyway.
 *
 * What gets cleared is the marker saying an account-recovery confirmation was
 * held back: the strongest warning this application can give, discharged on
 * behalf of somebody who was shown nothing.
 *
 * Asserted against the source because the renderer tests here render statically,
 * so no effect runs at all and neither ordering is observable in the output.
 */

const SOURCE = readFileSync(
	join(__dirname, '..', 'src', 'renderer', 'screens', 'Activity.tsx'),
	'utf8'
);

describe('the alert is cleared only once the entries are in hand', () => {
	it('acknowledges inside the load result, not in an effect of its own', () => {
		// The effect form is the bug: its position in the file decides when it runs.
		expect(SOURCE).not.toMatch(/useEffect\(\(\) => \{\s*seenRef\.current\(\);\s*\}, \[\]\);/);
		expect(SOURCE).toMatch(/setActivity\(loaded\);[\s\S]{0,900}markSeen\(loaded\.seq\);/);
	});

	it('does not acknowledge when the load failed', () => {
		// Locate the block-bodied failure continuation as syntax, not as a source
		// window. The old check searched for the impossible zero-argument spelling
		// `seenRef.current()` and therefore let both real acknowledgement calls
		// through.
		const file = ts.createSourceFile(
			'Activity.tsx',
			SOURCE,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX
		);
		const failures: ts.ArrowFunction[] = [];
		const findFailure = (node: ts.Node): void => {
			const callback = ts.isCallExpression(node) ? node.arguments[0] : undefined;
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === 'catch' &&
				callback !== undefined &&
				ts.isArrowFunction(callback) &&
				ts.isBlock(callback.body)
			) {
				failures.push(callback);
			}
			ts.forEachChild(node, findFailure);
		};
		findFailure(file);
		expect(failures, 'the initial-load failure callback changed shape').toHaveLength(1);

		const acknowledgements: string[] = [];
		const findAcknowledgement = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText(file);
				if (callee === 'seenRef.current' || callee === 'markSeen') acknowledgements.push(callee);
			}
			ts.forEachChild(node, findAcknowledgement);
		};
		findAcknowledgement(failures[0]!);
		expect(acknowledgements).toEqual([]);
	});

	it('acknowledges at most once', () => {
		// The load result can be reached again by the retry the error state offers.
		expect(SOURCE).toContain('acknowledged.current');
		expect(SOURCE).toMatch(
			/if \(acknowledged\.current \|\| !alive\.current\) \{\s*return;\s*\}\s*acknowledged\.current = true;/
		);
	});

	it('acknowledges from the retry path too, through the same guard', () => {
		// The retry rendered entries and discharged nothing, so a first load that
		// failed left the "needs you" badge lit for the rest of the session however
		// many times the user read the list. Both paths now go through `markSeen`.
		expect(SOURCE.match(/markSeen\(loaded\.seq\);/g) ?? []).toHaveLength(2);
	});

	it('does not acknowledge a load that was cancelled', () => {
		// Guarded by the same `cancelled` flag as the state it accompanies — a user
		// who opened and left has not been shown anything.
		expect(SOURCE).toMatch(/if \(!cancelled\) \{[\s\S]{0,900}markSeen\(loaded\.seq\);/);
	});
});

/*
 * The retry path is a load too.
 *
 * "Try again" rendered entries and discharged nothing, so a first load that
 * failed left the "needs you" badge lit for the rest of the session — however
 * many times the user then read the list.
 */
describe('both load paths discharge the alert', () => {
	it('routes the retry through the same acknowledgement', () => {
		const retry = SOURCE.slice(SOURCE.indexOf('const load = useCallback'));
		expect(retry.slice(0, 600)).toContain('markSeen(loaded.seq)');
	});

	it('shares one guard, so neither can fire twice', () => {
		expect(SOURCE.match(/acknowledged\.current = true;/g) ?? []).toHaveLength(1);
	});

	it('still does not acknowledge a retry that failed', () => {
		// The retry's failure branch is exactly one statement, and it is not this
		// one. Asserted on the branch itself rather than on a window of characters
		// after it — the window ran past the end of the callback and into the mount
		// effect, which legitimately does call `markSeen`.
		const retry = SOURCE.slice(SOURCE.indexOf('const load = useCallback'));
		expect(retry).toMatch(/\.catch\(\(err: unknown\) => setError\(messageOf\(err\)\)\);/);
	});
});

describe('leaving during a retry', () => {
	it('cannot acknowledge after unmount', () => {
		// The mount effect has its own `cancelled` flag; the retry path funnels
		// through `markSeen`, so the liveness check must sit inside it — press
		// Try again, then Back before the promise resolves, and the continuation
		// still runs. React swallows the state update; the acknowledgement IPC
		// does not get swallowed by anything except this guard.
		expect(SOURCE).toMatch(/const alive = useRef\(true\);/);
		expect(SOURCE).toMatch(/alive\.current = false;/);
		// And the retry's own continuation bails out before touching state.
		expect(SOURCE).toMatch(
			/\.then\(\(loaded\) => \{\s*if \(!alive\.current\) \{\s*return;\s*\}\s*setActivity\(loaded\);/
		);
	});
});
