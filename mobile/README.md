# StarCore Mobile

The native mobile client for StarCore - Android first, with an
architecture that adds iOS later without a rewrite. This is a client of
StarCore's existing server API (the same one `mission_control/` talks to
in a browser); there is no second backend anywhere in this directory.

```
Mobile UI  ->  Existing StarCore API  ->  StarCore Engine  ->  Satellites
```

## What's here

- Several servers, sign-in, secure session storage and restore, and a per-server biometric
  app lock.
- Home, Satellites, Settings, and in Developer Mode the Console and Config tabs.
- Every Satellite that ships a `ui.json`, drawn by the shared renderer (see "Satellite
  interfaces" below): Status, Photos, and File Explorer's read-only preview, the app's file
  browser.
- The shared audio player (`src/media/`), and Music's native library screens.
- Photos' previous native screens, its background phone sync, and the Locked Folder's unlock
  prompt and screens, until they are retired (`docs/remaining-work.md`).
- Developer Mode (`src/developer/`): the terminal icon at the top right of each tab, or the
  switch in Settings. Off by default and remembered per server on this device; it shows the
  Console and Config tabs and anything a Satellite marks `developer: true`. A display
  preference only - see docs/satellites.md, "Developer Mode".

Not built yet: notifications, an iOS build and a light theme.

## Prerequisites

- Node.js 18+
- A JDK (17 or 21) and the Android SDK - installed automatically if you use
  [Android Studio](https://developer.android.com/studio); command-line-only
  setups need `ANDROID_HOME` pointed at an SDK install with `platform-tools`,
  `build-tools;34.0.0` and `platforms;android-34`.
- A running StarCore server on the same network as the device/emulator you
  test with (see `docs/deployment.md` in the repository root) - the app
  never bundles or hardcodes a server address; you enter one on first
  launch (see "Connecting to a server" below).

## Running it locally

```bash
cd mobile
npm install
npm run android    # builds and launches on a connected device/emulator,
                    # and starts the Metro bundler if it isn't running
```

`npm run android` is `react-native run-android` under the hood - it needs
an already-running emulator (Android Studio's Device Manager, or
`emulator -avd <name>` from the SDK's `emulator/` tools) or a physical
device with USB debugging enabled and `adb devices` showing it connected.

If Metro's bundler needs restarting on its own: `npm start`.

### A pinned dependency: react-native-video

`package.json` pins `react-native-video` to an exact `6.16.0`, not a caret
range, on purpose: this project's `android/build.gradle` deliberately stays
on `compileSdkVersion 34` (see that file's own `ext` block), and
`react-native-video` 6.17.0 raised its own default `compileSdk`/`minSdk` to
35/24 - and every later 6.x release inherits that. `6.16.0` is the newest
release still built against `compileSdk 34` (`android/gradle.properties` in
the package itself pins `RNVideo_compileSdkVersion=34` and
`RNVideo_media3Version=1.4.1`), so it's the one that matches the app's
existing Android setup without also raising `compileSdk`, the Android
Gradle Plugin, or anything else project-wide just to add video playback.

If a future upgrade of `react-native-video` is wanted, raising
`compileSdkVersion` (and everything that implies - AGP, `targetSdkVersion`,
possibly `minSdkVersion`) across the whole Android project has to be a
deliberate, separate decision, not a side effect of `npm update` quietly
picking up a newer 6.x release.

### Music playback

Audio plays through the shared AudioHost (`src/media/`, see
`docs/media-audio.md`), which plays from whichever Satellite the capability
catalog lists as the `audio.library` provider (Music today; its native screens
stay in `src/music/` and are wired in by `src/satellites/builtins.tsx`). It
uses that same `react-native-video` rather than adding
`react-native-track-player`: one hidden `<Video>` lives in the `AudioHost`
(mounted around the tab navigator, inside the per-server `AuthProvider`), with `playInBackground` and `showNotificationControls`, so
playback runs in react-native-video's media3 `VideoPlaybackService` - a
`mediaPlayback` foreground service with notification, lock-screen and
headset play/pause, audio focus and becoming-noisy handling. The app's own
Kotlin package (`android/.../media/`) adds what JS can't reach: a
react-native-video plugin hook that gives the equalizer, bass boost,
loudness (ReplayGain boost) and pitch/tempo the player's own audio session,
Wi-Fi/cellular detection, and private-storage downloads under
`files/music/<server>/`. Limits of this approach: the notification shows
play/pause and seek, not next/previous; there is no crossfade or true gapless
playback (one player, tracks are loaded back to back); and remote control
through StarCore Connect only runs while the app is in the foreground.

### Status

Status's interface is its `ui.json` (UI contract 1.1), drawn by the shared
`SatelliteUiScreen`: a dashboard with charts, tables, a period choice and a
header, refreshed only while the screen is focused and the app is in the
foreground; when a request fails, the last reading stays on screen under an
offline banner. Charts are columns built from Views (the app has no SVG
library), laid on a fixed time grid so gaps stay gaps
(`src/components/charts.tsx`, shared by every Satellite). Home draws each
Satellite's `ui.json` widgets (`src/satellites/ui/Widgets.tsx`) from the
satellite list it already loads, so Status's costs no request of its own.

Status has no native screen of its own any more: see `docs/satellites/status.md`.

## Connecting to a server

The first screen asks for your StarCore server's address (e.g.
`http://192.168.1.20:8090`, or an HTTPS address if you've set that up per
`docs/deployment.md`). This is stored locally on the device
(`src/storage/preferences.ts`, plain `AsyncStorage` - a convenience to
remember, not a secret) and is never compiled into the app or committed to
this repository, so the source code carries no server-specific
configuration at all.

A LAN address without HTTPS is expected and supported - StarCore's own
default is plain HTTP on a private network (see `docs/deployment.md`,
"Private LAN access") - which is why `android/app/src/main/res/xml/
network_security_config.xml` allows cleartext traffic; see that file's own
comment for the reasoning.

## Authentication

Logging in calls the exact same `POST /api/auth/login` Mission Control
uses (`src/api/auth.ts`), with `kind: "mobile"` and a device label so the
session shows up distinctly in StarCore's "Active sessions" list (see
`docs/api.md`, "Authentication", in the repository root). One small,
backwards-compatible server change was needed to support this: a
`kind: "mobile"` login also returns the issued token in its JSON response
body, because a native HTTP stack doesn't expose the `Set-Cookie` header to
application code the way a browser's `fetch()` does - a plain/omitted
`kind` (the browser's own login) is completely unaffected. See the comment
on `_handle_auth_login` in `engine/starcore/api/server.py`, and
`test_a_mobile_login_also_returns_the_token_in_the_response_body` /
`test_a_web_login_does_not_return_a_token_in_the_body` in
`engine/tests/test_auth.py`.

The token itself is stored with `react-native-keychain`
(`src/platform/secureStorage.android.ts`), which uses the Android Keystore
- never `AsyncStorage`, and never the account password, which this app
only ever sends once, over the login request itself, and never stores at
all. `src/auth/session.ts`'s `SessionManager` owns the whole lifecycle
(login, restore-on-launch, logout) and is the one thing every screen asks
"am I logged in" - see that file's own docstring for the full security
reasoning, in particular that a locally stored token is **never** treated
as proof of a valid session by itself: every app launch re-checks it
against the live server (`GET /api/auth/status`) before trusting it.

### Biometric unlock

"Biometric unlock" in Settings is a per-server app lock. Turning it on (or
off) checks the sensor and enrollment and requires a successful fingerprint
match first; the preference is then stored in the Android Keystore-backed
secure store next to that server's session token, never in AsyncStorage.

Every cold start opens the server list first; nothing server-specific is
mounted until a server is picked (Server List -> Select Server -> Biometric
unlock or Login -> StarCore). While the lock is on, the lock screen shows
until the fingerprint prompt succeeds, and the app locks again after 30
seconds in the background (`RELOCK_AFTER_BACKGROUND_MS` in
`src/auth/appLock.ts`). Back (button or hardware) on the lock screen and the
login screen returns to the server list.

The preference is only ever removed by turning it off in Settings, which
needs a successful fingerprint. A cancelled, dismissed (tap outside the
prompt), failed or errored prompt changes nothing, never deletes the session
or server list, and logging out keeps the preference. An unreadable
preference counts as "on". If biometrics stop working, "Sign in with
password" on the lock screen signs in against the real server; after that
login, Settings allows turning the lock off without a fingerprint.

The session token itself is encrypted in the Keystore but deliberately not
biometric-gated: every API request reads it, and the headless Photo
background sync task must read it with no UI at all. See
`src/auth/appLock.ts`, `src/auth/session.ts` and `src/platform/types.ts`.

This is local to the device end-to-end: StarCore's server never receives a
fingerprint, a face scan, or any biometric template - it only ever sees the
same session token it would from a password login, exactly as before.

## Satellite interfaces

The app knows UI contracts and capabilities, not individual Satellites. A
Satellite that ships a `ui.json` (UI contract 1.0 to 1.2, see
[`docs/ui-contract.md`](../docs/ui-contract.md)) opens in
`src/screens/SatelliteUiScreen.tsx`, which draws its pages, navigation and
blocks with this app's own components (`src/satellites/ui/`) - no app change
is needed for a new one. Documents are cached per server and revalidated by
revision; page data is always live, and a refused session is never answered
from the cache. The rules shared with the Engine and Mission Control are in
`src/satellites/ui/contract.ts`, tested against `contracts/ui/` by
`__tests__/uiContract.test.ts`.

Status opens its `ui.json` alone; Photos opens its `ui.json` by default and keeps
its dedicated screens in Developer Mode, where they still serve its settings, phone
sync and the Locked Folder. File Explorer has no screen of its own: its `ui.json` is a
read-only preview, which the app opens (Mission Control keeps File Explorer's
own page by default). Music keeps its dedicated screens until the shared blocks
reach parity with them (`docs/remaining-work.md`). Satellite icons come from each
Satellite's `icon_name`.

Code written for one Satellite lives only in its own folder (`src/music/`,
`src/photo/`, `src/lockedFolder/`), wired in by
`src/satellites/builtins.tsx` and the navigation. Everything else is generic;
`engine/tests/test_client_modularity.py` lists the couplings left, and that list
may only shrink.

## Project structure

```
mobile/
├── android/              native Android project, with the app's own Kotlin
│                         modules (audio, downloads, files, privacy, build info)
├── src/
│   ├── api/              the StarCore API client (sign-in, sessions)
│   ├── auth/             SessionManager (framework-free), AuthContext, app lock
│   ├── servers/          the saved servers
│   ├── platform/         SecureStore/BiometricAuthenticator/DeviceInfo
│   │                     interfaces, with one *.android.ts implementation
│   │                     each - see platform/README.md
│   ├── navigation/       bottom tabs + the signed-in/signed-out switch
│   ├── screens/          the app's own screens, and SatelliteUiScreen
│   ├── satellites/       the Satellite list and document cache, and in ui/
│   │                     the shared renderer for UI contract documents
│   ├── media/            the shared audio host and player
│   ├── vault/            unlocking any media.vault store: the unlock card, the
│   │                     grant prompt, biometric unlock and a protected
│   │                     document's gate
│   ├── files/            saving, sharing and opening files
│   ├── components/       shared UI (cards, pills, sliders, charts, TopBarSlot,
│   │                     FloatingPlayerInset, ZoomableImage)
│   ├── theme/            tokens.ts (kept in sync with
│   │                     mission_control/tokens.css) and the accent
│   ├── developer/        Developer Mode
│   ├── storage/          plain (non-secret) local preferences
│   ├── music/ photo/     Satellite-specific screens, until they are retired
│   │   lockedFolder/     (docs/remaining-work.md)
│   └── config.ts         build-time constants only - no server address,
│                          no credentials, ever
└── __tests__/            Jest tests (see "Testing" below)
```

## Why React Native

Given "Android first, iOS-ready, shared logic and design system wherever
practical" (see the task brief this block was built from), a cross-platform
framework that shares UI code as well as business logic fits better than
two fully separate native codebases sharing only a hand-drawn design spec -
which is what "reuse the majority of the application logic and design
system" for a future iOS build calls for. React Native is used here in the
most standard way possible: community libraries where they exist, the app's
own Kotlin modules only for what JS can't reach (audio effects and downloads,
saving and sharing files, screen privacy, build info), and `src/App.tsx` as
the only platform-agnostic entry point (`index.js` registers it identically
on Android and, later, iOS).

`src/platform/` is where the genuinely platform-specific 10% lives, kept
behind two small interfaces (see `platform/README.md`) - everything else in
`src/` is already exactly as portable to a future iOS build as it is to
Android today.

## iOS readiness

There is no `ios/` project yet - only Android is being built and tested in
this block (see the task brief's platform scope), and generating a native
iOS project with nothing yet using it would just be unused scaffolding.
Adding iOS later means:

1. `npx react-native-community/cli` (or an equivalent current tool)
   generating the native `ios/` Xcode project.
2. `src/platform/secureStorage.ios.ts` and `src/platform/biometrics.ios.ts`,
   implementing the same two interfaces in `types.ts` via
   `react-native-keychain` and `react-native-biometrics` (both already
   support iOS - this is wiring, not new logic).
3. Everything else in `src/` - every screen, `SessionManager`, the theme,
   the navigation shell - used completely unmodified.

## Testing

```bash
npm test
```

The Jest suites in `__tests__/` cover sessions and the app lock (with
in-memory fakes from `__tests__/fakes.ts`, so a stored token is never trusted
without the live server), the UI contract against the shared fixtures in
`contracts/ui/` (`uiContract.test.ts`), the shared renderer and its blocks,
offline pages, the audio host, files, and the Satellite-specific screens. Run
`npm run typecheck` and `npm run lint` as well.

## Release builds

`pwsh scripts/build-release.ps1 -JavaHome <jdk17>` builds the signed,
standalone release APK (JS bundle embedded - no Metro, USB or ADB) into
`dist/` at the repository root. The release key is kept outside the
checkout (`~/.starcore/signing/keystore.properties` by default, or
`STARCORE_KEYSTORE_PROPERTIES`, or a gitignored `android/keystore.properties`)
and never committed. Version, `versionCode`, commit and build date come from
the repository's `VERSION` file and Git. See `docs/releasing.md` for signing,
publishing, upgrades and rollback.

A debug build (`npm run android`) and a release build are signed with
different keys, so one can only replace the other after uninstalling it.

## Project data and `.gitignore`

This project's own build output, dependencies and any signing material
follow the same rule as the rest of the repository: generated/secret,
never committed. The root `.gitignore` covers, for `mobile/`: `node_modules/`,
Android's `build/`/`local.properties`/Gradle caches, keystores
(`*.keystore`/`*.jks`) and `keystore.properties`, and - ahead of iOS
actually being added - Xcode's `Pods/`/`build/`/per-user state and iOS
signing material (`*.mobileprovision`/`*.p8`/`*.p12`/`*.cer`). See
`test_mobile_build_artifacts_and_signing_secrets_are_ignored` in
`engine/tests/test_gitignore.py`.

Nothing in `src/` or `android/` (source, not build output) contains a real
server address, password, PIN, private key, certificate, or token - see
`src/config.ts`'s own comment on why the server address is entered at
runtime instead.
