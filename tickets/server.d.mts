/**
 * The ticket service's public surface.
 *
 * `server.mjs` is plain JavaScript on purpose — it runs on the box straight from
 * the repository, with no build step between what is reviewed and what executes.
 * This file gives the rest of the project types for it anyway, so the tests are
 * checked rather than waved through as `any`.
 *
 * Only what is exported is described here. Everything else in that module —
 * sessions, the bootstrap token, the database handle's internals — is private
 * and should stay that way.
 */

/** A submitted report, after validation has cleaned it up. */
export interface TicketInput {
	kind: string;
	summary: string;
	detail: string;
	contact: string | null;
}

/**
 * Check a submitted form.
 *
 * Returns every problem at once rather than the first, so somebody does not
 * discover a second fault only after fixing the first. An empty `errors` means
 * the value is safe to store.
 */
export function validate(form: Record<string, string>): {
	errors: string[];
	value: TicketInput;
};

/** Whether a POST claims to have come from this site. */
export function originOk(request: { headers: Record<string, string | undefined> }): boolean;

/** A reference a person can read aloud without ambiguity. */
export function makeReference(): string;

/** Record a hit and say whether this key has exceeded `max` within the window. */
export function tooMany(key: string, max: number, windowMs: number): boolean;

/** Constant-time comparison that tolerates a length mismatch. */
export function sameSecret(a: Buffer, b: Buffer): boolean;

/** scrypt, with the parameters the stored verifiers were made with. */
export function derive(passphrase: string, salt: Buffer): Buffer;

/** Regenerate the one-time bootstrap token, or clear it once an admin exists. */
export function refreshBootstrap(): void;
/** Mint an access key for every legacy row that has none. Returns how many. */
export function backfillAccessKeys(): number;

/** What a buffer's leading bytes say it is, or undefined if it is not accepted. */
export function sniff(buffer: Buffer): { type: string; kind: 'image' | 'video' } | undefined;

/**
 * Whether a buffer carries every byte signature one media entry declares.
 *
 * Exported for the tests: the offset-combining logic is invisible through
 * `sniff` because no shipping format exercises the case that once broke.
 */
export function signatureMatches(
	buffer: Buffer,
	entry: { magic?: number[]; at4?: number[]; at8?: number[]; [key: string]: unknown }
): boolean;

/**
 * Claim a received upload, or explain why it was refused.
 *
 * Takes a file already on disk rather than a body in memory: an upload streams
 * to a temporary file as it arrives, and only its first bytes — enough for
 * `sniff` and no more — are ever held. Eight concurrent twenty-megabyte uploads
 * are permitted, and holding all of them used to be three hundred megabytes
 * against a 256M `MemoryMax`.
 *
 * Whatever is passed in, this owns: every refusal below deletes that file before
 * returning, and so does a failed claim.
 */
export function storeUpload(received: { path: string; bytes: number; head: Buffer }): {
	error?: string;
	full?: boolean;
	attachment?: { id: string; type: string; kind: string; bytes: number };
};

/** The path on disk for an attachment id. Throws on anything we did not generate. */
export function fileFor(id: string): string;

/**
 * Attach uploaded files to a report, or to one message on it.
 *
 * Returns how many were actually claimed, which is not always how many were
 * offered: ids that are unrecognised, already attached to something else, or
 * older than the unclaimed lifetime are skipped, and the list is capped at the
 * per-submission limit regardless of what it is handed.
 */
export function claimAttachments(
	ticketId: number,
	noteId: number | null,
	raw: string | undefined
): number;

/** How many keys the rate limiter is tracking, and how many sweeps it has run. */
export function attemptStats(): { size: number; sweeps: number };

/** The statuses a report can be in. */
export const STATUSES: string[];

/** Public routes. Resolves undefined when the path is not one of them. */
export function handle(request: unknown, response: unknown, url: URL): Promise<unknown>;

/** Admin routes. Resolves undefined when the path is not one of them. */
export function handleAdmin(request: unknown, response: unknown, url: URL): Promise<unknown>;

/** The sign-in page, optionally carrying a message. */
export function loginPage(message?: string): string;

/** Wrap a body in the site's layout. */
export function page(options: { title: string; body: string; noindex?: boolean }): string;

/** The HTTP server. Not listening when TICKETS_NO_LISTEN is set. */
export const server: import('node:http').Server;

/** The open SQLite handle. */
export const db: import('node:sqlite').DatabaseSync;
