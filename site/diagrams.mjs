/**
 * Explanatory diagrams, as inline SVG.
 *
 * ## Why these exist
 *
 * The guides had no images at all. For a page whose reader is mid-problem —
 * staring at a refused code, deciding whether a fifteen-day hold is coming — a
 * wall of prose is the wrong shape of answer, and every competing article has
 * pictures.
 *
 * ## Why not screenshots
 *
 * Screenshots of Steam and Windows are not ours to publish, they go stale with
 * every interface change, and a stale screenshot on a security page is worse
 * than none: the reader trusts the picture over the text and looks for a button
 * that moved two releases ago. So these illustrate the **mechanism** instead —
 * the thirty-second window, the restriction clock, which file holds which half
 * of a decryption. None of that changes when Valve moves a menu, and none of it
 * is illustrated anywhere else.
 *
 * ## Why inline
 *
 * No extra request, so no cost to Core Web Vitals. No fixed dimensions to guess
 * at, so no layout shift. Colours come from the page's own custom properties
 * through the `dg-` classes, so a diagram is correct in both themes without a
 * second copy. And the words inside are real text — selectable, searchable, and
 * read aloud by a screen reader rather than trapped in a bitmap.
 *
 * Each figure carries `role="img"` and an `aria-label` that states the whole
 * point, because a blind reader should get the conclusion, not a list of
 * rectangles.
 */

/** A figure wrapper, so every diagram is announced and captioned the same way. */
const figure = (label, svg, caption) => `
			<figure class="diagram">
				<svg viewBox="0 0 640 200" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
${svg}
				</svg>
				<figcaption>${caption}</figcaption>
			</figure>`;

/**
 * Why a wrong clock produces a wrong code.
 *
 * Two timelines, the same secret, different windows. This is the single idea
 * the troubleshooting page rests on and the one every content farm states
 * without explaining.
 */
export const timeWindowDiagram = () =>
	figure(
		'Two timelines. Steam is inside the window beginning at 10:00:30 and computes code 4B7KP. A device whose clock is ninety seconds slow is still inside the previous window and computes 9QW2M, so Steam refuses it.',
		`					<!-- Steam's timeline -->
					<text x="0" y="26" class="dg-label">Steam's clock</text>
					<line x1="0" y1="52" x2="640" y2="52" class="dg-line" stroke-width="1.5" />
					<g>
						<rect x="120" y="38" width="120" height="28" rx="6" class="dg-fill-panel" />
						<rect x="240" y="38" width="120" height="28" rx="6" class="dg-key" fill="none" stroke-width="1.5" />
						<text x="128" y="57" class="dg-text">10:00:00</text>
						<text x="248" y="57" class="dg-strong">10:00:30 → 4B7KP</text>
					</g>

					<!-- The device's timeline, shifted late -->
					<text x="0" y="118" class="dg-label">Your device, 90 seconds slow</text>
					<line x1="0" y1="144" x2="640" y2="144" class="dg-line" stroke-width="1.5" />
					<g>
						<rect x="120" y="130" width="120" height="28" rx="6" class="dg-bad" fill="none" stroke-width="1.5" />
						<rect x="240" y="130" width="120" height="28" rx="6" class="dg-fill-panel" />
						<text x="128" y="149" class="dg-strong">09:58:30 → 9QW2M</text>
						<text x="248" y="149" class="dg-text">10:00:00</text>
					</g>

					<!-- The mismatch -->
					<text x="380" y="100" class="dg-text">Different window,</text>
					<text x="380" y="118" class="dg-text">different code — refused.</text>`,
		`The secret is identical on both sides. Only the window differs. Steam is checking
				the code for <strong>10:00:30</strong> while a device ninety seconds behind is still
				producing the one for the window before it — so every code is valid, and every code
				is wrong.`
	);

/**
 * What a transfer costs versus what a removal costs.
 *
 * The thirteen-day difference between the two paths is the most actionable
 * number on the site, and a bar is faster to read than a table row.
 */
export const tradeHoldDiagram = () =>
	figure(
		'Two bars. Transferring an authenticator with Move Authenticator produces a two-day restriction. Removing one and enrolling again produces a fifteen-day restriction.',
		`					<text x="0" y="24" class="dg-label">Transfer — Move Authenticator</text>
					<rect x="0" y="36" width="62" height="30" rx="6" class="dg-fill-key" />
					<text x="76" y="56" class="dg-strong">2 days</text>
					<text x="140" y="56" class="dg-text">of trade and Market restriction</text>

					<text x="0" y="112" class="dg-label">Remove, then enrol again</text>
					<rect x="0" y="124" width="465" height="30" rx="6" class="dg-fill-warn" />
					<text x="479" y="144" class="dg-strong">15 days</text>
					<text x="0" y="184" class="dg-text">Same scale. The bar is the wait.</text>`,
		`Both paths end with a working authenticator on the new device. One of them costs
				you thirteen extra days of not being able to trade or use the Market, which is why
				it is worth knowing which one you are about to start.`
	);

/**
 * Why an encrypted maFile needs the manifest beside it.
 *
 * The most common self-inflicted lockout on the whole site, and it is a
 * two-boxes-and-an-arrow idea that prose makes sound more complicated than it is.
 */
export const manifestDiagram = () =>
	figure(
		'An encrypted maFile holds the ciphertext. manifest.json holds the salt and initialisation vector. Decryption needs the passphrase plus both files; copying the maFile alone leaves a file that cannot be opened.',
		`					<rect x="0" y="30" width="200" height="86" rx="10" class="dg-fill-panel" />
					<text x="16" y="56" class="dg-strong">76561…maFile</text>
					<text x="16" y="80" class="dg-text">ciphertext</text>
					<text x="16" y="100" class="dg-label">the account</text>

					<rect x="230" y="30" width="200" height="86" rx="10" class="dg-fill-panel" />
					<text x="246" y="56" class="dg-strong">manifest.json</text>
					<text x="246" y="80" class="dg-text">salt + IV</text>
					<text x="246" y="100" class="dg-label">how to open it</text>

					<line x1="200" y1="73" x2="230" y2="73" class="dg-line" stroke-width="2" />

					<rect x="460" y="30" width="180" height="86" rx="10" fill="none" class="dg-key" stroke-width="1.5" />
					<text x="476" y="56" class="dg-strong">+ passphrase</text>
					<text x="476" y="80" class="dg-text">= readable</text>
					<text x="476" y="100" class="dg-label">all three needed</text>
					<line x1="430" y1="73" x2="460" y2="73" class="dg-line" stroke-width="2" />

					<text x="0" y="156" class="dg-text">Copy only the .maFile and you have kept the locked box</text>
					<text x="0" y="176" class="dg-text">and left the key behind.</text>`,
		`SDA splits the two halves deliberately, which is why an encrypted maFile copied on
				its own cannot be opened even with the right passphrase. Copy the whole
				<code>maFiles</code> folder, never the single file.`
	);
