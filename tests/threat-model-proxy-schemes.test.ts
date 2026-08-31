import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planProxy } from '../src/main/net/egress';

/**
 * What docs/THREAT_MODEL.md promises about proxy schemes, checked against the
 * layer that actually decides.
 *
 * §2.6 told the reader that `socks4://` "is still accepted", and `planProxy` has
 * refused it for as long as `REFUSED_SCHEMES` has existed. The refusal is the
 * right call — SOCKS4 carries an IP address rather than a hostname, so a client
 * has to resolve every Steam host on the machine's own resolver before it can
 * connect, which hands the destination list to the party routing was meant to
 * keep it from — and the document was the half that was wrong.
 *
 * A stale sentence here is worse than a stale comment, and the difference is who
 * reads it. This document is published, it is the artifact whose entire purpose
 * is being true, and it invites people to check the product against it. Somebody
 * who did that would have configured the scheme this page named, been turned
 * away by the main process, and learned that the trust document does not
 * describe the program — which costs more than the paragraph was worth.
 *
 * `tests/proxy-scheme-copy.test.tsx` does exactly this for the setup screens.
 * This file is the same guard pointed at the document, and it is deliberately
 * built the same way, down to the vocabulary parse and the sentence window, so
 * the two can be read against each other. Where it differs it is because prose
 * is not a screen, and each difference is argued below rather than left as a
 * silent divergence.
 *
 * ## Where each half of the answer comes from
 *
 *   - The *verdict* — accepted or refused — is behaviour: one `planProxy` probe
 *     per name. Nothing about which schemes work is written down in this file,
 *     so `egress.ts` changing its mind changes what this file demands without
 *     anybody editing it.
 *   - The *vocabulary* — which names exist to be checked — is parsed out of
 *     `egress.ts`, from the scheme literals in its own tables, with comments
 *     stripped first so a name that appears only in its prose does not count.
 *     Source text is the weakest of the three ways to write a check and it is
 *     used here for the reason the screen test gives: a scheme egress has no
 *     opinion on exists nowhere at run time, so there is nothing to ask. The
 *     anchors the parse depends on are asserted present below, because a rename
 *     that quietly emptied the vocabulary would leave every case here passing on
 *     nothing.
 *
 * Unlike the screen test, this one does not import egress through a variable.
 * That trick exists because a `.tsx` test belongs to `tsconfig.web.json`, which
 * cannot see `src/main`. This file is `.ts` and belongs to `tsconfig.node.json`,
 * which compiles the main process and the tests together, so the plain import is
 * both legal and stronger — a rename of `planProxy` fails the typecheck instead
 * of failing here at run time.
 *
 * ## The property
 *
 * **The document may not put the NAME of a refused scheme in front of a reader
 * in any construction whatsoever, unless the sentence it sits in refuses it.**
 *
 * Not "may not say it is accepted". The screen test was defeated twice by
 * policing a construction — once by a promise that avoided the word `accepted`,
 * once by a promise written across an em dash — and the lesson it wrote down is
 * that the number of ways English can promise something is unbounded. A name a
 * reader meets is a name they may act on, so the only sentence allowed to
 * contain one is a sentence that turns it away.
 *
 * ## Two things this file deliberately does not check
 *
 *   - **That the refusal gives its reason.** The finding that produced this file
 *     asks the document to say *why* SOCKS4 is refused, because "unsupported"
 *     reads as "nobody has got to it yet" and invites a reader to wait for it
 *     rather than change proxies. That is a real requirement and it is not
 *     mechanised, because a regex hunting for the word "DNS" would be exactly
 *     the failure this repo keeps making: an assertion about the wording of a
 *     sentence rather than about the thing the sentence has to be true about.
 *     The reason is enforced in review.
 *   - **`scheme://` examples, as a separate rule.** The screen test has one,
 *     because an address on a form is a complete instruction to type. In prose
 *     it is just how a scheme is spelled, and the rule above already reaches it:
 *     the name is matched wherever it appears, `socks4://` included. A separate
 *     address rule would forbid the *corrected* document from writing
 *     `socks4://` even in the sentence refusing it, which is not an improvement
 *     anyone would accept.
 *
 * And one hole, stated plainly, the same one the screen test carries: a scheme
 * `egress.ts` has never heard of. A paragraph recommending `shadowsocks` in bare
 * words is invisible here. Written as a SOCKS dialect it is caught by the last
 * case below.
 *
 * ## Why only this document
 *
 * `docs/SECURITY_HARDENING_PLAN.md` also names `socks4`, and is left alone on
 * purpose: it is a record of what was decided when, not a description of what
 * the program does today. Rewriting a dated plan to match current behaviour
 * would destroy the only thing it is for. THREAT_MODEL.md is the one that claims
 * the present tense, so it is the one held to it.
 */

const ROOT = join(__dirname, '..');
const EGRESS_SOURCE = readFileSync(join(ROOT, 'src', 'main', 'net', 'egress.ts'), 'utf8');
const THREAT_MODEL = readFileSync(join(ROOT, 'docs', 'THREAT_MODEL.md'), 'utf8');

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
 * Copied from `tests/proxy-scheme-copy.test.tsx` on purpose — one wording rule
 * for the whole project, so a sentence that satisfies the screens satisfies the
 * document — and deliberately narrow. Every word here says "no" on its own, so a
 * sentence carrying one is a refusal rather than a promise with a negation
 * somewhere in it: bare `not` would let "SOCKS4 works too, and nothing is
 * stored" pass, which is the escape this shape of test exists to close.
 *
 * The cost is the other direction, and it is the cheap one: a rewrite that
 * refuses SOCKS4 in words not listed here fails loudly and gets a word added to
 * this list. A missing word costs an edit; a generous one costs a reader their
 * DNS queries.
 */
const REFUSAL_LANGUAGE =
	/\b(?:refused|refuses|refuse|rejected|rejects|reject|unsupported|turned away|turns away|turn away|turned down|not supported|not accepted|never accepted|not allowed|cannot be used|can(?:not| ?not|'t|’t) be routed|will not work|won(?:'|’)t work|does not work|doesn(?:'|’)t work)\b/i;

/**
 * The document as a reader sees it: markup off, words untouched.
 *
 * Code spans and emphasis are removed rather than replaced with a space, because
 * they wrap the exact string a reader takes away — `` `socks4://` `` is read as
 * `socks4://`, and a substitution that put spaces inside it would hide the name
 * from every pattern below. A link keeps its text and loses its target: the text
 * is the sentence, the target is a path nobody reads aloud.
 */
const readable = (markdown: string): string =>
	markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * A line that starts something new rather than continuing the line above it.
 *
 * Markdown prose is hard-wrapped, so a paragraph has to be rejoined before it
 * can be split into sentences — but rejoining everything would run a heading
 * into the paragraph under it and one bullet into the next. That matters here
 * for one reason: it would widen the window a refusal is allowed to appear in,
 * so a bullet that refuses `socks4a` could excuse a bullet three lines above it
 * that promises `socks4`. The bullets in §2.6 are exactly that shape.
 */
const BLOCK_START = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||$)/;

/** Hard-wrapped lines rejoined into the blocks a reader sees as one thing. */
const blocks = (markdown: string): string[] => {
	const found: string[] = [];
	let current = '';
	for (const line of markdown.split(/\r?\n/)) {
		if (BLOCK_START.test(line)) {
			if (current !== '') {
				found.push(current);
			}
			current = '';
		}
		if (line.trim() === '') {
			continue;
		}
		current = current === '' ? line.trim() : `${current} ${line.trim()}`;
	}
	if (current !== '') {
		found.push(current);
	}
	return found;
};

/**
 * The window a refusal has to appear in: one sentence.
 *
 * Split on sentence-ending punctuation and the semicolon, plus the table pipe so
 * a cell is judged as itself, and pointedly **not** on the em dash — the screen
 * test learned that one the hard way, from a promise written across a dash that
 * hid the refused name outside the part being read. A dash joins a clause to its
 * sentence; it does not start a new claim. The colon is not a boundary either,
 * because a refusal and the reason after it are one thought, and demanding the
 * reason be its own sentence is the sort of grammar rule this file avoids.
 *
 * It does over-split in one harmless way: `egress.ts normalises…` breaks at the
 * file extension, because a full stop followed by a space is all this can see.
 * That only ever makes the window *smaller*, which can cost a false failure and
 * can never grant a false pass, so it is left alone rather than papered over
 * with a list of abbreviations.
 */
const sentences = (block: string): string[] =>
	block
		.split('|')
		.flatMap((cell) => cell.split(/(?<=[.!?;])\s+/))
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence !== '');

/** Every stretch of text a reader could meet a scheme name in. */
const FRAGMENTS = blocks(THREAT_MODEL).flatMap((block) => sentences(readable(block)));

const mentions = (text: string, scheme: string): boolean =>
	// Word-bounded, or `socks5` would be found inside `socks5h` and `http` inside
	// `https`, and this would accuse the document of naming a scheme it never did.
	// Escaped, because a scheme name may legally contain `+`, `.` or `-`.
	new RegExp(`\\b${scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

/**
 * Anything spelled like a member of the SOCKS family.
 *
 * The family is where the dialects breed — `socks4`, `socks4a`, `socks5`,
 * `socks5h` — and they differ from each other in exactly the way that matters
 * here: where the DNS lookup happens. A name in this shape that egress has no
 * table entry for is prose inventing a dialect, and nobody can say whether it
 * routes or leaks.
 */
const SOCKS_DIALECT = /\bsocks[a-z0-9]*\b/gi;

/**
 * Bare `SOCKS`, with no digit, is the protocol family and not a dialect.
 *
 * The screens have no reason to write it and so the screen test does not except
 * it. A threat model does: §2.6 says "a SOCKS proxy needing a username and
 * password is refused", which is a true sentence about all of them, and there is
 * no version of it that names a dialect without becoming wrong.
 */
const SOCKS_FAMILY = 'socks';

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
					`broken and every check below is looking for nothing`
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

	/*
	 * And the document has to have been read. A path typo or a rename would throw
	 * above, but a fragmenter that quietly produced one giant blob, or nothing at
	 * all, would not — it would simply stop finding things.
	 */
	it('reads the threat model as sentences', () => {
		expect(
			FRAGMENTS.length,
			'docs/THREAT_MODEL.md broke into no sentences at all, so the checks below read nothing'
		).toBeGreaterThan(100);
		expect(
			Math.max(...FRAGMENTS.map((fragment) => fragment.length)),
			'one "sentence" of docs/THREAT_MODEL.md came out longer than any sentence is, so the ' +
				'document was flattened into a blob and a refusal anywhere in it would excuse a ' +
				'promise anywhere else'
		).toBeLessThan(1000);
	});
});

describe('docs/THREAT_MODEL.md tells the truth about proxy schemes', () => {
	it('never names a scheme the transport refuses except to refuse it', () => {
		for (const fragment of FRAGMENTS) {
			for (const scheme of REFUSED) {
				if (!mentions(fragment, scheme)) {
					continue;
				}
				expect(
					REFUSAL_LANGUAGE.test(fragment),
					`docs/THREAT_MODEL.md puts the name ${scheme} in front of a reader without turning ` +
						`it away, and planProxy refuses ${scheme}. This document is published as a true ` +
						`description of the program: somebody configures what it names, the main ` +
						`process turns them away, and the one artifact whose whole job is being ` +
						`checkable has failed its own check. Say plainly that it is refused and why, ` +
						`or stop naming it. The text: "${fragment}"`
				).toBe(true);
			}
		}
	});

	it('still says which schemes do route', () => {
		// A document that simply stopped naming schemes would satisfy the rule
		// above by saying nothing, and silence is its own defect here: §2.6 exists
		// to tell a reader which choice keeps DNS away from their own resolver,
		// which cannot be said without naming one.
		const named = ACCEPTED.filter((scheme) => FRAGMENTS.some((f) => mentions(f, scheme)));
		expect(
			named.length,
			'docs/THREAT_MODEL.md no longer names a single proxy scheme that works, so a reader is ' +
				'left guessing which one keeps their DNS off their own resolver — and this guard has ' +
				'nothing left to check'
		).toBeGreaterThan(0);
	});

	it('names no SOCKS dialect egress.ts has never heard of', () => {
		// `socks4a` and `socks5h` mean different things to different libraries, and
		// the difference is where DNS happens. Prose that invents a dialect — or
		// writes one egress has no table entry for — is making a promise nobody can
		// check, so it fails here and gets written as a name that exists.
		for (const fragment of FRAGMENTS) {
			for (const [dialect] of fragment.matchAll(SOCKS_DIALECT)) {
				const lower = dialect.toLowerCase();
				if (lower === SOCKS_FAMILY) {
					continue;
				}
				expect(
					SCHEME_VOCABULARY.includes(lower),
					`docs/THREAT_MODEL.md names "${dialect}", which egress.ts has no table entry for, ` +
						`so nothing in this app can say whether it routes or leaks. Name a scheme ` +
						`egress knows. The text: "${fragment}"`
				).toBe(true);
			}
		}
	});
});
