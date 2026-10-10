# RevivalSide Android

Android companion app for running RevivalSide phone-side tooling beside the Android CounterSide client.

## Current Capabilities

- Uses the Android `VpnService` only for explicit official-profile capture.
- Captures `JOIN_LOBBY_ACK` from the official Android client and exports the existing desktop import bundle.
- Extracts the latest `JOIN_LOBBY_ACK` capture into the embedded listener data directory and imports it as the active local profile.
- Starts a foreground RevivalSide listener service with bundled Node.js Mobile.
- Serves the RevivalSide listener and launcher-compatible endpoints on `127.0.0.1:8088`:
  - `GET /launcher/api/health`
  - `GET /launcher/api/official-profile/sources`
  - `POST /launcher/api/official-profile/import-latest`
  - `GET /launcher/api/server-time`
  - `POST /launcher/api/server-time`
  - `POST /launcher/api/server-time/clear`
  - `POST /user-manager/api/reload`
- Validates the installed Counter:Side version and RevivalSide endpoint patch before normal play.
- Runs normal ServerInfo, asset-download, login, and game traffic through Android's kernel TCP stack instead of the gameplay VPN proxy.
- Persists target package, ports, redirect ports, JOIN_LOBBY_ACK mode, and optional Android node path.

The Android app intentionally replaces Windows-only setup pieces with Android equivalents. Npcap/Wireshark becomes opt-in VPN capture, while normal play uses the patched client's local ServerInfo endpoint and the exact same listener payload as PC.

## Offline Payload ZIP

Public Android releases use one cloud-drive ZIP instead of a public loose-file CDN. The user downloads the matching ZIP, taps **IMPORT PAYLOAD ZIP**, and selects it with Android's system file picker. RevivalSide streams it into private app storage, verifies the APK-embedded manifest plus every file size and SHA-256, then serves the activated cache from `127.0.0.1:8088` to Counter:Side's built-in downloader. No root, broad storage permission, ADB tunnel, or write access to Counter:Side's protected app directory is required.

Package the rootless cloud-drive ZIP from the complete Android host tree with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\package-android-offline-payload.ps1 -Force
```

The selected ZIP must stay intact and requires roughly 12.6 GB of additional free space while importing the current payload.

## MuMu CounterSide Install

Start MuMu and make sure ADB is reachable, then run:

```powershell
.\install-counterside-xapk.ps1
```

By default this connects to `10.0.2.240:5555` and installs:

- `com.studiobside.CounterSide.apk`
- `config.armeabi_v7a.apk`

from `C:\Users\moemy\Downloads\CounterSide_9.21.3352381_APKPure.xapk`.

For normal RevivalSide play, patch and sign the user-supplied XAPK/split directory first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\tools\patch-counterside-android-client.ps1 `
  -InputPath C:\path\to\CounterSide.xapk
```

The tool patches both the fixed-width IL2CPP endpoint and Gamebase's launching response passed to Unity, 16 KB-aligns every APK, signs every split with one key, verifies the result, and writes `patched-client.json`. Pass a stable release keystore for public builds; its default debug key is only for local testing.

## Build And Run

### Local fork test releases

The local fork uses version `0.4.4a` (`versionCode=22`). The build compiles the Android Kotlin/Java frontend and DEX from current sources while preserving the verified upstream Android `v0.4.0a` resources, native libraries and game data. It also rebuilds the shared listener and both managed combat hosts.

The main screen uses one START/STOP toggle and a separate Chinese Fierce Boss selector. START starts the local listener; the official capture workflow is not part of this control. Boss selection is persisted outside the account database and applies without restarting; in-flight Fierce battles reject changes.

The local release builder requires Python 3.9+, Node.js, .NET 8, JDK 17, Android SDK 36, cached Kotlin 2.3.0 compiler dependencies, and R8 8.13.19. Obtain the R8 jar from the official Google Maven repository at `https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.13.19/r8-8.13.19.jar`, placing it at `exports/android-build-tools/r8-8.13.19.jar`. Kotlin compatibility is documented at [Android Kotlin support](https://developer.android.com/build/kotlin-support).

Configure `JAVA_HOME`, `ANDROID_HOME`, `REVIVALSIDE_ANDROID_KEYSTORE`, `REVIVALSIDE_ANDROID_KEY_ALIAS`, `REVIVALSIDE_ANDROID_KEYSTORE_PASSWORD` and `REVIVALSIDE_ANDROID_KEY_PASSWORD`, then run:

```sh
REVIVALSIDE_ANDROID_VERSION=0.4.4a REVIVALSIDE_ANDROID_VERSION_CODE=22 bash tools/build-android-local-release.sh
```

Stage new runtime files before packaging. The builder excludes personal account databases and `.env`, removes obsolete shared handlers, compiles the frontend, updates the manifest, aligns and signs the archive, and verifies source/DEX/resource/native/payload hashes. It preserves the original CounterSide client and external payload contract. Fork updates require the same signing identity; back up account data before changing keys.
