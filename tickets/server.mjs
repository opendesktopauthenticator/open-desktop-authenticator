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
 * **No file uploads.** The single most likely thing anyone would attach to a
 * report about this application is a `.maFile`, which is the one file that must
 * never be sent anywhere. Refusing uploads entirely is the only way to be sure
 * we never receive one.
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
import { readFileSync } from 'node:fs';
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
`);

const now = () => new Date().toISOString();

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

	/*
	 * Refuse anything that looks like a Steam secret.
	 *
	 * The form says not to paste one; people will anyway, in a panic, because
	 * they think it will help. Storing it would make this database worth
	 * attacking, and we would have collected the exact thing the whole product
	 * exists to keep people from handing over. So it is rejected at the door and
	 * never written.
	 */
	const haystack = `${summary}\n${detail}`;
	const secrets = [
		[/"?shared_secret"?\s*[:=]/i, 'a shared_secret'],
		[/"?identity_secret"?\s*[:=]/i, 'an identity_secret'],
		[/"?revocation_code"?\s*[:=]|\bR\d{5}\b/i, 'a revocation code'],
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
		[/"?steamid"?\s*[:=]\s*"?7656119\d{10}/i, 'a maFile']
	];
	for (const [pattern, what] of secrets) {
		if (pattern.test(haystack)) {
			errors.push(
				`That looks like it contains ${what}. Nothing here needs one — describe it instead. The report has not been saved.`
			);
			break;
		}
	}

	return { errors, value: { kind, summary, detail, contact: contact || null } };
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
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const derive = (passphrase, salt) =>
	scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });

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
	process.stdout.write(
		`no administrator configured — set one at /admin/bootstrap?token=${bootstrapToken}\n`
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
function styleHref() {
	try {
		const home = readFileSync('/var/www/oda/public/index.html', 'utf8');
		return /<link rel="stylesheet" href="([^"]+)"/.exec(home)?.[1] ?? '/assets/site.css';
	} catch {
		return '/assets/site.css';
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
	<link rel="stylesheet" href="${styleHref()}">
</head>
<body>
	<header class="masthead"><div class="wrap">
		<a class="brand" href="/"><span><b>Open Desktop</b> Authenticator</span></a>
		<nav aria-label="Main"><a href="/support">Support</a></nav>
	</div></header>
	<main id="main" class="wrap">
${body}
	</main>
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

function ticketView(ticket, notes) {
	return page({
		title: `Report ${ticket.reference}`,
		body: `		<article>
			<h1>Report ${escape(ticket.reference)}</h1>
			<p class="lede">${escape(KIND_LABEL[ticket.kind] ?? ticket.kind)} —
			<strong>${escape(ticket.status)}</strong></p>
			<h2>${escape(ticket.summary)}</h2>
			<p>${escape(ticket.detail).replace(/\n/g, '<br>')}</p>
			<p class="reviewed">Opened <time datetime="${escape(ticket.created_at)}">${escape(ticket.created_at.slice(0, 10))}</time>.</p>
			${
				notes.length
					? `<h2>Replies</h2>${notes
							.map(
								(n) =>
									`<div class="callout"><p>${escape(n.body).replace(/\n/g, '<br>')}</p>
									<p class="reviewed">${escape(n.created_at.slice(0, 10))}</p></div>`
							)
							.join('')}`
					: '<p class="muted">No reply yet.</p>'
			}
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
		db.prepare(
			`INSERT INTO tickets (reference, kind, summary, detail, contact, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(reference, value.kind, value.summary, value.detail, value.contact, stamp, stamp);
		return send(response, 200, submitted(reference));
	}

	/* ---- public: look a report up by reference ---- */
	const ref = /^\/support\/ticket\/(ODA-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(url.pathname);
	if (ref && method === 'GET') {
		const ticket = db.prepare('SELECT * FROM tickets WHERE reference = ?').get(ref[1]);
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
		const notes = db.prepare('SELECT * FROM notes WHERE ticket_id = ? ORDER BY id').all(ticket.id);
		return send(response, 200, ticketView(ticket, notes));
	}

	return undefined;
}

export { handle, makeReference, originOk, tooMany, page };

/* ----------------------------------------------------------------- admin -- */

function loginPage(message) {
	return page({
		title: 'Admin',
		body: `		<article>
			<h1>Admin</h1>
			${message ? notice('callout-warn', [message]) : ''}
			<form method="post" action="/admin/login">
				<label for="passphrase">Passphrase</label>
				<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required>
				<div class="controls"><button type="submit">Sign in</button></div>
			</form>
		</article>`
	});
}

function adminList(session, tickets) {
	const row = (t) => `			<li class="project">
				<h3><a href="/support/ticket/${escape(t.reference)}">${escape(t.summary)}</a></h3>
				<span class="domain">${escape(t.reference)} · ${escape(KIND_LABEL[t.kind] ?? t.kind)} · ${escape(t.created_at.slice(0, 10))}</span>
				<form method="post" action="/admin/ticket/${t.id}">
					<input type="hidden" name="csrf" value="${escape(session.csrf)}">
					<label for="note-${t.id}">Reply (the reporter can read this)</label>
					<textarea id="note-${t.id}" name="note" rows="2" maxlength="2000"></textarea>
					<div class="controls">
						<button type="submit" name="status" value="resolved">Resolve</button>
						<button type="submit" name="status" value="open" class="secondary">Keep open</button>
						<button type="submit" name="status" value="declined" class="secondary">Decline</button>
					</div>
				</form>
			</li>`;
	const open = tickets.filter((t) => t.status === 'open');
	const closed = tickets.filter((t) => t.status !== 'open');
	return page({
		title: 'Admin',
		body: `		<article>
			<h1>Reports</h1>
			<p class="lede">${open.length} open, ${closed.length} closed.</p>
			<h2>Open</h2>
			${open.length ? `<ul class="projects">\n${open.map(row).join('\n')}\n</ul>` : '<p class="muted">Nothing open.</p>'}
			<h2>Closed</h2>
			${
				closed.length
					? `<ul class="plain">${closed
							.map(
								(t) =>
									`<li><a href="/support/ticket/${escape(t.reference)}">${escape(t.summary)}</a> — ${escape(t.status)}</li>`
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
		const token = url.searchParams.get('token') ?? '';
		// Constant-time: this token is the only thing in front of the admin view.
		if (!sameSecret(Buffer.from(token), Buffer.from(bootstrapToken))) {
			return send(
				response,
				403,
				page({ title: 'Refused', body: notice('callout-warn', ['Bad or missing token.']) })
			);
		}
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
			<form method="post" action="/admin/bootstrap?token=${escape(token)}">
				<label for="p">Passphrase (16 characters or more)</label>
				<input id="p" name="passphrase" type="password" autocomplete="new-password" required>
				<div class="controls"><button type="submit">Set it</button></div>
			</form>
		</article>`
				})
			);
		}
		const form = await readForm(request).catch(() => ({}));
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
			'set-cookie': `admin=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_LIFETIME_MS / 1000}`
		});
	}

	const session = readSession(request);

	if (url.pathname === '/admin' && method === 'GET') {
		if (!session) {
			return send(response, 200, loginPage());
		}
		const tickets = db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 200').all();
		return send(response, 200, adminList(session, tickets));
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
		const status = ['open', 'resolved', 'declined'].includes(String(form.status))
			? String(form.status)
			: 'open';
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
			db.prepare('INSERT INTO notes (ticket_id, body, created_at) VALUES (?, ?, ?)').run(
				Number(act[1]),
				note,
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
