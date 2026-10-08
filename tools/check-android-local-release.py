#!/usr/bin/env python3
"""Verify the APK embeds the staged listener, managed host, platform tree and native libs."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(apk_path, report_path):
    report = json.loads(report_path.read_text())
    assets = ROOT / "kmp/app/src/main/assets"
    with zipfile.ZipFile(apk_path) as apk:
        if apk.testzip() is not None:
            raise ValueError("APK ZIP CRC verification failed")
        for name, expected in report["shellFiles"].items():
            if sha(apk.read(name)) != expected:
                raise ValueError(f"Released Android shell changed: {name}")
        if sha(apk.read("AndroidManifest.xml")) != report["manifestSha256"]:
            raise ValueError("Updated Android manifest differs from the packaging report")
        for path in sorted(assets.rglob("*")):
            if path.is_file():
                entry = "assets/" + path.relative_to(assets).as_posix()
                if apk.read(entry) != path.read_bytes():
                    raise ValueError(f"APK asset differs from staged input: {entry}")
        payload = apk.read("assets/revivalside-payload.zip")
        manifest = json.loads(apk.read("assets/revivalside-payload-manifest.json"))
        if sha(payload) != report["payloadSha256"] or manifest["archiveSha256"] != sha(payload) or manifest["archiveSize"] != len(payload):
            raise ValueError("Shared payload manifest mismatch")
        with zipfile.ZipFile(io.BytesIO(payload)) as shared:
            for required in ("cs-listener.js", "server/listener.js", "server-data/starter-users.json", "server-data/captured-flows/manifest.json", "server-data/captured-game-flow/manifest.json"):
                if not shared.read("payload/app/" + required):
                    raise ValueError(f"Missing listener startup file: {required}")
            for name, expected in report["sourceFiles"].items():
                if sha((ROOT / name).read_bytes()) != expected:
                    raise ValueError(f"Source changed since packaging: {name}")
                # This one file receives the existing official/RevivalSide mode bridge.
                packaged_hash = report["packagedListenerSha256"] if name == "server/listener.js" else expected
                if sha(shared.read("payload/app/" + name)) != packaged_hash:
                    raise ValueError(f"Shared listener differs from source: {name}")
        table_data = apk.read("assets/revivalside-gameplay-tables.zip")
        table_manifest = json.loads(apk.read("assets/revivalside-gameplay-tables-manifest.json"))
        if not re.fullmatch(r"\d{1,4}\.\d{1,4}\.[A-Za-z0-9_-]{1,16}", table_manifest["contentsVersion"]):
            raise ValueError("Invalid gameplay table content version")
        if sha(table_data) != table_manifest["archiveSha256"]:
            raise ValueError("Gameplay table archive manifest mismatch")
        with zipfile.ZipFile(io.BytesIO(table_data)) as tables:
            if not tables.read(table_manifest["requiredFile"]):
                raise ValueError("Missing required gameplay stage table")
        for name, expected in report["managedSourceFiles"].items():
            if sha((ROOT / name).read_bytes()) != expected or sha(apk.read("assets/revivalside-listener/" + name)) != expected:
                raise ValueError(f"Managed source changed since packaging: {name}")
        for rid in ("android-arm", "android-arm64"):
            if sha(apk.read(f"assets/revivalside-listener/combat-runtime/{rid}/CombatHost.dll")) != report["combatHostSha256"]:
                raise ValueError(f"Rebuilt host was not embedded for {rid}")
            native_manifest = apk.read(f"assets/revivalside-listener/combat-runtime/{rid}/native-libraries.txt").decode("utf-8-sig")
            abi = "arm64-v8a" if rid == "android-arm64" else "armeabi-v7a"
            native_names = [name.strip() for name in native_manifest.splitlines() if name.strip()]
            if not native_names:
                raise ValueError(f"Missing native runtime list: {rid}")
            for name in native_names:
                if "/" in name or "\\" in name or not name.endswith(".so") or "lib/" + abi + "/" + name not in apk.namelist():
                    raise ValueError(f"Missing or invalid native runtime dependency: {abi}/{name}")
        for required in ("combat-managed/Data/Managed/Assembly-CSharp.dll", "combat-runtime/common/CombatHost.runtimeconfig.json", "combat-runtime/common/Mono.Cecil.dll"):
            if not apk.read("assets/revivalside-listener/" + required):
                raise ValueError(f"Missing managed host startup dependency: {required}")
        for name, expected in report["nativeLibraries"].items():
            if sha(apk.read("lib/" + name)) != expected:
                raise ValueError(f"Native library changed: {name}")
        platform_names = sorted(name for name in apk.namelist() if name.startswith("assets/revivalside-listener/") and not name.endswith("/"))
        records = [f"{name.removeprefix('assets/revivalside-listener/')}|{sha(apk.read(name))}" for name in platform_names]
        platform_hash = sha("\n".join(records).encode())
        platform_manifest = json.loads(apk.read("assets/revivalside-platform-manifest.json"))
        if platform_hash != report["platformTreeSha256"] or platform_manifest["treeSha256"] != platform_hash:
            raise ValueError("Platform tree manifest mismatch")
    print(f"PASS: {apk_path.name}; {len(report['sourceFiles'])} sources; both Android combat hosts; {len(report['nativeLibraries'])} native libraries; inherited {report['shellRelease']} UI; all staged assets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--report", type=Path, default=ROOT / "exports/android-local-build.json")
    options = parser.parse_args()
    verify(options.apk, options.report)
