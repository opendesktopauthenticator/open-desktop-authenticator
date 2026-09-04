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

The previous implementation gave both top-level windows one combined
`setAppDetails({ appId, appIconPath, appIconIndex })` call. That looks atomic at
the TypeScript boundary, but Electron forwards the values to Chromium in this
order:

1. `System.AppUserModel.ID`
2. `System.AppUserModel.RelaunchIconResource`

Windows documents the opposite dependency: relaunch properties must be stored
before `System.AppUserModel.ID`, because committing the ID tells the taskbar to
refresh. The current call therefore refreshes the group while its relaunch
icon is absent and leaves the generic host icon selected.

This also explains why setting the constructor `icon` was insufficient. That
sets the native window's small and large icons, while an explicit taskbar group
uses the relaunch icon resource associated with its AppUserModelID.

## Related release identities found during the pre-fix review

The same helper is used by four materially different Windows environments, so
the corrective change must not treat `app.isPackaged` as the whole decision:

| Environment | Shell identity | Durable icon / relaunch target |
| --- | --- | --- |
| Development | a development-only per-window ID | source-tree `build/icon.ico`; no installed shortcut assumed |
| Installed / unpacked NSIS | the desktop product ID used by Electron Builder | the packaged executable and installer shortcut; no per-window override |
| Portable | a portable-specific per-window ID | `PORTABLE_EXECUTABLE_FILE`, the stable outer launcher, never the temporary inner executable |
| Microsoft Store | the package manifest's identity | Windows package metadata; no desktop AppUserModelID override |

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

Keep a shared per-window policy and apply it to both `BrowserWindow` and
`BaseWindow` before either is shown. Development and portable windows need
explicit details. Apply one complete details object and then repeat the ID:

1. store `{ appId, appIconPath, appIconIndex, relaunchCommand,
   relaunchDisplayName }`;
2. store `{ appId }` again, causing Windows to refresh after the icon and
   relaunch metadata from the first call exists.

The second call is deliberate. Chromium changes only the non-empty properties
it receives, so it does not erase the first call's metadata. Using a complete
first call also remains safe if Electron later starts enforcing its documented
statement that an AppUserModelID is required for the other options to have an
effect.

For development, include a development-specific ID, source ICO and a relaunch
command containing Electron plus the application path, but do not restore the
process-global production AppUserModelID or write production registry
identity. For portable, include the outer launcher's stable path as the icon
resource and relaunch command, with the product display name. For Store, return
no per-window override. Installed/unpacked NSIS uses its process-level product
ID and branded executable/shortcut, so it needs no per-window override.

The process-level policy must make the same distinctions: desktop ID for NSIS,
portable ID for portable, no desktop override for Store or ordinary
development. Store still receives its manifest-matched toast activator; that
decision must no longer be coupled to whether the desktop AppUserModelID is
claimed. Registry display/icon metadata remains non-Store and non-portable.

Do not replace `BaseWindow`, add a timed refresh, or spoof process metadata.
Those changes do not address the confirmed property-order defect and would
reopen earlier grouping or notification behavior.

## Regression boundary

- Model the Windows property-store refresh in the unit test: writing the ID
  snapshots the icon available at that moment. One combined call without the
  final ID refresh must fail.
- Assert exactly two calls, full metadata first and AppUserModelID-only second,
  for development and portable windows.
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
2. Commit the ordered property writes, regression tests, and corrected
   changelog wording together.
3. Leave the unrelated untracked audit and release documents untouched.
