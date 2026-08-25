# Microsoft Store listing

The exact text submitted to Partner Center, kept here rather than only in the
dashboard.

A Store listing is re-entered on every submission and is invisible to CI, so it
is the one piece of user-facing copy nothing in this repository would catch
drifting. `README.md`, `site/pages/home.mjs` and this file all describe the same
product to the same people; when one changes the others are wrong until they do
too.

**Product**: Open Desktop Authenticator · **Store ID**: 9NMM2XJ6HZ1D
**Package identity**: `TheMaster.OpenDesktopAuthenticator`

> [!NOTE]
> **The live listing is one sentence behind this file.** Submission 1 went to
> certification carrying "our download button only ever links a file published
> on our GitHub releases page", written when GitHub was the only channel. It
> stopped being true the moment this listing existed. A submission cannot be
> edited while it is in certification, so the corrected wording below ships with
> the next one — there is no user-visible harm in the meantime, since the
> sentence understates where the app is available rather than overstating it.

---

## Description

> Open Desktop Authenticator keeps your Steam Guard codes and your trade and
> market confirmations on your own machine. It is open source, and it is a
> maintained successor to Steam Desktop Authenticator.
>
> **Why this exists**
>
> The tool much of Steam trading depends on, Steam Desktop Authenticator, is no
> longer maintained. Search for it and the results are full of clone sites
> shipping modified builds that steal accounts. Our founder lost about $3,000 to
> exactly that. Those sites are still there, and they come back under new domains
> every time one is reported.
>
> Being open source is not by itself an answer, because an attacker can compile
> open source with malware added. What answers it is a chain you can walk without
> having to trust us: a company that says who it is, a public repository, a build
> produced by public CI from a specific commit, and a published hash for the file
> you downloaded. Installing from the Microsoft Store is the short version of
> that chain — Microsoft builds the trust link for you.
>
> **What it does**
>
> - An encrypted vault for as many accounts as you have, unlocked with a
>   passphrase you choose.
> - Imports the maFiles you already have from Steam Desktop Authenticator.
> - Steam Guard codes.
> - Trade and market confirmations: see what is pending, accept it or deny it.
> - Optional auto-confirm, configurable per account and per confirmation type,
>   and off until you turn it on.
> - Optional per-account network routing.
>
> **What it will never do**
>
> No servers. No sync. No accounts with us. No telemetry of any kind, including
> the opt-in kind. No paid tiers. We run no backend for this product: your
> machine talks to Valve directly and to nothing of ours.
>
> It also does not automate trading beyond confirming what you already started,
> and has no market or inventory tooling. Those are not features we have not got
> to yet. They are things we have decided not to build.
>
> **Before you install anything else**
>
> Never download an authenticator from a website, including ours. This listing
> and our GitHub releases page are the only two places a genuine build comes
> from, and our own website hosts no installer — every button on it links to one
> of those two. Anything else claiming to be this application is not ours.
>
> Source, documented threat model and build instructions:
> https://github.com/opendesktopauthenticator/open-desktop-authenticator
>
> Open Desktop Authenticator is not affiliated with, endorsed by, or sponsored by
> Valve Corporation. Steam and Steam Guard are trademarks of Valve Corporation.

## Product features

Up to 20, 200 characters each. These render as a bulleted list above the
description.

- Encrypted multi-account vault, unlocked with a passphrase you choose
- Imports your existing Steam Desktop Authenticator maFiles
- Steam Guard codes
- Trade and market confirmations: view, accept, deny
- Optional auto-confirm, per account and per type, off by default
- Optional per-account network routing
- Runs entirely on your machine: no servers, no sync, no telemetry, no accounts
- Open source, built in public CI, MIT licensed

## Short description

> Steam Guard codes and trade confirmations on your own machine. Open source, no
> servers, no telemetry. A maintained successor to Steam Desktop Authenticator.

## Search terms

Seven maximum, 30 characters each, not shown to users.

`steam authenticator`, `steam guard`, `sda`, `trade confirmations`,
`steam 2fa`, `desktop authenticator`, `maFile`

## Copyright and trademark info

> Copyright © 2026 MASTERPANEL LLC. Licensed MIT. Steam and Steam Guard are
> trademarks of Valve Corporation. Open Desktop Authenticator is not affiliated
> with, endorsed by, or sponsored by Valve Corporation.

## Additional system requirements

> Windows 10 version 1809 (build 17763) or later.

Matches `minVersion` in `electron-builder.config.mjs`, which is Chromium's floor
for the Electron this ships. Stated here because the Store shows it to people
deciding whether to install.

## Developed by

> MASTERPANEL LLC

---

## Notes for whoever files the next submission

- **Screenshots must never show a real account.** Run the application against an
  empty data directory and screenshot that. A listing image is public
  permanently, and a SteamID or persona name in one is not retractable.
- The description repeats the "never download an authenticator from a website"
  warning on purpose. It is the single most useful sentence in the listing for
  the person most at risk, and the Store page is where they arrive.
- Do not describe the product as audited. It is tested, by the maintainer,
  against live accounts. `README.md` draws the same line and so should this.
