/**
 * The issue tracker for opendesktopauthenticator.com.
 *
 * ## Why this is written out longhand
 *
 * The rest of this domain is static files. This is the only thing on it that
 * executes anything, which makes it the only thing on it that can be attacked,
 * so it is deliberately the smallest program that does the job: Node's own HTTP
 * server, SQLite through `node:sqlite`, and nothing else. No framework, no
 * middleware stack, no template engine, no dependency tree to be compromised
 * six months from now by a package nobody reads.
 *
 * Everything a framework would have given us is here in a form that can be read
 * in one sitting.
 *
 * ## What it deliberately does not do
 *
 * **No accounts for reporters.** Somebody reporting a scam site should not have
 * to create a login first; they will not, and the report is lost. A submission
 * returns a reference, and that reference is the only thing needed to see it
 * again.
 *
 * **Uploads, but only pictures of the problem.** This refused files entirely at
 * first, on the grounds that the single most likely thing anyone would attach to
 * a report about this application is a `.maFile` — the one file that must never
 * be sent anywhere. That reasoning was sound and the conclusion was still wrong:
 * a screenshot is often the whole report, and somebody who cannot attach one
 * describes a dialog from memory instead.
 *
 * So the rule became narrower rather than absolute. A file is identified by its
 * own leading bytes and must be a PNG, JPEG, GIF, WebP, MP4 or WebM; nothing
 * else is stored, the declared type is never believed, and a `.maFile` — being
 * JSON — matches none of those signatures and is refused as a matter of format
 * rather than of policy. What is stored is served back only through the report
 * that owns it, as the type it actually is, with `nosniff` and a sandboxed
 * content security policy so it can never be a way to run something here.
 *
 * **No email sending.** Notification needs SMTP credentials and a mail
 * reputation, and neither exists yet. The admin view is polled instead, which
 * is honest about the fact that this is one maintainer with a list.
 *
 * ## Trust boundary
 *
 * Runs as an unprivileged user, listening only on loopback. nginx is the only
 * thing that can reach it, and the systemd unit takes away the filesystem, the
 * network namespace and most syscalls. Nothing here should be able to matter
 * even if all of it is wrong.
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.TICKETS_DB ?? join(here, 'tickets.db');

/* --------------------------------------------------------------- storage -- */

const db = new DatabaseSync(DB_PATH);
// WAL so a read never blocks a write; both are on one small file on one box.
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);
db.exec(`
	CREATE TABLE IF NOT EXISTS tickets (
		id          INTEGER PRIMARY KEY,
		reference   TEXT NOT NULL UNIQUE,
		kind        TEXT NOT NULL,
		summary     TEXT NOT NULL,
		detail      TEXT NOT NULL,
		contact     TEXT,
		status      TEXT NOT NULL DEFAULT 'open',
		created_at  TEXT NOT NULL,
		updated_at  TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, id DESC);
	CREATE TABLE IF NOT EXISTS notes (
		id         INTEGER PRIMARY KEY,
		ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
		body       TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS admins (
		id       INTEGER PRIMARY KEY,
		salt     BLOB NOT NULL,
		verifier BLOB NOT NULL
	);
	/*
	 * An uploaded screenshot or clip.
	 *
	 * ticket_id is null between the upload and the submission that claims it,
	 * which is the window a person spends still typing. Anything left unclaimed is
	 * swept, so an upload endpoint cannot be used as free anonymous storage.
	 *
	 * The id is the filename on disk. Nothing the uploader sends is ever used to
	 * build a path - not the filename, not the declared type, nothing.
	 */
	CREATE TABLE IF NOT EXISTS attachments (
		id         TEXT PRIMARY KEY,
		ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
		note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
		media_type TEXT NOT NULL,
		bytes      INTEGER NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS attachments_ticket ON attachments(ticket_id);
`);

/**
 * Add a column that older databases do not have yet.
 *
 * The box runs whatever is in the repository, so a deploy can meet a database
 * made by the previous version. `ADD COLUMN` is not idempotent, hence the check.
 */
function addColumn(table, column, definition) {
	const existing = db.prepare(`PRAGMA table_info(${table})`).all();
	if (!existing.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

// Who wrote a message. Everything that existed before this column was from us.
addColumn('notes', 'author', `TEXT NOT NULL DEFAULT 'us'`);

const now = () => new Date().toISOString();

/* ----------------------------------------------------------- attachments -- */

/**
 * What may be uploaded, decided by looking at the bytes.
 *
 * **The declared content type is not consulted for anything.** It is a string
 * chosen by whoever is uploading, so it can say `image/png` over a payload that
 * is not one. The type recorded and later served is the one these signatures
 * identify, which means a file can only ever be served back as what it actually
 * is.
 *
 * SVG is deliberately absent. It is an image everywhere else in a product and a
 * script host here: an `<svg>` can carry `<script>` and event handlers, and
 * serving one from this origin would hand an attacker exactly the execution the
 * rest of this service is built to deny. GIF, PNG, JPEG, WebP, MP4 and WebM
 * have no such interpretation.
 */
const MEDIA = [
	{ type: 'image/png', kind: 'image', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ type: 'image/jpeg', kind: 'image', magic: [0xff, 0xd8, 0xff] },
	{ type: 'image/gif', kind: 'image', magic: [0x47, 0x49, 0x46, 0x38] },
	// RIFF....WEBP — the four size bytes in between are skipped.
	{ type: 'image/webp', kind: 'image', magic: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
	// An ISO base media file: the box type at offset 4 is 'ftyp'.
	{ type: 'video/mp4', kind: 'video', at4: [0x66, 0x74, 0x79, 0x70] },
	{ type: 'video/webm', kind: 'video', magic: [0x1a, 0x45, 0xdf, 0xa3] }
];

const SIZE = { image: 6 * 1024 * 1024, video: 20 * 1024 * 1024 };
const MAX_FILES = 4;
/** Long enough to finish writing a report, short enough not to be storage. */
const UNCLAIMED_LIFETIME_MS = 2 * 60 * 60 * 1000;

const startsWith = (buffer, bytes, offset = 0) =>
	bytes.every((b, i) => buffer[offset + i] === b);

/** The media type these bytes actually are, or undefined. */
function sniff(buffer) {
	if (buffer.length < 16) {
		return undefined;
	}
	for (const entry of MEDIA) {
		if (entry.magic && !startsWith(buffer, entry.magic)) continue;
		if (entry.at4 && !startsWith(buffer, entry.at4, 4)) continue;
		if (entry.at8 && !startsWith(buffer, entry.at8, 8)) continue;
		if (entry.magic || entry.at4) return entry;
	}
	return undefined;
}

const FILES_DIR = process.env.TICKETS_FILES ?? join(dirname(DB_PATH), 'attachments');

/** Ids are ours and hex, so a path can never be built out of a request. */
const isAttachmentId = (value) => /^[0-9a-f]{32}$/.test(String(value));

const fileFor = (id) => {
	if (!isAttachmentId(id)) {
		throw new Error('refusing to build a path from an untrusted id');
	}
	return join(FILES_DIR, id);
};

/** Drop uploads nobody ever attached to a report, from disk and from the table. */
function sweepUnclaimed() {
	const cutoff = new Date(Date.now() - UNCLAIMED_LIFETIME_MS).toISOString();
	const stale = db
		.prepare('SELECT id FROM attachments WHERE ticket_id IS NULL AND created_at < ?')
		.all(cutoff);
	for (const row of stale) {
		try {
			rmSync(fileFor(row.id), { force: true });
		} catch {
			// A file already gone is the state we wanted; the row still goes.
		}
	}
	if (stale.length) {
		db.prepare('DELETE FROM attachments WHERE ticket_id IS NULL AND created_at < ?').run(cutoff);
	}
}

/**
 * Read a request body of unknown length, refusing early rather than late.
 *
 * The cap is enforced as chunks arrive, so an oversized upload is dropped after
 * one chunk over the line instead of after the sender has finished sending it.
 */
function readBody(request, limit) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

/** Store an uploaded body, or say why not. Returns { error } or { attachment }. */
function storeUpload(buffer) {
	const media = sniff(buffer);
	if (!media) {
		return {
			error: 'That file is not a kind we accept. Screenshots as PNG, JPEG, GIF or WebP; video as MP4 or WebM.'
		};
	}
	if (buffer.length > SIZE[media.kind]) {
		return {
			error: `That ${media.kind} is over the ${SIZE[media.kind] / (1024 * 1024)} MB limit for ${media.kind}s.`
		};
	}
	const id = randomBytes(16).toString('hex');
	mkdirSync(FILES_DIR, { recursive: true });
	// 0o600: readable by the service account and nothing else. These are other
	// people's screenshots and some of them will contain more than intended.
	writeFileSync(fileFor(id), buffer, { mode: 0o600 });
	db.prepare(
		'INSERT INTO attachments (id, ticket_id, media_type, bytes, created_at) VALUES (?, NULL, ?, ?, ?)'
	).run(id, media.type, buffer.length, now());
	return { attachment: { id, type: media.type, kind: media.kind, bytes: buffer.length } };
}

/**
 * Attach uploads to the report that referenced them.
 *
 * Only unclaimed, recent rows can be claimed, so an id that has been seen on
 * someone else's report cannot be pinned to a second one.
 */
function claimAttachments(ticketId, noteId, raw) {
	const ids = String(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(isAttachmentId)
		.slice(0, MAX_FILES);
	const cutoff = new Date(Date.now() - UNCLAIMED_LIFETIME_MS).toISOString();
	const claim = db.prepare(
		'UPDATE attachments SET ticket_id = ?, note_id = ? WHERE id = ? AND ticket_id IS NULL AND created_at >= ?'
	);
	let claimed = 0;
	for (const id of ids) {
		claimed += claim.run(ticketId, noteId, id, cutoff).changes;
	}
	return claimed;
}

/* ------------------------------------------------------------ validation -- */

/**
 * Every field, checked against a fixed shape before it is stored.
 *
 * Bounds are as tight as the field can stand. A summary does not need 10,000
 * characters, and a limit that generous is a limit that exists to be filled by
 * something automated.
 */
const KINDS = new Set(['bug', 'documentation', 'clone-site', 'security', 'other']);
const LIMITS = { summary: [8, 140], detail: [20, 4000], contact: [0, 120] };

function validate(form) {
	const errors = [];
	const kind = String(form.kind ?? '');
	if (!KINDS.has(kind)) {
		errors.push('Choose what kind of report this is.');
	}
	const field = (name) =>
		String(form[name] ?? '')
			.trim()
			.replace(/\r\n/g, '\n');
	const summary = field('summary');
	const detail = field('detail');
	const contact = field('contact');

	for (const [name, value] of [
		['summary', summary],
		['detail', detail],
		['contact', contact]
	]) {
		const [min, max] = LIMITS[name];
		if (value.length < min) errors.push(`The ${name} needs at least ${min} characters.`);
		if (value.length > max) errors.push(`The ${name} must be under ${max} characters.`);
	}

	errors.push(...secretsIn(`${summary}\n${detail}`));

	return { errors, value: { kind, summary, detail, contact: contact || null } };
}

/**
 * Refuse anything that looks like a Steam secret.
 *
 * The form says not to paste one; people will anyway, in a panic, because they
 * think it will help. Storing it would make this database worth attacking, and
 * we would have collected the exact thing the whole product exists to keep
 * people from handing over. So it is rejected at the door and never written.
 *
 * Shared with the reply route rather than living inside `validate`: somebody who
 * has just been asked a follow-up question is the single most likely person to
 * paste a secret in answer to it, and a check that only guarded the first
 * message would have missed exactly that.
 */
const SECRETS = [
	[/"?shared_secret"?\s*[:=]/i, 'a shared_secret'],
	[/"?identity_secret"?\s*[:=]/i, 'an identity_secret'],
	[/"?revocation_code"?\s*[:=]|\bR\d{5}\b/i, 'a revocation code'],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
	[/"?steamid"?\s*[:=]\s*"?7656119\d{10}/i, 'a maFile']
];

function secretsIn(text) {
	for (const [pattern, what] of SECRETS) {
		if (pattern.test(text)) {
			return [
				`That looks like it contains ${what}. Nothing here needs one — describe it instead. The report has not been saved.`
			];
		}
	}
	return [];
}

/* ----------------------------------------------------------------- admin -- */

/**
 * One administrator, one passphrase, stored as a scrypt verifier.
 *
 * There is no sign-up and no password reset. The passphrase is set once through
 * a bootstrap token printed to the journal, so it is never transmitted to
 * anybody, never handled in plaintext by anything but the browser posting it,
 * and never recoverable if lost — which for a single-maintainer tool is the
 * correct trade.
 */
// 128 * N * r is exactly 32 MiB at these parameters, which is also Node's
// default `maxmem` — and the check rejects rather than rounds, so every call
// threw and neither the bootstrap nor the sign-in could ever have completed.
// The ceiling is raised rather than the cost lowered: the work factor is the
// only thing standing between a stolen database and the passphrase.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const derive = (passphrase, salt) =>
	scryptSync(passphrase, salt, SCRYPT.keylen, {
		N: SCRYPT.N,
		r: SCRYPT.r,
		p: SCRYPT.p,
		maxmem: SCRYPT.maxmem
	});

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
function sameSecret(a, b) {
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

const sessions = new Map();
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

function newSession() {
	// Swept here rather than on a timer: `readSession` only drops a session when
	// that exact one is presented again, so a session signed in and never
	// returned to would sit in the map until the process restarted.
	const now = Date.now();
	for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id);

	const id = randomBytes(32).toString('base64url');
	sessions.set(id, {
		expires: Date.now() + SESSION_LIFETIME_MS,
		csrf: randomBytes(32).toString('base64url')
	});
	return id;
}

function readSession(request) {
	const cookie = /(?:^|;\s*)admin=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
	if (!cookie) {
		return undefined;
	}
	const session = sessions.get(cookie);
	if (!session) {
		return undefined;
	}
	if (session.expires < Date.now()) {
		sessions.delete(cookie);
		return undefined;
	}
	return { id: cookie, ...session };
}

/**
 * A one-time bootstrap token, regenerated whenever no administrator exists.
 *
 * Printed to the journal and nowhere else, so setting the passphrase requires
 * access to the server that is already running the thing. It stops existing the
 * moment an administrator is created.
 */
let bootstrapToken;
function refreshBootstrap() {
	const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
	if (count > 0) {
		bootstrapToken = undefined;
		return;
	}
	bootstrapToken = randomBytes(24).toString('base64url');
	// Printed as a bare value, deliberately not as a clickable URL: a link invites
	// pasting the secret into an address bar, and everything downstream of an
	// address bar — the access log, browser history, autocomplete — keeps it.
	process.stdout.write(
		`no administrator configured — open /admin/bootstrap and paste this setup token: ${bootstrapToken}\n`
	);
}

export { db, validate, sameSecret, derive, refreshBootstrap };

/* -------------------------------------------------------------- rendering -- */

const escape = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);

/**
 * The site's own stylesheet, by its hashed name.
 *
 * Read from the deployed pages rather than hardcoded, because the name changes
 * with the content and a stale reference would leave these pages unstyled while
 * still returning 200 — a failure nothing would notice.
 */
/*
 * Where the built site lives.
 *
 * Configurable rather than hardcoded because the previous hardcoded path meant
 * these pages could only ever be styled on the box itself — run them anywhere
 * else, including a local check before a deploy, and every one of them rendered
 * as unstyled markup while still returning 200.
 */
const PUBLIC_DIR = process.env.TICKETS_PUBLIC ?? '/var/www/oda/public';

function styleHref() {
	try {
		const home = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
		return /<link rel="stylesheet" href="([^"]+)"/.exec(home)?.[1] ?? '/assets/site.css';
	} catch {
		return '/assets/site.css';
	}
}

/**
 * The attachment script, by its hashed name, read out of the built support page.
 *
 * Same reasoning as the stylesheet: the name changes with the content, and a
 * stale reference here would mean the reply form silently loses its file picker
 * while still rendering perfectly.
 */
/*
 * Attribution shown on every page this service renders.
 *
 * Kept in step with the same values in site/build.mjs by hand — two small
 * constants in two programs is a smaller price than a shared module that the
 * service would have to read off disk at request time.
 */
const SDA = {
	author: 'Jessecar96',
	repo: 'https://github.com/Jessecar96/SteamDesktopAuthenticator'
};
const BRAND = {
	name: 'MASTERPANEL',
	legal: 'MASTERPANEL LLC',
	url: 'https://masterspanel.com'
};

/** The company mark, by its hashed name, read out of the built home page. */
function brandLogoHref() {
	try {
		const home = readFileSync(join(PUBLIC_DIR, 'owners.html'), 'utf8');
		return /"(\/assets\/projects\/masterspanel\.[^"]+\.svg)"/.exec(home)?.[1] ?? '/assets/projects/masterspanel.svg';
	} catch {
		return '/assets/projects/masterspanel.svg';
	}
}

function scriptHref() {
	try {
		const support = readFileSync(join(PUBLIC_DIR, 'support.html'), 'utf8');
		return /<script src="(\/assets\/support\.[^"]+)"/.exec(support)?.[1] ?? '/assets/support.js';
	} catch {
		return '/assets/support.js';
	}
}

function page({ title, body, noindex = true }) {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escape(title)} · ODA</title>
	${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
	<link rel="icon" href="/favicon.ico" sizes="32x32">
	<link rel="stylesheet" href="${escape(styleHref())}">
	<script src="${escape(scriptHref())}" defer></script>
</head>
<body>
	<header class="masthead"><div class="wrap">
		<a class="brand" href="/"><span><b>Open Desktop</b> Authenticator</span></a>
		<nav aria-label="Main"><a href="/support">Support</a></nav>
	</div></header>
	<main id="main" class="wrap">
${body}
	</main>
	<!--
		The same footer the static pages carry.

		These pages had none at all, which meant a person following a reference
		into their own report landed somewhere that shared the site's stylesheet
		but none of its attribution — no way back, no publisher named, and no link
		to the original project. A support page is exactly where somebody is
		already unsure who they are dealing with.
	-->
	<footer class="site-foot">
		<div class="wrap">
			<div class="foot-brand">
				<p class="foot-origin">
					Looking for the original <strong>Steam Desktop Authenticator</strong> by
					${SDA.author}? It lives at
					<a href="${SDA.repo}" rel="noopener">github.com/${SDA.author}/SteamDesktopAuthenticator</a>
					— the only official source for it.
				</p>
				<a class="powered" href="${BRAND.url}" rel="noopener">
					<img src="${escape(brandLogoHref())}" alt="" width="28" height="28" loading="lazy">
					<span><span class="powered-by">Powered by</span>
					<strong>${BRAND.name}</strong></span>
				</a>
			</div>
			<nav aria-label="Footer">
				<a href="/">Home</a>
				<a href="/support">Report a problem</a>
				<a href="/security">Security</a>
				<a href="/docs">Documentation</a>
			</nav>
			<p class="fineprint">
				Published by <a href="${BRAND.url}" rel="noopener">${BRAND.legal}</a>. Not
				affiliated with, endorsed by, or connected to Valve Corporation, Steam, or
				${SDA.author}. Steam is a trademark of Valve Corporation.
			</p>
		</div>
	</footer>
</body>
</html>
`;
}

const send = (response, status, html, headers = {}) => {
	response.writeHead(status, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store',
		'referrer-policy': 'same-origin',
		'x-content-type-options': 'nosniff',
		...headers
	});
	response.end(html);
};

/* ----------------------------------------------------------------- forms -- */

/** Parse a form body, with a hard cap so a large POST cannot be a memory attack. */
function readForm(request, limit = 16 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => {
			const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
			resolve(Object.fromEntries(params));
		});
		request.on('error', reject);
	});
}

/**
 * A second rate limit, inside the application.
 *
 * nginx already limits this path, and that is the one that matters under load
 * because it rejects before any of this runs. This exists because the nginx
 * zone is one config edit away from being removed by accident, and submission
 * is the one endpoint where that would be expensive.
 */
const attempts = new Map();
function tooMany(key, max, windowMs) {
	const cutoff = Date.now() - windowMs;
	const hits = (attempts.get(key) ?? []).filter((t) => t > cutoff);
	hits.push(Date.now());
	attempts.set(key, hits);
	if (attempts.size > 5000) {
		// Bounded: an attacker rotating addresses must not grow this without limit.
		for (const [k, v] of attempts) if (v[v.length - 1] < cutoff) attempts.delete(k);
	}
	return hits.length > max;
}

const clientOf = (request) =>
	String(request.headers['x-real-ip'] ?? request.socket.remoteAddress ?? 'unknown');

/**
 * Where a POST claims to have come from.
 *
 * The public form lives on a static page, so it cannot carry a per-session
 * token — there is no session until something is submitted. For an
 * unauthenticated form that is mostly fine: there is no account to act against,
 * and the abuse case is spam, which rate limiting handles. What an Origin check
 * does add is that a form on somebody else's site cannot post here at all.
 *
 * The admin forms are served by this process and do carry a token, because
 * there the request is authenticated and CSRF is a real escalation.
 */
function originOk(request) {
	const origin = request.headers.origin ?? request.headers.referer;
	if (!origin) {
		// A form post from a browser always sends one. Absence is a script.
		return false;
	}
	try {
		return new URL(origin).host === 'opendesktopauthenticator.com';
	} catch {
		return false;
	}
}

/** A reference a person can read down a phone. No ambiguous characters. */
function makeReference() {
	const alphabet = '23456789BCDFGHJKMNPQRTVWXY';
	const pick = randomBytes(8);
	return `ODA-${[...pick]
		.slice(0, 4)
		.map((b) => alphabet[b % alphabet.length])
		.join('')}-${[...pick]
		.slice(4)
		.map((b) => alphabet[b % alphabet.length])
		.join('')}`;
}

const notice = (kind, lines) =>
	`\t\t<div class="callout ${kind}"><p>${lines.map(escape).join('</p><p>')}</p></div>`;

/* ---------------------------------------------------------------- routes -- */

const KIND_LABEL = {
	bug: 'Bug',
	documentation: 'Documentation',
	'clone-site': 'Suspected clone site',
	security: 'Security',
	other: 'Other'
};

function submitted(reference) {
	return page({
		title: 'Report received',
		body: `		<article>
			<h1>Report received</h1>
			<p class="lede">Your reference is <code>${escape(reference)}</code>. Keep it — it is
			the only way to look this up again, and there is no account to recover it from.</p>
			<p><a href="/support/ticket/${escape(reference)}">View this report</a> ·
			<a href="/support">Report something else</a></p>
		</article>`
	});
}

/**
 * What each state means, in words rather than a database token.
 *
 * "open" tells somebody nothing about whether a person has looked. The
 * distinction that matters to the person waiting is between *received* and
 * *someone is on it*, so the states carry that and the page says which.
 */
const STATUS = {
	open: { label: 'Received', says: 'Filed and waiting to be picked up.' },
	assigned: { label: 'Being looked at', says: 'A maintainer has this open and is working through it.' },
	waiting: { label: 'Waiting on you', says: 'We have asked something below and cannot go further until you answer.' },
	resolved: { label: 'Resolved', says: 'Closed as done. Reply below if it is not.' },
	declined: { label: 'Declined', says: 'Closed without a change. The reason is below.' }
};
const STATUSES = Object.keys(STATUS);

const bytesLabel = (n) =>
	n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** A day, spelled out — "12 August 2026" reads unambiguously in every country. */
const dayLabel = (iso) =>
	new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function attachmentList(reference, files) {
	if (!files.length) {
		return '';
	}
	const item = (f, i) => {
		const href = `/support/ticket/${encodeURIComponent(reference)}/file/${encodeURIComponent(f.id)}`;
		// A video gets a real player; an image gets a thumbnail that opens full size.
		const preview = f.media_type.startsWith('video/')
			? `<video controls preload="metadata" src="${escape(href)}"></video>`
			: `<a href="${escape(href)}"><img src="${escape(href)}" alt="Attachment ${i + 1} on report ${escape(reference)}" loading="lazy"></a>`;
		return `<li class="attachment">${preview}
					<span class="meta"><span>${escape(f.media_type.split('/')[1].toUpperCase())}</span><span class="bytes">${escape(bytesLabel(f.bytes))}</span></span>
				</li>`;
	};
	return `<ul class="attachments">${files.map(item).join('')}</ul>`;
}

function message(who, when, body, extra = '') {
	const mine = who === 'us';
	return `<li class="message ${mine ? 'message-us' : 'message-reporter'}">
				<div class="message-head">
					<span class="message-who">${mine ? 'Open Desktop Authenticator' : 'You'}</span>
					<time class="message-when" datetime="${escape(when)}">${escape(dayLabel(when))}</time>
				</div>
				<p>${escape(body).replace(/\n/g, '<br>')}</p>
				${extra}
			</li>`;
}

function ticketView(ticket, notes, files, options = {}) {
	const state = STATUS[ticket.status] ?? STATUS.open;
	const ofNote = (id) => files.filter((f) => f.note_id === id);
	const opening = files.filter((f) => f.note_id === null);

	const thread = [
		message('reporter', ticket.created_at, ticket.detail, attachmentList(ticket.reference, opening)),
		...notes.map((n) =>
			message(n.author, n.created_at, n.body, attachmentList(ticket.reference, ofNote(n.id)))
		)
	].join('\n');

	const closed = ticket.status === 'resolved' || ticket.status === 'declined';

	return page({
		title: `Report ${ticket.reference}`,
		body: `		<article>
			<div class="ticket-head">
				<span class="ticket-ref">${escape(ticket.reference)}</span>
				<span class="status status-${escape(ticket.status)}">${escape(state.label)}</span>
			</div>
			<h1>${escape(ticket.summary)}</h1>
			<p class="lede">${escape(state.says)}</p>
			<p class="hint">${escape(KIND_LABEL[ticket.kind] ?? ticket.kind)} · opened ${escape(dayLabel(ticket.created_at))}</p>

			<ul class="thread">
${thread}
			</ul>

			${options.notice ?? ''}

			<h2>${closed ? 'Reopen this' : 'Add something'}</h2>
			<p>${
				closed
					? 'If this was closed too early, reply and it goes back into the queue.'
					: 'Anything you forgot, or an answer to a question above.'
			}</p>
			<form class="form" method="post" action="/support/ticket/${escape(ticket.reference)}/reply">
				<div class="field">
					<label for="reply">Your message</label>
					<textarea id="reply" name="body" rows="5" maxlength="4000" minlength="4" required
					          placeholder="Add anything that would help."></textarea>
				</div>
				<div class="field" data-attach hidden>
					<label for="reply-files">Add a screenshot or a clip</label>
					<div class="dropzone" data-dropzone tabindex="0" role="button">
						<strong>Drop files here, or choose them</strong>
						<p class="hint">PNG, JPEG, GIF or WebP up to 6&nbsp;MB. MP4 or WebM up to 20&nbsp;MB.</p>
						<input id="reply-files" type="file" multiple
						       accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm">
					</div>
					<ul class="attachments" data-list></ul>
				</div>
				<div class="controls"><button type="submit">Send</button></div>
			</form>

			<p class="hint">Keep the reference ${escape(ticket.reference)} — it is the only way back to this page.</p>
		</article>`
	});
}

async function handle(request, response, url) {
	const method = request.method ?? 'GET';
	const client = clientOf(request);

	/* ---- public: submit a report ---- */
	if (url.pathname === '/support/submit' && method === 'POST') {
		if (!originOk(request)) {
			return send(
				response,
				403,
				page({
					title: 'Refused',
					body: notice('callout-warn', ['That form was not submitted from this site.'])
				})
			);
		}
		if (tooMany(`submit:${client}`, 5, 10 * 60 * 1000)) {
			return send(
				response,
				429,
				page({
					title: 'Too many',
					body: notice('callout-warn', ['Too many reports from this address. Try again shortly.'])
				})
			);
		}
		const form = await readForm(request).catch(() => undefined);
		if (!form) {
			return send(
				response,
				413,
				page({
					title: 'Too large',
					body: notice('callout-warn', ['That submission was too large.'])
				})
			);
		}
		const { errors, value } = validate(form);
		if (errors.length) {
			return send(
				response,
				400,
				page({
					title: 'Not saved',
					body: `${notice('callout-warn', errors)}\n\t\t<p><a href="/support">Back to the form</a></p>`
				})
			);
		}
		const reference = makeReference();
		const stamp = now();
		const inserted = db
			.prepare(
				`INSERT INTO tickets (reference, kind, summary, detail, contact, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(reference, value.kind, value.summary, value.detail, value.contact, stamp, stamp);
		claimAttachments(Number(inserted.lastInsertRowid), null, form.attachments);
		return send(response, 200, submitted(reference));
	}

	/* ---- public: upload one screenshot or clip ---- */
	if (url.pathname === '/support/attach' && method === 'POST') {
		// Answers here are JSON because only the page's own script calls it.
		const json = (status, payload) =>
			send(response, status, JSON.stringify(payload), { 'content-type': 'application/json' });

		if (!originOk(request)) {
			return json(403, { error: 'That upload did not come from this site.' });
		}
		// Four files per report, and a person does not file many reports. Twelve in
		// ten minutes is generous for one person and useless as a way to fill a disk.
		if (tooMany(`attach:${client}`, 12, 10 * 60 * 1000)) {
			return json(429, { error: 'Too many uploads from this address. Try again shortly.' });
		}
		sweepUnclaimed();

		// One byte over the largest thing we accept is enough to reject on.
		const body = await readBody(request, SIZE.video + 1024).catch(() => undefined);
		if (!body) {
			return json(413, { error: 'That file is larger than we accept.' });
		}
		const result = storeUpload(body);
		if (result.error) {
			return json(415, { error: result.error });
		}
		return json(200, result.attachment);
	}

	/* ---- public: a report, and everything on it ---- */
	const onTicket = /^\/support\/ticket\/(ODA-[A-Z0-9]{4}-[A-Z0-9]{4})(\/reply|\/file\/([0-9a-f]{32}))?$/.exec(
		url.pathname
	);
	if (onTicket) {
		const ticket = db.prepare('SELECT * FROM tickets WHERE reference = ?').get(onTicket[1]);
		if (!ticket) {
			return send(
				response,
				404,
				page({
					title: 'Not found',
					body: notice('callout-warn', ['No report with that reference.'])
				})
			);
		}

		/*
		 * An attachment, served only through the report it belongs to.
		 *
		 * The reference is the capability for the whole page, so a file on it is
		 * reachable on exactly the same terms — no more, and no less. Asking for a
		 * real id under the wrong reference is a 404, so ids cannot be walked.
		 */
		if (onTicket[3] && method === 'GET') {
			const file = db
				.prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ?')
				.get(onTicket[3], ticket.id);
			if (!file) {
				return send(response, 404, page({ title: 'Not found', body: notice('callout-warn', ['No such file.']) }));
			}
			let bytes;
			try {
				bytes = readFileSync(fileFor(file.id));
			} catch {
				return send(response, 404, page({ title: 'Not found', body: notice('callout-warn', ['No such file.']) }));
			}
			response.writeHead(200, {
				// The type recorded from the file's own bytes, never a string the
				// uploader chose, and `nosniff` so the browser does not go looking
				// for a second opinion.
				'content-type': file.media_type,
				'content-length': bytes.length,
				'x-content-type-options': 'nosniff',
				// Belt and braces: even if something got past the signature check,
				// this response may load nothing, run nothing and reach nowhere.
				//
				// nginx adds the site policy to this response as well, so two
				// content security policies arrive. Unlike two Referrer-Policy
				// values — where the browser picks one and the order decides which —
				// multiple policies are each enforced in full, so the effective
				// result is the intersection and therefore this stricter one. That
				// is the wanted outcome, so the upstream copy is deliberately not
				// hidden in the proxy block the way the others are.
				'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
				'content-disposition': `inline; filename="${ticket.reference}-${file.id.slice(0, 8)}.${file.media_type.split('/')[1]}"`,
				'cross-origin-resource-policy': 'same-origin',
				'referrer-policy': 'same-origin',
				// Somebody else's screenshot is not for a shared cache to hold.
				'cache-control': 'private, no-store'
			});
			return response.end(bytes);
		}

		/* ---- the reporter adds to their own report ---- */
		if (onTicket[2] === '/reply' && method === 'POST') {
			if (!originOk(request)) {
				return send(
					response,
					403,
					page({ title: 'Refused', body: notice('callout-warn', ['That form was not submitted from this site.']) })
				);
			}
			if (tooMany(`reply:${client}`, 10, 10 * 60 * 1000)) {
				return send(
					response,
					429,
					page({ title: 'Too many', body: notice('callout-warn', ['Too many messages. Try again shortly.']) })
				);
			}
			const form = await readForm(request).catch(() => ({}));
			const body = String(form.body ?? '').trim();
			if (body.length < 4 || body.length > 4000) {
				return send(
					response,
					400,
					page({ title: 'Not sent', body: notice('callout-warn', ['A message needs between 4 and 4000 characters.']) })
				);
			}
			// The same refusal the first message gets. Somebody who has been asked a
			// follow-up question is exactly the person most likely to paste a secret
			// in answer to it.
			const leaked = secretsIn(body);
			if (leaked.length) {
				return send(response, 400, page({ title: 'Not sent', body: notice('callout-warn', leaked) }));
			}
			const stamp = now();
			const note = db
				.prepare('INSERT INTO notes (ticket_id, body, author, created_at) VALUES (?, ?, ?, ?)')
				.run(ticket.id, body, 'reporter', stamp);
			claimAttachments(ticket.id, Number(note.lastInsertRowid), form.attachments);
			// A reply from the reporter moves a closed report back into the queue,
			// and a "waiting on you" one back to us. Nobody should have to file a
			// second report to answer a question on the first.
			const next = ticket.status === 'assigned' ? 'assigned' : 'open';
			db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(
				next,
				stamp,
				ticket.id
			);
			return send(response, 303, '', { location: `/support/ticket/${ticket.reference}` });
		}

		if (method === 'GET') {
			const notes = db.prepare('SELECT * FROM notes WHERE ticket_id = ? ORDER BY id').all(ticket.id);
			const files = db
				.prepare('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at, id')
				.all(ticket.id);
			return send(response, 200, ticketView(ticket, notes, files));
		}
	}

	return undefined;
}

export { handle, makeReference, originOk, tooMany, page, sniff, storeUpload, fileFor, STATUSES };

/* ----------------------------------------------------------------- admin -- */

function loginPage(message) {
	return page({
		title: 'Admin',
		body: `		<article>
			<h1>Admin</h1>
			${message ? notice('callout-warn', [message]) : ''}
			<form class="form" method="post" action="/admin/login">
				<div class="field">
					<label for="passphrase">Passphrase</label>
					<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required>
				</div>
				<div class="controls"><button type="submit">Sign in</button></div>
			</form>
		</article>`
	});
}

function adminList(session, tickets, counts) {
	const row = (t) => {
		const state = STATUS[t.status] ?? STATUS.open;
		const files = counts.get(t.id) ?? 0;
		return `			<li class="message">
				<div class="ticket-head">
					<span class="ticket-ref">${escape(t.reference)}</span>
					<span class="status status-${escape(t.status)}">${escape(state.label)}</span>
					${files ? `<span class="hint">${files} attachment${files === 1 ? '' : 's'}</span>` : ''}
				</div>
				<h3><a href="/support/ticket/${escape(t.reference)}">${escape(t.summary)}</a></h3>
				<p class="hint">${escape(KIND_LABEL[t.kind] ?? t.kind)} · ${escape(dayLabel(t.created_at))}${
					t.contact ? ` · reply to ${escape(t.contact)}` : ' · no reply address'
				}</p>
				<form class="form" method="post" action="/admin/ticket/${t.id}">
					<input type="hidden" name="csrf" value="${escape(session.csrf)}">
					<div class="field">
						<label for="note-${t.id}">Reply (the reporter can read this)</label>
						<textarea id="note-${t.id}" name="note" rows="3" maxlength="2000"
						          placeholder="Answer, or ask for what is missing."></textarea>
					</div>
					<div class="controls">
						<button type="submit" name="status" value="assigned">I am on it</button>
						<button type="submit" name="status" value="waiting" class="secondary">Need more from them</button>
						<button type="submit" name="status" value="resolved" class="secondary">Resolve</button>
						<button type="submit" name="status" value="declined" class="secondary">Decline</button>
					</div>
				</form>
			</li>`;
	};
	const live = tickets.filter((t) => !['resolved', 'declined'].includes(t.status));
	const closed = tickets.filter((t) => ['resolved', 'declined'].includes(t.status));
	return page({
		title: 'Admin',
		body: `		<article>
			<div class="admin-head">
				<h1>Reports</h1>
				<form method="post" action="/admin/logout" class="controls">
					<input type="hidden" name="csrf" value="${escape(session.csrf)}">
					<button type="submit" class="secondary">Sign out</button>
				</form>
			</div>
			<p class="lede">${live.length} open, ${closed.length} closed.</p>
			<h2>Open</h2>
			${live.length ? `<ul class="thread">\n${live.map(row).join('\n')}\n</ul>` : '<p class="muted">Nothing open.</p>'}
			<h2>Closed</h2>
			${
				closed.length
					? `<ul class="plain">${closed
							.map(
								(t) =>
									`<li><a href="/support/ticket/${escape(t.reference)}">${escape(t.summary)}</a> — ${escape((STATUS[t.status] ?? STATUS.open).label)}</li>`
							)
							.join('')}</ul>`
					: '<p class="muted">Nothing closed yet.</p>'
			}
		</article>`
	});
}

async function handleAdmin(request, response, url) {
	const method = request.method ?? 'GET';
	const client = clientOf(request);

	/* ---- first run: set the passphrase, using the token from the journal ---- */
	if (url.pathname === '/admin/bootstrap') {
		if (!bootstrapToken) {
			return send(
				response,
				404,
				page({
					title: 'Not found',
					body: notice('callout-warn', ['An administrator already exists.'])
				})
			);
		}
		// **The token is a form field, never a query parameter.** A secret in a URL
		// is written to the nginx access log by `$request`, echoed into the log
		// again as the `$http_referer` of every subresource the page pulls, kept in
		// browser history, and offered by autocomplete forever after. That log is
		// mode 640 root:adm, and `adm` contains unprivileged accounts — so a token
		// that is still valid would be readable by someone who has no other way in,
		// and reading it is enough to become the administrator. A POST body is in
		// none of those places.
		if (method === 'GET') {
			return send(
				response,
				200,
				page({
					title: 'Set the admin passphrase',
					body: `		<article>
			<h1>Set the admin passphrase</h1>
			<p class="lede">Chosen once, and never recoverable. There is no reset — losing it
			means deleting the administrator row and bootstrapping again, which requires access
			to this server.</p>
			<p>The setup token was printed to the service journal when it started with no
			administrator configured. Read it on the server with
			<code>journalctl -u tickets | grep "setup token"</code> and paste it below.</p>
			<form class="form" method="post" action="/admin/bootstrap">
				<div class="field">
					<label for="t">Setup token</label>
					<input id="t" name="token" type="password" autocomplete="off" required>
				</div>
				<div class="field">
					<label for="p">Passphrase (16 characters or more)</label>
					<input id="p" name="passphrase" type="password" autocomplete="new-password" required>
				</div>
				<div class="controls"><button type="submit">Set it</button></div>
			</form>
		</article>`
				})
			);
		}
		// Guessing is hopeless against 192 bits, but an unlimited guess rate is a
		// free amplifier and there is no reason to offer one.
		if (tooMany(`bootstrap:${client}`, 5, 15 * 60 * 1000)) {
			return send(
				response,
				429,
				page({ title: 'Too many', body: notice('callout-warn', ['Too many attempts. Wait fifteen minutes.']) })
			);
		}
		const form = await readForm(request).catch(() => ({}));
		// Constant-time: this token is the only thing in front of the admin view.
		if (!sameSecret(Buffer.from(String(form.token ?? '')), Buffer.from(bootstrapToken))) {
			return send(
				response,
				403,
				page({ title: 'Refused', body: notice('callout-warn', ['Bad or missing token.']) })
			);
		}
		const passphrase = String(form.passphrase ?? '');
		if (passphrase.length < 16) {
			return send(
				response,
				400,
				page({ title: 'Too short', body: notice('callout-warn', ['At least 16 characters.']) })
			);
		}
		const salt = randomBytes(16);
		db.prepare('INSERT INTO admins (salt, verifier) VALUES (?, ?)').run(
			salt,
			derive(passphrase, salt)
		);
		refreshBootstrap();
		return send(
			response,
			200,
			page({
				title: 'Done',
				body: `${notice('callout', ['Administrator created.'])}\n\t\t<p><a href="/admin">Sign in</a></p>`
			})
		);
	}

	if (url.pathname === '/admin/login' && method === 'POST') {
		if (!originOk(request)) {
			return send(response, 403, loginPage('That form was not submitted from this site.'));
		}
		// Slows guessing without locking the only administrator out for long.
		if (tooMany(`login:${client}`, 5, 15 * 60 * 1000)) {
			return send(response, 429, loginPage('Too many attempts. Wait fifteen minutes.'));
		}
		const form = await readForm(request).catch(() => ({}));
		const admin = db.prepare('SELECT * FROM admins ORDER BY id LIMIT 1').get();
		if (!admin) {
			return send(response, 403, loginPage('No administrator is configured yet.'));
		}
		const candidate = derive(String(form.passphrase ?? ''), admin.salt);
		if (!sameSecret(candidate, Buffer.from(admin.verifier))) {
			return send(response, 403, loginPage('That passphrase is not right.'));
		}
		const id = newSession();
		return send(response, 303, '', {
			location: '/admin',
			// Host-only, HTTPS-only, invisible to script, and never sent on a
			// cross-site navigation — the cookie half of the CSRF defence.
			// Scoped to /admin so the session identifier is not attached to every
			// request for a stylesheet or an icon as well.
			'set-cookie': `admin=${id}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}`
		});
	}

	const session = readSession(request);

	// Signing out was missing entirely: the only way to end a session was to wait
	// eight hours or restart the service. Someone who signs in on a machine they
	// do not own needs a way to end it before they walk away from it.
	if (url.pathname === '/admin/logout' && method === 'POST') {
		// A POST with the session's own token, so another site cannot sign the
		// administrator out by pointing them at a link.
		if (session && sameSecret(Buffer.from(String((await readForm(request).catch(() => ({}))).csrf ?? '')), Buffer.from(session.csrf))) {
			sessions.delete(session.id);
		}
		return send(response, 303, '', {
			location: '/admin',
			'set-cookie': 'admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
		});
	}

	if (url.pathname === '/admin' && method === 'GET') {
		if (!session) {
			return send(response, 200, loginPage());
		}
		const tickets = db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 200').all();
		const counts = new Map(
			db
				.prepare('SELECT ticket_id, COUNT(*) AS n FROM attachments WHERE ticket_id IS NOT NULL GROUP BY ticket_id')
				.all()
				.map((r) => [r.ticket_id, r.n])
		);
		return send(response, 200, adminList(session, tickets, counts));
	}

	const act = /^\/admin\/ticket\/(\d+)$/.exec(url.pathname);
	if (act && method === 'POST') {
		if (!session) {
			return send(response, 403, loginPage('Session expired.'));
		}
		const form = await readForm(request).catch(() => ({}));
		if (!sameSecret(Buffer.from(String(form.csrf ?? '')), Buffer.from(session.csrf))) {
			return send(
				response,
				403,
				page({
					title: 'Refused',
					body: notice('callout-warn', ['Stale form. Reload and try again.'])
				})
			);
		}
		const status = STATUSES.includes(String(form.status)) ? String(form.status) : 'open';
		const note = String(form.note ?? '')
			.trim()
			.slice(0, 2000);
		const stamp = now();
		db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(
			status,
			stamp,
			Number(act[1])
		);
		if (note) {
			db.prepare('INSERT INTO notes (ticket_id, body, author, created_at) VALUES (?, ?, ?, ?)').run(
				Number(act[1]),
				note,
				'us',
				stamp
			);
		}
		return send(response, 303, '', { location: '/admin' });
	}

	return undefined;
}

/* ----------------------------------------------------------------- serve -- */

refreshBootstrap();

const server = createServer((request, response) => {
	// The origin is fixed rather than taken from the Host header: this process is
	// only ever reached through nginx for one hostname, and parsing an
	// attacker-supplied Host into routing decisions is how host-header bugs start.
	const url = new URL(request.url ?? '/', 'https://opendesktopauthenticator.com');
	Promise.resolve()
		.then(() => handle(request, response, url))
		.then((done) => (done === undefined ? handleAdmin(request, response, url) : done))
		.then((done) => {
			if (done === undefined && !response.headersSent) {
				send(
					response,
					404,
					page({ title: 'Not found', body: notice('callout-warn', ['No such page.']) })
				);
			}
		})
		.catch((error) => {
			// The journal gets the detail; the visitor gets none of it. An error
			// message is a description of internals to whoever provoked it.
			process.stderr.write(`request failed: ${error?.message}\n`);
			if (!response.headersSent) {
				send(
					response,
					500,
					page({
						title: 'Error',
						body: notice('callout-warn', ['Something went wrong. Nothing was saved.'])
					})
				);
			}
		});
});

// Loopback only. nginx is the only thing that may reach this.
if (process.env.TICKETS_NO_LISTEN !== '1') {
	server.listen(PORT, '127.0.0.1', () => {
		process.stdout.write(`tickets listening on 127.0.0.1:${PORT}\n`);
	});
}

export { handleAdmin, server, loginPage };
