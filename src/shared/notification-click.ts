import type { ToastClick } from './ipc';

/**
 * Atomically elect the first delivery of one notification click.
 *
 * Push and the unlock recovery request can settle in either order. The token,
 * rather than the SteamID, is the identity here: two clicks for one account
 * remain distinct, and an older delayed delivery cannot roll back a newer one.
 */
export interface ConfirmationClickClaims {
	/** Newest intention delivered by either IPC path, even if navigation had to wait. */
	newestObserved: number | undefined;
	/** Newest intention whose navigation or accepted in-place refresh settled. */
	handled: number | undefined;
	/** Newest handled intention whose exact acknowledgement settled successfully. */
	acknowledged?: number | undefined;
}

export function claimConfirmationClick(
	claims: ConfirmationClickClaims,
	token: number,
	navigate: () => boolean
): boolean {
	/*
	 * Observing and handling are deliberately separate. The push can arrive before
	 * the refreshed account list and fail to navigate; its slow-path twin must be
	 * allowed to retry later. But once token 2 has been observed, a delayed token 1
	 * is an obsolete intention even when 2 has not navigated yet.
	 */
	if (claims.newestObserved !== undefined && token < claims.newestObserved) {
		return false;
	}
	if (claims.newestObserved === undefined || token > claims.newestObserved) {
		claims.newestObserved = token;
	}
	if ((claims.handled !== undefined && token <= claims.handled) || !navigate()) {
		return false;
	}
	claims.handled = token;
	return true;
}

/** Retry an acknowledgement without repeating navigation in the same document. */
export function shouldAcknowledgeConfirmationClick(
	claims: ConfirmationClickClaims,
	token: number
): boolean {
	return (
		claims.handled === token &&
		claims.newestObserved === token &&
		(claims.acknowledged === undefined || token > claims.acknowledged)
	);
}

/** Record only successful acknowledgement settlement; failures remain retryable. */
export function markConfirmationClickAcknowledged(
	claims: ConfirmationClickClaims,
	token: number
): void {
	if (claims.acknowledged === undefined || token > claims.acknowledged) {
		claims.acknowledged = token;
	}
}

const ACK_RETRY_DELAYS_MS = [100, 500, 1500] as const;

/**
 * A local IPC acknowledgement is idempotent and exact-token matched. Retry it
 * without re-running navigation; stop if a newer click supersedes this token.
 */
export async function retryConfirmationClickAcknowledgement(
	claims: ConfirmationClickClaims,
	token: number,
	acknowledge: () => Promise<unknown>,
	wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<boolean> {
	for (let attempt = 0; attempt <= ACK_RETRY_DELAYS_MS.length; attempt += 1) {
		if (!shouldAcknowledgeConfirmationClick(claims, token)) return false;
		if (attempt !== 0) {
			const delay = ACK_RETRY_DELAYS_MS[attempt - 1];
			if (delay === undefined) return false;
			await wait(delay);
			if (!shouldAcknowledgeConfirmationClick(claims, token)) return false;
		}
		try {
			await acknowledge();
			markConfirmationClickAcknowledged(claims, token);
			return true;
		} catch {
			// The next bounded attempt acknowledges only this exact token.
		}
	}
	return false;
}

/**
 * A toast may replace only the idle account list.
 *
 * Child screens own their busy state and deliberately disable Back while an
 * operation cannot be recalled. Parent-level navigation must not bypass those
 * locks. The click remains in main and is retried when this readiness changes.
 */
export function notificationMayTakeOver(screen: {
	view: string;
	overlayOpen: boolean;
	signInOpen: boolean;
	accountListBusy?: boolean;
}): boolean {
	const replaceableView =
		screen.view === 'accounts' || screen.view === 'activity' || screen.view === 'about';
	return replaceableView && !screen.overlayOpen && !screen.signInOpen && !screen.accountListBusy;
}

/** A distinct click for the account already shown must refresh, not re-navigate. */
export function notificationRefreshesOpenAccount(
	openSteamId64: string | undefined,
	click: { steamId64: string; token: number },
	alreadyHandled: number | undefined
): boolean {
	return openSteamId64 === click.steamId64 && alreadyHandled !== click.token;
}

/**
 * A same-screen refresh accepts its click only when it can start now.
 *
 * Merely observing a token is not enough: an approve, deny, sign-in, or list
 * already in flight owns the screen until it settles. Keeping this predicate
 * beside the click-claim rules makes that distinction directly testable.
 */
export function notificationRefreshMayStart(
	token: number | undefined,
	attemptedToken: number | undefined,
	busy: boolean,
	listsInFlight: number
): boolean {
	return token !== undefined && attemptedToken !== token && !busy && listsInFlight === 0;
}

/**
 * Run one refresh which has already accepted ownership of an exact click.
 *
 * Success and a failure rendered by `showFailure` are both settled outcomes:
 * either way the user has received the click's result on the screen already
 * open for it. The caller keeps Back disabled until this promise settles.
 */
export async function runAcceptedNotificationRefresh(
	token: number,
	load: () => Promise<void>,
	showFailure: (cause: unknown) => void,
	settle: (token: number) => void
): Promise<void> {
	try {
		await load();
	} catch (cause) {
		showFailure(cause);
	} finally {
		settle(token);
	}
}

export interface ConfirmationRefreshSettlement {
	click: ToastClick;
	acknowledge: boolean;
}

/**
 * Settle only the refresh click which is still current.
 *
 * A slower request for token N may finish after token N+1 was delivered. It
 * must neither clear nor acknowledge N+1, and it must not move the claim's
 * handled marker backwards.
 */
export function settleConfirmationRefreshClick(
	claims: ConfirmationClickClaims,
	current: ToastClick | undefined,
	token: number
): ConfirmationRefreshSettlement | undefined {
	if (current === undefined || current.token !== token) {
		return undefined;
	}
	const handled = claimConfirmationClick(claims, token, () => true);
	return {
		click: current,
		acknowledge: handled || shouldAcknowledgeConfirmationClick(claims, token)
	};
}
