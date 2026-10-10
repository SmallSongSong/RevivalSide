#!/usr/bin/env python3
"""Rebuild a test APK with the verified release UI and newly staged backend assets."""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_SHA = "abad85109100ef5eafb8a9ebb317571d5618af4b2372f27971aa986e0cd33864"
ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def chunks(data):
    cursor = 8
    while cursor < len(data):
        kind, header_size, size = struct.unpack_from("<HHI", data, cursor)
        if size < header_size or size == 0 or cursor + size > len(data):
            raise ValueError("Invalid binary Android XML chunk")
        yield kind, bytearray(data[cursor:cursor + size])
        cursor += size


def length(data, cursor, utf8):
    if utf8:
        first = data[cursor]
        return (((first & 0x7f) << 8) | data[cursor + 1], cursor + 2) if first & 0x80 else (first, cursor + 1)
    first = struct.unpack_from("<H", data, cursor)[0]
    return (((first & 0x7fff) << 16) | struct.unpack_from("<H", data, cursor + 2)[0], cursor + 4) if first & 0x8000 else (first, cursor + 2)


def encode_length(value, utf8):
    if utf8:
        return bytes((0x80 | (value >> 8), value & 0xff)) if value >= 0x80 else bytes((value,))
    return struct.pack("<HH", 0x8000 | (value >> 16), value & 0xffff) if value >= 0x8000 else struct.pack("<H", value)


def read_pool(pool):
    count, style_count, flags, start, _ = struct.unpack_from("<IIIII", pool, 8)
    if style_count:
        raise ValueError("Styled manifest string pools are unsupported")
    utf8 = bool(flags & 0x100)
    header_size = struct.unpack_from("<H", pool, 2)[0]
    strings = []
    for index in range(count):
        cursor = start + struct.unpack_from("<I", pool, header_size + index * 4)[0]
        units, cursor = length(pool, cursor, utf8)
        if utf8:
            byte_length, cursor = length(pool, cursor, True)
            strings.append(bytes(pool[cursor:cursor + byte_length]).decode("utf-8"))
        else:
            strings.append(bytes(pool[cursor:cursor + units * 2]).decode("utf-16le"))
    return strings, utf8


def write_pool(pool, strings, utf8):
    header_size = struct.unpack_from("<H", pool, 2)[0]
    start = header_size + len(strings) * 4
    result = bytearray(pool[:header_size])
    struct.pack_into("<II", result, 20, start, 0)
    data = bytearray()
    offsets = []
    for value in strings:
        offsets.append(len(data))
        units = len(value.encode("utf-16le")) // 2
        if utf8:
            encoded = value.encode("utf-8")
            data += encode_length(units, True) + encode_length(len(encoded), True) + encoded + b"\0"
        else:
            data += encode_length(units, False) + value.encode("utf-16le") + b"\0\0"
    result += struct.pack("<" + "I" * len(offsets), *offsets) + data
    result += b"\0" * (-len(result) % 4)
    struct.pack_into("<I", result, 4, len(result))
    return result


def update_manifest(data, version, version_code):
    if struct.unpack_from("<HHI", data, 0) != (3, 8, len(data)):
        raise ValueError("Expected a binary Android manifest")
    parts = list(chunks(data))
    pool_index = next(index for index, (kind, _) in enumerate(parts) if kind == 1)
    strings, utf8 = read_pool(parts[pool_index][1])
    changed = set()
    for kind, node in parts:
        if kind != 0x102 or strings[struct.unpack_from("<I", node, 20)[0]] != "manifest":
            continue
        attribute_start, attribute_size, attribute_count = struct.unpack_from("<HHH", node, 24)
        if attribute_size != 20:
            raise ValueError("Unsupported manifest attribute size")
        for index in range(attribute_count):
            cursor = 16 + attribute_start + index * attribute_size
            namespace, name, raw = struct.unpack_from("<III", node, cursor)
            if namespace == 0xffffffff or strings[namespace] != ANDROID_NAMESPACE:
                continue
            name = strings[name]
            value_type = node[cursor + 15]
            value = struct.unpack_from("<I", node, cursor + 16)[0]
            if name == "versionName":
                if value_type != 3:
                    raise ValueError("versionName is not a literal string")
                strings[value] = version
                if raw != 0xffffffff:
                    strings[raw] = version
                changed.add(name)
            elif name == "versionCode":
                if value_type not in (0x10, 0x11):
                    raise ValueError("versionCode is not a literal integer")
                struct.pack_into("<I", node, cursor + 16, version_code)
                if raw != 0xffffffff:
                    strings[raw] = str(version_code)
                changed.add(name)
    if changed != {"versionName", "versionCode"}:
        raise ValueError("Both manifest version attributes must be present")
    parts[pool_index] = (1, write_pool(parts[pool_index][1], strings, utf8))
    result = bytearray(data[:8]) + b"".join(part for _, part in parts)
    struct.pack_into("<I", result, 4, len(result))
    return bytes(result)


def is_signature(name):
    return name.upper() == "META-INF/MANIFEST.MF" or bool(re.fullmatch(r"META-INF/[^/]+\.(SF|RSA|DSA|EC)", name, re.I))


def build(args):
    if args.output.resolve() == args.upstream_apk.resolve():
        raise ValueError("The rebuilt APK must use a different output path from the upstream APK")
    if digest_file(args.upstream_apk) != UPSTREAM_SHA:
        raise ValueError("Upstream release shell SHA-256 mismatch")
    report = json.loads(args.report.read_text())
    if report["version"] != args.version or report["upstreamApkSha256"] != UPSTREAM_SHA:
        raise ValueError("Backend staging report does not match this build")
    assets = ROOT / "kmp/app/src/main/assets"
    compiled_ui = None
    if args.compiled_ui:
        compiled_ui = json.loads((args.compiled_ui / "ui-manifest.json").read_text())
        for name, expected in compiled_ui["sourceFiles"].items():
            if digest_file(ROOT / name) != expected:
                raise ValueError(f"UI source changed since compilation: {name}")
        for name, expected in compiled_ui["dexFiles"].items():
            if not re.fullmatch(r"classes(?:\d+)?\.dex", name) or digest_file(args.compiled_ui / "dex" / name) != expected:
                raise ValueError(f"Invalid compiled UI DEX: {name}")
        report["compiledUi"] = compiled_ui
        report["shellFiles"] = {name: value for name, value in report["shellFiles"].items() if not re.fullmatch(r"classes(?:\d+)?\.dex", name)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.upstream_apk) as source, zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        manifest = update_manifest(source.read("AndroidManifest.xml"), args.version, args.version_code)
        for entry in source.infolist():
            if entry.is_dir() or is_signature(entry.filename) or entry.filename.startswith("assets/revivalside-"):
                continue
            if compiled_ui and re.fullmatch(r"classes(?:\d+)?\.dex", entry.filename):
                continue
            info = copy.copy(entry)
            info.extra = b""  # zipalign recreates alignment after packaging.
            target.writestr(info, manifest if entry.filename == "AndroidManifest.xml" else source.read(entry))
        if compiled_ui:
            for name in compiled_ui["dexFiles"]:
                target.writestr(name, (args.compiled_ui / "dex" / name).read_bytes())
        for path in sorted(assets.rglob("*")):
            if not path.is_file() or not path.relative_to(assets).as_posix().startswith("revivalside-"):
                continue
            info = zipfile.ZipInfo("assets/" + path.relative_to(assets).as_posix(), (2026, 10, 8, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if path.suffix == ".zip" else zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, path.read_bytes())
    report.update({"versionCode": args.version_code, "manifestSha256": hashlib.sha256(manifest).hexdigest()})
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    ui = "compiled Kotlin UI" if compiled_ui else f"inherited {report['shellRelease']} UI"
    print(f"Rebuilt unsigned APK with {ui}: {args.output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-apk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default="0.4.3a")
    parser.add_argument("--version-code", type=int, default=15)
    parser.add_argument("--report", type=Path, default=ROOT / "exports/android-local-build.json")
    parser.add_argument("--compiled-ui", type=Path)
    build(parser.parse_args())
