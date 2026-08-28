import { contextBridge, ipcRenderer } from 'electron';
// Values come from the zod-free module; types are erased at compile time.
// Importing CHANNELS from '../shared/ipc' would emit require("zod") into this
// bundle, which a sandboxed preload cannot resolve — see shared/channels.ts.
import { CHANNELS } from '../shared/channels';
import type {
	AccountSummary,
	ActivityList,
	AppInfo,
	CodesList,
	ConfirmationsList,
	ImportOutcome,
	ImportReport,
	ImportSelection,
	OpenBrowserResult,
	RendererApi,
	EnrollBegin,
	ExportResult,
	AdoptResult,
	RecoverResult,
	SignInResult,
	UpdateCheckResult,
	VaultSettingsView,
	VaultStatus,
	TransferAuthenticated,
	TransferStartChallenge,
	TransferComplete,
	TransferStatus
} from '../shared/ipc';

/**
 * The preload bridge (§11 S6).
 *
 * This file is the entire attack surface between the renderer and the main
 * process, so it is deliberately tiny and deliberately boring.
 *
 * What it must never do:
 *  - expose `ipcRenderer` itself, or any function taking a channel name from the
 *    caller. That is a generic "invoke anything" bridge wearing a disguise.
 *  - expose anything from `node:` — the renderer has no Node access and must not
 *    gain one through here.
 *  - import anything that pulls in an npm dependency. This bundle runs sandboxed
 *    and can only require `electron`; anything else throws and silently takes
 *    the whole bridge down with it.
 *  - pass through arguments unexamined. Each function below names its channel as
 *    a literal from the contract.
 *
 * Every exposed function corresponds to exactly one channel declared in
 * `shared/ipc.ts`, which the main process validates on receipt.
 */

/**
 * Every function names its channel as a literal from the contract, and takes
 * only the arguments that channel declares. None of them accept a channel name
 * from the caller — that would be a generic invoke bridge in disguise.
 */
const api: RendererApi = {
	getAppInfo: () => ipcRenderer.invoke(CHANNELS.appInfo, {}) as Promise<AppInfo>,

	getVaultStatus: () => ipcRenderer.invoke(CHANNELS.vaultStatus, {}) as Promise<VaultStatus>,
	createVault: (passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.vaultCreate, { passphrase }) as Promise<{ ok: true }>,
	unlockVault: (passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.vaultUnlock, { passphrase }) as Promise<{ ok: true }>,
	restoreVaultBackup: (passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.vaultRestoreBackup, { passphrase }) as Promise<{ ok: true }>,
	adoptVaultFile: () => ipcRenderer.invoke(CHANNELS.vaultAdopt, {}) as Promise<AdoptResult>,
	lockVault: () => ipcRenderer.invoke(CHANNELS.vaultLock, {}) as Promise<{ ok: true }>,
	touchVault: () => ipcRenderer.invoke(CHANNELS.vaultTouch, {}) as Promise<{ ok: true }>,
	changePassphrase: (current: string, next: string) =>
		ipcRenderer.invoke(CHANNELS.vaultChangePassphrase, { current, next }) as Promise<{
			ok: true;
		}>,

	listAccounts: () =>
		ipcRenderer.invoke(CHANNELS.accountsList, {}) as Promise<{ accounts: AccountSummary[] }>,
	getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet, {}) as Promise<VaultSettingsView>,
	updateSettings: (settings: VaultSettingsView) =>
		ipcRenderer.invoke(CHANNELS.settingsUpdate, settings) as Promise<{ ok: true }>,
	checkForUpdate: () => ipcRenderer.invoke(CHANNELS.updateCheck, {}) as Promise<UpdateCheckResult>,

	// Moving an authenticator that already exists on the Steam mobile app. The
	// password and the Guard code travel inbound only; what comes back names an
	// account and carries no token.
	authenticateTransfer: (
		accountName: string,
		password: string,
		steamGuardCode: string,
		proxyUrl?: string
	) =>
		ipcRenderer.invoke(CHANNELS.transferAuthenticate, {
			accountName,
			password,
			steamGuardCode,
			...(proxyUrl === undefined || proxyUrl === '' ? {} : { proxyUrl })
		}) as Promise<TransferAuthenticated>,
	startTransferChallenge: () =>
		ipcRenderer.invoke(CHANNELS.transferStartChallenge, {}) as Promise<TransferStartChallenge>,
	completeTransfer: (smsCode: string) =>
		ipcRenderer.invoke(CHANNELS.transferComplete, { smsCode }) as Promise<TransferComplete>,
	retryTransferPersist: () =>
		ipcRenderer.invoke(CHANNELS.transferRetryPersist, {}) as Promise<TransferComplete>,
	getTransferStatus: () =>
		ipcRenderer.invoke(CHANNELS.transferStatus, {}) as Promise<TransferStatus>,
	cancelTransfer: () => ipcRenderer.invoke(CHANNELS.transferCancel, {}) as Promise<object>,

	// Enrollment. The password travels inbound only, exactly as a vault
	// passphrase does, and is never held in renderer state beyond the input.
	beginEnrollment: (accountName: string, password: string, proxyUrl?: string) =>
		ipcRenderer.invoke(CHANNELS.enrollBegin, {
			accountName,
			password,
			...(proxyUrl === undefined || proxyUrl === '' ? {} : { proxyUrl })
		}) as Promise<EnrollBegin>,
	submitEnrollmentEmailCode: (code: string) =>
		ipcRenderer.invoke(CHANNELS.enrollEmailCode, { code }) as Promise<EnrollBegin>,
	cancelEnrollment: () => ipcRenderer.invoke(CHANNELS.enrollCancel, {}) as Promise<{ ok: true }>,
	activateAuthenticator: (steamId64: string, code: string) =>
		ipcRenderer.invoke(CHANNELS.enrollActivate, { steamId64, code }) as Promise<{
			state: 'activated' | 'wantMore';
		}>,

	// Takes no path and returns none: the OS dialog is the only thing that names
	// a location, and the main process is the only thing that writes one.
	exportAccount: (steamId64: string) =>
		ipcRenderer.invoke(CHANNELS.accountExport, { steamId64 }) as Promise<ExportResult>,
	recoverAccount: (passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.accountRecover, { passphrase }) as Promise<RecoverResult>,
	deactivateAuthenticator: (steamId64: string, passphrase: string, acknowledgement: string) =>
		ipcRenderer.invoke(CHANNELS.accountDeactivate, {
			steamId64,
			passphrase,
			// Forwarded, never synthesised here. The handler is what enforces it.
			acknowledgement
		}) as Promise<{ ok: true }>,

	removeAccount: (steamId64: string, passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.accountRemove, { steamId64, passphrase }) as Promise<{
			ok: true;
		}>,
	setAccountAutoConfirm: (
		steamId64: string,
		settings: {
			marketListings: boolean;
			trades: boolean;
			pollIntervalSeconds: number;
			/** Forwarded, never synthesised here. The handler is what enforces it. */
			tradesAcknowledgement?: string;
		}
	) =>
		ipcRenderer.invoke(CHANNELS.accountSetAutoConfirm, { steamId64, ...settings }) as Promise<{
			ok: true;
		}>,
	setAccountProxy: (steamId64: string, proxyUrl: string | null) =>
		ipcRenderer.invoke(CHANNELS.accountSetProxy, { steamId64, proxyUrl }) as Promise<{
			ok: true;
		}>,

	// Takes no path and returns none: the OS picker is the only thing that names
	// a file, and the main process is the only thing that reads one.
	scanMaFiles: () => ipcRenderer.invoke(CHANNELS.importScan, {}) as Promise<ImportReport>,
	unlockImport: (passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.importUnlock, { passphrase }) as Promise<ImportReport>,
	commitImport: (selections: ImportSelection[]) =>
		ipcRenderer.invoke(CHANNELS.importCommit, { selections }) as Promise<{
			outcomes: ImportOutcome[];
		}>,
	discardImport: () => ipcRenderer.invoke(CHANNELS.importDiscard, {}) as Promise<{ ok: true }>,

	listCodes: () => ipcRenderer.invoke(CHANNELS.codesList, {}) as Promise<CodesList>,
	copyCode: (steamId64: string) =>
		ipcRenderer.invoke(CHANNELS.codeCopy, { steamId64 }) as Promise<{
			code: string;
			clipboardClearsInSeconds: number;
		}>,

	listActivity: () => ipcRenderer.invoke(CHANNELS.activityList, {}) as Promise<ActivityList>,
	acknowledgeActivity: (upTo: number) =>
		ipcRenderer.invoke(CHANNELS.activityAcknowledge, { upTo }) as Promise<{
			ok: true;
			urgent: boolean;
		}>,
	listConfirmations: (steamId64: string) =>
		ipcRenderer.invoke(CHANNELS.confirmationsList, { steamId64 }) as Promise<ConfirmationsList>,
	actOnConfirmations: (steamId64: string, action: 'allow' | 'cancel', ids: string[]) =>
		ipcRenderer.invoke(CHANNELS.confirmationsAct, { steamId64, action, ids }) as Promise<{
			ok: true;
		}>,
	signInToSteam: (steamId64: string, password: string) =>
		ipcRenderer.invoke(CHANNELS.steamSignIn, { steamId64, password }) as Promise<SignInResult>,

	/**
	 * Open a signed-in, routed browser for this account.
	 *
	 * Passes only the account. The destination is the main process's decision —
	 * a URL crossing this bridge would be a way to aim a live Steam session at
	 * any page that reached the renderer.
	 */
	openAccountBrowser: (steamId64: string, useProxy: boolean) =>
		ipcRenderer.invoke(CHANNELS.accountOpenBrowser, {
			steamId64,
			useProxy
		}) as Promise<OpenBrowserResult>,

	// §11 S2 exception (a). The passphrase is required again on purpose.
	revealRevocationCode: (steamId64: string, passphrase: string) =>
		ipcRenderer.invoke(CHANNELS.revocationReveal, { steamId64, passphrase }) as Promise<{
			revocationCode: string;
		}>,
	confirmRevocationBackup: (steamId64: string) =>
		ipcRenderer.invoke(CHANNELS.revocationConfirmBackup, { steamId64 }) as Promise<{ ok: true }>
};

// contextIsolation is on, so this is the only way anything reaches the renderer.
contextBridge.exposeInMainWorld('api', api);
