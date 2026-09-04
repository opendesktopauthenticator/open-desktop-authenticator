import { recoveryPathForAuthenticator } from '../src/main/vault/recovery';
import type { Account } from '../src/shared/vault-schema';

/** A valid application-owned path returned by a successful in-memory writer fake. */
export function successfulRecoveryPath(account: Account): string {
	return recoveryPathForAuthenticator('recovery-test-root', account);
}
