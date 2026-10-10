#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream_apk="${1:-$repo_root/exports/upstream-android/RevivalSide-Android-v0.4.4a.apk}"
dotnet_bin="${DOTNET_BIN:-dotnet}"
python_bin="${PYTHON_BIN:-python3}"
version="${REVIVALSIDE_ANDROID_VERSION:-0.4.5a}"
version_code="${REVIVALSIDE_ANDROID_VERSION_CODE:-23}"
publish_dir="$repo_root/exports/android-combat-host"
output_apk="$repo_root/exports/RevivalSide-Android-v$version.apk"
unsigned_apk="$repo_root/exports/RevivalSide-Android-v$version-unsigned.apk"
aligned_apk="$repo_root/exports/RevivalSide-Android-v$version-aligned.apk"
build_tools="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Set ANDROID_HOME or ANDROID_SDK_ROOT}}/build-tools/36.0.0"
ui_dir="$repo_root/exports/android-kotlin-ui"

for variable in REVIVALSIDE_ANDROID_KEYSTORE REVIVALSIDE_ANDROID_KEY_ALIAS REVIVALSIDE_ANDROID_KEYSTORE_PASSWORD REVIVALSIDE_ANDROID_KEY_PASSWORD; do
  if [[ -z "${!variable:-}" ]]; then
    echo "Set $variable before building a signed test release." >&2
    exit 1
  fi
done

"$python_bin" "$repo_root/tools/compile-android-local-ui.py" --output "$ui_dir" \
  --sdk "${ANDROID_HOME:-$ANDROID_SDK_ROOT}" --java-home "${JAVA_HOME:?Set JAVA_HOME to JDK 17}"

"$dotnet_bin" publish "$repo_root/combat-host/CombatHost.csproj" -c Release \
  --self-contained false -p:UseAppHost=false -o "$publish_dir"
"$python_bin" "$repo_root/tools/stage-android-local-release.py" \
  --upstream-apk "$upstream_apk" --combat-host-publish "$publish_dir" \
  --native-source-ref 0bc49be43e4b2ee1f7876b57cc9e83d195da148b --version "$version"

"$python_bin" "$repo_root/tools/repack-android-local-release.py" \
  --upstream-apk "$upstream_apk" --output "$unsigned_apk" --version "$version" --version-code "$version_code" --compiled-ui "$ui_dir"
"$build_tools/zipalign" -P 16 -f 4 "$unsigned_apk" "$aligned_apk"
"$build_tools/apksigner" sign --ks "$REVIVALSIDE_ANDROID_KEYSTORE" \
  --ks-key-alias "$REVIVALSIDE_ANDROID_KEY_ALIAS" \
  --ks-pass env:REVIVALSIDE_ANDROID_KEYSTORE_PASSWORD --key-pass env:REVIVALSIDE_ANDROID_KEY_PASSWORD \
  --out "$output_apk" "$aligned_apk"
"$python_bin" "$repo_root/tools/check-android-local-release.py" "$output_apk"
"$build_tools/apksigner" verify --verbose "$output_apk"
echo "Signed APK: $output_apk"
