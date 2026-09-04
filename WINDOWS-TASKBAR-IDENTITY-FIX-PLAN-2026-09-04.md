# Windows taskbar identity corrective plan

Status: implementation approved by the user's report on 2026-09-04.

This is a corrective amendment to
`BROWSER-COMPATIBILITY-UX-PLAN-2026-09-04.md`. The screenshot from a current
development run proves that the earlier taskbar change did not satisfy its
manual acceptance check.

## Confirmed failure

Opening the account browser still creates a Windows taskbar group with the
generic Electron icon. The running process is the current development build
(`electron.exe .`), so this is not an old packaged binary or a stale source
checkout.

The first source review found a real ordering problem in the previous helper.
Electron forwards a combined
`setAppDetails({ appId, appIconPath, appIconIndex })` call to Chromium in this
order:

1. `System.AppUserModel.ID`
2. `System.AppUserModel.RelaunchIconResource`

Windows documents the opposite dependency: relaunch properties must be stored
before `System.AppUserModel.ID`, because committing the ID tells the taskbar to
refresh. The current call therefore refreshes the group while its relaunch icon
is absent.

That was not the whole defect. A native two-window probe then compared three
real Electron 43.3.0 variants on this Windows host: combined details,
AppUserModelID alone, and complete details followed by an ID refresh. All three
produced the same result as the user's screenshot: the `BrowserWindow` carried
the product icon and the `BaseWindow` carried the generic white-window icon.

The probe rendered each window's `WM_GETICON` handle and compared its pixels.
The `BaseWindow` handle is the actual ODA artwork, not a missing or generic
native icon, and its property store contains the written shell fields. Explorer
is substituting the taskbar image specifically for this `BaseWindow` path. An
identity-only change therefore passes API tests but does not fix the reported
behavior.

### Second manual-gate correction — 2026-09-05

`Screenshot_3893.png` proves the first implementation still did not meet the
visible acceptance check: replacing `BaseWindow` removed the generic white
window, but the account `BrowserWindow` appeared under Electron's gray atom.
The earlier verification mistook an unchanged taskbar crop for successful
grouping; it never identified the account button itself.

A new live matrix held the BrowserWindow class, ICO bytes and window behavior
constant. Supplying those bytes as either the generated `windowImage()` or a
`NativeImage` loaded from `build/icon.ico` produced Electron's atom. Supplying
the absolute `build/icon.ico` **string path** directly as the constructor's
`icon` produced the green ODA shield. Full development AppDetails remains
compatible but is not the controlled variable. Therefore the remaining defect
is the representation passed to Electron, not another window-class or refresh
ordering problem.

### Third manual-gate correction — 2026-09-05

The second conclusion was also rejected before implementation was committed.
Its green shield belonged to a separate, one-window ODA process. A new probe
enumerated the exact account HWND, made that HWND the foreground window, read
the taskbar button's accessibility identity and captured the highlighted
button. With two top-level windows, the absolute ICO string alone still grouped
under `electron.app.Electron` and still drew the atom.

The controlled result is now:

| Two-window development variant                                                                   | Exact foreground group |
| ------------------------------------------------------------------------------------------------ | ---------------------- |
| absolute constructor ICO only                                                                    | Electron atom          |
| fresh process AUMID + complete per-window AppDetails                                             | ODA shield             |
| stable `com.opendesktopauthenticator.desktop.development` AUMID + complete per-window AppDetails | ODA shield             |
| same complete identity with the original constructor NativeImage                                 | ODA shield             |

The actual boundary is therefore Windows shell group identity, not the
constructor icon representation. The absolute-path selector drafted after the
second conclusion is unnecessary and must not ship. No Start Menu shortcut is
needed: the complete per-window relaunch properties are the documented
shortcut-free identity route, and that exact route passed the foreground-mapped
native check.

### Fourth manual-gate correction — 2026-09-05

The foreground-mapped two-window check passed, but it still sampled only one
point in the window lifecycle. After the probe's two windows closed, the real
development app remained under the same
`com.opendesktopauthenticator.desktop.development` taskbar identity and its
single taskbar button changed back to Electron's atom. A fresh screen capture
and UI Automation lookup identified the same button at X=1403–1447; this was
not another adjacent-icon error.

The third conclusion was therefore incomplete, not wholly wrong. Process and
per-window AppUserModelID metadata controls a multi-window **group**. When that
group collapses to one window, Explorer can draw the native icon of the
remaining window instead. The current generated `NativeImage` does not displace
the `electron.exe` icon on that singleton path. The interactive, uniquely named
lifecycle matrix then proved that an absolute constructor ICO preserves the
singleton icon but still needs the existing group identity for two windows. The
product needs both layers.

Before implementation, a native transition probe held the current process ID
and AppDetails policy constant, changed only the constructor icon to the real
absolute ICO, and identified the exact taskbar button through all of these
states:

1. main window alone;
2. main plus account browser, with the account browser foreground;
3. account browser closed, main alone again;
4. account browser reopened, then main closed so the account browser remains;
5. both windows closed and a fresh main window opened.

Every live state showed the ODA shield under a fresh AppUserModelID. Stages were
captured by exact UI Automation AppID and bounds rather than by the position of
a nearby icon. A green sample at only one state would not have been a pass.

### Fifth manual-gate correction — 2026-09-05

The exact production-helper run then used the already-seen stable
`.development` AppUserModelID. Its first singleton had the real ICO, complete
AppDetails, a matching foreground HWND and the correct taskbar AutomationId —
but Explorer still drew the atom. The same construction under fresh, unique
development IDs drew the ODA shield. Windows had retained the image selected by
the earlier broken implementation for the old development group ID.

Do not make the user restart Explorer, erase the global icon cache, write an
unrequested shortcut, or manually edit the registry. Give only the
unreleased/development channel a one-time semantic identity revision:
`.development.icon1`. Process and window details must use the same revised ID.
Installed, portable and Store identities remain byte-for-byte unchanged. The
revised development ID is stable across ordinary runs; it is not random per
launch, so windows still group and notification testing can still register one
predictable identity when explicitly enabled.

The final production-helper acceptance must use that exact revised ID through
all five lifecycle states. A fresh random probe ID is supporting evidence, not
the release gate.

## Related release identities found during the pre-fix review

The same helper is used by four materially different Windows environments, so
the corrective change must not treat `app.isPackaged` as the whole decision:

| Environment               | Shell identity                                  | Durable icon / relaunch target                                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Development               | stable development process/window ID            | source ICO in complete per-window AppDetails and as the real Windows constructor icon       |
| Installed / unpacked NSIS | the desktop product ID used by Electron Builder | the packaged executable and installer shortcut; no per-window override                      |
| Portable                  | a portable-specific per-window ID               | `PORTABLE_EXECUTABLE_FILE`, the stable outer launcher, never the temporary inner executable |
| Microsoft Store           | the package manifest's identity                 | Windows package metadata; no desktop AppUserModelID override                                |

Two additional defects are confirmed by this matrix:

- Electron Builder's portable launcher runs the inner executable from a
  temporary directory and exposes the stable outer path as
  `PORTABLE_EXECUTABLE_FILE`. Pointing the relaunch icon at `process.execPath`
  therefore leaves a dead resource after the portable app exits.
- A Store package's AppUserModelID is derived from its package family and
  application manifest ID. Applying `com.opendesktopauthenticator.desktop`
  overrides that package identity for grouping, activation, and lifecycle.

The Store path must skip both the process-level desktop AppUserModelID and the
per-window desktop identity. The portable path must use the stable launcher and
a distinct portable ID so an installed and portable vault do not share one
taskbar group.

## Concrete fix

Replace only the account window shell from `BaseWindow` to `BrowserWindow`.
Use the `BrowserWindow`'s existing owned `webContents` for the hardened toolbar,
instead of creating a third-party page there or adding another renderer. Keep
every Steam/trading page in its existing isolated child `WebContentsView`, with
no preload and no vault IPC. The visible layering remains:

1. the owned toolbar renderer fills the shell background and receives the
   trusted browser-chrome preload;
2. the selected site view is bounded below `CHROME_HEIGHT` and overlays only
   the content region;
3. inactive site views remain attached but hidden exactly as before.

This removes the `BaseWindow` path Explorer renders generically while retaining
the two security domains and the existing tab/session lifecycle. It does not
add an unused `BrowserWindow` renderer.

Unlike `BaseWindow`, a development `BrowserWindow` inherits Electron's native
application menu. Remove the account shell's menu explicitly in every build so
Alt cannot reveal a third navigation/control surface over the trusted toolbar.

The migration changes one global fact: account shells now appear in
`BrowserWindow.getAllWindows()` and can become `getFocusedWindow()`. Introduce a
shared weak window-role registry and mark each account shell at construction.
Every main-app-only consumer must select or iterate windows through that role:

- file/recovery/vault pickers remain parented to the main application window,
  never a trading browser that happened to have focus;
- vault-lock renderer reload and confirmation-toast IPC target only the main
  renderer, never the browser toolbar;
- tray/Dock main-window lookup cannot mistake an account browser for the app
  home window;
- OS `session-end` listeners still cover every real `BrowserWindow`, including
  account shells, because ending secrets on shutdown is intentionally global.

A real migration probe also confirmed that Windows focuses the owned toolbar
contents when an account `BrowserWindow` is reactivated, even if the active site
held focus before Alt-Tab/taskbar deactivation. Record whether the page or
toolbar was last intentionally focused when the window blurs, and restore that
surface on activation. Do not always force the site: a user who left the address
bar focused expects to return to it.

The same hidden-window probe found that Electron 43 on Windows can report the
child-focused shell as focused before it is visible; `show()` then emits its
event without making the window visible. Reveal it with `showInactive()` and
then `focus()` on Windows. Keep `show()` followed by `focus()` on Linux and
macOS, because `showInactive()` is explicitly unsupported on Wayland.

Ordinary Windows development must claim its stable development-specific
AppUserModelID at the process boundary, and every top-level development window
must receive complete relaunch details before it is shown. On unpackaged
Windows, each BrowserWindow constructor must also receive the absolute tracked
`build/icon.ico` path. The group metadata fixes the two-window state; the real
constructor ICO fixes the singleton state before, between and after grouped
windows. On packaged Windows the branded executable remains the durable icon,
and on non-Windows platforms the existing generated `NativeImage` remains the
window icon. Development and portable windows apply one complete details object
and repeat the ID:

1. store `{ appId, appIconPath, appIconIndex, relaunchCommand,
relaunchDisplayName }`;
2. store `{ appId }` again, causing Windows to refresh after the icon and
   relaunch metadata from the first call exists.

The second call is deliberate. Chromium changes only the non-empty properties
it receives, so it does not erase the first call's metadata. Using a complete
first call also remains safe if Electron later starts enforcing its documented
statement that an AppUserModelID is required for the other options to have an
effect.

For ordinary development, include a development-specific ID, source ICO and a
relaunch command containing Electron plus the application path. Remove the
`ODA_WINDOWS_IDENTITY=1` gate from process and window taskbar identity: leaving
either optional recreates the reported bug in the normal run. Retain that flag
only for development's persistent notification registration; the taskbar fix
does not need to leave registry or toast-activation state behind. Use the
stable `.development.icon1` revision so Explorer cannot reuse the atom cached
under the earlier `.development` experiment. For portable, include the outer
launcher's stable path as the icon resource and relaunch command, with the
product display name. For Store, return no per-window override.
Installed/unpacked NSIS uses its process-level product ID and branded
executable/shortcut, so it needs no per-window override.

The process-level policy must make the same distinctions: desktop ID for NSIS,
portable ID for portable, development ID for unpackaged Windows, and no desktop
override for Store. Store still receives its manifest-matched toast activator;
that decision must not be coupled to whether the desktop AppUserModelID is
claimed. Registry display/icon metadata remains non-Store and non-portable, and
ordinary development keeps the existing `ODA_WINDOWS_IDENTITY=1` opt-in for
those persistent notification side effects.

Do not add a timed refresh, hide the account browser from the taskbar, retain an
unused renderer, or spoof process metadata. Each would either leave the
confirmed rendering path in place or trade the icon for a task-switching or
security regression.

## Regression boundary

- Assert the production account shell is a `BrowserWindow`, its owned
  `webContents` is the toolbar, and no separate toolbar `WebContentsView` is
  constructed.
- Assert its native application menu is removed before the window is shown.
- Preserve toolbar/site partition separation, permission denial, hardened web
  preferences, no site preload, tab bounds below the toolbar, popup adoption,
  proxy authentication, and teardown of every child view.
- Prove the shared window-role selector prefers a focused main window, falls
  back to a live main window when an account browser is focused, and never
  returns an account browser. Exercise every main-only enumeration listed
  above.
- Drive both focus histories: page -> deactivate -> activate restores the active
  page, while toolbar -> deactivate -> activate leaves focus in the toolbar.
- Model the Windows property-store refresh for ordinary development and
  portable paths. One combined call without the final ID refresh must fail.
- Assert exactly two calls, full metadata first and AppUserModelID-only second,
  for ordinary development and portable windows.
- Assert both calls happen before the main window and account browser are
  shown.
- Assert both constructors select the absolute tracked ICO on unpackaged
  Windows and retain `windowImage()` everywhere else. An ICO-only change is not
  the shell-group fix, so the process ID and complete AppDetails assertions must
  remain alongside it.
- Assert ordinary Windows development always selects the development process
  ID, pin the `.development.icon1` revision, and assert both call sites pass the
  inputs that produce complete per-window AppDetails. The old environment gate
  and old cache-poisoned `.development` ID must not survive.
- Cover the complete development / installed / portable / Store matrix.
- Parse or inspect the AppX configuration and prove the Store path never writes
  the desktop AppUserModelID.
- Prove portable uses `PORTABLE_EXECUTABLE_FILE` for its icon and relaunch
  command and never uses the temporary `process.execPath`.
- Preserve the installed executable resource and non-Windows no-op behavior.
- Run the focused identity/browser-host tests, format, lint, both typechecks,
  the full suite, and the build.
- The final release gate is the five-state Windows lifecycle above, not merely
  both windows open. Evidence must identify the exact taskbar button and focused
  HWND at every state. Absence of a new button, an unchanged crop, or a green
  icon that later reverts is not a pass. Restarting the running development
  process is required because it cannot hot-reload main-process code.

## Commit strategy

1. Commit this corrective plan by itself.
2. Commit the account-shell migration, channel-specific identity policy,
   regression tests, and corrected changelog wording together.
3. Commit this second, screenshot-driven plan correction by itself.
4. Commit this foreground-mapped plan correction by itself.
5. Commit the default development identity, complete per-window details,
   non-vacuous regression tests and changelog correction together.
6. Commit this lifecycle correction by itself before changing product code.
7. Commit the Windows constructor-ICO selector, lifecycle regression tests and
   changelog correction together only after the five-state native probe passes
   under the exact revised development ID.
8. Leave the unrelated untracked audit and release documents untouched.
