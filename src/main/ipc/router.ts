import { ipcMain } from 'electron';
import type { z } from 'zod';
import { IPC_CONTRACT, type ChannelName } from '../../shared/ipc';

/**
 * The IPC boundary (§11 S6).
 *
 * Every handler is registered through here, which means every request is parsed
 * against its schema before the handler sees it. A handler therefore never
 * receives unvalidated renderer input — that guarantee is structural, not a
 * convention someone has to remember.
 *
 * Responses are validated too. That is not paranoia about our own code: it is
 * how a handler that accidentally starts returning a secret gets caught by a
 * schema that never allowed one (§11 S2).
 */

type Contract = typeof IPC_CONTRACT;
type RequestOf<C extends ChannelName> = z.infer<Contract[C]['request']>;
type ResponseOf<C extends ChannelName> = z.infer<Contract[C]['response']>;

const registered = new Set<ChannelName>();

/**
 * Decides whether an IPC message's origin is one we trust.
 *
 * Defaults to refusing everything. A handler that answers before the trusted
 * sender is configured would be answering an unknown caller, and failing closed
 * is the only safe default for that ordering mistake.
 */
let isTrustedSender: (frameUrl: string) => boolean = () => false;

/**
 * Install the sender check. Call once at startup, before handlers are registered.
 *
 * Validating the sender matters because `ipcMain.handle` answers **any**
 * WebContents in the process, not just our window. Anything that ever gets its
 * own renderer — a dependency, a stray view — could otherwise call every channel
 * we expose.
 */
export function setTrustedSender(predicate: (frameUrl: string) => boolean): void {
	isTrustedSender = predicate;
}

export function registerHandler<C extends ChannelName>(
	channel: C,
	handler: (request: RequestOf<C>) => ResponseOf<C> | Promise<ResponseOf<C>>
): void {
	if (registered.has(channel)) {
		throw new Error(`IPC channel ${channel} is already registered`);
	}
	registered.add(channel);

	const contract = IPC_CONTRACT[channel];

	ipcMain.handle(channel, async (event, rawRequest: unknown) => {
		// Who is asking, before what they are asking. `senderFrame` is null when the
		// frame has already gone away, which is not a caller we should answer.
		const senderUrl = event.senderFrame?.url;
		if (!senderUrl || !isTrustedSender(senderUrl)) {
			throw new Error(`request on ${channel} rejected: untrusted sender`);
		}

		const parsedRequest = contract.request.safeParse(rawRequest ?? {});
		if (!parsedRequest.success) {
			// Deliberately terse: the renderer gets no schema detail to probe with,
			// and nothing from the payload is echoed back (§11 S4).
			throw new Error(`invalid request on ${channel}`);
		}

		const result = await handler(parsedRequest.data as RequestOf<C>);

		const parsedResponse = contract.response.safeParse(result);
		if (!parsedResponse.success) {
			// A handler returning something the contract does not allow is a bug in
			// us, and potentially a secret leak. Fail rather than forward it.
			throw new Error(`handler for ${channel} produced a response violating its schema`);
		}

		return parsedResponse.data;
	});
}

/** Channels currently registered. Used by the posture tests. */
export function registeredChannels(): ReadonlySet<ChannelName> {
	return registered;
}

/** Test-only. Handlers are registered once per process at runtime. */
export function __resetRouterForTests(): void {
	for (const channel of registered) {
		ipcMain.removeHandler(channel);
	}
	registered.clear();
	isTrustedSender = () => false;
}
