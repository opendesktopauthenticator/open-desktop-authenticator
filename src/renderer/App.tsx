import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
	AccountSummary,
	BrowserRoute,
	CodesList,
	EnrollmentStatus,
	ExportResult,
	OpenBrowserResult,
	RendererApi,
	ToastClick,
	TransferStatus,
	UpdateCheckResult,
	VaultStatus
} from '../shared/ipc';
import {
	claimConfirmationClick,
	notificationMayTakeOver,
	notificationRefreshesOpenAccount,
	retryConfirmationClickAcknowledgement,
	settleConfirmationRefreshClick,
	shouldAcknowledgeConfirmationClick,
	type ConfirmationClickClaims
} from '../shared/notification-click';
export { claimConfirmationClick } from '../shared/notification-click';
import { recoveryExitView } from '../shared/recovery-view';
export { recoveryExitView } from '../shared/recovery-view';
import {
	claimRecoveryForeground,
	deliverRecoveryAttention,
	supersedeRecoveryForeground,
	type ForegroundRevision
} from './recovery-navigation';
import { DynamicError } from './DynamicError';
import { CreateVault } from './screens/CreateVault';
import { AccountRouting } from './screens/AccountRouting';
import { Activity } from './screens/Activity';
import { AutoConfirm } from './screens/AutoConfirm';
import { Confirmations } from './screens/Confirmations';
import { RemoveAccount } from './screens/RemoveAccount';
import { About } from './screens/About';
import { Settings } from './screens/Settings';
import { ImportAccounts } from './screens/ImportAccounts';
import { RecoverAccount } from './screens/RecoverAccount';
import { AddAuthenticator } from './screens/AddAuthenticator';
import { MoveAuthenticator } from './screens/MoveAuthenticator';
import { RevocationBackup } from './screens/RevocationBackup';
import { BrowserOpenRetry } from './screens/BrowserOpenRetry';
import { SteamSignIn } from './screens/SteamSignIn';
import { UnlockVault } from './screens/UnlockVault';
import { noted, VaultHome } from './screens/VaultHome';
import { messageOf } from './ipc-message';

declare global {
	interface Window {
		/**
		 * Optional on purpose. If the preload script fails — the classic cause is
		 * importing something a sandboxed preload cannot `require` — the bridge is
		 * never exposed and this is `undefined`. Typing it as always-present makes
		 * the compiler agree with a lie, and the app white-screens on a synchronous
		 * TypeError that no `.catch()` can see.
		 */
		api?: RendererApi;
	}
}

/** How often to refresh status, which also drives the auto-lock countdown. */
const STATUS_POLL_MS = 1000;
/** Activity is reported at most this often; a ping per keystroke is pointless. */
const TOUCH_THROTTLE_MS = 15_000;

type AppView =
	'accounts' | 'import' | 'settings' | 'activity' | 'enroll' | 'move' | 'recover' | 'about';

type RecoveryDestination = 'enroll' | 'move';

interface DeferredRecovery {
	destination: RecoveryDestination;
	queuedMove: boolean;
}

/**
 * A completed plaintext export that remains owned by `App`, not by the account
 * list that happened to start it.
 *
 * The account list is routinely unmounted for Settings, Activity and every
 * account overlay. Keeping this here means those deliberate navigations cannot
 * erase the only report that a save failed or left an older `.prev` file behind.
 */
export interface ExportNotice {
	id: string;
	steamId64: string;
	accountName: string;
	status: string | undefined;
	error: string | undefined;
}

export type ExportNoticeAction =
	{ type: 'record'; notice: ExportNotice } | { type: 'dismiss'; id: string };

/**
 * Append outcomes instead of giving each account one replaceable slot. Starting
 * another export is not acknowledgement of the result already on screen; only
 * the notice's Dismiss button removes it.
 */
export function exportNoticeReducer(
	state: readonly ExportNotice[],
	action: ExportNoticeAction
): readonly ExportNotice[] {
	if (action.type === 'dismiss') {
		return state.filter((notice) => notice.id !== action.id);
	}
	return [...state, action.notice];
}

/** Translate the typed main-process answer without losing its plaintext warning. */
export function exportNoticeFor(
	account: Pick<AccountSummary, 'steamId64' | 'accountName'>,
	attempt: number,
	result: ExportResult
): ExportNotice {
	return {
		id: `${account.steamId64}:${attempt}`,
		steamId64: account.steamId64,
		accountName: account.accountName,
		status:
			result.state === 'saved'
				? `Saved as ${result.fileName}. Treat that file as a key to this account.`
				: 'Nothing was saved.',
		error:
			result.state === 'saved' && result.staleCopy
				? 'The previous export could not be deleted — a file ending “.prev” is still beside it, holding the older secrets. Delete it when you can.'
				: undefined
	};
}

/** The rejection counterpart to `exportNoticeFor`, kept path-safe by `messageOf`. */
export function exportFailureNoticeFor(
	account: Pick<AccountSummary, 'steamId64' | 'accountName'>,
	attempt: number,
	err: unknown
): ExportNotice {
	return {
		id: `${account.steamId64}:${attempt}`,
		steamId64: account.steamId64,
		accountName: account.accountName,
		status: undefined,
		error: `It could not be saved: ${messageOf(err)}`
	};
}

/**
 * Settle one export into its app-level owner. `current` preserves the existing
 * per-account stale-attempt rule while `record` keeps React out of the behavior
 * test: navigation may replace any child screen during the await and this owner
 * still receives the result.
 */
export async function settleAccountExport(
	account: Pick<AccountSummary, 'steamId64' | 'accountName'>,
	attempt: number,
	request: Promise<ExportResult>,
	current: () => boolean,
	record: (notice: ExportNotice) => void
): Promise<void> {
	try {
		const result = await request;
		if (current()) {
			record(exportNoticeFor(account, attempt, result));
		}
	} catch (err) {
		if (current()) {
			record(exportFailureNoticeFor(account, attempt, err));
		}
	}
}

/**
 * Finish the durable action before refreshing its presentation.
 *
 * The refresh is useful but it is not part of publishing the backup. If it
 * fails after publication, rejecting this promise tells the row that the
 * backup failed and invites a retry of work that already succeeded. Surface
 * that transient read failure through the app's poll banner instead.
 */
export async function finishRecoveryBackupWithRefresh(
	finish: () => Promise<{ ok: true }>,
	refresh: () => Promise<void>,
	onRefreshError: (message: string) => void
): Promise<{ ok: true }> {
	const result = await finish();
	try {
		await refresh();
	} catch (err) {
		onRefreshError(messageOf(err));
	}
	return result;
}

/**
 * One app-owned recovery-backup attempt.
 *
 * The Set is updated before any IPC can settle, so a notification delivered in
 * the same turn sees the navigation lock. Its callbacks keep the result above
 * `VaultHome`, where an unrelated navigation cannot destroy it.
 */
export async function runRecoveryBackupAttempt(options: {
	steamId64: string;
	inFlight: Set<string>;
	finish: () => Promise<{ ok: true }>;
	refresh: () => Promise<void>;
	onRefreshError: (message: string) => void;
	onBusy: (accounts: ReadonlySet<string>) => void;
	onError: (steamId64: string, message: string | undefined) => void;
	onStart: () => void;
}): Promise<boolean> {
	if (options.inFlight.has(options.steamId64)) return false;
	options.inFlight.add(options.steamId64);
	options.onBusy(new Set(options.inFlight));
	try {
		options.onError(options.steamId64, undefined);
		options.onStart();
		await finishRecoveryBackupWithRefresh(options.finish, options.refresh, options.onRefreshError);
		return true;
	} catch (err) {
		options.onError(options.steamId64, messageOf(err));
		return false;
	} finally {
		options.inFlight.delete(options.steamId64);
		options.onBusy(new Set(options.inFlight));
	}
}

/** Parent navigation must not replace an account-list operation still in flight. */
export function accountListOperationBusy(
	exportingAccountCount: number,
	finishingRecoveryAccountCount: number
): boolean {
	return exportingAccountCount > 0 || finishingRecoveryAccountCount > 0;
}

/**
 * Rendered above `screen()`, so changing the current screen cannot hide or
 * destroy a completed result. Only the explicit button acknowledges one.
 */
export function ExportNotices({
	notices,
	onDismiss
}: {
	notices: readonly ExportNotice[];
	onDismiss: (id: string) => void;
}): React.JSX.Element | null {
	if (notices.length === 0) {
		return null;
	}
	return (
		<>
			{notices.map((notice) => (
				<section className="banner notice" key={notice.id} aria-labelledby={`export-${notice.id}`}>
					<strong id={`export-${notice.id}`}>Export for {notice.accountName}</strong>
					{notice.status && <p role="status">{notice.status}</p>}
					{notice.error && <DynamicError>{notice.error}</DynamicError>}
					<div className="controls">
						<button type="button" className="secondary" onClick={() => onDismiss(notice.id)}>
							Dismiss
						</button>
					</div>
				</section>
			))}
		</>
	);
}

/**
 * May this update-check answer reach the screen?
 *
 * Named and exported so both settlement orders can be tested: the rule is
 * ordering-sensitive and lives inside an effect, and this project has no DOM
 * test runner to drive one.
 *
 * Two ways an answer is stale, and they are different questions. It can belong
 * to a check that has since been superseded — the effect re-runs when either
 * gating setting moves, so two can be in the air, and the main process aborts
 * the older one, which settles as `unknown` *after* the newer one succeeded.
 * Or the user can have switched update checks off while it was in the air, in
 * which case no answer is welcome.
 */
export function updateAnswerIsCurrent(
	newest: number,
	mine: number,
	bannerSuppressed: boolean
): boolean {
	return newest === mine && !bannerSuppressed;
}

/**
 * The account a notification click should open, or nothing.
 *
 * Exported and tested directly, the same way `updateAnswerIsCurrent` is: this
 * project has no DOM runner, and this is the line that decides whether an id
 * arriving over IPC can navigate the window.
 *
 * **The renderer navigates to an account it already knows about.** The main
 * process is the only sender and it sends an id it already held, so this is not
 * the last line of defence — but a lookup that trusted its input would make the
 * channel a way to point the window at something the account list does not
 * contain, and there is no reason to accept that when a lookup costs nothing.
 */
export function confirmationsTargetFor(
	accounts: readonly AccountSummary[],
	steamId64: string
): AccountSummary | undefined {
	return accounts.find((entry) => entry.steamId64 === steamId64);
}

/**
 * A stable identity for the set of accounts a notification may navigate to.
 *
 * Status polling replaces `accounts` with a fresh array every second, so the
 * array itself is too noisy for an effect dependency. Its length is too weak:
 * replacing account A with account B keeps the same length and can leave a
 * retained click for B asleep forever. Steam IDs are decimal-only, which makes
 * a sorted comma-separated membership unambiguous and insensitive to ordering.
 */
export function confirmationAccountMembership(accounts: readonly AccountSummary[]): string {
	return accounts
		.map((account) => account.steamId64)
		.sort()
		.join(',');
}

/** Start one exact, idempotent acknowledgement without duplicating navigation. */
function beginConfirmationClickAcknowledgement(
	api: RendererApi,
	claims: ConfirmationClickClaims,
	inProgress: Set<number>,
	click: ToastClick
): void {
	if (inProgress.has(click.token)) return;
	inProgress.add(click.token);
	void retryConfirmationClickAcknowledgement(claims, click.token, () =>
		api.takePendingConfirmations({ acknowledged: click })
	).finally(() => inProgress.delete(click.token));
}

/** The account and route a sign-in screen is asking about. */
export interface BrowserSignInPrompt {
	account: AccountSummary;
	route: BrowserRoute;
	reason?: string;
}

/** The password-free continuation after Steam has accepted a sign-in. */
export interface BrowserOpenContinuation {
	account: AccountSummary;
	route: BrowserRoute;
	busy: boolean;
	error?: string;
}

export type BrowserOpenAfterSignInResult = { opened: true } | { opened: false; reason: string };

/**
 * Retry only the browser operation after authentication has succeeded.
 *
 * A thrown window/session error and a browser that still rejects the stored
 * session are both browser failures. Turning either one back into a
 * `SignInResult` asks for a password that Steam already accepted.
 */
export async function openBrowserAfterSignIn(
	open: () => Promise<OpenBrowserResult>
): Promise<BrowserOpenAfterSignInResult> {
	try {
		const result = await open();
		if (result.signInRequired) {
			return {
				opened: false,
				reason: result.reason ?? 'Steam accepted the sign-in but would not open a browsing session.'
			};
		}
		return { opened: true };
	} catch (err) {
		return { opened: false, reason: messageOf(err) };
	}
}

/**
 * Which screen takeover is newest.
 *
 * Module-level rather than a `useRef`, on purpose and for two reasons. There is
 * one renderer document and one `App` inside it, so "the newest thing the user
 * asked for" is a property of the window and not of a component instance. And a
 * ref cannot be exported, so the ordering rule below could only have been
 * checked by reading the source — while this project has no DOM runner to drive
 * two overlapping opens through a rendered component.
 */
let uiGeneration = 0;

/**
 * Claim the screen for an open that is starting, and get back the only function
 * allowed to say what its answer may do.
 *
 * **Different account rows open concurrently, and the answers come back in
 * whatever order Steam and the proxies decide.** Every response used to write
 * the single `browserSignIn` state, so whichever settled last won. Opening
 * account A and then account B, typing a password into the sign-in screen B
 * asked for, and then letting A's older response land, replaced the screen and
 * **erased what had been typed** — a password half-entered for one Steam
 * account swapped for a prompt about another, with nothing on screen saying it
 * had happened.
 *
 * So the generation is claimed when the open *begins*, which is the moment that
 * corresponds to what the user was looking at, rather than when it settles,
 * which corresponds to nothing. An answer from a superseded generation returns
 * `undefined` and the caller installs nothing.
 *
 * **Silently, and that is a deliberate trade.** A superseded open that needed a
 * sign-in now reports nothing at all: the user pressed something newer, and
 * interrupting them to describe a request they have moved on from is how the
 * erasure above felt in the first place. The row's own error path is unaffected
 * — a sign-in is not an error and never travelled that way.
 */
/**
 * Give up on every browser open still in flight.
 *
 * The generation above is claimed by a *newer open*, which covers one row's
 * answer landing on top of another's and covers nothing else. Ordinary
 * navigation left it untouched, and the sign-in prompt is rendered ahead of the
 * view switch — so pressing Trade, going to Settings, typing both passphrase
 * fields, and then letting the Trade request settle as `signInRequired`
 * unmounted Settings and **erased what had been typed**. The same erasure the
 * generation was introduced to stop, reached by the door it did not cover.
 *
 * Exported so the effect that watches the view can call it, and so this rule can
 * be tested without a DOM: a module-level counter cannot be reached any other
 * way.
 */
export function abandonPendingSignIns(): void {
	uiGeneration += 1;
}

/** Claim the same foreground generation for the password-free browser stage. */
export function claimBrowserOpenContinuation(): () => boolean {
	const mine = (uiGeneration += 1);
	return () => uiGeneration === mine;
}

/**
 * Make an account-list overlay the newest owner of the screen.
 *
 * Three writes belong in one synchronous operation. Advancing the generation
 * rejects browser opens that are still in flight; raising the ref closes the
 * gap before React runs its effects; clearing state removes a prompt that had
 * already arrived. Leaving any one of the three for later is how Back from a
 * notification made an obsolete password form reappear.
 */
export function supersedeBrowserSignInForOverlay(
	overlayOpen: { current: boolean },
	clearPrompt: () => void
): void {
	abandonPendingSignIns();
	overlayOpen.current = true;
	clearPrompt();
}

/**
 * Whether a sign-in prompt may take the window, given where the user is.
 *
 * **The barrier that does not depend on anything being remembered.** The
 * generation above, and the effect that advances it on navigation, are both
 * bookkeeping: correct today, and one deleted `useEffect` from being wrong
 * again, with no test able to notice because effects do not run under
 * `renderToStaticMarkup` and this project has no DOM runner.
 *
 * This is the same rule expressed where it cannot be forgotten — in the render
 * itself, as a pure function of what is on screen. An open can only be started
 * from the account list, so an answer to one has nothing to say about any other
 * screen. Settings cannot be replaced by a stale response whatever the counter
 * says.
 *
 * A type predicate rather than a boolean so the caller keeps its narrowing and
 * the check cannot be written and then ignored.
 */
export function mayShowSignInPrompt(
	prompt: BrowserSignInPrompt | undefined,
	view: string,
	overlayOpen = false
): prompt is BrowserSignInPrompt {
	return prompt !== undefined && view === 'accounts' && !overlayOpen;
}

export function claimSignInScreen(): (
	account: AccountSummary,
	route: BrowserRoute,
	result: OpenBrowserResult
) => BrowserSignInPrompt | undefined {
	const mine = (uiGeneration += 1);
	return (account, route, result) => {
		if (uiGeneration !== mine || !result.signInRequired) {
			return undefined;
		}
		return {
			account,
			route,
			// Spread rather than `reason: result.reason`, so an absent reason stays
			// absent instead of becoming a present `undefined` the screen would have
			// to re-check.
			...(result.reason === undefined ? {} : { reason: result.reason })
		};
	};
}

export function App(): React.JSX.Element {
	const api = window.api;

	const [status, setStatus] = useState<VaultStatus | undefined>();
	const [accounts, setAccounts] = useState<AccountSummary[]>([]);
	const [codes, setCodes] = useState<CodesList | undefined>();
	/** Whether automatic confirmation has left something a person must look at. */
	const [activityUrgent, setActivityUrgent] = useState(false);
	/**
	 * Which unlocked screen is showing. Not persisted anywhere: the main process
	 * reloads this window whenever the vault locks, so an unlock always lands back
	 * on the account list rather than resuming a half-finished import.
	 */
	const [view, setView] = useState<AppView>('accounts');
	/**
	 * Ownership of the foreground while the unlock recovery query is in flight.
	 *
	 * This is deliberately a ref: an account-row click must revoke the query's
	 * claim in the same call stack, before React renders the destination. A state
	 * value would leave a microtask-sized window in which the late query could
	 * still replace the screen and erase what the user had begun entering.
	 */
	const foregroundRevision = useRef<ForegroundRevision>({ current: 0 });
	const accountHomeOwnsForeground = useRef(true);
	const leaveAccountHome = useCallback((): void => {
		accountHomeOwnsForeground.current = false;
		supersedeRecoveryForeground(foregroundRevision.current);
	}, []);
	const returnToAccountHome = useCallback((): void => {
		accountHomeOwnsForeground.current = true;
		supersedeRecoveryForeground(foregroundRevision.current);
		setView('accounts');
	}, []);
	const navigateFromAccountHome = useCallback(
		(next: Exclude<AppView, 'accounts'>): void => {
			leaveAccountHome();
			setView(next);
		},
		[leaveAccountHome]
	);
	const [deferredRecovery, setDeferredRecovery] = useState<DeferredRecovery | undefined>();
	/** A second legacy workflow that must be shown after the first is handled. */
	const [queuedRecoveryView, setQueuedRecoveryView] = useState<'move' | undefined>();
	const leaveEnrollmentRecovery = (): void => {
		const next = recoveryExitView(queuedRecoveryView);
		setQueuedRecoveryView(undefined);
		if (next === 'accounts') {
			returnToAccountHome();
		} else {
			leaveAccountHome();
			setView(next);
		}
	};
	/*
	 * **Leaving the screen abandons what it started.**
	 *
	 * An open begun from the account list belongs to the account list. Navigating
	 * anywhere means the user has moved on, and an answer arriving afterwards has
	 * no claim on the screen they are looking at now — least of all the sign-in
	 * prompt, which renders ahead of the view switch and takes the whole window.
	 *
	 * On `view` rather than at each `setView`: there are twenty-one of those, and
	 * the one that gets forgotten is the bug coming back.
	 */

	/**
	 * An enrolled-but-unactivated account being resumed, if any.
	 *
	 * Kept here rather than inside the enrollment screen so that leaving it — to
	 * write the revocation code down, which the screen instructs — does not
	 * destroy the only route back to finishing.
	 */
	const [resumeEnrollment, setResumeEnrollment] = useState<AccountSummary | undefined>();
	/**
	 * The account whose backup ceremony is open, if any.
	 *
	 * Only the two fields the ceremony actually needs, rather than a full
	 * `AccountSummary`. Requiring the whole summary is what forced a lookup in the
	 * polled `accounts` list, and made the post-enrollment hand-off depend on a
	 * refresh that had not happened yet.
	 */
	const [backupFor, setBackupFor] = useState<
		{ steamId64: string; accountName: string } | undefined
	>();
	/** The account whose routing is being changed, if any. */
	const [routingFor, setRoutingFor] = useState<AccountSummary | undefined>();
	/** The account whose confirmations are open, if any. */
	const [confirmingFor, setConfirmingFor] = useState<AccountSummary | undefined>();
	const confirmingForRef = useRef<AccountSummary | undefined>(undefined);
	useEffect(() => {
		confirmingForRef.current = confirmingFor;
	}, [confirmingFor]);
	/** A new toast for the account already shown waits for a successful re-list. */
	const confirmationRefreshClick = useRef<ToastClick | undefined>(undefined);
	const [confirmationRefreshToken, setConfirmationRefreshToken] = useState<number | undefined>();
	/**
	 * Native export dialogs and disk writes outlive `VaultHome`. Both ownership and
	 * outcomes therefore live here: every ordinary navigation unmounts the account
	 * list, but none of them unmounts `App`.
	 */
	const exportingAccounts = useRef(new Set<string>());
	const [exportingAccountIds, setExportingAccountIds] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const exportingAccountCount = exportingAccountIds.size;
	const noteExportBusy = useCallback((steamId64: string, busy: boolean): void => {
		const wasBusy = exportingAccounts.current.has(steamId64);
		if (busy) {
			exportingAccounts.current.add(steamId64);
		} else {
			exportingAccounts.current.delete(steamId64);
		}
		if (wasBusy !== busy) {
			setExportingAccountIds(new Set(exportingAccounts.current));
		}
	}, []);
	const exportAttempt = useRef(new Map<string, number>());
	const [exportNotices, updateExportNotices] = useReducer(exportNoticeReducer, []);
	/**
	 * Recovery-backup publication outlives `VaultHome` for the same reason an
	 * export does: a native notification or deliberate navigation can unmount the
	 * account list while the disk write is settling. Keep both ownership and its
	 * per-account failure here.
	 */
	const recoveryBackupAccounts = useRef(new Set<string>());
	const [finishingRecoveryAccountIds, setFinishingRecoveryAccountIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const finishingRecoveryAccountCount = finishingRecoveryAccountIds.size;
	const [recoveryBackupErrors, setRecoveryBackupErrors] = useState<ReadonlyMap<string, string>>(
		() => new Map()
	);
	const startAccountExport = useCallback(
		(account: AccountSummary): void => {
			if (!api || exportingAccounts.current.has(account.steamId64)) {
				return;
			}

			const mine = (exportAttempt.current.get(account.steamId64) ?? 0) + 1;
			exportAttempt.current.set(account.steamId64, mine);
			const current = (): boolean => exportAttempt.current.get(account.steamId64) === mine;

			// Before the IPC opens its native dialog. A recovery answer settling in
			// this same turn must already know the account list no longer owns the
			// foreground, and notification takeover must already see the busy set.
			leaveAccountHome();
			noteExportBusy(account.steamId64, true);

			let request: Promise<ExportResult>;
			try {
				request = api.exportAccount(account.steamId64);
			} catch (err) {
				updateExportNotices({
					type: 'record',
					notice: exportFailureNoticeFor(account, mine, err)
				});
				noteExportBusy(account.steamId64, false);
				return;
			}

			void settleAccountExport(account, mine, request, current, (notice) =>
				updateExportNotices({ type: 'record', notice })
			).finally(() => {
				// A superseded attempt cannot release its replacement. The UI prevents
				// that overlap, but this ownership check keeps the invariant true at
				// the callback boundary too.
				if (current()) {
					noteExportBusy(account.steamId64, false);
				}
			});
		},
		[api, leaveAccountHome, noteExportBusy]
	);
	/** The account being removed, if any. */
	const [removingFor, setRemovingFor] = useState<AccountSummary | undefined>();
	/** The account whose automatic-confirmation settings are open, if any. */
	const [autoConfirmFor, setAutoConfirmFor] = useState<AccountSummary | undefined>();
	/**
	 * The browser could not open because Steam wants a sign-in, and for which
	 * account.
	 *
	 * A whole screen rather than a message on the row, because the answer is a
	 * password field — and the row has nowhere to put one. `Confirmations` does
	 * the same thing for the same reason.
	 */
	const [browserSignIn, setBrowserSignIn] = useState<BrowserSignInPrompt | undefined>();
	/** A successful sign-in whose browser window still needs to open. */
	const [browserOpenContinuation, setBrowserOpenContinuation] = useState<
		BrowserOpenContinuation | undefined
	>();

	useEffect(() => {
		abandonPendingSignIns();
	}, [view]);

	/*
	 * **And the prompt already held, which the counter cannot reach.**
	 *
	 * `abandonPendingSignIns` stops a *late* answer from installing itself. A
	 * prompt that had already arrived stayed in state: a notification opening
	 * Confirmations over it left it there, and pressing Back re-rendered it — a
	 * sign-in, with a password field, for a request the user began before and has
	 * since navigated away from twice. `mayShowSignInPrompt` hid it in between,
	 * which is what made this survivable rather than obvious, and also what let it
	 * come back.
	 *
	 * Adjusted during render rather than in an effect. React's own guidance for
	 * state that has to be reset when something else changes, and here it is also
	 * the correct one: an effect would render the stale prompt once before
	 * clearing it, which on this screen means a password field appearing and
	 * vanishing.
	 *
	 * The same reasoning the overlay guard beside `setBrowserSignIn` already uses:
	 * the open belonged to the account list, so leaving discards it.
	 */
	const [signInBelongsTo, setSignInBelongsTo] = useState(view);
	if (signInBelongsTo !== view) {
		setSignInBelongsTo(view);
		setBrowserSignIn(undefined);
		setBrowserOpenContinuation(undefined);
		abandonPendingSignIns();
	}

	/**
	 * **Discarded rather than deferred.**
	 *
	 * Moving the prompt below the overlays stopped it *replacing* Account routing
	 * or Revocation backup. It did not stop it waiting: the answer stayed in state
	 * while one of those screens was open, and the moment the user pressed Back it
	 * took the window — a sign-in for a request they had started before, arriving
	 * as a surprise on a screen they had navigated to themselves.
	 *
	 * The same rule as leaving the screen, and the same reason: an open belongs to
	 * the screen it was started from, and that screen is the plain account list.
	 * The set here is the one `openConfirmationsFor` clears, which is the same
	 * question asked the other way round — "what is covering the list" — and
	 * `tests/sign-in-prompt-ordering.test.ts` holds the two lists to each other so
	 * a sixth overlay cannot be added to one and forgotten in the other.
	 */
	const overlayOpen = Boolean(
		autoConfirmFor || removingFor || confirmingFor || routingFor || backupFor
	);
	useEffect(() => {
		if (overlayOpen) {
			abandonPendingSignIns();
		}
	}, [overlayOpen]);

	/*
	 * Read at the moment an answer arrives, which is the moment the question is
	 * asked. A ref rather than the value itself: the handler that installs the
	 * prompt is a callback on the account list, and closing over `overlayOpen`
	 * would give it whatever was true when that callback was last built.
	 */
	const overlayOpenRef = useRef(overlayOpen);
	useEffect(() => {
		overlayOpenRef.current = overlayOpen;
	}, [overlayOpen]);
	const openAccountOverlay = useCallback(
		(open: () => void): void => {
			leaveAccountHome();
			/*
			 * Own the browser settlement boundary in this call stack. Waiting for
			 * `overlayOpen`'s effect leaves one render in which an older Trade open
			 * can install a sign-in prompt behind the overlay and reappear on Back.
			 */
			supersedeBrowserSignInForOverlay(overlayOpenRef, () => {
				setBrowserSignIn(undefined);
				setBrowserOpenContinuation(undefined);
			});
			open();
		},
		[leaveAccountHome]
	);
	/**
	 * Unrecoverable, and only ever one thing: the bridge to the main process does
	 * not exist, so no screen in this app can function.
	 */
	const fatal = api
		? undefined
		: 'The preload bridge did not load, so this window has no way to reach the main ' +
			'process. This is a build problem, not a configuration one — check that the preload ' +
			'bundle requires nothing but "electron".';

	/**
	 * A poll that failed. Deliberately **not** fatal.
	 *
	 * These are transient by nature — the vault can lock between the status check
	 * and the calls that follow it, and from 0.2 the same loop will touch the
	 * network. Treating one rejected promise as terminal replaced the entire
	 * window with an error screen that nothing could clear, so a moment's
	 * unluckiness needed an application restart. It is shown as a banner over the
	 * live UI instead, and it disappears on the next tick that works.
	 */
	const [pollError, setPollError] = useState<string | undefined>();
	/** Set from app info once the bridge answers. False until then, which is the
	 * safe default: it shows the toggle rather than hiding a real control. */
	const [installedFromStore, setInstalledFromStore] = useState(false);
	/**
	 * Whether this machine can show a desktop notification.
	 *
	 * `undefined` until app info answers, so the auto-confirm screen says nothing
	 * rather than warning about a machine it has not asked about yet.
	 */
	const [notificationsAvailable, setNotificationsAvailable] = useState<boolean | undefined>();

	/** Latest answer from the update check. Only `updateAvailable` is ever shown. */
	const [update, setUpdate] = useState<UpdateCheckResult | undefined>();

	/**
	 * @param includeCodes fetch Steam Guard codes as well as status and accounts.
	 *
	 * Codes are separable because they are the only slow part: `listCodes` waits on
	 * the Steam clock sync, which on a first call can take a full transport
	 * timeout. Everything else here is local and immediate.
	 *
	 * That mattered on unlock. The unlock screen only stops saying "Unlocking…"
	 * when it unmounts, and it only unmounted once this whole call had finished —
	 * so a slow clock sync read as a stuck unlock for tens of seconds, on the one
	 * screen where the user is already wondering whether they typed it right.
	 *
	 * Accounts are **not** separable in the same way, and that is deliberate:
	 * swapping to the account list before they arrive would show "No accounts yet"
	 * to somebody who has accounts. A moment of a wrong empty state is worse than a
	 * moment of a spinner.
	 */
	/**
	 * Which refresh is newest.
	 *
	 * The poll skips a tick while one of its own is in flight, but dialog closes
	 * call `refresh` directly — that is why they exist, so the list updates
	 * without waiting a second — and those overlapped the poll freely. Both wrote
	 * `setAccounts`, and the older answer could land last: newly imported
	 * accounts vanished from the list, and a removed one reappeared, until some
	 * later tick happened to correct it.
	 */
	const refreshSeq = useRef(0);

	const refresh = useCallback(
		async ({ includeCodes = true }: { includeCodes?: boolean } = {}): Promise<void> => {
			if (!api) {
				return;
			}
			const mine = (refreshSeq.current += 1);
			/** True while this is still the newest refresh in flight. */
			const newest = (): boolean => refreshSeq.current === mine;

			const next = await api.getVaultStatus();
			if (!newest()) {
				return;
			}
			setStatus(next);
			if (!next.unlocked) {
				setAccounts([]);
				// Not merely stale — codes are only meaningful while unlocked, and a
				// locked window must not still be showing the last ones it had.
				setCodes(undefined);
				setActivityUrgent(false);
				return;
			}
			const listed = (await api.listAccounts()).accounts;
			if (!newest()) {
				return;
			}
			setAccounts(listed);
			// Before the early return. The activity log is in memory and costs
			// nothing, and it survives a lock — so skipping it on the unlock path
			// meant an account that had been held back, or an engine that had given
			// up, showed no alert until the next poll on the one screen the user is
			// looking at hardest.
			const urgent = (await api.listActivity()).urgent;
			if (!newest()) {
				return;
			}
			setActivityUrgent(urgent);
			if (!includeCodes) {
				return;
			}
			// Regenerated on every tick rather than cached until the window rolls over.
			// A code is an HMAC over twenty bytes; recomputing one per second per
			// account costs nothing, and it removes an entire class of bug where the
			// displayed code and its countdown disagree about which window they are in.
			const codesList = await api.listCodes();
			if (!newest()) {
				return;
			}
			setCodes(codesList);
		},
		[api]
	);

	const startRecoveryBackup = useCallback(
		(account: AccountSummary): void => {
			if (!api) return;
			void runRecoveryBackupAttempt({
				steamId64: account.steamId64,
				inFlight: recoveryBackupAccounts.current,
				finish: () => api.finishRecoveryBackup(account.steamId64),
				refresh: () => refresh({ includeCodes: false }),
				onRefreshError: setPollError,
				onBusy: setFinishingRecoveryAccountIds,
				onError: (steamId64, message) => setRecoveryBackupErrors(noted(steamId64, message)),
				onStart: leaveAccountHome
			});
		},
		[api, leaveAccountHome, refresh]
	);

	const beginBrowserOpenAfterSignIn = useCallback(
		(prompt: Pick<BrowserSignInPrompt, 'account' | 'route'>): void => {
			if (!api) return;
			const current = claimBrowserOpenContinuation();
			const opening: BrowserOpenContinuation = {
				account: prompt.account,
				route: prompt.route,
				busy: true
			};
			setBrowserSignIn(undefined);
			setBrowserOpenContinuation(opening);

			void openBrowserAfterSignIn(() =>
				api.openAccountBrowser(prompt.account.steamId64, prompt.route)
			).then((result) => {
				if (!current()) return;
				if (result.opened) {
					setBrowserOpenContinuation(undefined);
					void refresh();
					return;
				}
				setBrowserOpenContinuation({ ...opening, busy: false, error: result.reason });
			});
		},
		[api, refresh]
	);

	/**
	 * Navigate to one account's confirmations, from a clicked notification.
	 *
	 * **The lookup is the first thing it does.** The renderer navigates to an
	 * account it already knows about, never to whatever arrived on the wire — so
	 * an id it does not recognise is ignored rather than trusted.
	 *
	 * **And the competing screens are cleared, not just the target set.** The
	 * view is a stack of `if`s in which `autoConfirmFor` and `removingFor` are
	 * tested *above* `confirmingFor`, so setting the target while either is open
	 * navigates nowhere and the click looks broken.
	 */
	const notificationTakeoverReady = notificationMayTakeOver({
		view,
		overlayOpen,
		signInOpen: browserSignIn !== undefined || browserOpenContinuation !== undefined,
		accountListBusy: accountListOperationBusy(exportingAccountCount, finishingRecoveryAccountCount)
	});
	const confirmationAccounts = confirmationAccountMembership(accounts);
	const openConfirmationsFor = useCallback(
		(steamId64: string): boolean => {
			// A parent-level navigation may not bypass a child screen's disabled Back
			// button. This includes an already-open Confirmations screen: acknowledging
			// a same-account click without reloading would discard the only signal that
			// its current list is stale. The retained click is retried after the user
			// leaves the screen, which remounts it with a fresh list.
			if (
				!notificationTakeoverReady ||
				exportingAccounts.current.size > 0 ||
				recoveryBackupAccounts.current.size > 0
			) {
				return false;
			}
			const account = confirmationsTargetFor(accounts, steamId64);
			if (!account) {
				return false;
			}
			// A native-notification click is deliberate foreground navigation too.
			// Revoke an unlock-recovery claim before changing any React state.
			leaveAccountHome();
			supersedeBrowserSignInForOverlay(overlayOpenRef, () => {
				setBrowserSignIn(undefined);
				setBrowserOpenContinuation(undefined);
			});
			setAutoConfirmFor(undefined);
			setRemovingFor(undefined);
			setRoutingFor(undefined);
			setBackupFor(undefined);
			setView('accounts');
			setConfirmingFor(account);
			return true;
		},
		[accounts, leaveAccountHome, notificationTakeoverReady]
	);

	/**
	 * The newest `openConfirmationsFor`, reachable from a subscription that is
	 * not rebuilt when it changes.
	 *
	 * That callback closes over `accounts`, so it is a new function on every
	 * status poll — once a second. Depending on it directly meant the effect
	 * below re-ran at the same rate, and `onOpenConfirmations` had no way to
	 * unsubscribe, so each run added a listener that stayed. Thousands an hour,
	 * each pinning its own `accounts` snapshot.
	 *
	 * It was a correctness bug as well as a leak: a click ran every listener,
	 * oldest first, and `openConfirmationsFor` returns early for an account it
	 * cannot find **without clearing `confirmingFor`**. So a stale listener
	 * holding a since-removed account set it, and the newest listener bailed
	 * without undoing that — the confirmations screen opened for an account the
	 * vault no longer had. One listener that always reads the current callback
	 * cannot do that.
	 */
	const openConfirmationsRef = useRef(openConfirmationsFor);
	/**
	 * The push and recovery IPC calls are two deliveries of one click. Whichever
	 * delivery reaches this renderer first owns the token; the other is ignored.
	 * This is deliberately a token check, not an account check: two clicks for
	 * the same SteamID are distinct user actions.
	 */
	const confirmationClickClaims = useRef<ConfirmationClickClaims>({
		newestObserved: undefined,
		handled: undefined,
		acknowledged: undefined
	});
	const acknowledgingConfirmationClicks = useRef(new Set<number>());

	/**
	 * Process either delivery path for one click. A new click for the account
	 * already displayed is observed but deliberately not handled until that
	 * component has completed a new list request.
	 */
	const processConfirmationClick = useCallback(
		(click: ToastClick): void => {
			if (!api) return;
			const claims = confirmationClickClaims.current;
			if (
				notificationRefreshesOpenAccount(confirmingForRef.current?.steamId64, click, claims.handled)
			) {
				claimConfirmationClick(claims, click.token, () => false);
				if (
					claims.newestObserved === click.token &&
					(claims.handled === undefined || click.token > claims.handled)
				) {
					confirmationRefreshClick.current = click;
					setConfirmationRefreshToken(click.token);
				}
				return;
			}

			const navigated = claimConfirmationClick(claims, click.token, () =>
				openConfirmationsRef.current(click.steamId64)
			);
			if (navigated || shouldAcknowledgeConfirmationClick(claims, click.token)) {
				beginConfirmationClickAcknowledgement(
					api,
					claims,
					acknowledgingConfirmationClicks.current,
					click
				);
			}
		},
		[api]
	);
	const processConfirmationClickRef = useRef(processConfirmationClick);
	useEffect(() => {
		processConfirmationClickRef.current = processConfirmationClick;
	}, [processConfirmationClick]);

	const completeNotificationRefresh = useCallback(
		(token: number): void => {
			if (!api) return;
			const claims = confirmationClickClaims.current;
			const settlement = settleConfirmationRefreshClick(
				claims,
				confirmationRefreshClick.current,
				token
			);
			if (!settlement) return;
			if (settlement.acknowledge) {
				beginConfirmationClickAcknowledgement(
					api,
					claims,
					acknowledgingConfirmationClicks.current,
					settlement.click
				);
			}
			confirmationRefreshClick.current = undefined;
			setConfirmationRefreshToken(undefined);
		},
		[api]
	);
	// In an effect, not during render: writing a ref while rendering is a
	// side-effect in a function React may call speculatively, and `react-hooks/refs`
	// refuses it. This one runs whenever the callback changes and does nothing but
	// a local assignment — no IPC, no subscription.
	useEffect(() => {
		openConfirmationsRef.current = openConfirmationsFor;
	}, [openConfirmationsFor]);

	// The fast path: a click while this document is alive and listening.
	useEffect(() => {
		if (!api) {
			return;
		}
		// Depends on `api` alone, so this is established once and torn down once —
		// which is what the preload's comment always claimed and could not deliver.
		return api.onOpenConfirmations((click: ToastClick) => {
			/*
			 * **Navigation and acknowledgement are separate.**
			 *
			 * `activate` retains *and* pushes, always — deliberately, because a
			 * lock reloads this window and the retained copy is the only thing
			 * that survives it. Nothing marked the push as having landed, so the
			 * slow path below collected the same intent a second later and
			 * navigated again.
			 *
			 * Usually invisible; destructive inside that one second. The second
			 * navigation is a *rollback*: whatever the user did after clicking the
			 * toast — closing the screen, opening Settings, starting a removal —
			 * is undone by `setView('accounts')` and the four clears above.
			 *
			 * A successful navigation starts an exact-token acknowledgement. If that
			 * local IPC call fails, bounded retries acknowledge the same token without
			 * navigating again. **The boolean is load-bearing.**
			 * `openConfirmationsFor` returns false
			 * when the id is not in the account list yet, and that is exactly the
			 * case the slow path exists for — a click landing after unlock but
			 * before `listAccounts` has answered. Clearing there would delete the
			 * intent rather than double-use it.
			 */
			processConfirmationClickRef.current(click);
		});
	}, [api]);

	/**
	 * The slow path, and the one that makes a lock survivable.
	 *
	 * A lock **reloads** this window, so a click that arrived while the vault was
	 * locked — or in the instant before the reload landed — reached a document
	 * that no longer exists. Main kept the intent; this peeks once there is an
	 * account list to navigate within, and acknowledges the exact token only after
	 * navigation succeeds.
	 *
	 * Gated on the list being non-empty rather than only on `unlocked`, because
	 * navigating needs an account to navigate *to*. Peeking earlier is safe now,
	 * but can only fail the lookup and add a needless IPC round trip.
	 */
	useEffect(() => {
		if (!api || !status?.unlocked || confirmationAccounts.length === 0) {
			return;
		}
		let cancelled = false;
		api
			.takePendingConfirmations()
			.then((pending) => {
				const target = pending.steamId64;
				const token = pending.token;
				if (cancelled || target === undefined || token === undefined) {
					return;
				}
				/*
				 * **Cleared only once exact acknowledgement succeeds.**
				 *
				 * Reading used to clear it in main, and this threw away the boolean
				 * saying whether it had worked. `openConfirmationsFor` returns false
				 * when the account is not in the list yet — the exact case this path
				 * exists for — so a security notification opened the application, went
				 * nowhere, and left nothing behind to try again with. A successful
				 * navigation starts bounded acknowledgement retries; later collections
				 * can retry acknowledgement without repeating the navigation.
				 */
				processConfirmationClickRef.current({ steamId64: target, token });
			})
			.catch(() => {
				// A click that cannot be collected is not worth an error path; the
				// account list is on screen and the confirmations are one click away.
			});
		return () => {
			cancelled = true;
		};
		/*
		 * **Account membership, and not `openConfirmationsFor`.**
		 *
		 * That callback closes over `accounts`, which `listAccounts` replaces with
		 * a fresh array every second — so this effect tore down and re-ran once a
		 * second for the life of an unlocked session, asking main for a pending
		 * click each time.
		 *
		 * Peeking is non-destructive now, so the churn cannot lose a click. It can
		 * still start and cancel a needless IPC round trip every second, delaying
		 * the useful delivery and doing work for no state change.
		 *
		 * A sorted Steam-ID signature stays stable for those refreshes but changes
		 * when account A is replaced by account B even if the list length stays one.
		 * That replacement is exactly when a retained click for B must be retried.
		 */
	}, [api, status?.unlocked, confirmationAccounts, view, notificationTakeoverReady]);

	// The window title comes from branding, never from HTML — one source of truth
	// while Q1 is unresolved. It doubles as the end-to-end IPC signal: if the
	// title stays "Loading…", the bridge did not complete a round trip.
	useEffect(() => {
		if (!api) {
			return;
		}
		api
			.getAppInfo()
			.then((info) => {
				document.title = info.productName;
				// Which Windows channel installed this. Settings needs it because the
				// update toggle is inert in a Store build, and showing a switch that
				// cannot do anything is the thing this screen already refuses to do
				// for the unimplemented vault options.
				setInstalledFromStore(info.installedFromStore);
				// So the auto-confirm screen can say that a notify-only account has no
				// surface on this machine, rather than offering the switch silently.
				setNotificationsAvailable(info.notificationsAvailable);
			})
			.catch(() => {
				// Status polling below surfaces a broken bridge properly; a failed
				// title is not worth a second error path.
			});
	}, [api]);

	// Poll rather than push. The vault can lock without the renderer doing
	// anything — idle timeout, machine suspend — so the UI has to notice on its
	// own rather than wait to be told.
	useEffect(() => {
		if (!api) {
			return;
		}
		let cancelled = false;
		/**
		 * Whether the previous tick is still running.
		 *
		 * The interval fires every second whether or not the last one finished, and
		 * `refresh` makes four IPC calls in sequence — one of which, `listCodes`,
		 * waits on the Steam clock sync and can take a full transport timeout. So a
		 * single slow sync used to start a new chain every second while the old ones
		 * were still going: dozens of overlapping requests, all racing to `setState`,
		 * with the oldest and stalest able to land last.
		 *
		 * Skipping a tick costs nothing. The next one is a second away, and the state
		 * it would have fetched is the state the in-flight call is already fetching.
		 */
		let inFlight = false;
		const tick = (): void => {
			if (inFlight) {
				return;
			}
			inFlight = true;
			refresh()
				.then(() => {
					if (!cancelled) {
						setPollError(undefined);
					}
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setPollError(err instanceof Error ? err.message : String(err));
					}
				})
				.finally(() => {
					inFlight = false;
				});
		};
		tick();
		const timer = setInterval(tick, STATUS_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [api, refresh]);

	// Report real interaction so the idle timer measures idleness rather than
	// wall-clock time. Throttled: the point is "someone is here", not a precise
	// event count.
	const lastTouch = useRef(0);
	useEffect(() => {
		if (!api || !status?.unlocked) {
			return;
		}
		const onActivity = (): void => {
			const now = Date.now();
			if (now - lastTouch.current < TOUCH_THROTTLE_MS) {
				return;
			}
			lastTouch.current = now;
			void api.touchVault();
		};
		const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel'];
		events.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
		return () => events.forEach((name) => window.removeEventListener(name, onActivity));
	}, [api, status?.unlocked]);

	/**
	 * Go straight back to an unfinished transfer after unlocking.
	 *
	 * A lock reloads the window, which is how a transfer that had already rotated
	 * the authenticator lost the screen that was asking to save it. Recovering
	 * *when the screen happens to be opened* is not enough: the user has no reason
	 * to suspect there is anything to come back to, and the secrets Steam will
	 * never reissue are held in memory until the process exits.
	 *
	 * So the app opens it for them. This is the only place a view is chosen
	 * without the user asking, and the justification is the size of the loss —
	 * every other screen can wait.
	 */
	useEffect(() => {
		if (!api || !status?.unlocked) {
			return;
		}
		let cancelled = false;
		const foregroundClaim = claimRecoveryForeground(foregroundRevision.current);
		void Promise.allSettled([api.getEnrollmentStatus(), api.getTransferStatus()])
			.then(([enrollmentResult, transferResult]) => {
				if (cancelled) return;
				const enrollment: EnrollmentStatus =
					enrollmentResult.status === 'fulfilled'
						? enrollmentResult.value
						: {
								problem:
									enrollmentResult.reason instanceof Error
										? enrollmentResult.reason.message
										: String(enrollmentResult.reason)
							};
				const transfer: TransferStatus =
					transferResult.status === 'fulfilled'
						? transferResult.value
						: {
								problem:
									transferResult.reason instanceof Error
										? transferResult.reason.message
										: String(transferResult.reason)
							};
				const enrollmentNeedsAttention =
					enrollment.pending !== undefined || enrollment.problem !== undefined;
				const transferNeedsAttention =
					transfer.awaiting !== undefined ||
					transfer.recovery !== undefined ||
					transfer.problem !== undefined;
				if (!enrollmentNeedsAttention && !transferNeedsAttention) {
					return;
				}
				const attention: DeferredRecovery = {
					destination: enrollmentNeedsAttention ? 'enroll' : 'move',
					queuedMove: enrollmentNeedsAttention && transferNeedsAttention
				};
				// Enrollment first, deterministically: its AddAuthenticator reply may be
				// process-only. New code prevents both workflows coexisting. If legacy
				// records do, queue Move so closing or finishing this screen cannot hide it.
				deliverRecoveryAttention(
					foregroundRevision.current,
					foregroundClaim,
					accountHomeOwnsForeground.current,
					() => {
						accountHomeOwnsForeground.current = false;
						setDeferredRecovery(undefined);
						setQueuedRecoveryView(attention.queuedMove ? 'move' : undefined);
						if (attention.destination === 'enroll') {
							setResumeEnrollment(undefined);
						}
						setView(attention.destination);
					},
					() => setDeferredRecovery(attention)
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [api, status?.unlocked]);

	/**
	 * Ask once per unlock, not on a timer.
	 *
	 * The main process caches the answer for hours, so this is cheap — but asking
	 * on a schedule would make the app chatty for no benefit. An update that
	 * lands while somebody is mid-session can wait until the next unlock.
	 */
	/**
	 * Set the moment the user saves `updateCheck: false`, cleared when they turn
	 * it back on. A ref, not state: the in-flight check's continuation reads it,
	 * and it must see the save that happened after the request started.
	 */
	const updateBannerSuppressed = useRef(false);

	/**
	 * Which update check is newest, so an older one cannot answer for it.
	 *
	 * **Every check could write the banner, whichever order they settled in.**
	 * The effect re-runs when `Require proxies` or the update setting moves, so
	 * two can be in the air at once — and the main process aborts the older one,
	 * which settles as `unknown`. Landing after the newer check succeeded, it
	 * replaced a real "update available" with "could not check": the cache in
	 * the main process stayed correct and the screen stopped saying there was a
	 * release.
	 *
	 * The same shape as `refreshSeq` above, and for the same reason.
	 */
	const updateSeq = useRef(0);

	/**
	 * How many times settings have been saved this session.
	 *
	 * **The update effect is driven by this rather than by the settings' values.**
	 * Watching `status.requireProxies` and `status.updateCheck` looked equivalent
	 * and is not: turn `Require proxies` on and straight off again between two
	 * status polls and both fields come back to what they already were, so React
	 * sees no dependency change and never re-runs. No newer check starts — and
	 * the answer from the check the *first* save aborted is then still the newest
	 * one anybody claimed, so `updateAnswerIsCurrent` lets it through. The screen
	 * ends up showing "could not check" because of a setting the user turned on
	 * and off again.
	 *
	 * A counter cannot come back to where it was. Every successful save moves it,
	 * whether or not the values ended up different, so every save starts a fresh
	 * check and supersedes whatever was in the air.
	 */
	const [settingsRevision, setSettingsRevision] = useState(0);

	useEffect(() => {
		if (!api || !status?.unlocked) {
			return;
		}
		const mine = (updateSeq.current += 1);
		// Never `.catch(setFatal)`. A failed update check is background work the
		// user did not ask for, and it must not be able to replace the screen they
		// are using — the handler already reports failure as a value.
		api
			.checkForUpdate()
			.then((result) => {
				// Both staleness questions in one place. See `updateAnswerIsCurrent`.
				if (updateAnswerIsCurrent(updateSeq.current, mine, updateBannerSuppressed.current)) {
					setUpdate(result);
				}
			})
			.catch(() => undefined);
		/*
		 * **Both settings that gate the check, not just the unlock.**
		 *
		 * This asked once per unlock, so the two switches that stop a check could
		 * not start one again: turning update checks back on, or turning `Require
		 * proxies` off — the other thing that stops it — left the app waiting for
		 * the next unlock to discover there was a release.
		 */
		/*
		 * **The revision, not the values.** `settingsUpdate` is the only writer of
		 * either setting, so a bump covers every way they can change — and unlike
		 * the values, it cannot return to a number it has already been. See
		 * `settingsRevision`.
		 */
	}, [api, status?.unlocked, settingsRevision]);

	const openDeferredRecovery = (): void => {
		const attention = deferredRecovery;
		if (!attention) return;
		leaveAccountHome();
		setDeferredRecovery(undefined);
		setQueuedRecoveryView(attention.queuedMove ? 'move' : undefined);
		if (attention.destination === 'enroll') {
			setResumeEnrollment(undefined);
		}
		setView(attention.destination);
	};
	const deferredRecoveryCanOpen =
		view === 'accounts' &&
		!overlayOpen &&
		browserSignIn === undefined &&
		browserOpenContinuation === undefined &&
		!accountListOperationBusy(exportingAccountCount, finishingRecoveryAccountCount);

	if (fatal || !api) {
		return (
			<main className="shell">
				<h1>Something is wrong</h1>
				<DynamicError>{fatal}</DynamicError>
			</main>
		);
	}

	return (
		<>
			<ExportNotices
				notices={exportNotices}
				onDismiss={(id) => updateExportNotices({ type: 'dismiss', id })}
			/>
			{deferredRecovery && (
				<section className="banner notice" role="status" aria-labelledby="recovery-waiting-title">
					<strong id="recovery-waiting-title">
						{deferredRecovery.queuedMove
							? 'Two interrupted authenticator operations need attention.'
							: deferredRecovery.destination === 'enroll'
								? 'An interrupted authenticator setup needs attention.'
								: 'An interrupted authenticator move needs attention.'}
					</strong>{' '}
					It was not opened automatically because you had already moved to another screen.
					{deferredRecoveryCanOpen ? (
						<div className="controls">
							<button type="button" onClick={openDeferredRecovery}>
								Open recovery
							</button>
						</div>
					) : (
						<span> Finish or leave the current screen, then open it from the account list.</span>
					)}
				</section>
			)}
			{/* Over the live UI, not instead of it. The next successful tick clears it. */}
			{pollError && <DynamicError className="banner error">{pollError}</DynamicError>}
			{/* Only when there is genuinely something newer. "Up to date" and "could
			    not check" are both answers nobody needs a banner about — and a
			    permanent green tick is exactly the reassurance that stops being
			    read. The link opens in the OS browser; the app never fetches it. */}
			{update?.state === 'updateAvailable' && (
				<p className="banner" role="status">
					<strong>{update.version} is available.</strong> Get it from the signed release on GitHub —
					never from a link anywhere else.{' '}
					<a href={update.url} target="_blank" rel="noreferrer noopener">
						Open the release
					</a>
				</p>
			)}
			{screen()}
		</>
	);

	function screen(): React.JSX.Element {
		if (!api || !status) {
			return (
				<main className="shell">
					<p className="muted">Starting…</p>
				</main>
			);
		}

		// `!unlocked` matters: a vault *file* can vanish under an open session
		// (moved, deleted, a cloud-sync misfire), and showing the create screen
		// then invited replacing live accounts with an empty vault. The open
		// session is the better state — it still holds everything, and its next
		// save rewrites the file from memory.
		if (!status.exists && !status.unlocked) {
			return (
				<CreateVault
					onCreate={async (passphrase) => {
						await api.createVault(passphrase);
						await refresh({ includeCodes: false });
					}}
					// A vault file can be missing while its backup is not — moved,
					// deleted, or a restore that failed partway. Without this, the only
					// route the screen offered was creating a fresh vault, whose second
					// save copies over the backup that still held every account.
					backupAvailable={status.backupAvailable}
					onRestoreBackup={async (passphrase) => {
						await api.restoreVaultBackup(passphrase);
						await refresh({ includeCodes: false });
					}}
					onAdopt={async (passphrase) => {
						const result = await api.adoptVaultFile(passphrase);
						// Adopting makes a vault exist, which swaps this screen for the
						// unlock one. Nothing here can unlock it — the passphrase is the
						// user's and the next screen is where it belongs.
						await refresh({ includeCodes: false });
						return result;
					}}
				/>
			);
		}

		if (!status.unlocked) {
			return (
				<UnlockVault
					backupAvailable={status.backupAvailable}
					onRestoreBackup={async (passphrase) => {
						await api.restoreVaultBackup(passphrase);
						await refresh({ includeCodes: false });
					}}
					onUnlock={async (passphrase) => {
						await api.unlockVault(passphrase);
						// Without codes, so the screen swaps as soon as the vault is open
						// rather than when the Steam clock sync finishes. The next poll,
						// a second later, fills them in.
						await refresh({ includeCodes: false });
					}}
				/>
			);
		}

		if (autoConfirmFor) {
			const current =
				accounts.find((entry) => entry.steamId64 === autoConfirmFor.steamId64) ?? autoConfirmFor;
			return (
				<AutoConfirm
					// Holds unsaved switch positions and the trades acknowledgement.
					key={current.steamId64}
					account={current}
					accounts={accounts}
					requireProxies={status?.requireProxies === true}
					notificationsAvailable={notificationsAvailable}
					onSave={(settings) => api.setAccountAutoConfirm(current.steamId64, settings)}
					onClose={() => {
						setAutoConfirmFor(undefined);
						returnToAccountHome();
						void refresh();
					}}
				/>
			);
		}

		if (removingFor) {
			return (
				<RemoveAccount
					// Holds a typed passphrase and an acknowledgement.
					key={removingFor.steamId64}
					account={removingFor}
					onRemove={(passphrase) => api.removeAccount(removingFor.steamId64, passphrase)}
					onDeactivate={(passphrase, acknowledgement) =>
						api.deactivateAuthenticator(removingFor.steamId64, passphrase, acknowledgement)
					}
					onResolve={(kind, operationToken, steamActed, passphrase) =>
						api.resolveAccountOperation(
							removingFor.steamId64,
							kind,
							operationToken,
							steamActed,
							passphrase
						)
					}
					onClearStale={(kind, staleToken) =>
						api.clearStaleAccountOperation(removingFor.steamId64, kind, staleToken)
					}
					onClose={() => {
						setRemovingFor(undefined);
						returnToAccountHome();
						void refresh();
					}}
				/>
			);
		}

		if (confirmingFor) {
			return (
				<Confirmations
					/*
					 * **Keyed by account, so switching target remounts rather than
					 * reuses.**
					 *
					 * Without this React keeps the instance when `confirmingFor`
					 * changes: the fetch effect re-runs because it depends on the id,
					 * and nothing else resets. Clicking account B's notification left
					 * A's confirmation list on screen with buttons that now acted on
					 * B, A's error text, and — if A was showing the password form —
					 * the password already typed into it, with the callback silently
					 * repointed at B.
					 *
					 * A key is the whole fix: every piece of account-scoped state in
					 * that subtree is discarded at once, which is stronger than
					 * remembering to clear each one.
					 */
					key={confirmingFor.steamId64}
					account={confirmingFor}
					onList={() => api.listConfirmations(confirmingFor.steamId64)}
					onAct={(action, ids) => api.actOnConfirmations(confirmingFor.steamId64, action, ids)}
					onSignIn={(password) => api.signInToSteam(confirmingFor.steamId64, password)}
					notificationRefreshToken={confirmationRefreshToken}
					onNotificationRefresh={completeNotificationRefresh}
					onClose={() => {
						setConfirmingFor(undefined);
						returnToAccountHome();
					}}
				/>
			);
		}

		if (routingFor) {
			// Re-read from the live list so the screen reflects a change made in it,
			// rather than the snapshot taken when it was opened.
			const current =
				accounts.find((entry) => entry.steamId64 === routingFor.steamId64) ?? routingFor;
			return (
				<AccountRouting
					// Holds a typed proxy URL, which is account-specific by definition.
					key={current.steamId64}
					account={current}
					onSave={(proxyUrl) => api.setAccountProxy(current.steamId64, proxyUrl)}
					onClose={() => {
						setRoutingFor(undefined);
						returnToAccountHome();
						void refresh();
					}}
				/>
			);
		}

		if (backupFor) {
			return (
				<RevocationBackup
					accountName={backupFor.accountName}
					steamId64={backupFor.steamId64}
					onReveal={(passphrase) => api.revealRevocationCode(backupFor.steamId64, passphrase)}
					onConfirm={() => api.confirmRevocationBackup(backupFor.steamId64)}
					onClose={() => {
						setBackupFor(undefined);
						// A durable transfer can be queued behind enrollment recovery. Going
						// through the encouraged revocation-code ceremony is still leaving
						// enrollment; closing it must drain that queue rather than strand Move
						// behind the account list until another lock/unlock.
						leaveEnrollmentRecovery();
						void refresh();
					}}
				/>
			);
		}

		if (view === 'activity') {
			return (
				<Activity
					accounts={accounts}
					onLoad={() => api.listActivity()}
					onSeen={(seq) => {
						// The snapshot's own high-water mark, not "everything up to now": a
						// pass finishing between the fetch and this call must stay unseen.
						// **The answer, not `false`.** An urgent entry recorded between the
						// snapshot and this call is outside the watermark on purpose, so
						// main keeps it urgent — and clearing the badge unconditionally
						// hid a fresh account-recovery warning until some later poll
						// happened to restore it.
						void api.acknowledgeActivity(seq).then((result) => setActivityUrgent(result.urgent));
					}}
					onOpenAccount={(openFor) => {
						openAccountOverlay(() => {
							setView('accounts');
							setConfirmingFor(openFor);
						});
					}}
					onClose={returnToAccountHome}
				/>
			);
		}

		if (view === 'about') {
			return <About onLoad={() => api.getAppInfo()} onClose={returnToAccountHome} />;
		}

		if (view === 'settings') {
			return (
				<Settings
					installedFromStore={installedFromStore}
					onLoad={() => api.getSettings()}
					onChangePassphrase={(current, next) => api.changePassphrase(current, next)}
					onSave={async (settings) => {
						const result = await api.updateSettings(settings);
						// Switching the check off must also take down a banner it already
						// raised. Leaving it up meant the one visible consequence of the
						// setting — the only thing it does that a user can see — carried on
						// for the rest of the session as though nothing had changed.
						updateBannerSuppressed.current = !settings.updateCheck;
						if (!settings.updateCheck) {
							setUpdate(undefined);
						}
						/*
						 * **What actually restarts the update check.**
						 *
						 * Bumped after the save succeeded, so it is not reached when
						 * `updateSettings` throws. Nothing here reads the settings back to
						 * decide: a save that changed nothing still supersedes a check the
						 * previous save aborted, and a counter cannot land on a value it
						 * has already had. See `settingsRevision`.
						 */
						setSettingsRevision((revision) => revision + 1);

						/*
						 * And the status, for the rest of the screen — the account list
						 * hides its Direct and Steam-only buttons on `requireProxies`, and
						 * waiting a poll tick for that is a second of offering a button
						 * the main process would refuse. Deliberately **not** what drives
						 * the update effect: this is fire-and-forget, so two of them can
						 * be in flight and the older is discarded by `refreshSeq` — which
						 * is exactly the hole the revision above closes.
						 */
						void refresh({ includeCodes: false });
						return result;
					}}
					onClose={returnToAccountHome}
				/>
			);
		}

		if (view === 'move') {
			return (
				<MoveAuthenticator
					requireProxies={status.requireProxies}
					onAuthenticate={(accountName, password, code, proxyUrl) =>
						api.authenticateTransfer(accountName, password, code, proxyUrl)
					}
					onStartChallenge={() => api.startTransferChallenge()}
					onComplete={(smsCode) => api.completeTransfer(smsCode)}
					onRetryPersist={(passphrase) => api.retryTransferPersist(passphrase)}
					onStatus={() => api.getTransferStatus()}
					onResolve={(attemptId, resolution, passphrase) =>
						api.resolveTransfer(attemptId, resolution, passphrase)
					}
					onCancel={() => api.cancelTransfer()}
					// The same channel the standalone back-up ceremony uses. It is
					// accepted here because the transfer handler recorded the reveal
					// when it handed this screen the code — the confirm still refuses
					// for an account whose code nobody has seen.
					onAcknowledgeBackup={(steamId64) => api.confirmRevocationBackup(steamId64)}
					onClose={returnToAccountHome}
				/>
			);
		}

		if (view === 'enroll') {
			const closeEnrollment = (): void => {
				setResumeEnrollment(undefined);
				leaveEnrollmentRecovery();
			};
			return (
				<AddAuthenticator
					requireProxies={status.requireProxies}
					recoveryQueued={queuedRecoveryView === 'move'}
					onMove={() => {
						setQueuedRecoveryView(undefined);
						leaveAccountHome();
						setView('move');
					}}
					{...(resumeEnrollment
						? {
								resume: {
									steamId64: resumeEnrollment.steamId64,
									accountName: resumeEnrollment.accountName
								}
							}
						: {})}
					{
						// **The refusal to repeat an activation, read from the account.** It
						// lived in that screen's own state, which lasts as long as the
						// screen: closing it and coming back through "Finish activation"
						// offered the form again, after the application had said it would
						// not send the request a second time. The vault holds it now.
						...(resumeEnrollment?.unresolvedOperation?.kind === 'activate'
							? { unresolved: resumeEnrollment.unresolvedOperation }
							: {})
					}
					onResolve={(steamId64, operationToken, steamActed) =>
						api.resolveAccountOperation(steamId64, 'activate', operationToken, steamActed)
					}
					onClearStale={(steamId64, kind, staleToken) =>
						api.clearStaleAccountOperation(steamId64, kind, staleToken)
					}
					onEnrollmentStatus={() => api.getEnrollmentStatus()}
					onRetryEnrollment={(attemptId, steamId64) =>
						api.retryEnrollmentPersist(attemptId, steamId64)
					}
					onResolveEnrollment={(attemptId, steamId64, resolution) =>
						api.resolveEnrollment(attemptId, steamId64, resolution)
					}
					onBegin={(accountName, password, proxyUrl) =>
						api.beginEnrollment(accountName, password, proxyUrl)
					}
					onEmailCode={(code) => api.submitEnrollmentEmailCode(code)}
					onCancel={() => api.cancelEnrollment()}
					onActivate={(steamId64, code) => api.activateAuthenticator(steamId64, code)}
					onBackup={(steamId64, accountName) => {
						// Straight into the S12 ceremony for the account just created. The
						// revocation code is the one thing a new enrollment must not leave
						// the user without, and making them go and find it invites skipping.
						//
						// The account is **not** looked up in `accounts` first. That list is
						// polled, so in the seconds after an enrollment it may not contain
						// the new SteamID yet — and the lookup failing meant the button did
						// nothing at all: no navigation, no error, at the exact moment the
						// screen is telling the user this is the one step not to skip. The
						// enrollment screen already knows both values, so it passes them.
						openAccountOverlay(() => {
							setView('accounts');
							setBackupFor({ steamId64, accountName });
						});
					}}
					onClose={closeEnrollment}
				/>
			);
		}

		if (view === 'recover') {
			return (
				<RecoverAccount
					onRecover={(passphrase) => api.recoverAccount(passphrase)}
					onClose={() => {
						returnToAccountHome();
						// A restored account has to appear without waiting on the poll —
						// the whole point of the screen is seeing it come back.
						void refresh();
					}}
				/>
			);
		}

		if (view === 'import') {
			return (
				<ImportAccounts
					onScan={() => api.scanMaFiles()}
					onUnlock={(passphrase) => api.unlockImport(passphrase)}
					onCommit={(selections) => api.commitImport(selections)}
					onDiscard={() => api.discardImport()}
					onClose={() => {
						returnToAccountHome();
						// Imported accounts appear without waiting on the poll, the same way
						// a recovered one does. A second of the list not showing what the
						// previous screen just said it imported reads as a failure.
						void refresh();
					}}
				/>
			);
		}

		/*
		 * **Last, so it can outrank nothing.**
		 *
		 * This sat above `routingFor` and `backupFor`, which are overlays rendered
		 * while the view is still `accounts` — so a stale answer took the window
		 * from Account routing, and from Revocation backup, which is a passphrase
		 * screen. `view === 'accounts'` is not the same question as "the account
		 * list is what is on screen", and the fix that introduced it answered the
		 * wrong one.
		 *
		 * Placed immediately before the account list rather than given a list of
		 * overlays to check: every screen above returns before reaching here, so a
		 * new one takes precedence by existing. A list is a thing to forget.
		 */
		if (browserOpenContinuation !== undefined && view === 'accounts' && !overlayOpen) {
			return (
				<BrowserOpenRetry
					accountName={browserOpenContinuation.account.accountName}
					busy={browserOpenContinuation.busy}
					{...(browserOpenContinuation.error === undefined
						? {}
						: { error: browserOpenContinuation.error })}
					onRetry={() => beginBrowserOpenAfterSignIn(browserOpenContinuation)}
					onCancel={() => {
						abandonPendingSignIns();
						setBrowserOpenContinuation(undefined);
					}}
				/>
			);
		}

		if (mayShowSignInPrompt(browserSignIn, view, overlayOpen)) {
			return (
				<SteamSignIn
					// Holds a typed password. Same reasoning as `Confirmations`: a
					// different account must never inherit one.
					key={browserSignIn.account.steamId64}
					accountName={browserSignIn.account.accountName}
					{...(browserSignIn.reason === undefined ? {} : { reason: browserSignIn.reason })}
					onSignIn={(password) =>
						api.signInToSteam(
							browserSignIn.account.steamId64,
							password,
							// The same route the window will use. Signing in through a proxy
							// the user chose Direct to get past is the failure this whole
							// screen exists downstream of.
							browserSignIn.route
						)
					}
					onSignedIn={() => beginBrowserOpenAfterSignIn(browserSignIn)}
					onCancel={() => setBrowserSignIn(undefined)}
				/>
			);
		}

		return (
			<VaultHome
				accounts={accounts}
				codes={codes}
				msUntilAutoLock={status.msUntilAutoLock}
				onCopyCode={(steamId64) => api.copyCode(steamId64)}
				onBackUpRevocationCode={(account) => openAccountOverlay(() => setBackupFor(account))}
				onChangeRouting={(account) => openAccountOverlay(() => setRoutingFor(account))}
				onShowConfirmations={(account) => openAccountOverlay(() => setConfirmingFor(account))}
				requireProxies={status.requireProxies}
				onOpenBrowser={async (account, route) => {
					/*
					 * **Claimed before the request goes out, never after it comes back.**
					 *
					 * The claim is what says "this is the screen the user is currently
					 * asking for", and that is only true at the moment they pressed.
					 * Claiming after the `await` would hand every response the newest
					 * generation there is — including one that has been overtaken while it
					 * was in the air — which is the defect itself, spelled differently.
					 */
					leaveAccountHome();
					const settle = claimSignInScreen();
					const result = await api.openAccountBrowser(account.steamId64, route);
					// Taking over the screen here rather than in `VaultHome`: the row has
					// nowhere to put a password field, and this is the component that owns
					// which screen is showing.
					const prompt = settle(account, route, result);
					// Guarded, rather than setting whatever comes back. A superseded
					// answer must install nothing *and clear nothing* — passing its
					// `undefined` straight through would take down the sign-in screen a
					// newer open put up, and the password already typed into it, which is
					// the erasure this whole mechanism exists to stop.
					/*
					 * **And nothing is installed behind a screen that is already open.**
					 *
					 * Putting the prompt below the overlays stopped it replacing Account
					 * routing or Revocation backup. It did not stop it waiting: the answer
					 * sat in state until the user pressed Back, and then took the window —
					 * a sign-in for a request they had started before, arriving as a
					 * surprise on a screen they had navigated to themselves.
					 *
					 * Discarded rather than deferred, for the same reason leaving the
					 * screen discards one: the open belonged to the account list.
					 */
					if (prompt && !overlayOpenRef.current) {
						setBrowserSignIn(prompt);
					}
					return result;
				}}
				onRemoveAccount={(account) => openAccountOverlay(() => setRemovingFor(account))}
				onChangeAutoConfirm={(account) => openAccountOverlay(() => setAutoConfirmFor(account))}
				onImport={() => navigateFromAccountHome('import')}
				onRecover={() => navigateFromAccountHome('recover')}
				onEnrol={() => {
					setResumeEnrollment(undefined);
					navigateFromAccountHome('enroll');
				}}
				onMove={() => navigateFromAccountHome('move')}
				onFinishActivation={(account) => {
					/*
					 * An unresolved operation owns this account before its row status does.
					 * In particular, a durable deactivation can coexist with the legacy
					 * `pendingActivation` status. Passing the complete summary into the
					 * operation surface preserves its exact kind and opaque token.
					 */
					if (account.unresolvedOperation !== undefined) {
						openAccountOverlay(() => setRemovingFor(account));
						return;
					}
					setResumeEnrollment(account);
					navigateFromAccountHome('enroll');
				}}
				onFinishRecoveryBackup={startRecoveryBackup}
				finishingRecovery={finishingRecoveryAccountIds}
				recoveryErrors={recoveryBackupErrors}
				onExport={startAccountExport}
				exporting={exportingAccountIds}
				onSettings={() => navigateFromAccountHome('settings')}
				onAbout={() => navigateFromAccountHome('about')}
				onActivity={() => navigateFromAccountHome('activity')}
				activityUrgent={activityUrgent}
				onLock={() => {
					// The main process reloads this window on lock, so there is nothing to
					// clean up here — the whole document goes.
					void api.lockVault();
				}}
			/>
		);
	}
}
