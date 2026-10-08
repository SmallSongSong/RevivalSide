#!/usr/bin/env python3
"""Stage current listener sources and a rebuilt managed host with pinned Android binaries."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "kmp/app/src/main/assets"
UPSTREAM_SHA = "abad85109100ef5eafb8a9ebb317571d5618af4b2372f27971aa986e0cd33864"
SOURCE_ROOTS = ("server", "modules", "packet-handlers", "combat-handler", "combat-simulator", "stages")
SOURCE_FILES = ("cs-listener.js", "package.json", "package-lock.json", "packet-schema.json")
FIXED_TIME = (2026, 10, 8, 0, 0, 0)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def source_paths():
    # Only versioned files enter the archive; private server-data and local profiles stay out.
    names = git("ls-files", "-z").decode().split("\0")
    return sorted(name for name in names if name and (ROOT / name).is_file())


def source_overlay(names, inherited):
    return {
        name: (ROOT / name).read_bytes()
        for name in names
        if name in SOURCE_FILES
        or name.split("/")[0] in SOURCE_ROOTS
        or name in inherited and not name.startswith("server-data/")
    }


def safe_relative(name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name:
        raise ValueError(f"Unsafe archive path: {name}")
    return relative


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def tree_sha(directory):
    records = [f"{path.relative_to(directory).as_posix()}|{file_sha(path)}" for path in sorted(directory.rglob("*")) if path.is_file()]
    return sha("\n".join(records).encode())


def check_publish(publish):
    for name in ("CombatHost.dll", "CombatHost.deps.json", "CombatHost.runtimeconfig.json"):
        if not (publish / name).is_file():
            raise ValueError(f"Missing rebuilt managed host file: {publish / name}")
    config = json.loads((publish / "CombatHost.runtimeconfig.json").read_text())
    if config["runtimeOptions"]["tfm"] != "net8.0":
        raise ValueError("The embedded Android runtime requires a net8.0 host")
    deps = json.loads((publish / "CombatHost.deps.json").read_text())
    libraries = set(deps["libraries"])
    if libraries != {"CombatHost/1.0.0", "Mono.Cecil/0.11.5"}:
        raise ValueError(f"Managed dependencies changed; rebuild Android runtime manifests: {libraries}")


def stage(args):
    untracked_runtime = [name for name in git("ls-files", "--others", "--exclude-standard", "-z", "--", *SOURCE_ROOTS, "combat-host").decode().split("\0") if name]
    if untracked_runtime:
        raise ValueError("Stage new runtime files with git add before packaging: " + ", ".join(untracked_runtime))
    if file_sha(args.upstream_apk) != UPSTREAM_SHA:
        raise ValueError("Upstream APK SHA-256 differs from the pinned v0.4.0a release")
    check_publish(args.combat_host_publish)
    names = source_paths()
    managed_sources = {name: (ROOT / name).read_bytes() for name in names if name.startswith("combat-host/")}
    # Reusing the native bridge is valid only while its source and build flags stay unchanged.
    for name in ("kmp/app/src/main/cpp/native-lib.cpp", "kmp/app/src/main/cpp/dotnet-host.cpp", "kmp/app/CMakeLists.txt"):
        if (ROOT / name).read_bytes() != git("show", f"{args.native_source_ref}:{name}"):
            raise ValueError(f"Native source changed: {name}; build with the NDK instead")
    with zipfile.ZipFile(args.upstream_apk) as base, tempfile.TemporaryDirectory(prefix="revivalside-stage-") as temporary:
        staging = Path(temporary)
        asset_dir = staging / "assets"
        native_dir = staging / "jniLibs"
        for entry in base.infolist():
            if entry.is_dir():
                continue
            if entry.filename.startswith("assets/revivalside-"):
                target = asset_dir / str(safe_relative(entry.filename.removeprefix("assets/")))
            elif entry.filename.startswith("lib/"):
                target = native_dir / str(safe_relative(entry.filename.removeprefix("lib/")))
            else:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base.read(entry))
        old_archive = asset_dir / "revivalside-payload.zip"
        with zipfile.ZipFile(old_archive) as archive:
            inherited = {entry.filename.removeprefix("payload/app/"): archive.read(entry) for entry in archive.infolist() if not entry.is_dir() and entry.filename.startswith("payload/app/")}
        current = source_overlay(names, inherited)
        # Remove old handlers before overlaying so renamed/deleted packet IDs cannot survive.
        merged = {name: data for name, data in inherited.items() if name.split("/")[0] not in SOURCE_ROOTS and "__pycache__" not in name and not name.endswith(".pyc") and name != ".env"}
        merged.update(current)
        listener = staging / "listener.js"
        listener.write_bytes(merged["server/listener.js"])
        subprocess.run(["node", str(ROOT / "tools/patch-android-official-server-bridge.js"), str(listener)], check=True)
        merged["server/listener.js"] = listener.read_bytes()
        with zipfile.ZipFile(old_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(merged.items()):
                safe_relative(name)
                entry = zipfile.ZipInfo("payload/app/" + name, FIXED_TIME)
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, data)
        payload_hash = file_sha(old_archive)
        write_json(asset_dir / "revivalside-payload-manifest.json", {
            "schemaVersion": 1, "payloadId": f"revivalside-{args.version}-android",
            "sourcePayloadId": f"revivalside-{args.version}", "releaseTag": f"v{args.version}",
            "archiveName": "revivalside-payload.zip", "archiveSize": old_archive.stat().st_size,
            "archiveSha256": payload_hash,
        })
        platform = asset_dir / "revivalside-listener"
        for name, data in managed_sources.items():
            target = platform / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for rid in ("android-arm", "android-arm64"):
            shutil.copyfile(args.combat_host_publish / "CombatHost.dll", platform / "combat-runtime" / rid / "CombatHost.dll")
        for dll in args.combat_host_publish.glob("Mono.Cecil*.dll"):
            shutil.copyfile(dll, platform / "combat-runtime/common" / dll.name)
        platform_hash = tree_sha(platform)
        write_json(asset_dir / "revivalside-platform-manifest.json", {
            "schemaVersion": 1, "platformId": "revivalside-android-platform-" + platform_hash[:12],
            "treeSha256": platform_hash, "requiredFile": "combat-managed/Data/Managed/Assembly-CSharp.dll",
        })
        report = {
            "buildMode": "rebuilt-listener-and-managed-host-with-pinned-release-shell",
            "shellRelease": "v0.4.0a",
            "version": args.version, "baseCommit": git("rev-parse", "HEAD").decode().strip(),
            "trackedWorktreeChanges": git("diff", "--name-only", "HEAD").decode().splitlines(),
            "upstreamApkSha256": UPSTREAM_SHA, "nativeSourceRef": args.native_source_ref,
            "payloadSha256": payload_hash, "platformTreeSha256": platform_hash,
            "packagedListenerSha256": sha(merged["server/listener.js"]),
            "combatHostSha256": file_sha(args.combat_host_publish / "CombatHost.dll"),
            "sourceFiles": {name: sha(data) for name, data in sorted(current.items())},
            "managedSourceFiles": {name: sha(data) for name, data in sorted(managed_sources.items())},
            "nativeLibraries": {path.relative_to(native_dir).as_posix(): file_sha(path) for path in sorted(native_dir.rglob("*.so"))},
            "shellFiles": {name: sha(base.read(name)) for name in sorted(base.namelist()) if name.endswith(".dex") or name == "resources.arsc" or name.startswith("res/")},
            "upstreamManifestSha256": sha(base.read("AndroidManifest.xml")),
        }
        # Detect source edits during staging before replacing the active build assets.
        if current != source_overlay(source_paths(), inherited):
            raise ValueError("Listener source changed while staging; retry after source work is complete")
        if managed_sources != {name: (ROOT / name).read_bytes() for name in source_paths() if name.startswith("combat-host/")}:
            raise ValueError("Managed host source changed while staging; rebuild and retry")
        for path in asset_dir.iterdir():
            target = ASSETS / path.name
            if path.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(path, target)
            else:
                shutil.copyfile(path, target)
        target_native = ROOT / "kmp/app/src/main/jniLibs"
        if target_native.exists():
            shutil.rmtree(target_native)
        shutil.copytree(native_dir, target_native)
        write_json(args.report, report)
        print(f"Staged {len(current)} current source files; payload {payload_hash}; host {report['combatHostSha256']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-apk", type=Path, required=True)
    parser.add_argument("--combat-host-publish", type=Path, required=True)
    parser.add_argument("--native-source-ref", required=True)
    parser.add_argument("--version", default="0.4.1-local.2")
    parser.add_argument("--report", type=Path, default=ROOT / "exports/android-local-build.json")
    stage(parser.parse_args())
