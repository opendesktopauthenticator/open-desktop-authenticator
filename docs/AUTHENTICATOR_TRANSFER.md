# Moving an authenticator off the Steam mobile app

How this application takes over an authenticator that already exists on
somebody's phone, and why almost every part of it is shaped by one fact: Steam
issues the replacement secrets exactly once.

## The distinction that matters most

There are two ways to end up with an authenticator here instead of on a phone,
and they are not interchangeable.

**Transfer** — `RemoveAuthenticatorViaChallengeContinue` with
`generate_new_token` set. Steam replaces the authenticator in one server-side
step and hands back a fresh secret bundle. The account carries a short trading
and Market restriction afterwards.

**Remove, then add** — `RemoveAuthenticator` followed by `AddAuthenticator`.
Reaches a similar end state and costs the account **fifteen days** of no trading
and no Market, with a window in between where the account has no second factor
at all.

> Substituting the second for the first is a bug, not a simplification. If a
> future change makes the transfer path awkward, the fix is to make it work —
> not to reach for the pair that costs a fortnight.

This is also **not** extraction. Nothing reads the secret off the phone, and
nothing could. Steam mints new secrets and invalidates the old ones; the phone's
copy becomes inert on Steam's side without anything being done to the device.

## The flow

1. **Sign in** with the account name, password, and the Guard code showing on
   the phone. Changes nothing on the account.
2. **Start** — `RemoveAuthenticatorViaChallengeStart`. Steam sends a code to the
   registered phone number. Changes nothing, and can be abandoned.
3. **Continue** — `RemoveAuthenticatorViaChallengeContinue` with the code and
   `generate_new_token`. **Irreversible.** Steam rotates the authenticator and
   returns the replacement.
4. **Store** — recovery file, then vault, then read back and verify.
5. **Ceremony** — show the new recovery code and require the user to confirm
   they have written it down.

## Authentication

The transfer calls need a user-scoped MobileApp JWT, not a Web API key. This
application already obtains one: `steam-session` asks for `MobileApp`, and
`src/main/steam/access-token.ts` refuses a web-scoped token outright, because a
web-scoped one signs in fine and then cannot approve a single confirmation.

Sign-in for a transfer is separate from `EnrollmentService`, which refuses an
account that already has an authenticator — precisely the account this is for.
Its error even suggests removing the authenticator first, which is the
fifteen-day mistake above.

`signIn()` normally derives the Guard code from a stored `sharedSecret`. During
a transfer there is no stored secret — it is still on the phone — so a typed
code is accepted instead. Supplying it up front matters: left to challenge, Steam
asks for a device confirmation this application cannot drive, which is exactly
the failure the enrolment path returns.

The JWT never crosses IPC, never appears in a URL, an error, or a log.

## Wire format

These two endpoints speak **protobuf**, unlike every other `ITwoFactorService`
call here, which are form-encoded with JSON replies. That was established
against a real account rather than assumed: `Start` answers HTTP 200 with a
**zero-byte body**, because its response message has a single optional field and
an unset optional field encodes to nothing at all.

The outcome is in the **`x-eresult` header**. `SteamResponse.eresult` exists for
that reason; before this feature the application discarded every header it was
sent.

`version` is written explicitly as `2`. The schema's default is `1`, and a field
left to its default is not serialised — so relying on the default sends neither
the field nor Valve's current value.

The request encoding is checked against a known vector:

```
sms_code "12345", generate_new_token true, version 2
  → 0A 05 31 32 33 34 35 10 01 18 02
  → CgUxMjM0NRABGAI=
```

That vector caught a real bug. protobufjs camel-cases field names by default, so
`sms_code` and `generate_new_token` matched no field and were silently dropped
while `version` survived. The result was a valid protobuf message that asked
Steam to **remove the authenticator without issuing a replacement**. Nothing
threw. `parse(SCHEMA, { keepCase: true })` is what prevents it.

Response bodies for this call are read as `latin1`, not UTF-8. The transport
otherwise reads text, and a protobuf body of raw secret material read as UTF-8
has most of its bytes replaced with U+FFFD — silently, still a valid string, and
the secrets it yields would generate wrong codes forever. `SteamRequest.binary`
exists for this one call.

## Secret handling

- Secrets stay in the main process. `contextIsolation` on, `nodeIntegration`
  off, as everywhere else.
- The only secret that crosses IPC is the **revocation code**, once, so the
  ceremony can show it. Not the shared secret, not the identity secret, not the
  session.
- 64-bit fields (`steamid`, `serial_number`) are handled as decimal strings.
  `Number(steamid)` rounds, and a SteamID wrong in its last digits looks
  entirely plausible while belonging to nobody.
- Every field Steam returns is stored, including ones nothing reads yet. They
  are issued once.

## Failure, and the one outcome that is not a failure

`Continue` is **never retried automatically**, and must not be. A request that
times out may still have been processed: a retry submits a spent code against an
already-rotated authenticator, and the failure it returns would mask the first
attempt that succeeded and threw the secrets away.

The storage order exists for the same reason:

1. **Recovery file first.** Sealed with the vault's own key, so it is no less
   protected, and it survives a vault this process cannot write.
2. **Vault.**
3. **Read back and compare.** "The write did not throw" and "the secrets are on
   disk and decryptable" are different claims. Only the second is safe to tell
   somebody whose phone stopped being their authenticator a moment ago.

Three failure branches, each naming what the user can still do:

| What failed                        | What the user is told                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Vault write, recovery file written | Nothing is lost; unlock and retry from this screen                                            |
| Both                               | The revocation code is printed in the error — at that moment it is the only copy in existence |
| Read-back mismatch                 | Refuses to call it success, keeps the secrets, invites a retry                                |

**A reply that cannot be decoded is not a failure.** Steam answered, so the
authenticator has probably rotated already. The raw bytes escape the API layer
before anything tries to parse them, are held in memory (never on disk
unsealed), and `retryDecode` can read them again. The message says the
authenticator has probably been replaced and not to close the window — because
saying "it failed" there would be false and would invite exactly the wrong
action.

## Testing

Unit and integration tests use mocked Steam responses; nothing in CI performs a
transfer. The encoding vector above is the anchor.

A live transfer is destructive and can only be validated by performing one. When
doing so, on a **sacrificial account whose current recovery code is written down
off-machine**, confirm:

- [ ] The new code ODA generates is accepted by Steam at sign-in
- [ ] The code the phone shows is no longer accepted
- [ ] Confirmations can be listed and approved with the new identity secret
- [ ] The new recovery code was captured before leaving the ceremony
- [ ] The restriction observed matches a transfer, not a fifteen-day
      remove-and-add

### Status

A live transfer has been performed successfully against a real account with an
active authenticator, including the SMS challenge and the replacement being
stored. The individual checklist items above were not each recorded at the time
and are worth confirming explicitly on the next run.

## Not built yet

- A dedicated `outcome_uncertain` screen for a network timeout _after_ the
  submit. The retry path covers the same ground; the wording could be clearer.
- `QueryStatus` verification of `time_transferred` after the transfer.
- A gated live-test harness (`STEAM_TRANSFER_LIVE_TEST=1`).

## Sources

- SteamDatabase protobufs — `webui/service_twofactor.proto`
- DoctorMcKay, `node-steam-session` — MobileApp session authentication
- Valve, Steam Guard Mobile Authenticator FAQ —
  <https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31>

BeyondDimension/WinAuth was consulted as behavioural evidence only. It is
GPL-licensed and none of it is copied here; the implementation follows from the
protobuf contract and from observed request behaviour.
