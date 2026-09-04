import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddAuthenticator } from '../src/renderer/screens/AddAuthenticator';
import { MoveAuthenticator } from '../src/renderer/screens/MoveAuthenticator';

/**
 * What the setup screens promise about proxy schemes, checked against the layer
 * that actually decides.
 *
 * Both screens said "HTTP, HTTPS, SOCKS4 and SOCKS5 are all accepted", and
 * `planProxy` has never accepted `socks4://`. It refuses it on purpose: the
 * protocol carries an address rather than a hostname, so the client must resolve
 * first and every Steam host is looked up by the user's own machine, in the
 * clear, on whatever resolver the network hands out — the exact leak routing an
 * account exists to close.
 *
 * So the refusal is right and the copy was wrong, and the shape of the failure
 * is the bad part: somebody read the screen, typed the address the screen named,
 * and was turned away by a message contradicting the sentence directly above the
 * field — at the one moment they were also handing over a Steam password. A
 * refusal a user was invited into is worse than no invitation at all.
 *
 * Rendered rather than grepped, because the promise is a thing on a screen: the
 * paragraph only exists in the credentials step of either flow, and a source
 * scan would keep passing over copy that had been moved somewhere no one sees.
 *
 * ## Why this no longer tries to read the sentence
 *
 * The first version of this file looked for the claim — `"<schemes> are
 * accepted"` — and checked which scheme names fell inside it. That guard was
 * defeated twice, with the defect fully back and the file still green:
 *
 *   - Rewriting the second sentence of the Add screen to "SOCKS4 works too, so
 *     an older proxy is fine." promises the refused scheme without ever using
 *     the word `accepted`, so the claim pattern matched nothing about it.
 *   - Writing the promise across an em dash — "SOCKS4, SOCKS5 — and HTTP and
 *     HTTPS — are accepted" — pushed the refused name outside the captured
 *     clause, because the capture stopped at the dash.
 *
 * Both escapes are the same mistake: policing one grammatical construction, when
 * the number of ways English can promise something is unbounded. So the property
 * checked here is not about grammar at all:
 *
 *   **A screen may not put the NAME of a refused scheme in front of a user in
 *   any construction whatsoever, unless the sentence it sits in refuses it.**
 *
 * "Works too", an em dash, a bulleted list, a table cell, a placeholder — all of
 * them name `socks4` where a reader will read it, and all of them fail here. The
 * only sentence allowed to contain a refused name is one that turns it away.
 *
 * ## Where each half of the answer comes from
 *
 *   - The *verdict* — accepted or refused — is behaviour: one `planProxy` probe
 *     per name. Nothing about which schemes work is written down in this file.
 *   - The *vocabulary* — which names exist to be checked — is parsed out of
 *     `egress.ts`, from the scheme literals in its own tables, with comments
 *     stripped first so a name mentioned only in its prose does not count. This
 *     is source text, which is the weakest of the three ways to write a check,
 *     and it is used here because the names of schemes egress has no opinion on
 *     exist nowhere at run time. The anchors it depends on are asserted present
 *     below, so a rename cannot quietly empty the vocabulary and pass everything.
 *
 * That leaves exactly one honest hole, stated plainly: a scheme `egress.ts` has
 * never heard of. Copy naming `shadowsocks` in bare words is invisible here.
 * Two of the three ways it could show up are closed anyway — written as an
 * address (`shadowsocks://…`) it is probed directly, and written as a SOCKS
 * dialect (`socks4a`, `socks9`) it is caught by the dialect case.
 *
 * ## Why egress is loaded through a variable rather than imported
 *
 * `tsconfig.web.json` is the project that knows how to parse JSX, so a test that
 * renders a screen belongs to it — and it lists the renderer and `src/shared`,
 * never `src/main`. A plain `import { planProxy } from '../src/main/net/egress'`
 * therefore fails `npm run typecheck` outright with TS6307, and the boundary
 * doing that is a good one: the renderer must not reach into the main process,
 * and the project references are what stop it.
 *
 * This file is not the renderer, and the whole point of it is to hold the two
 * halves against each other — the promise from one, the verdict from the other.
 * Naming the module in a variable puts the load past TypeScript's project graph
 * while Vitest resolves it exactly as it would any other import, so the refused
 * set stays derived at run time. The same trick carries the `?raw` load of the
 * source text: the suffix is a bundler instruction TypeScript cannot resolve.
 */
const EGRESS_MODULE = '../src/main/net/egress';
const EGRESS_SOURCE_MODULE = '../src/main/net/egress.ts?raw';

/** The one thing this file asks egress, and the shape it is asked in. */
const { planProxy } = (await import(EGRESS_MODULE)) as {
	planProxy: (proxyUrl: string) => unknown;
};

/** The same module again, as text, for the names rather than the verdicts. */
const EGRESS_SOURCE = ((await import(EGRESS_SOURCE_MODULE)) as { default: string }).default;

/**
 * Comments gone, so the vocabulary comes from the tables and not the essay.
 *
 * `egress.ts` explains at length why `socks4a` is absent from `SUPPORTED`, and a
 * scan that counted prose would take every scheme argued about in a paragraph as
 * a scheme the module handles. Line comments are only cut where the `//` is not
 * preceded by a colon, because the refusal messages themselves contain
 * `socks5://` and a naive cut would swallow the rest of those lines.
 */
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Every scheme name `egress.ts` has a table entry for.
 *
 * The tables all key on the `URL.protocol` spelling — a name with a trailing
 * colon, quoted — so one pattern reaches `SUPPORTED`, `REFUSED_SCHEMES`,
 * `CHROMIUM_SCHEME`, `DEFAULT_PORT` and `NODE_SOCKS_SCHEME` alike. Which of them
 * a name appears in is deliberately not read: that would be a second copy of the
 * accept/refuse decision, and `planProxy` is asked instead.
 */
const SCHEME_VOCABULARY = [
	...new Set(
		[...withoutComments(EGRESS_SOURCE).matchAll(/'([a-z][a-z0-9+.-]*):'/g)].map(
			(match) => match[1] as string
		)
	)
];

/**
 * Would egress take an address in this scheme?
 *
 * Ported, hostful and credential-free deliberately, so the only thing left for
 * `planProxy` to object to is the scheme itself. It also refuses a hostless URL
 * and a SOCKS proxy carrying a username, and neither of those is the question
 * being asked here — a probe that tripped over one of them would report every
 * scheme as refused and this file would fail for a reason nobody could read.
 */
const egressAccepts = (scheme: string): boolean => {
	try {
		planProxy(`${scheme}://proxy.example:1080`);
		return true;
	} catch {
		return false;
	}
};

/** The two halves of the vocabulary, straight from the transport. */
const ACCEPTED = SCHEME_VOCABULARY.filter((scheme) => egressAccepts(scheme));
const REFUSED = SCHEME_VOCABULARY.filter((scheme) => !egressAccepts(scheme));

/**
 * Language that turns a scheme away.
 *
 * Deliberately narrow. Every word here says "no" on its own, so a sentence
 * carrying one is a refusal and not a promise with a negation somewhere in it —
 * bare `not` would let "SOCKS4 works too, and nothing is stored" pass, which is
 * the escape this file exists to close.
 *
 * The cost is the other direction, and it is the cheap one: a rewrite that
 * refuses SOCKS4 in words not listed here fails loudly and gets a word added to
 * this list. A missing word costs an edit; a generous one costs a user their DNS
 * queries.
 */
const REFUSAL_LANGUAGE =
	/\b(?:refused|refuses|refuse|rejected|rejects|reject|unsupported|turned away|turns away|turn away|turned down|not supported|not accepted|never accepted|not allowed|cannot be used|can(?:not| ?not|'t|’t) be routed|will not work|won(?:'|’)t work|does not work|doesn(?:'|’)t work)\b/i;

/**
 * The screen as a reader sees it: markup gone, entities back, spacing collapsed.
 *
 * Closing block tags become a full stop first. A paragraph and the label above it
 * are two separate things on the screen, and flattening the markup with spaces
 * glued them into one run of text — which widened the window a refusal is allowed
 * to appear in to "anywhere in the surrounding page", so a refusal word in a
 * label could have excused a promise in the paragraph beneath it.
 */
const readable = (html: string): string =>
	html
		.replace(
			/<\/(?:p|div|li|ul|ol|label|h[1-6]|section|article|button|td|th|tr|option|legend|fieldset)>|<br\s*\/?>/gi,
			'. '
		)
		.replace(/<[^>]*>/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ');

/**
 * Text a user reads that never becomes an element's contents.
 *
 * The placeholder is the line most people copy and it lives in an attribute, so
 * stripping tags deletes exactly the string that teaches the scheme. Each value
 * is treated as its own sentence below, which means the rule lands on it as
 * "a placeholder may not name a refused scheme" — no placeholder has room to
 * refuse anything.
 */
const visibleAttributeText = (html: string): string[] =>
	[...html.matchAll(/(?:placeholder|title|aria-label|alt)="([^"]*)"/gi)].map((match) =>
		readable(match[1] as string)
	);

/**
 * The window a refusal has to appear in: one sentence.
 *
 * Split on sentence-ending punctuation and the semicolon, and pointedly **not**
 * on the em dash — an earlier version treated the dash as a boundary and a
 * promise written across one ("SOCKS4, SOCKS5 — and HTTP and HTTPS — are
 * accepted") hid the refused name outside the part being read. A dash joins a
 * clause to its sentence; it does not start a new claim.
 *
 * The colon is not a boundary either, because both screens explain the refusal
 * after one ("SOCKS4 is turned away: it carries an address…") and the refusal
 * and its reason are one thought.
 */
const sentences = (text: string): string[] =>
	text
		.split(/(?<=[.!?;])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== '');

/** Every stretch of text a reader could meet a scheme name in. */
const readableFragments = (html: string): string[] => [
	...sentences(readable(html)),
	...visibleAttributeText(html)
];

const mentions = (text: string, scheme: string): boolean =>
	// Word-bounded, or `socks5` would be found inside `socks5h` and `http` inside
	// `https`, and the test would accuse a screen of naming a scheme it never did.
	// Escaped, because a scheme name may legally contain `+`, `.` or `-`.
	new RegExp(`\\b${scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

/** Every `scheme://` example the screen puts in front of a user, markup included. */
const EXAMPLE_ADDRESS = /\b([a-z][a-z0-9+.-]*):\/\//gi;

/**
 * Anything spelled like a member of the SOCKS family.
 *
 * The family is where the dialects breed — `socks`, `socks4`, `socks4a`,
 * `socks5`, `socks5h` — and they differ from each other in exactly the way that
 * matters here: where the DNS lookup happens. A name in this shape that egress
 * has no table entry for is copy inventing a dialect, and nobody can say whether
 * it routes.
 */
const SOCKS_DIALECT = /\bsocks[a-z0-9]*\b/gi;

const noop = (): void => {};

const addAuthenticator = (): string =>
	renderToStaticMarkup(
		<AddAuthenticator
			requireProxies={false}
			onBegin={() => Promise.resolve({ state: 'needsEmailCode' as const })}
			onEmailCode={() => Promise.resolve({ state: 'needsEmailCode' as const })}
			onCancel={() => Promise.resolve()}
			onResolve={() => Promise.resolve({ ok: true as const })}
			onClearStale={() => Promise.resolve()}
			onActivate={() => Promise.resolve({ state: 'activated' as const })}
			onBackup={noop}
			onClose={noop}
			onMove={noop}
		/>
	);

const moveAuthenticator = (): string =>
	renderToStaticMarkup(
		<MoveAuthenticator
			requireProxies={false}
			onAuthenticate={() =>
				Promise.resolve({
					state: 'authenticated' as const,
					steamId64: '76561198000000001',
					accountName: 'someone'
				})
			}
			onCancel={() => Promise.resolve()}
			onStartChallenge={() =>
				Promise.resolve({ shape: 'protobuf' as const, sent: true, eresult: 1 })
			}
			onComplete={() =>
				Promise.resolve({
					steamId64: '76561198000000001',
					accountName: 'someone',
					revocationCode: 'R12345',
					timeOffsetSeconds: 0
				})
			}
			onRetryPersist={() =>
				Promise.resolve({
					steamId64: '76561198000000001',
					accountName: 'someone',
					revocationCode: 'R12345',
					timeOffsetSeconds: 0
				})
			}
			onStatus={() => Promise.resolve({})}
			onAcknowledgeBackup={() => Promise.resolve({})}
			onClose={noop}
		/>
	);

const SCREENS: ReadonlyArray<[string, () => string]> = [
	['AddAuthenticator', addAuthenticator],
	['MoveAuthenticator', moveAuthenticator]
];

describe('the vocabulary and the verdicts this file is built out of', () => {
	/*
	 * The scheme names are read out of `egress.ts` as text, which is the part of
	 * this file that can rot silently: rename the tables, change the quoting, and
	 * the vocabulary quietly becomes the empty list while every case below passes
	 * on nothing. So the anchors are asserted rather than assumed.
	 */
	it('found the scheme tables in egress.ts', () => {
		const source = withoutComments(EGRESS_SOURCE);
		expect(
			source.includes('SUPPORTED'),
			'egress.ts no longer has a SUPPORTED table, so the scheme names below were read out of ' +
				'something this file no longer understands'
		).toBe(true);
		expect(
			source.includes('REFUSED_SCHEMES'),
			'egress.ts no longer has a REFUSED_SCHEMES table, so this file cannot see which names ' +
				'the transport turns away by name'
		).toBe(true);
		for (const known of ['http', 'https', 'socks5']) {
			expect(
				SCHEME_VOCABULARY.includes(known),
				`the scheme names parsed out of egress.ts do not include ${known}, so the parse is ` +
					`broken and every screen check below is looking for nothing`
			).toBe(true);
		}
	});

	/*
	 * Without this, a `planProxy` that threw on everything — or on nothing —
	 * would leave every case below passing for no reason at all, which is the one
	 * failure a derived expectation is prone to.
	 */
	it('gets both answers out of egress', () => {
		expect(
			ACCEPTED.length,
			'egress accepted no scheme at all, so the probe is broken'
		).toBeGreaterThan(0);
		expect(
			REFUSED.length,
			'egress refused no scheme at all, so nothing below is actually being checked'
		).toBeGreaterThan(0);
	});
});

describe.each(SCREENS)('%s tells the truth about proxy schemes', (name, render) => {
	it('never names a scheme the transport refuses except to refuse it', () => {
		for (const fragment of readableFragments(render())) {
			for (const scheme of REFUSED) {
				if (!mentions(fragment, scheme)) {
					continue;
				}
				expect(
					REFUSAL_LANGUAGE.test(fragment),
					`${name} puts the name ${scheme} in front of a user without turning it away, and ` +
						`planProxy refuses ${scheme}: the user types it, the main process turns them ` +
						`away mid sign-in with their password already entered, and the screen has ` +
						`contradicted itself. Say plainly that it is refused, or stop naming it. ` +
						`The text: "${fragment}"`
				).toBe(true);
			}
		}
	});

	it('still tells the user which schemes do work', () => {
		// A screen that simply stopped naming schemes would satisfy every rule
		// above by saying nothing, and silence is its own defect here: the field
		// takes a URL and nothing else on the screen says what kind.
		const text = readable(render());
		const named = ACCEPTED.filter((scheme) => mentions(text, scheme));
		expect(
			named.length,
			`${name} no longer names a single proxy scheme that works, so the user is left guessing ` +
				`what to type — and this guard has nothing left to check`
		).toBeGreaterThan(0);
	});

	it('shows no example address in a scheme the transport refuses', () => {
		// Probed whatever the scheme is, rather than only the names egress knows:
		// an address is a complete instruction to a reader, so `shadowsocks://` on
		// the screen has to survive `planProxy` like any other.
		for (const [, scheme] of render().matchAll(EXAMPLE_ADDRESS)) {
			const lower = (scheme ?? '').toLowerCase();
			expect(
				egressAccepts(lower),
				`${name} shows ${lower}:// as an example address and planProxy refuses that scheme`
			).toBe(true);
		}
	});

	it('names no SOCKS dialect egress.ts has never heard of', () => {
		// `socks4a` and bare `socks` mean different things to different libraries,
		// and the difference is where DNS happens. Copy that invents a dialect —
		// or writes one egress has no table entry for — is making a promise nobody
		// can check, so it fails here and gets written as a name that exists.
		for (const [dialect] of readable(render()).matchAll(SOCKS_DIALECT)) {
			expect(
				SCHEME_VOCABULARY.includes(dialect.toLowerCase()),
				`${name} names "${dialect}", which egress.ts has no table entry for, so nothing in ` +
					`this app can say whether it routes or leaks. Name a scheme egress knows.`
			).toBe(true);
		}
	});
});
