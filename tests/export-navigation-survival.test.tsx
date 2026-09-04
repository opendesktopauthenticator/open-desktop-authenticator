import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
	ExportNotices,
	exportNoticeReducer,
	settleAccountExport,
	type ExportNotice
} from '../src/renderer/App';

const ACCOUNT = { steamId64: '76561198000000001', accountName: 'someone' } as const;

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function shown(notices: readonly ExportNotice[]): string {
	return renderToStaticMarkup(<ExportNotices notices={notices} onDismiss={() => undefined} />);
}

function shownAt(screen: string, notices: readonly ExportNotice[]): string {
	return renderToStaticMarkup(
		<>
			<ExportNotices notices={notices} onDismiss={() => undefined} />
			<div data-current-screen={screen}>{screen}</div>
		</>
	);
}

const NAVIGATIONS = [
	'Import',
	'Recover',
	'Add authenticator',
	'Move from phone',
	'Settings',
	'Activity',
	'About',
	'Account routing',
	'Confirmations',
	'Revocation backup',
	'Automatic confirmations',
	'Remove account',
	'Browser sign-in'
] as const;

describe('export results across an unmounting navigation', () => {
	it.each(NAVIGATIONS)('keeps a delayed success after navigating to %s', async (destination) => {
		const answer = deferred<{ state: 'saved'; fileName: string }>();
		let notices: readonly ExportNotice[] = [];
		const settlement = settleAccountExport(
			ACCOUNT,
			1,
			answer.promise,
			() => true,
			(notice) => {
				notices = exportNoticeReducer(notices, { type: 'record', notice });
			}
		);

		// This is the user-intent ordering that lost the result: the child account
		// screen is gone before the IPC answer arrives. The recorder above belongs to
		// App, so changing the child cannot take it with it.
		expect(shownAt(destination, notices)).toContain(`data-current-screen="${destination}"`);
		answer.resolve({ state: 'saved', fileName: 'someone.maFile' });
		await settlement;

		const after = shownAt(destination, notices);
		expect(after).toContain(`data-current-screen="${destination}"`);
		expect(after).toContain('Saved as someone.maFile');
	});

	it('keeps a failed save as an assertive, dismissible notice', async () => {
		const answer = deferred<never>();
		let notices: readonly ExportNotice[] = [];
		const settlement = settleAccountExport(
			ACCOUNT,
			2,
			answer.promise,
			() => true,
			(notice) => {
				notices = exportNoticeReducer(notices, { type: 'record', notice });
			}
		);

		answer.reject(new Error('the drive went away'));
		await settlement;
		const html = shown(notices);
		expect(html).toContain('It could not be saved: the drive went away');
		expect(html).toContain('role="alert"');
		expect(html).toContain('Dismiss');
	});

	it('keeps both the success and the residual-plaintext warning', async () => {
		let notices: readonly ExportNotice[] = [];
		await settleAccountExport(
			ACCOUNT,
			3,
			Promise.resolve({ state: 'saved', fileName: 'someone.maFile', staleCopy: true }),
			() => true,
			(notice) => {
				notices = exportNoticeReducer(notices, { type: 'record', notice });
			}
		);

		const html = shown(notices);
		expect(html).toContain('Saved as someone.maFile');
		expect(html).toContain('file ending “.prev” is still beside it');
	});

	it('retains every result until that exact notice is acknowledged', () => {
		const first: ExportNotice = {
			id: `${ACCOUNT.steamId64}:4`,
			...ACCOUNT,
			status: 'Saved as first.maFile.',
			error: undefined
		};
		const second: ExportNotice = {
			id: `${ACCOUNT.steamId64}:5`,
			...ACCOUNT,
			status: undefined,
			error: 'It could not be saved.'
		};
		const both = exportNoticeReducer(exportNoticeReducer([], { type: 'record', notice: first }), {
			type: 'record',
			notice: second
		});
		const after = exportNoticeReducer(both, { type: 'dismiss', id: first.id });

		expect(after).toEqual([second]);
	});

	it('preserves the existing stale-attempt refusal', async () => {
		const recorded: ExportNotice[] = [];
		await settleAccountExport(
			ACCOUNT,
			6,
			Promise.resolve({ state: 'saved', fileName: 'stale.maFile' }),
			() => false,
			(notice) => recorded.push(notice)
		);
		expect(recorded).toEqual([]);
	});
});
