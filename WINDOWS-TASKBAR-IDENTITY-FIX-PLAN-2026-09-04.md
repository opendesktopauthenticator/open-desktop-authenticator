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

## Related release identities found during the pre-fix review

The same helper is used by four materially different Windows environments, so
the corrective change must not treat `app.isPackaged` as the whole decision:

| Environment               | Shell identity                                  | Durable icon / relaunch target                                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Development               | no process/window ID in the ordinary run        | each real `BrowserWindow`'s source-tree product icon                                        |
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

Ordinary development then needs no explicit per-window AppUserModelID: both
top-level windows are real `BrowserWindow`s carrying the product icon. Only the
development notification opt-in and portable channel need explicit relaunch
details. For those two cases, apply one complete details object and repeat the
ID:

1. store `{ appId, appIconPath, appIconIndex, relaunchCommand,
relaunchDisplayName }`;
2. store `{ appId }` again, causing Windows to refresh after the icon and
   relaunch metadata from the first call exists.

The second call is deliberate. Chromium changes only the non-empty properties
it receives, so it does not erase the first call's metadata. Using a complete
first call also remains safe if Electron later starts enforcing its documented
statement that an AppUserModelID is required for the other options to have an
effect.

For development with `ODA_WINDOWS_IDENTITY=1`, include a development-specific
ID, source ICO and a relaunch command containing Electron plus the application
path. Ordinary development sets none of those properties. For portable,
include the outer launcher's stable path as the icon resource and relaunch
command, with the product display name. For Store, return no per-window
override. Installed/unpacked NSIS uses its process-level product ID and branded
executable/shortcut, so it needs no per-window override.

The process-level policy must make the same distinctions: desktop ID for NSIS,
portable ID for portable, no desktop override for Store or ordinary
development. Store still receives its manifest-matched toast activator; that
decision must no longer be coupled to whether the desktop AppUserModelID is
claimed. Registry display/icon metadata remains non-Store and non-portable.

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
- Model the Windows property-store refresh for the opt-in development and
  portable paths. One combined call without the final ID refresh must fail.
- Assert exactly two calls, full metadata first and AppUserModelID-only second,
  for opted-in development and portable windows; ordinary development gets
  none.
- Assert both calls happen before the main window and account browser are
  shown.
- Cover the complete development / installed / portable / Store matrix.
- Parse or inspect the AppX configuration and prove the Store path never writes
  the desktop AppUserModelID.
- Prove portable uses `PORTABLE_EXECUTABLE_FILE` for its icon and relaunch
  command and never uses the temporary `process.execPath`.
- Preserve the installed executable resource and non-Windows no-op behavior.
- Run the focused identity/browser-host tests, format, lint, both typechecks,
  the full suite, and the build.
- The final release gate remains a manual Windows check with both taskbar
  windows open. Restarting the running development process is required before
  that check because it cannot hot-reload main-process code.

## Commit strategy

1. Commit this corrective plan by itself.
2. Commit the account-shell migration, channel-specific identity policy,
   regression tests, and corrected changelog wording together.
3. Leave the unrelated untracked audit and release documents untouched.
