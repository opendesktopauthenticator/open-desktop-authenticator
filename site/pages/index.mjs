/**
 * The page list. One source for the pages themselves, the navigation, the
 * breadcrumbs, the sitemap and the verifier — so none of them can disagree.
 *
 * Order matters: it is the order of the sitemap and the order a newcomer is
 * assumed to need things in.
 */
import home from './home.mjs';
import sda from './sda.mjs';
import { scamClones, verify, security } from './safety.mjs';
import { download, importFromSda, docs, faq, support, notFound } from './guides.mjs';
import { mafile, lostAuthenticator, alternatives } from './answers.mjs';
import { codeNotWorking, moveAuthenticator, revocationCode, encryptedMafile } from './rescues.mjs';
import { confirmationsOnDesktop, mobileVsDesktop, withoutPhone, openMafile } from './using.mjs';
import owners from './owners.mjs';
import story from './story.mjs';
import { credits, donate } from './support-us.mjs';
import { privacy } from './privacy.mjs';

export const PAGES = [
	home,
	sda,
	scamClones,
	story,
	verify,
	security,
	mafile,
	openMafile,
	encryptedMafile,
	lostAuthenticator,
	revocationCode,
	moveAuthenticator,
	codeNotWorking,
	withoutPhone,
	confirmationsOnDesktop,
	mobileVsDesktop,
	alternatives,
	download,
	importFromSda,
	docs,
	faq,
	support,
	owners,
	credits,
	donate,
	privacy,
	notFound
];
