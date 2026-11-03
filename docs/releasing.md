# Releasing StarCore

How a StarCore release is versioned, built, signed, published, deployed, backed up and rolled
back. The first release following this process is `v0.1.0-alpha.1`.

## Versions

The repository's top-level `VERSION` file is the one source of truth, e.g. `0.1.0-alpha.1`
(semver; the pre-release label is `alpha`, `beta` or `rc`, and its number stays below 100).
Everything else derives from it:

| Where | How |
| --- | --- |
| Engine and Mission Control | `engine/starcore/build_info.py` reads `VERSION` at runtime; `/api/status` reports it as `build` |
| Android `versionName` | `android/app/build.gradle` reads the same `VERSION` |
| Android `versionCode` | derived from it so updates always install in release order: `0.1.0-alpha.1` = 100101, `0.1.0-beta.1` = 100201, `0.1.0-rc.1` = 100301, `0.1.0` = 100900, `0.1.1-alpha.1` = 101101 |
| `engine/pyproject.toml` | the PEP 440 spelling (`0.1.0a1`) - checked against `VERSION` by `tests/test_release_hardening.py` |
| `mobile/package.json` | the same string - also checked by that test |

The release channel is the pre-release label (`alpha`), or `stable` without one.

Build metadata comes from Git and is never typed in:

- **Build number** - `git rev-list --count HEAD`: grows with every commit on `main`.
- **Commit** - `git rev-parse --short=7 HEAD`, shown as `<sha> + local changes` when tracked
  files differ from that commit.
- **Build date** - the Engine shows its commit's date (it runs from a checkout); the APK shows
  the UTC day it was built.

A value Git can't provide (a source archive without history) is shown as unknown, never
guessed. None of this includes a server address, account, path or token, so "Copy build info"
in Mission Control (Configuration > About) and in the Android app (Settings > About) is safe to
paste into a public bug report.

To start the next release, change `VERSION`, `engine/pyproject.toml` (then `uv lock` in
`engine/`) and `mobile/package.json` + the two root entries of `mobile/package-lock.json`, and
add a `CHANGELOG.md` section.

## Android signing key

The release APK is signed with one key, and **every future update must be signed with the same
key** - Android refuses to install an update signed differently, and a lost key means users
must uninstall (losing the app's local data) to move to a new one. So:

- The key lives **outside any checkout**, by default `~/.starcore/signing/`
  (`%USERPROFILE%\.starcore\signing\` on Windows): `starcore-release.jks` (PKCS12, RSA 4096,
  alias `starcore`) and `keystore.properties`:

  ```properties
  storeFile=C:/Users/<you>/.starcore/signing/starcore-release.jks
  storePassword=...
  keyAlias=starcore
  keyPassword=...
  ```

  Gradle also accepts the path in `STARCORE_KEYSTORE_PROPERTIES`, or a gitignored
  `mobile/android/keystore.properties`. Never commit either file; `*.jks`, `*.keystore` and
  `keystore.properties` are gitignored as a backstop.
- **Back up the folder** (both files) somewhere offline and encrypted, e.g. a password manager
  attachment. Restrict it to your own account (`icacls <folder> /inheritance:r /grant:r
  "%USERNAME%:(OI)(CI)F"` on Windows, `chmod 700` elsewhere).
- To create a key on a new machine (only ever once per app):

  ```
  keytool -genkeypair -v -storetype PKCS12 -keystore starcore-release.jks -alias starcore \
          -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=StarCore, O=StarCore"
  ```

Without a key, `assembleRelease` warns and produces an unsigned APK, and the release script
refuses to continue. A release build is never signed with the debug key.

**Debug and release builds can't replace each other.** `npm run android` installs a
debug-signed build; a release APK can only replace it after uninstalling it, which deletes the
app's local data (saved servers, sign-ins, downloaded music). Both use the application ID
`com.starcore.mobile`, so updates from one release to the next install in place.

## Building the APK

```
pwsh mobile/scripts/build-release.ps1 -JavaHome C:\path\to\jdk-17
```

The script checks that a release key is configured and the working tree is clean, runs
`gradlew assembleRelease` with that JDK for this build only, verifies the signature with
`apksigner` (refusing a debug-signed result), and writes:

- `dist/StarCore-<version>.apk` - standalone: the JS bundle and assets are embedded, so it
  runs without Metro, USB or ADB
- `dist/StarCore-<version>.apk.sha256`

`-AllowDirty` builds from uncommitted changes for testing; the app then shows
`+ local changes`, so never publish such a build. On Linux/macOS, the same build is
`JAVA_HOME=<jdk17> ./gradlew assembleRelease` in `mobile/android`; the APK is
`app/build/outputs/apk/release/app-release.apk`.

The app has no built-in server address: users enter their own on first launch. An address
typed without a scheme defaults to `https://` for a public host name and to `http://` for a LAN
address, `localhost` or `host:port`.

## Publishing a release

1. `VERSION`, `CHANGELOG.md` and `docs/releases/v<version>.md` are updated and committed.
2. Tests pass (see "Checks" below).
3. Tag the release commit and push it:

   ```
   git tag -a v0.1.0-alpha.1 -m "StarCore 0.1.0-alpha.1"
   git push origin main v0.1.0-alpha.1
   ```

4. Build the APK from that tag with a clean tree (`build-release.ps1`, no `-AllowDirty`).
5. Create the GitHub pre-release with the APK and its checksum:

   ```
   gh release create v0.1.0-alpha.1 --prerelease --title "StarCore 0.1.0-alpha.1" \
       --notes-file docs/releases/v0.1.0-alpha.1.md \
       dist/StarCore-0.1.0-alpha.1.apk dist/StarCore-0.1.0-alpha.1.apk.sha256
   ```

### Checks

| Check | Command |
| --- | --- |
| Engine and Satellites | `cd engine && .venv/Scripts/python -m unittest discover -s tests -t .` |
| Mission Control scripts | `node --check` on every tracked `.js` outside `mobile/` |
| Android | `cd mobile && npx tsc --noEmit && npx jest && npx eslint src __tests__` |
| APK | `build-release.ps1`, then install it on a device or emulator |

## Updating the Linux server

The server runs from a Git checkout (`/opt/starcore/app`, see "Linux server (systemd)" in
`docs/deployment.md`). Back up first (below), then:

```
sudo bash /opt/starcore/app/deploy/linux/install.sh --update   # fast-forward + dependencies
sudo systemctl restart starcore
journalctl -u starcore -n 30                                    # look for "StarCore <version>"
```

`install.sh --update` only fast-forwards to `origin/main`; it stops if the checkout has drifted
and never touches `config.toml` files, data or nginx. To deploy exactly a tag instead:
`sudo -u starcore git -C /opt/starcore/app checkout v0.1.0-alpha.1`, then re-run
`install.sh` (without `--update`) and restart.

## Backups

Everything that isn't code:

| What | Where (Linux server) |
| --- | --- |
| Account, sessions, audit log, Status history, Photo and Music libraries, Locked Folder state and keys | `/var/lib/starcore/` |
| Settings | `/opt/starcore/app/engine/config.toml` and each `satellites/*/*/config.toml` |
| Media StarCore serves | `/srv/starcore/` (and wherever Photo / Locked Folder point) |
| HTTPS proxy | `/etc/nginx/sites-available/starcore` |

```
sudo systemctl stop starcore
sudo tar -czf /root/starcore-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
    /var/lib/starcore /opt/starcore/app/engine/config.toml \
    /opt/starcore/app/satellites/native/*/config.toml /opt/starcore/app/satellites/link/*/config.toml \
    /etc/nginx/sites-available/starcore
sudo systemctl start starcore
```

Stopping first gives a consistent copy of the SQLite databases. Keep the Locked Folder
recovery key (if one was created) separately - it is the only way back into an encrypted vault
if the server key is lost. Add `/srv/starcore` (it can be large) to whatever backs up media.

## Rolling back

**Server.** Stop StarCore, check out the previous tag, re-sync and start:

```
sudo systemctl stop starcore
sudo -u starcore git -C /opt/starcore/app checkout v<previous>
sudo bash /opt/starcore/app/deploy/linux/install.sh
sudo systemctl start starcore
```

If the newer version changed stored data (its changelog says so), restore the backup of
`/var/lib/starcore` taken before the update too. To go back to following `main`:
`sudo -u starcore git -C /opt/starcore/app checkout main`. The nginx site is restored from its
own backup with `sudo cp -a <backup> /etc/nginx/sites-available/starcore && sudo nginx -t &&
sudo systemctl reload nginx`.

**Android.** Android never installs a lower `versionCode` over a higher one. To go back, users
uninstall and install the older APK (losing the app's local data - they sign in again); the
server is unaffected. Prefer fixing forward with the next pre-release number.
