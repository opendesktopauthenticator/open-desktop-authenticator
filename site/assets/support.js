/*
 * Attachments on the support form.
 *
 * ## Why the files do not ride along with the form
 *
 * The obvious build is `enctype="multipart/form-data"` and a multipart parser on
 * the server. This does not do that. Multipart is a genuinely awkward format —
 * boundary handling, header folding, chunk boundaries falling mid-delimiter —
 * and a parser bug there is a parser bug in the one process on the domain that
 * executes anything. So each file goes up on its own as a plain request body,
 * the server reads it as bytes and identifies it by its signature, and the form
 * then carries nothing but the ids it was given back.
 *
 * ## Progressive enhancement
 *
 * The attachment field ships hidden and this script reveals it. With script
 * disabled the report still sends — it just has no pictures on it — rather than
 * presenting a control that silently does nothing.
 */

(() => {
	'use strict';

	/*
	 * Copy a donation address to the clipboard.
	 *
	 * A button rather than "select it yourself", because a hand-typed payment
	 * address is a lost payment and a partial selection is worse — it fails
	 * silently in some wallets and succeeds into somebody else's in others. The
	 * text stays visible in full so it can still be read and compared, which the
	 * page asks people to do afterwards.
	 */
	document.querySelectorAll('[data-copy]').forEach((button) => {
		button.addEventListener('click', async () => {
			const target = document.getElementById(button.getAttribute('data-copy'));
			if (!target) return;
			const value = target.textContent.trim();
			const say = (text) => {
				button.textContent = text;
				setTimeout(() => {
					button.textContent = 'Copy';
				}, 2200);
			};
			try {
				await navigator.clipboard.writeText(value);
				say('Copied — now check it');
			} catch {
				// Clipboard access can be refused outright. Selecting the text is a
				// worse outcome than copying it, and a much better one than a button
				// that appears to have worked.
				const range = document.createRange();
				range.selectNodeContents(target);
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
				say('Selected — copy it');
			}
		});
	});

	const LIMITS = { image: 6 * 1024 * 1024, video: 20 * 1024 * 1024 };
	const MAX_FILES = 4;

	const bytesLabel = (n) =>
		n >= 1024 * 1024
			? (n / (1024 * 1024)).toFixed(1) + ' MB'
			: Math.max(1, Math.round(n / 1024)) + ' KB';

	document.querySelectorAll('[data-attach]').forEach((field) => {
		const form = field.closest('form');
		const input = field.querySelector('input[type="file"]');
		const zone = field.querySelector('[data-dropzone]');
		const list = field.querySelector('[data-list]');
		if (!form || !input || !zone || !list) {
			return;
		}

		// Nothing below works without fetch and FormData-free uploads; if the
		// browser is too old, leave the field hidden rather than half-working.
		if (!window.fetch || !window.FileReader) {
			return;
		}

		field.hidden = false;

		/** @type {{id: string, kind: string}[]} */
		const done = [];

		const submit = form.querySelector('button[type="submit"]');
		let inFlight = 0;
		const settle = () => {
			if (submit) {
				submit.disabled = inFlight > 0;
				submit.textContent =
					inFlight > 0 ? 'Uploading…' : submit.dataset.label || submit.textContent;
			}
		};
		if (submit) {
			submit.dataset.label = submit.textContent;
		}

		/** The hidden field the server reads the claimed ids from. */
		let carrier = form.querySelector('input[name="attachments"]');
		if (!carrier) {
			carrier = document.createElement('input');
			carrier.type = 'hidden';
			carrier.name = 'attachments';
			form.appendChild(carrier);
		}
		const sync = () => {
			carrier.value = done.map((a) => a.id).join(',');
		};

		function complain(text) {
			const p = document.createElement('p');
			p.className = 'field-error';
			p.textContent = text;
			list.parentNode.insertBefore(p, list);
			setTimeout(() => p.remove(), 8000);
		}

		function card(file) {
			const li = document.createElement('li');
			li.className = 'attachment is-uploading';

			// A local preview, so somebody sees what they picked before it is sent
			// and can catch a screenshot with something private in the corner.
			const url = URL.createObjectURL(file);
			const preview = document.createElement(file.type.indexOf('video/') === 0 ? 'video' : 'img');
			preview.src = url;
			if (preview.tagName === 'VIDEO') {
				preview.muted = true;
				preview.playsInline = true;
			} else {
				preview.alt = '';
			}
			li.appendChild(preview);

			const meta = document.createElement('span');
			meta.className = 'meta';
			const name = document.createElement('span');
			// textContent, never innerHTML: this is a filename chosen by whoever is
			// sitting at the keyboard, and it is about to go into the page.
			name.textContent = file.name.length > 16 ? file.name.slice(0, 15) + '…' : file.name;
			const size = document.createElement('span');
			size.className = 'bytes';
			size.textContent = bytesLabel(file.size);
			meta.appendChild(name);
			meta.appendChild(size);
			li.appendChild(meta);

			list.appendChild(li);
			return { li, url };
		}

		async function upload(file) {
			const kind = file.type.indexOf('video/') === 0 ? 'video' : 'image';
			if (file.size > LIMITS[kind]) {
				complain(
					'“' +
						file.name +
						'” is ' +
						bytesLabel(file.size) +
						', over the ' +
						LIMITS[kind] / (1024 * 1024) +
						' MB limit for a ' +
						kind +
						'.'
				);
				return;
			}
			if (done.length >= MAX_FILES) {
				complain('Four files at most.');
				return;
			}

			const { li, url } = card(file);
			inFlight += 1;
			settle();
			try {
				const response = await fetch('/support/attach', {
					method: 'POST',
					// Sent as an opaque blob. The server decides what it is by looking.
					headers: { 'content-type': 'application/octet-stream' },
					body: file
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok) {
					throw new Error(payload.error || 'That file was not accepted.');
				}
				done.push({ id: payload.id, kind: payload.kind });
				sync();
				li.classList.remove('is-uploading');

				const remove = document.createElement('button');
				remove.type = 'button';
				remove.textContent = 'Remove';
				remove.addEventListener('click', () => {
					const at = done.findIndex((a) => a.id === payload.id);
					if (at >= 0) done.splice(at, 1);
					sync();
					URL.revokeObjectURL(url);
					li.remove();
				});
				li.appendChild(remove);
			} catch (error) {
				complain(error.message);
				URL.revokeObjectURL(url);
				li.remove();
			} finally {
				inFlight -= 1;
				settle();
			}
		}

		const take = (files) => Array.prototype.slice.call(files).forEach(upload);

		input.addEventListener('change', () => {
			take(input.files);
			// Cleared so choosing the same file twice still fires a change.
			input.value = '';
		});

		zone.addEventListener('click', (event) => {
			if (event.target !== input) input.click();
		});
		zone.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				input.click();
			}
		});

		['dragenter', 'dragover'].forEach((name) =>
			zone.addEventListener(name, (event) => {
				event.preventDefault();
				zone.classList.add('is-over');
			})
		);
		['dragleave', 'drop'].forEach((name) =>
			zone.addEventListener(name, (event) => {
				event.preventDefault();
				zone.classList.remove('is-over');
			})
		);
		zone.addEventListener('drop', (event) => {
			if (event.dataTransfer && event.dataTransfer.files) take(event.dataTransfer.files);
		});
	});
})();
