import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	AccountSummary,
	BrowserRoute,
	CodesList,
	OpenBrowserResult,
	RendererApi,
	UpdateCheckResult,
	VaultStatus
} from '../shared/ipc';
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
import { SteamSignIn } from './screens/SteamSignIn';
import { UnlockVault } from './screens/UnlockVault';
import { VaultHome } from './screens/VaultHome';

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

/** The account and route a sign-in screen is asking about. */
export interface BrowserSignInPrompt {
	account: AccountSummary;
	route: BrowserRoute;
	reason?: string;
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
	view: string
): prompt is BrowserSignInPrompt {
	return prompt !== undefined && view === 'accounts';
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
	const [view, setView] = useState<
		'accounts' | 'import' | 'settings' | 'activity' | 'enroll' | 'move' | 'recover' | 'about'
	>('accounts');
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
	useEffect(() => {
		abandonPendingSignIns();
	}, [view]);

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
	const openConfirmationsFor = useCallback(
		(steamId64: string): boolean => {
			const account = confirmationsTargetFor(accounts, steamId64);
			if (!account) {
				return false;
			}
			setAutoConfirmFor(undefined);
			setRemovingFor(undefined);
			setRoutingFor(undefined);
			setBackupFor(undefined);
			setView('accounts');
			setConfirmingFor(account);
			return true;
		},
		[accounts]
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
		return api.onOpenConfirmations((steamId64) => {
			/*
			 * **A navigation that worked consumes the remembered copy.**
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
			 * **The boolean is load-bearing.** `openConfirmationsFor` returns false
			 * when the id is not in the account list yet, and that is exactly the
			 * case the slow path exists for — a click landing after unlock but
			 * before `listAccounts` has answered. Clearing there would delete the
			 * intent rather than double-use it.
			 */
			if (openConfirmationsRef.current(steamId64)) {
				void api.takePendingConfirmations({ acknowledged: steamId64 }).catch(() => undefined);
			}
		});
	}, [api]);

	/**
	 * The slow path, and the one that makes a lock survivable.
	 *
	 * A lock **reloads** this window, so a click that arrived while the vault was
	 * locked — or in the instant before the reload landed — reached a document
	 * that no longer exists. Main kept the intent; this collects it once there is
	 * an account list to navigate within, and collecting clears it.
	 *
	 * Gated on the list being non-empty rather than only on `unlocked`, because
	 * navigating needs an account to navigate *to*: asking a beat too early would
	 * take the intent, fail the lookup, and throw it away.
	 */
	useEffect(() => {
		if (!api || !status?.unlocked || accounts.length === 0) {
			return;
		}
		let cancelled = false;
		api
			.takePendingConfirmations()
			.then((pending) => {
				const target = pending.steamId64;
				if (cancelled || target === undefined) {
					return;
				}
				/*
				 * **Cleared only once the navigation actually happened.**
				 *
				 * Reading used to clear it in main, and this threw away the boolean
				 * saying whether it had worked. `openConfirmationsFor` returns false
				 * when the account is not in the list yet — the exact case this path
				 * exists for — so a security notification opened the application, went
				 * nowhere, and left nothing behind to try again with.
				 */
				if (openConfirmationsRef.current(target)) {
					void api.takePendingConfirmations({ acknowledged: target }).catch(() => undefined);
				}
			})
			.catch(() => {
				// A click that cannot be collected is not worth an error path; the
				// account list is on screen and the confirmations are one click away.
			});
		return () => {
			cancelled = true;
		};
		/*
		 * **`accounts.length`, and not `openConfirmationsFor`.**
		 *
		 * That callback closes over `accounts`, which `listAccounts` replaces with
		 * a fresh array every second — so this effect tore down and re-ran once a
		 * second for the life of an unlocked session, asking main for a pending
		 * click each time.
		 *
		 * The churn lost clicks. `takePendingConfirmations` is read-and-clear, so
		 * a call whose round trip straddled a poll tick had already emptied the
		 * slot in main when its cleanup set `cancelled` — and the result was then
		 * dropped here, with nothing anywhere reporting it. The click was gone.
		 *
		 * A count is a number: it changes when the account list actually changes,
		 * which is the only thing this effect is waiting for.
		 */
	}, [api, status?.unlocked, accounts.length]);

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
		void api
			.getTransferStatus()
			.then((transfer) => {
				if (!cancelled && transfer.awaiting) {
					setView('move');
				}
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

	if (fatal || !api) {
		return (
			<main className="shell">
				<h1>Something is wrong</h1>
				<p className="error">{fatal}</p>
			</main>
		);
	}

	return (
		<>
			{/* Over the live UI, not instead of it. The next successful tick clears it. */}
			{pollError && (
				<p className="banner error" role="status">
					{pollError}
				</p>
			)}
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
					onAdopt={async () => {
						const result = await api.adoptVaultFile();
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
					onClose={() => {
						setRemovingFor(undefined);
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
					onClose={() => setConfirmingFor(undefined)}
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
						setView('accounts');
						setConfirmingFor(openFor);
					}}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'about') {
			return <About onLoad={() => api.getAppInfo()} onClose={() => setView('accounts')} />;
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
					onClose={() => setView('accounts')}
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
					onRetryPersist={() => api.retryTransferPersist()}
					onStatus={() => api.getTransferStatus()}
					onCancel={() => api.cancelTransfer()}
					// The same channel the standalone back-up ceremony uses. It is
					// accepted here because the transfer handler recorded the reveal
					// when it handed this screen the code — the confirm still refuses
					// for an account whose code nobody has seen.
					onAcknowledgeBackup={(steamId64) => api.confirmRevocationBackup(steamId64)}
					onClose={() => setView('accounts')}
				/>
			);
		}

		if (view === 'enroll') {
			return (
				<AddAuthenticator
					requireProxies={status.requireProxies}
					onMove={() => setView('move')}
					{...(resumeEnrollment
						? {
								resume: {
									steamId64: resumeEnrollment.steamId64,
									accountName: resumeEnrollment.accountName
								}
							}
						: {})}
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
						setView('accounts');
						setBackupFor({ steamId64, accountName });
					}}
					onClose={() => {
						setResumeEnrollment(undefined);
						setView('accounts');
					}}
				/>
			);
		}

		if (view === 'recover') {
			return (
				<RecoverAccount
					onRecover={(passphrase) => api.recoverAccount(passphrase)}
					onClose={() => {
						setView('accounts');
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
						setView('accounts');
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
		if (mayShowSignInPrompt(browserSignIn, view)) {
			return (
				<SteamSignIn
					// Holds a typed password. Same reasoning as `Confirmations`: a
					// different account must never inherit one.
					key={browserSignIn.account.steamId64}
					accountName={browserSignIn.account.accountName}
					{...(browserSignIn.reason === undefined ? {} : { reason: browserSignIn.reason })}
					onSignIn={async (password) => {
						const result = await api.signInToSteam(
							browserSignIn.account.steamId64,
							password,
							// The same route the window will use. Signing in through a proxy
							// the user chose Direct to get past is the failure this whole
							// screen exists downstream of.
							browserSignIn.route
						);
						// **Only on success**, for the reason `Confirmations` records: a
						// failure comes back rather than throwing, so advancing here would
						// clear the form as though the sign-in had worked.
						if (!result.ok) {
							return result;
						}

						// Straight into the browser the user actually pressed for, rather
						// than back to a list they would have to press again.
						const opened = await api.openAccountBrowser(
							browserSignIn.account.steamId64,
							// The retry keeps the choice the user made when they pressed.
							browserSignIn.route
						);
						if (opened.signInRequired) {
							/*
							 * A fresh sign-in that Steam still will not accept for browsing.
							 *
							 * `retryable: false` on purpose: another password cannot fix
							 * this, and a form that keeps asking for one is how a person ends
							 * up typing their Steam password over and over into a window an
							 * application drew. The form withdraws and says so.
							 */
							return {
								ok: false as const,
								retryable: false,
								reason:
									opened.reason ??
									'Steam accepted the sign-in but would not open a browsing session.'
							};
						}

						setBrowserSignIn(undefined);
						// The account now has a session, which the list shows.
						void refresh();
						return result;
					}}
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
				onBackUpRevocationCode={setBackupFor}
				onChangeRouting={setRoutingFor}
				onShowConfirmations={setConfirmingFor}
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
					if (prompt) {
						setBrowserSignIn(prompt);
					}
					return result;
				}}
				onRemoveAccount={setRemovingFor}
				onChangeAutoConfirm={setAutoConfirmFor}
				onImport={() => setView('import')}
				onRecover={() => setView('recover')}
				onEnrol={() => {
					setResumeEnrollment(undefined);
					setView('enroll');
				}}
				onMove={() => setView('move')}
				onFinishActivation={(account) => {
					setResumeEnrollment(account);
					setView('enroll');
				}}
				onExport={(account) => api.exportAccount(account.steamId64)}
				onSettings={() => setView('settings')}
				onAbout={() => setView('about')}
				onActivity={() => setView('activity')}
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
