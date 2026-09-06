# Microsoft Store listing

The canonical Partner Center working copy, kept here rather than only in the
dashboard. It records the submitted text and explicitly marks any clarification
prepared after the current submission.

A Store listing is re-entered on every submission and is invisible to CI, so it
is the one piece of user-facing copy nothing in this repository would catch
drifting. `README.md`, `site/pages/home.mjs` and this file all describe the same
product to the same people; when one changes the others are wrong until they do
too.

**Product**: Open Desktop Authenticator · **Store ID**: 9NMM2XJ6HZ1D
**Package identity**: `TheMaster.OpenDesktopAuthenticator`
**Live package**: `1.5.0.0` · **Architecture**: `x64`

> [!NOTE]
> **Version 1.5.0 is live in the Microsoft Store.** Submission 2 is the current
> public listing. Submission 3 was submitted on 2026-09-07, marks the 1.5.0
> package update as mandatory, uses the approved four-sentence no-backend
> wording shown verbatim below, and is in certification. The
> proxy-qualified route sentence below was clarified in this repository after
> submission and is not part of Submission 3; apply it only when the listing is
> next editable. Changes unique to Submission 3 are not public until Microsoft
> publishes it.

---

## Description

> Open Desktop Authenticator keeps your Steam Guard codes and your trade and
> market confirmations on your own machine. It is an open-source, maintained
> successor to Steam Desktop Authenticator.
>
> Open Desktop Authenticator is developed, owned and published by MASTERPANEL
> LLC. Its official product website is https://opendesktopauthenticator.com.
> MASTERPANEL LLC also operates Master Panel at https://masterspanel.com, its
> principal commercial product and company website. Open Desktop Authenticator
> and Master Panel are separate products within the same MASTERPANEL LLC
> portfolio.
>
> WHY THIS EXISTS
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
> WHAT IT DOES
>
> - An encrypted vault for as many accounts as you have, unlocked with a
>   passphrase you choose.
> - Imports the maFiles you already have from Steam Desktop Authenticator.
> - Steam Guard codes.
> - Trade and market confirmations: see what is pending, accept it or deny it.
> - An isolated signed-in Steam browser for each account, with tabs, an address
>   bar and a routing choice for every window.
> - Optional desktop notifications for pending confirmations, off by default and
>   with selectable detail.
> - Optional per-account network routing and a vault-wide Require proxies
>   setting.
> - Optional auto-confirm, configurable per account and per confirmation type,
>   and off until you turn it on.
>
> WHAT IT WILL NEVER DO
>
> No ODA backend. No ODA account. No cloud sync. No telemetry. No paid tiers.
> Steam operations go from your machine to Valve, using any route or proxy you
> configure, without passing through an ODA service.
>
> It also does not automate trading beyond confirming what you already started,
> and has no market or inventory tooling. Those are not features we have not got
> to yet. They are things we have decided not to build.
>
> BEFORE YOU INSTALL ANYTHING ELSE
>
> Never download an authenticator from a website, including ours. This listing in
> the Microsoft Store and our GitHub releases page are the only two places a
> genuine build comes from. The official product website,
> https://opendesktopauthenticator.com, hosts no installer — its download buttons
> lead to one of those two channels. MASTERPANEL LLC's main site,
> https://masterspanel.com, identifies the same publisher and links to the
> product. Anything else claiming to be this application is not ours.
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
- No ODA backend. No ODA account. No cloud sync. No telemetry.
- Open source, built in public CI, MIT licensed
- Separate signed-in Steam browser session for each account
- Optional desktop notifications for confirmations, off by default

## What's new in this version

1,486 characters in Partner Center, leaving 14 characters below the Store's
1,500-character limit.

> Version 1.5 brings an isolated browser, notifications and safer recovery.
>
> BROWSER
> Open trade offers, market listings, account settings and supported trading
> sites inside the app. Each account has separate cookies and a signed-in
> session, so one account's sign-in is never reused by another. Locking the vault
> closes all browser windows and ends every Steam session.
>
> ROUTING
> For each window, choose: use the account proxy for everything; use it for Steam
> while supported trade sites go Direct; or use Direct throughout. Require
> proxies removes the Direct choices. Direct is offered honestly: a shared proxy
> collects rate limits and challenges a home connection never sees, so the
> routed window is sometimes the one that will not load.
>
> NOTIFICATIONS
> Confirmation notifications are off until you turn them on. Clicking one opens
> that account's confirmations, even if the vault locked in between. Choose
> Everything, Type only or Count only. Notifications may appear on your lock
> screen and remain in Windows notification history, so choose less detail on a
> shared computer.
>
> SAFER STEAM CHANGES
> Adding, activating, removing or transferring an authenticator can reach Steam
> before its reply is lost. If the outcome is unknown, the app stops and asks
> you to check the account instead of offering the action again. Retrying
> something Steam may already have done can leave you without access. The app
> remembers the uncertain state across closing the screen, locking the vault and
> restarting.

## Short description

> Steam Guard codes and trade confirmations on your own machine. Open source.
> No ODA backend. No ODA account. No cloud sync. No telemetry.
> A maintained successor to Steam Desktop Authenticator.

## Search terms

Seven maximum, 30 characters each, not shown to users.

`steam authenticator`, `steam guard`, `sda`, `trade confirmations`,
`steam 2fa`, `desktop authenticator`, `maFile`

## Copyright and trademark info

> Copyright © 2026 MASTERPANEL LLC. Licensed MIT. Steam and Steam Guard are
> trademarks of Valve Corporation. Not affiliated with, endorsed by, or
> sponsored by Valve Corporation.

175 characters; Partner Center limits this field to 200.

## Website and support

- Website: `https://opendesktopauthenticator.com`
- Support contact: `support@opendesktopauthenticator.com`
- Privacy policy: `https://opendesktopauthenticator.com/privacy`

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
