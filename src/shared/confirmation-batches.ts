import { CONFIRMATION_ACTION_BATCH_LIMIT } from './ipc';

function actionErrorMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
}

/** Send an arbitrarily large visible selection through the bounded IPC contract. */
export async function actOnConfirmationBatches(
	onAct: (action: 'allow' | 'cancel', ids: string[]) => Promise<unknown>,
	action: 'allow' | 'cancel',
	ids: readonly string[]
): Promise<void> {
	let completed = 0;
	for (let offset = 0; offset < ids.length; offset += CONFIRMATION_ACTION_BATCH_LIMIT) {
		const batch = ids.slice(offset, offset + CONFIRMATION_ACTION_BATCH_LIMIT);
		try {
			await onAct(action, batch);
			completed += batch.length;
		} catch (err) {
			const later = ids.length - completed - batch.length;
			const prefix =
				completed === 0
					? ''
					: `${completed} confirmation${completed === 1 ? '' : 's'} were processed before this batch. `;
			const suffix =
				later === 0
					? ''
					: `${later} later confirmation${later === 1 ? '' : 's'} were not attempted. `;
			throw new Error(
				`${prefix}The result for ${batch.length} confirmation${batch.length === 1 ? '' : 's'} in the failed batch could not be confirmed. ${suffix}${actionErrorMessage(err)}`,
				{ cause: err }
			);
		}
	}
}
