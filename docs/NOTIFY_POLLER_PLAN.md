# Confirmation notifications — implementation plan

**Status: signed off on the decisions; implementation held pending further
review.**
**Revision 5** — four corrections from a verification pass against the real
tree, marked **[r5]**. Two audit findings were **refuted** and are recorded as
refuted (§13), because a plan that quietly drops a claim teaches the next
reader nothing. The toast default is **`full`**, set by the owner against the
recommendation in revision 3 (§2.1 records both). Revision 2's corrections,
marked **[r2]**, record what revision 1 got wrong; they are kept because several
were wrong in the direction of sounding safer than the code is.

Poll Steam for pending confirmations on an interval the user sets, raise a
desktop notification when one appears that needs a person, and warn — where the
interval is set — that a short one risks rate-limiting.

---

## 1. The two decisions everything else follows from

### 1.1 Extend `AutoConfirmEngine`; do not add a second poller

A second poller would double mobileconf traffic per account and duplicate
backoff, halt, lock handling and stagger. It would _cause_ the rate-limiting
this feature is supposed to warn about.

What the engine already has:

| Property               | Where                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| 10s floor per account  | `MIN_INTERVAL_MS`                                                         |
| 1s beat, early-out     | `SCHEDULER_TICK_MS`, `earliestDueAt`                                      |
| Stagger                | `staggerFor(index, intervalMs)` — **sweep index**, capped at `interval/4` |
| 30s→15min backoff      | `BACKOFF_START_MS`, `BACKOFF_MAX_MS`                                      |
| Halt after 10 failures | `HALT_AFTER_FAILURES`                                                     |
| Stops on lock          | `stop()`, generation counter                                              |

> **[r2] Revision 1 said the stagger was "derived from the SteamID".** It is
> not. A SteamID hash over `interval / 4` was **removed** because it was finer
> than the 1s sampling beat, so every account still landed on the same beat and
> polled in lockstep. The current stagger is the account's index within the
> sweep. Do not "restore" a SteamID hash.
>
> The `staggerFor` docblock in `auto.ts` still claims the SteamID derivation and
> contradicts the code directly beneath it — that is where revision 1 got it
> from. **Fix that comment in phase 3**, in passing.

### 1.2 A notify-only account polls through `list()`, never `runAutoConfirm()`

> **[r2] Revision 1 stated the danger wrongly, and overstated it.** It claimed
> `runAutoConfirm` on a notify-only account "would auto-confirm trades they
> never automated". It would not: the method returns
> `{ approved: [], held: [], unreadable: 0 }` when both auto types are off.

The real failure is quieter and still bad:

- It returns an empty outcome, so **nothing is ever notified** — a feature that
  is switched on, polls Steam forever, and does nothing.
- It pays for `connect()` first, so it spends the request anyway.
- It is one edit away from becoming the overstated version, if the early return
  is ever moved or a third auto type is added.

So `list()` is right on both correctness and defence in depth, and the mutation
test stays. Pin it for what it actually is: **never lists, so never notifies.**

---

## 2. Decisions

All five answered. No open questions remain.

| #   | Decision                        | Detail                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Toast default is **`full`**     | `"Trade with SomeTrader — you give: AK-47 Redline"`. **Owner's decision, against revision 3's recommendation of `type`; see §2.1 for both sides.**                                                                                                                                                                                                                                                      |
| 2   | Silent seed **with carve-outs** | The first poll for an account seeds without toasting, so unlocking with twenty pending confirmations does not fire twenty toasts — **except** for `securityCritical` entries and a non-zero `unreadable`, which notify even on the first poll. Without that, unlocking to a pending account takeover would show nothing at all: notify-only polls write no activity entry, so there is no badge either. |
| 3   | **Per-account**                 | Beside the interval it already shares.                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | A halt **does** notify          | And `onFailure`'s copy — _"Automatic confirmation stopped for this account…"_ — is reworded, because it is the wrong sentence for an account that was only ever watching.                                                                                                                                                                                                                               |
| 5   | **Click-to-open: yes, now**     | It is a new main→renderer IPC surface. Designed in §8.                                                                                                                                                                                                                                                                                                                                                  |

### 2.1 Why the toast default is `full`, and what it costs

Revision 3 recommended `type` and the owner chose `full`. Both arguments belong
here, because the reasoning is what a later reader needs — not the winner.

**Against `full`:** a Windows toast is not a private surface. It appears on the
lock screen and persists in notification history, so `full` puts the trade
partner and the item names somewhere a person walking past the desk can read,
and somewhere they remain after the toast is gone. `headline` and `summary` are
also **Steam-controlled strings**, so `full` renders text this application did
not author into an OS-level surface.

**For `full`, and why it settles it:** notifications are **off by default**. A
toast cannot reach anybody who has not first opened the AutoConfirm screen for
that account and switched them on — which is exactly where the disclosure sits.
The person the privacy argument protects, one who receives `full` toasts without
having chosen to, does not exist in this design. And a notification whose whole
job is to say whether something is worth interrupting for is more useful when it
says what the trade is.

**What this obliges, and it is not optional:**

- The disclosure on the AutoConfirm screen is no longer a footnote on an opt-in
  path. It sits **beside the enable switch**, not beside the `full` radio, and
  states plainly that toasts will name the trade and its items and that Windows
  keeps them in notification history.
- `count` and `type` remain, and the screen presents them as the answer for a
  shared or overlooked machine.
- The Steam-controlled strings are **length-capped and stripped of control
  characters** before they reach a toast. This is the one place text this app
  did not write reaches an OS surface, and `full` makes it the default path
  rather than an opt-in one.

#### **[r5] The Windows lock screen, which is not the vault lock**

Revision 4 leaned on "a toast appears on the lock screen" without separating
two different locks, and the distinction changes what has to be built.

**The vault lock needs nothing.** When the vault locks, `tick()` returns at its
`!this.vault.isUnlocked()` check (`auto.ts:225`) before any poll happens, and
`notifier.forget()` runs in the lock teardown. No poll, so no toast. The
renderer independently clears its account list (`App.tsx:192-198`), the main
process reloads the whole document (`index.ts:347-349`), and `accountsList`
throws `VaultLockedError` while locked — three layers, all agreeing that a
locked app shows no account names. Nothing further is required here, and an
earlier draft of this section that proposed degrading `full` while the _vault_
is locked was solving a case the engine already makes unreachable.

**The Windows lock screen is a different condition, and the code does nothing
about it.** The vault can be unlocked, the poller running, while the person has
locked Windows and walked away. That is the case where a `full` toast prints
the trade partner and the item on a screen in an empty room — and where it
persists in notification history afterwards.

So the rule is about the **session**, not the vault:

```ts
// `powerMonitor` reports the Windows session lock, which is unrelated to the
// vault's own lock. The vault lock stops polling outright; this one does not,
// so it is the only case where a toast can reach an unattended screen.
powerMonitor.on('lock-screen', () => notifier.setSessionLocked(true));
powerMonitor.on('unlock-screen', () => notifier.setSessionLocked(false));
```

While the session is locked the notifier composes at **`count`** regardless of
the account's `detail`. The toast still fires — the point is that something is
waiting — it just stops naming what. This is not a reversal of the `full`
decision: `full` remains the default for the case the owner actually reasoned
about, a person sitting at their machine.

**What this does not fix, and the disclosure must say so:** a `full` toast
raised while the session was unlocked stays in Windows notification history and
is readable after a later lock. Degrading on the transition does not retract
what was already shown. The sentence beside the enable switch says this.

---

## 3. Phase 1 — schema and defaults

**Gate: full suite green, no behaviour change.**

### Step 1.1 · `src/shared/vault-schema.ts`

```ts
/**
 * How much a confirmation notification says.
 *
 * A toast is not a private surface: Windows keeps it in notification history
 * and shows it on the lock screen. `full` names the trade partner and the items
 * — which is what makes it useful and what makes it a disclosure.
 *
 * It is the default anyway, and the reason is that notifications are **off** by
 * default: nothing reaches a toast until somebody opens this account's screen
 * and switches them on, which is where the disclosure sits. `count` and `type`
 * are there for a shared or overlooked machine.
 *
 * The strings `full` prints are Steam's, not ours — the only place text this
 * application did not author reaches an OS surface. They are length-capped and
 * stripped of control characters on the way.
 */
export const notifyDetailSchema = z.enum(['count', 'type', 'full']);
export type NotifyDetail = z.infer<typeof notifyDetailSchema>;
```

```ts
export const AUTO_CONFIRM_DEFAULTS = {
  marketListings: false,
  trades: false,
  pollIntervalSeconds: 15,
  notify: { enabled: false, detail: 'full' }
} as const;
```

```ts
notify: z.object({
  enabled: z.boolean().default(false),
  detail: notifyDetailSchema.default('full')
})
  // **[r2] The nested object needs its own `.passthrough()`.** The outer
  // `autoConfirmSchema` has one, which protects a sibling key called `notify`
  // — it does not protect keys *inside* it. Without this, a future build
  // adding `notify.sound` would have it stripped by the next `mutate()` in an
  // older build, which is exactly the promise the top of this file makes.
  .passthrough()
  .default({ enabled: false, detail: 'full' });
```

> **Known wrinkle.** `AUTO_CONFIRM_DEFAULTS` is `as const`, so nested `notify`
> is deeply readonly and `z.object().default(AUTO_CONFIRM_DEFAULTS)` on
> `accountSchema` may reject it. Spread at the use site rather than dropping
> `as const` — several places rely on its literal types.

### Step 1.2 · Tests

- an account with no `notify` parses, and comes back disabled
- `detail` outside the enum is refused
- `pollIntervalSeconds` floor of 10 unchanged
- **[r2]** an unknown key **inside** `notify` survives a `mutate()` round trip.
  Revision 1 pointed this test at the outer object, where it would have passed
  without testing the thing that can actually be lost.

---

## 4. Phase 2 — the projection

**Gate: full suite green, no behaviour change.**

### Step 2.1 · `src/main/vault/service.ts`

```ts
autoConfirmSchedule(): {
  steamId64: string;
  /** [r2] For the toast title. Not a secret, and the alternative is `read()`,
   *  which deep-clones every secret the vault holds on every beat. */
  accountName: string;
  marketListings: boolean;
  trades: boolean;
  pollIntervalSeconds: number;
  notify: { enabled: boolean; detail: NotifyDetail };
  /** Whether a proxy is stored — not the URL. The engine only needs to know
   *  whether `Require proxies` would refuse this account. */
  hasProxy: boolean;
}[]
```

> **[r2]** Revision 1 said the toast title is the account name and never
> supplied it. Adding it here is the cheap fix; reaching for `read()` in the
> notifier is the expensive one this method exists to avoid.

### Step 2.2 · Tests

- the projection carries `accountName`, `notify` and `hasProxy`
- it still carries no secrets — assert the returned object's keys **exactly**

---

## 5. Phase 3 — the engine

**Gate: full suite green. `onPending` fires; nothing consumes it yet.**

### Step 3.1 · Mode

```ts
/**
 * Why this account is being polled.
 *
 * `confirm` acts on what it finds; `notify` only looks. `runAutoConfirm` is
 * the approve path, and it returns an empty outcome when neither auto type is
 * on — so sending a notify-only account through it produces a feature that
 * polls forever and never tells anybody anything.
 */
type PollMode = 'confirm' | 'notify';
```

### Step 3.2 · `dueAccounts()`

```ts
const wantsConfirm = account.marketListings || account.trades;
const wantsNotify = account.notify.enabled;

if (!wantsConfirm && !wantsNotify) {
  this.state.delete(account.steamId64);
  continue;
}

// Under `Require proxies` an account with none cannot build a transport at
// all — `transports.forAccount` throws — so polling it spends ten failures
// reaching a halt caused by a policy refusal rather than a fault, and then
// hides the account until something unrelated changes.
if (this.requireProxies() && !account.hasProxy) {
  this.state.delete(account.steamId64);
  continue;
}

// ...existing halted / nextDueAt checks unchanged...

due.push({
  steamId64: account.steamId64,
  accountName: account.accountName,
  pollIntervalSeconds: account.pollIntervalSeconds,
  mode: wantsConfirm ? 'confirm' : 'notify',
  notify: wantsNotify,
  detail: account.notify.detail
});
```

`requireProxies` is a new `AutoConfirmEngineOptions` field defaulting to
`() => false`, wired in `index.ts` to the **existing** reader the transports
already use — not a second one.

### Step 3.3 · `tick()` — **[r2] revision 1 forgot this entirely**

`tick()` currently calls `runOne(steamId64, pollIntervalSeconds, generation, index)`.
The new `mode`, `notify`, `accountName` and `detail` have to be threaded
through it. Revision 1 changed `runOne`'s body and left its only caller
unchanged, which would not compile.

### Step 3.4 · `runOne()`

Scheduling, backoff, halt and generation handling **unchanged**. Only the call
in the middle branches:

```ts
if (mode === 'confirm') {
  const outcome = await this.confirmations.runAutoConfirm(steamId64);
  if (this.generation !== generation) {
    this.onOutcome(steamId64, outcome);
    // [r2] and **no** onPending here. A lock happened; a toast raised after
    // the vault closed is precisely what `stop()` exists to prevent.
    return;
  }
  // ...existing state.set, onOutcome...
  if (notify) {
    // `held` is the set that still needs a person: anything Steam listed that
    // the policy refused.
    this.onPending(
      steamId64,
      accountName,
      outcome.held.map((h) => h.confirmation),
      outcome.unreadable,
      detail
    );
  }
} else {
  let listing;
  try {
    listing = await this.confirmations.list(steamId64);
  } catch (err) {
    // [r2] `ConfirmationListing` is `{ confirmations, unreadable }` — there is
    // no `signInRequired` on it. That field is synthesised in
    // `confirmations/ipc.ts` by catching this error. Revision 1 read
    // `listing.signInRequired`, which does not compile — and worse, the throw
    // would have counted toward the ten-strike halt, stopping an account for a
    // reason no amount of backing off fixes.
    //
    // Calling the IPC handler instead is not an option either: it runs
    // `vault.touch()`, so a background poll would defer the idle auto-lock
    // every time it ran.
    if (err instanceof ConfirmationsError && err.needsSignIn) {
      if (this.generation !== generation) return;
      this.state.set(steamId64, { nextDueAt: this.now() + interval + jitter });
      this.rememberEarliest();
      this.onSignInNeeded(steamId64, accountName);
      return;
    }
    throw err; // the existing catch below handles it: backoff, halt, report
  }
  if (this.generation !== generation) return;
  // ...existing state.set...
  this.onPending(steamId64, accountName, listing.confirmations, listing.unreadable, detail);
}
```

### Step 3.5 · New options

```ts
/** Confirmations now awaiting a person, after a poll of either kind. */
onPending: (
  steamId64: string,
  accountName: string,
  awaiting: ConfirmationSummary[],
  unreadable: number,
  detail: NotifyDetail
) => void;
/** A notify poll that found the session needs a password. */
onSignInNeeded: (steamId64: string, accountName: string) => void;
/** Whether the vault refuses to talk to Steam without a proxy. */
requireProxies?: () => boolean;
```

The activity log is **not** written on a notify-only poll — an entry per poll
would bury the entries that matter. See open question 2 for what that costs.

### Step 3.5a · `onFailure` has to widen — **[r5]**

**Every revision of this plan up to r4 was internally inconsistent here.**
Decision 4 says a halt notifies and that its copy is reworded for an account
that was only ever watching. §4.2 says the toast title is the account name.
Neither is reachable, because the callback that reports a halt is unchanged
from the shipped signature:

```ts
onFailure?: (steamId64: string, reason: string, halted: boolean) => void;
```

`steamId64` and a pre-formatted English sentence. No `accountName`, no `mode`.
`index.ts:531` wires it straight to `activity.recordFailure`, and the only way
that consumer could resolve a name is `vault.read()` — which deep-clones every
shared secret, identity secret and revocation code, and is the exact cost
`autoConfirmSchedule()` exists to avoid. So the halt toast this plan promises
could not have been built from what the plan gave it.

The fix is small because §3.3 already threads `accountName` and `mode` into
`runOne`, which is where both call sites live. They just are not passed on:

```ts
onFailure?: (
  steamId64: string,
  reason: string,
  halted: boolean,
  // **[r5] New, and both are already in `runOne`'s scope.**
  context?: { accountName: string; mode: PollMode }
) => void;
```

Optional, so the existing `activity.recordFailure` wiring keeps compiling and
keeps ignoring it; the notifier is the consumer that reads it.

**The halt sentence is composed from `mode`, not reworded once.** An account
with `mode === 'notify'` never had automatic confirmation to stop:

| `mode`    | Halt copy                                                      |
| --------- | -------------------------------------------------------------- |
| `confirm` | `Automatic confirmation stopped for <name> after 10 failures.` |
| `notify`  | `Stopped checking <name> after 10 failures.`                   |

**Keep `halted` a flag, do not infer it from the text.** `auto.ts:397-398`
records that the activity log used to decide this by running `/stopped/i` over
the sentence, and that reading the flag replaced it. Both sentences above
contain "stopped", so the old approach would now be ambiguous as well as
fragile.

### Step 3.6 · Fix the stale comment **[r2]**

Rewrite the `staggerFor` docblock, which still describes the SteamID derivation
that was removed. It is what misled revision 1 of this plan.

### Step 3.7 · Tests — `tests/auto-confirm-engine.test.ts`

| Test                            | Asserts                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| notify-only account is polled   | appears in a sweep with both auto types off                                       |
| **notify-only uses `list`**     | `runAutoConfirm` never called for it                                              |
| auto-confirm account still acts | `runAutoConfirm` called, `list` not                                               |
| both on                         | one poll not two; `onPending` receives `held`                                     |
| neither on                      | never polled; state entry deleted                                                 |
| `Require proxies` + no proxy    | skipped, halt counter untouched                                                   |
| `needsSignIn`                   | `onSignInNeeded`; **no** failure counted; normal interval                         |
| a real failure                  | still backs off and still halts at ten                                            |
| lock mid-poll                   | no `onPending` on the disowned generation                                         |
| **[r5] halt carries context**   | `onFailure`'s 4th argument has this account's name and mode                       |
| **[r5] halt copy by mode**      | `notify` says "Stopped checking"; `confirm` says "Automatic confirmation stopped" |
| **[r5] `halted` stays a flag**  | both sentences contain "stopped"; the flag still distinguishes them               |
| backoff / halt / lock / stagger | existing tests still pass unchanged                                               |

---

## 6. Phase 4 — the notifier

**Gate: full suite green. Notifications appear.**

### Step 4.1 · `src/main/confirmations/notify.ts` (new)

```ts
/** The slice of Electron this needs. Injected so it is testable headless. */
export interface ToastHost {
  show(options: { title: string; body: string }): void;
}
```

State: `Map<steamId64, { seen: Set<string>; toldSignInNeeded: boolean }>`.

> **[r2]** `toldSignInNeeded` is new. Revision 1 specified `onSignInNeeded` on
> the engine and gave nothing that consumed it, then claimed "no repeat toast
> per poll" with nothing to make that true.

`pending(...)` behaviour:

1. **First poll for an account seeds** — record every id — **but still notifies
   for `securityCritical` entries and a non-zero `unreadable`** (see Q2).
   Everything else is silent.
2. Otherwise the new ids are `awaiting` minus `seen`. If empty, return.
3. Prune ids no longer pending, bounding the set.
4. `unreadable > 0` notifies. Steam sent something this build could not parse,
   which is exactly the case a person must look at.

`forget()` (on lock) and `forgetAccount(steamId64)` clear state.
**[r2]** `forgetAccount` must be called from the account-removal path, beside
the other per-account `forget`s.

### Step 4.2 · Body text

| `detail` | Body                                                           |
| -------- | -------------------------------------------------------------- |
| `count`  | `2 confirmations need you`                                     |
| `type`   | `1 trade, 1 market listing`                                    |
| `full`   | `Trade with <partner> — you give: <first item>` then `+N more` |

**`full` is the default, so its input is treated as untrusted.** `headline` and
`summary` are Steam's strings. Before either reaches a toast it is capped in
length and stripped of control characters — this is the only path on which text
this application did not author reaches an OS-level surface.

Title is the account name, from the projection (§2.1).

### Step 4.2a · The session-lock degrade — **[r5]**

`setSessionLocked(boolean)` on the notifier, fed by `powerMonitor` (§2.1).
While true, every body is composed at `count` whatever the account's `detail`
says. It is one branch in the body formatter, not a second code path.

Tests: `full` with the session locked produces the `count` body · `type` with
the session locked produces the `count` body · unlocking restores `full` · the
account's stored `detail` is never mutated by a lock.

### Step 4.2b · "Sign in again" needs an activity kind — **[r5]**

An audit asked for deduplicated transition-only activity entries for four
conditions. **Three of the four already have what it asked for**, and the
fourth needs something different from what it asked for. See §14 for the
refutations; this step is the part that survived.

A poll that fails because the saved session expired reaches the log through
`auto.ts`'s generic catch as `kind: 'failed'`, and `hasUrgent()`
(`activity.ts:154-167`) lists `held`+`securityCritical`, `halted` and
`unreadable` — **not `failed`**. So the one condition that no amount of
retrying fixes, and that only the user can clear, is the one the activity badge
stays silent about. It surfaces only after ten strikes, as a `halted` entry
phrased as "failures in a row".

The engine already distinguishes it: §3.4 catches
`err instanceof ConfirmationsError && err.needsSignIn` and calls
`onSignInNeeded` rather than counting a failure. That branch currently writes
nothing to the log.

```ts
// activity.ts — a sixth kind, mirrored in the wire schema's discriminated union.
| { kind: 'signInRequired'; at: string }
```

added to `hasUrgent()`'s predicate beside `halted` and `unreadable`.

**Deduplicate by state, not by transition, and not by text.** A plain append
would add one entry per poll for as long as the session stays expired. But
recording only the transition collides with `acknowledgedSeq`
(`activity.ts:157`): acknowledge advances a high-water mark, so a
transition-only entry the user acknowledges makes a still-broken account read
as clear until it flips and flips back. The rule that satisfies both:

> Append a `signInRequired` entry only when the account's most recent entry is
> not already `signInRequired`. Resolve it by appending nothing — the next
> successful poll's own entry ends the run.

Keyed on the **kind**, never on the reason string. `activity.ts:112-116`
records that classification by message text was removed once already, because
the wording is composed in another file.

Tests: a repeated sign-in failure appends one entry, not one per poll ·
`hasUrgent()` is true for it · a successful poll between two failures lets the
second append · the reason text is never read to decide the kind.

### Step 4.3 · `src/main/index.ts` wiring

```ts
const notifier = new ConfirmationNotifier({
  show: ({ title, body }) =>
    new Notification({
      title,
      body,
      // 256px. The tray icon exists at 16 and 32 only, and Windows upscaling it
      // is what made the existing tray balloon blurry.
      icon: notificationImage()
    }).show()
});
```

`windows-identity.ts` already sets an AppUserModelID, which Windows requires for
toasts, so there is no packaging work. `notifier.forget()` joins the existing
lock teardown beside `confirmations.forget()`.

> **[r2] No click handler in this phase.** See §7.5.

### Step 4.4 · Tests — `tests/confirmation-notify.test.ts` (new)

first poll seeds silently · first poll **does** toast for `securityCritical` ·
first poll **does** toast for `unreadable > 0` · second poll with a new id
toasts once · same id twice toasts once · resolved id pruned, and a reappearing
id toasts again · `unreadable > 0` with no new ids toasts · each `detail`
produces its exact body · an over-long Steam string is capped · a Steam string
containing control characters is stripped · several accounts have distinct titles and separate
sets · `forget()` re-seeds · `forgetAccount` drops one · `onSignInNeeded` toasts
once and not again until cleared.

---

## 7. Phase 5 — reaching the screen

**Gate: full suite green. Feature reachable.**

> **[r2] Revision 1's phase 5 could not have worked.** It changed the contract
> and the screen and nothing in between. Every item below is required for a
> round trip.

### Step 7.1 · Contract — `src/shared/ipc.ts`

- `accountSetAutoConfirm` request is **`.strict()`**. An unrecognised `notify`
  key is _rejected_, not ignored, so it must be added explicitly:
  `notify: z.object({ enabled: z.boolean(), detail: notifyDetailSchema })`
- **`accountSummary.autoConfirm`** carries only `marketListings`, `trades`,
  `pollIntervalSeconds`. Add `notify`, or the screen cannot render its current
  value.
- `pollIntervalSeconds` bounds (`min(10).max(3600)`) unchanged.
- The trades acknowledgement rules are untouched. Notifications do not spend
  money and must not inherit that ceremony.

### Step 7.2 · Main — `src/main/vault/ipc.ts`

- `toSummary` (and its local type near line 444) gains `notify`.
- The `accountSetAutoConfirm` handler writes `notify` **field by field**, not by
  spread, matching the existing note about a future field arriving without
  anyone deciding it should be writable.

### Step 7.3 · Bridge

- `src/preload/index.ts` — `setAccountAutoConfirm` signature.
- `RendererApi` in `src/shared/ipc.ts` — same.
- `tests/ipc-contract.test.ts` — the `accountsList` sample response gains
  `notify`, or the clean-sample assertion added earlier this cycle will fail.

### Step 7.4 · Renderer

- **`AutoConfirm.tsx`** — an `enabled` checkbox with the disclosure **beside
  it, not beside the `full` radio**: `full` is the default, so the sentence has
  to be read by anyone switching notifications on, not only by someone who goes
  looking at the detail options. It states that toasts will name the trade and
  its items and that Windows keeps them in notification history. A `detail`
  radio group, disabled while off, presents `count` and `type` as the answer for
  a shared or overlooked machine. The interval label changes to _"How often this
  account is checked"_ because it now serves both.
- **The rate warning**, below 30s:

  > About **N** requests a minute across **M** accounts. Steam rate-limits, and
  > a blocked account stops confirmations entirely for a while.

  **[r2]** `M` is the number of accounts **actually polled** — auto-confirm on,
  or notify on — not `accounts.length`. `N` is `60 / interval × M`, rounded.
  Note the default interval of 15s will show this warning; that is honest and
  should not be special-cased away.

- **`VaultHome.tsx`** — the row currently prints `auto-confirm: off` for every
  account, and its card title says the control approves trades without asking.
  With notify-only as a real mode, both are wrong: an account that is watching
  reads as doing nothing. Add a state for it and reword the title.

### Step 7.5 · Click-to-open — **now its own phase, see §8**

Revision 1 said a toast click "focuses the window and opens Confirmations,
reusing the tray's existing show path". None of that was available, and the
reasons are why §8 exists rather than a line in this phase:

- The tray path only **focuses**; it does not navigate.
- There is **no main→renderer navigation channel** for the main window. The only
  `webContents.send` calls are browser chrome.
- The renderer view is a stack of `if`s, and `autoConfirmFor` (line 532) and
  `removingFor` (547) sit **above** `confirmingFor` (563), so setting
  `confirmingFor` while either is open does nothing.
- Locking **reloads** the window, so a click cannot carry renderer state across.
- `ToastHost.show({ title, body })` has no `steamId64`.

### Step 7.6 · Tests

the switch round-trips through the contract · the warning appears below 30s and
not at or above · its number matches interval × polled accounts · `full` states
the disclosure · the detail group is disabled while off · VaultHome shows a
notify-only account as watching, not as off.

---

## 8. Phase 6 — click-to-open

**Gate: full suite green. A toast click lands on that account's confirmations.**

This is a new IPC surface, which is why it is a phase and not a line. There is
precedent for the shape — `preload/browser-chrome.ts` already exposes
`onState` / `onFocusAddress` over `ipcRenderer.on` — but nothing like it exists
for the main window.

### Step 8.1 · Why a push alone is not enough

Three states the click has to survive, and a bare `webContents.send` handles
only the first two:

> **[r5] The second row of this table was false, and the conclusion survives
> anyway.** Closing to tray destroys nothing: `index.ts:951-957` is
> `event.preventDefault()` followed by `mainWindow.hide()`, and the window is
> only truly destroyed when the tray's Quit item sets `quitting = true` and the
> process is going away regardless. The `webContents`, its document and its IPC
> listeners all survive a close-to-tray, so there is always something to send
> to. What is _not_ stable is the document behind it — which is the real reason
> a bare push is not enough, and a stronger one than revision 3 gave.

| State when the toast is clicked                                  | What a bare push does                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window open, vault unlocked                                      | Works                                                                                                                                                                                                                                                                                       |
| Window hidden to tray                                            | **[r5]** The `webContents` is alive and the push is delivered. This works — unless the document was replaced while hidden, which is the row below                                                                                                                                           |
| Vault locked, or locked at any point since the window was hidden | The lock **reloads** the window (`index.ts:347-349`), unconditionally and with no visibility check. The `webContents` id survives; the document, its listeners and its React state do not. The push lands on a renderer with no subscriber, or on the unlock screen, and the intent is lost |
| No window at all                                                 | Only before first launch finishes. `createMainWindow` runs once at startup, and thereafter only when `getAllWindows()` is empty — which a hidden window prevents                                                                                                                            |

So the main process **remembers** the intent and the renderer **collects** it,
with the push as the fast path:

```ts
/** The account a toast click asked for, until a renderer takes it. */
let pendingConfirmationsFor: string | undefined;
```

### Step 8.2 · Main

On toast click: set `pendingConfirmationsFor`, then reuse the tray's existing
`showMainWindow` path — **[r5]** which already handles every case correctly
(`index.ts:934-945`: restore if minimised, `show()`, `focus()`, and create only
when `getAllWindows()` is empty). Then push `app:open-confirmations` with the
id.

**[r5]** The push is the fast path and nothing depends on it landing. It is
sent unconditionally when a `webContents` exists, which after a close-to-tray
it does; the stored intent is what makes the reload and unlock cases work. Do
not add a "was it hidden?" branch here — the two paths have to be able to run
together, because a window can be hidden _and_ have been reloaded by a lock.

### Step 8.3 · Channels

- **Push**, main→renderer: `app:open-confirmations`, payload `steamId64`.
- **Invoke**, renderer→main: `app:takePendingConfirmations`, returns
  `{ steamId64?: string }` and **clears** it. Called by the renderer once the
  account list is available after an unlock — which is what makes the locked and
  closed-to-tray cases work.

Both carry a SteamID the main process already holds. Neither carries a secret,
and neither _acts_: navigating is all they do. Approving still goes through the
existing confirmation channels with their own checks.

### Step 8.4 · Preload — `src/preload/index.ts`

```ts
onOpenConfirmations: (listener: (steamId64: string) => void) => {
  ipcRenderer.on('app:open-confirmations', (_event, steamId64: string) =>
    listener(steamId64)
  );
},
takePendingConfirmations: () => ipcRenderer.invoke(CHANNELS.takePendingConfirmations)
```

### Step 8.5 · Renderer — `src/renderer/App.tsx`

A single `openConfirmationsFor(steamId64)` used by both paths:

```ts
// **The competing screens are cleared, not just the target set.**
// `autoConfirmFor` and `removingFor` are tested above `confirmingFor` in the
// view stack, so setting the target while one of those is open navigates
// nowhere — the click would look broken.
setAutoConfirmFor(undefined);
setRemovingFor(undefined);
setRoutingFor(undefined);
setBackupFor(undefined);
setView('accounts');
setConfirmingFor(account);
```

- The id is **matched against the polled account list**, and ignored if absent.
  The renderer navigates to an account it knows about, not to whatever arrives.
- Subscribed once, in an effect. Collected via
  `takePendingConfirmations()` when `status.unlocked` becomes true and the
  account list is non-empty.

### Step 8.6 · Tests

| Test                       | Asserts                                                       |
| -------------------------- | ------------------------------------------------------------- |
| push navigates             | `confirmingFor` becomes that account                          |
| a competing screen is open | it is cleared, and the navigation still lands                 |
| unknown id                 | ignored; nothing changes                                      |
| locked                     | nothing happens; after unlock the pending intent is collected |
| pending is taken once      | a second call returns nothing                                 |
| contract                   | both channels are in `IPC_CONTRACT` with valid samples        |

The renderer half is asserted on `openConfirmationsFor` as an exported
function — the same approach `updateAnswerIsCurrent` took, and for the same
reason: the rule is ordering-sensitive and this project has no DOM runner.

---

## 9. Phase 7 — documentation

- **`docs/THREAT_MODEL.md`** — a new recurring request class: what it asks
  Steam, on whose route, how often, that it stops with the lock, and that a
  toast is a lock-screen surface.
- **`docs/FOUNDER_TEST_PLAN.md`** — **T34** (the next id after T33). Switch
  notifications on for one account at 60s **with market auto-confirm off** —
  otherwise the listing is approved and there is correctly no toast — make a
  listing from another device, confirm exactly one toast naming that account,
  confirm the next poll does not repeat it, lock and confirm no further toasts.
- **`README.md`** — one line in the feature list.

---

## 10. Edge cases

| Case                                    | Behaviour                                                      |
| --------------------------------------- | -------------------------------------------------------------- |
| Vault locks                             | Engine stops, seen-sets cleared, no toast on the disowned path |
| `Require proxies`, account has no proxy | Skipped in `dueAccounts`; halt counter untouched               |
| `needsSignIn`                           | Caught in the engine; one toast; no failure counted            |
| Auto-confirm approved it                | No toast; activity log already records it                      |
| Resolved on the phone                   | Gone from the next list; pruned                                |
| App closed when it arrived              | Seeded — except `securityCritical` / `unreadable`. See Q2      |
| Ten failures → halt                     | Polling stops. See Q4                                          |
| Account removed                         | `forgetAccount` clears its set                                 |
| Windows Focus Assist                    | Electron respects OS settings. Nothing to do                   |
| **[r5]** Windows session locked         | Toast fires, body degraded to `count`. See §2.1                |
| **[r5]** Vault locked                   | No poll happens, so no toast. Needs nothing                    |
| **[r5]** Saved session expired          | `onSignInNeeded`; one activity entry per run, not per poll     |

---

## 11. Mutation inventory

Each must be confirmed to turn its named test red.

1. notify-only account routed through `runAutoConfirm` — **pin it as "never
   lists, so never notifies"**
2. `dueAccounts` ignores `notify.enabled`
3. first poll toasts instead of seeding
4. first-poll seed swallows `securityCritical`
5. first-poll seed swallows `unreadable`
6. seen-set never pruned
7. `Require proxies` skip removed
8. `needsSignIn` counted as a failure
9. `onPending` fires on the disowned generation
10. `forget()` / `forgetAccount` no longer clear
11. warning threshold moved off 30s
12. warning counts all accounts rather than polled ones
13. `detail` ignored — always `full`
    13a. the default detail is not `full`
    13b. Steam strings reach the toast uncapped
    13c. Steam strings reach the toast unstripped
    13d. the disclosure moves off the enable switch
14. nested `notify` passthrough removed
15. click-to-open does not clear the competing screens
16. click-to-open trusts an id not in the account list
17. the pending intent is not cleared when taken
18. halt no longer notifies
19. halt copy still says "Automatic confirmation" for a watching account
20. **[r5]** `onFailure`'s context argument dropped — the halt toast loses the name
21. **[r5]** halt copy stops branching on `mode`
22. **[r5]** `halted` inferred from the sentence again instead of the flag
23. **[r5]** the session-lock degrade removed — `full` reaches a locked screen
24. **[r5]** the degrade mutates the stored `detail` instead of the composed body
25. **[r5]** `signInRequired` left out of `hasUrgent()`
26. **[r5]** `signInRequired` appends on every poll instead of once per run
27. **[r5]** the dedup keys on the reason string rather than the kind
28. **[r5]** click-to-open skips the push when the window is merely hidden

---

## 12. Gate, every phase

```
npm run format:check && npm run lint && npm run typecheck
npx vitest run
npm run build && node site/build.mjs
npm run smoke:browser && npm run stress:browser
```

Plus that phase's mutation entries. A phase is not finished until each new test
has been seen to fail with its fix removed.

---

## 13. Refuted audit findings — **[r5]**

Kept because the reasoning is what a later reader needs, and because a plan
that silently drops a claim invites the next audit to raise it again.

**"The activity log has no kind for a halt or for unreadable entries, and
neither is urgent."** Both kinds already exist and both are already urgent.
`activity.ts:27-41` defines `halted` and `unreadable` as their own entry kinds,
and `hasUrgent()` (`activity.ts:154-167`) lists both, alongside `held` +
`securityCritical`. `halted` is even selected by a passed-in flag rather than
by matching text, which is the fix this plan would otherwise have proposed for
it. Of the four conditions that audit named, only "sign-in required" was real;
that one became §6 step 4.2b.

**"A singleton security-critical confirmation slips past the batch guard."**
True as a code path, and **deliberate**. `client.ts:145-153` documents the
intent: someone recovering their own account has every right to approve it;
what is refused is doing so as one of eleven items swept up by a "select all"
nobody read. Two tests pin the singleton case as _allowed_ —
`confirmation-client.test.ts:217` and `confirmation-service.test.ts:225` — so
"fixing" it would turn CI red. The automatic path is separately and genuinely
closed: `AUTO_CONFIRMABLE` is the hard-coded pair `[2, 3]`, and types 5 and 6
sit in `NEVER_AUTO_CONFIRMABLE`. Nothing in this plan touches any of it; a
notify-only account approves nothing by construction.

**"`tick()` wastes a Steam round trip when nothing is due."** Half true, and
too small to act on. `ensureClock()` is called before `dueAccounts()`, so a
vault with nothing enabled does reach it on every one-second beat — but it
returns immediately unless the clock offset is stale, which is a 15-minute TTL
with a 60-second cooldown after a failure. The cost is a function call per
beat, not a request per beat. Recorded rather than fixed, and this plan makes
the case rarer: a notify-only account is now another reason for the state map
to be populated, which arms the `earliestDueAt` early-out that sits above it.

---

## 14. Rollback

Every phase is additive and defaults to off. Reverting is `git revert` of that
phase's commit. A vault written with `notify` loads on a build without it
because `autoConfirmSchema` is `.passthrough()` — **and keys inside `notify`
survive only once §3 step 1.1's nested passthrough is in place.**
