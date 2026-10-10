#!/usr/bin/env python3
"""Compile the Android Kotlin UI into verified DEX while retaining packaged native libraries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "exports/android-kotlin-ui")
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--r8-jar", type=Path, default=ROOT / "exports/android-build-tools/r8-8.13.19.jar")
    parser.add_argument("--gradle-cache", type=Path, default=Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1")
    args = parser.parse_args()
    output = args.output.resolve()
    if output in (ROOT, ROOT.parent, Path.home(), Path("/")):
        raise ValueError("Use a dedicated UI build directory")
    output.mkdir(parents=True, exist_ok=True)
    classes, dex = output / "classes", output / "dex"
    for directory in (classes, dex):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir()
    version = "2.3.0"
    groups = [f"org.jetbrains.kotlin/kotlin-compiler-embeddable/{version}", f"org.jetbrains.kotlin/kotlin-stdlib/{version}", f"org.jetbrains.kotlin/kotlin-script-runtime/{version}", "org.jetbrains.kotlin/kotlin-reflect", "org.jetbrains.intellij.deps/trove4j", "org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm", "org.jetbrains/annotations"]
    jars = [jar for group in groups for jar in sorted((args.gradle_cache / group).rglob("*.jar"))]
    stdlib = next((args.gradle_cache / groups[1]).rglob("*.jar"))
    annotations = next((args.gradle_cache / groups[-1]).rglob("*.jar"))
    # https://developer.android.com/build/kotlin-support: Kotlin 2.3 needs R8 8.13.19+.
    if not args.r8_jar.is_file():
        raise ValueError("Provide R8 8.13.19 with --r8-jar; SDK 36's bundled D8 cannot read Kotlin 2.3 metadata")
    android = args.sdk / "platforms/android-36/android.jar"
    java = args.java_home / "bin/java"
    javac = args.java_home / "bin/javac"
    java_sources = sorted((ROOT / "kmp/app/src/main/java").rglob("*.java"))
    kotlin_sources = sorted((ROOT / "kmp/app/src/main/kotlin").rglob("*.kt")) + sorted((ROOT / "kmp/shared/src/commonMain/kotlin").rglob("*.kt"))
    subprocess.run([str(javac), "-source", "17", "-target", "17", "-cp", str(android), "-d", str(classes), *map(str, java_sources)], check=True)
    with (output / "compile.log").open("w") as log:
        subprocess.run([str(java), "-Xmx2g", "-cp", os.pathsep.join(map(str, jars)), "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath", os.pathsep.join(map(str, [android, stdlib, annotations, classes])), "-d", str(classes), *map(str, kotlin_sources)], stdout=log, stderr=subprocess.STDOUT, check=True)
    jar = output / "app-classes.jar"
    with zipfile.ZipFile(jar, "w") as archive:
        for file in sorted(classes.rglob("*.class")):
            archive.write(file, file.relative_to(classes).as_posix())
    env = {**os.environ, "JAVA_HOME": str(args.java_home)}
    with (output / "d8.log").open("w") as log:
        subprocess.run([str(java), "-cp", str(args.r8_jar), "com.android.tools.r8.D8", "--release", "--min-api", "26", "--lib", str(android), "--output", str(dex), str(jar), str(stdlib), str(annotations)], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
    manifest = {"schemaVersion": 1, "sourceFiles": {file.relative_to(ROOT).as_posix(): digest(file) for file in java_sources + kotlin_sources}, "dexFiles": {file.name: digest(file) for file in sorted(dex.glob("*.dex"))}, "toolchain": {"kotlin": version, "java": "17", "minApi": 26, "r8Sha256": digest(args.r8_jar)}}
    if not manifest["dexFiles"]:
        raise ValueError("Android UI compilation produced no DEX")
    (output / "ui-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Compiled Android UI: {len(manifest['sourceFiles'])} sources, {len(manifest['dexFiles'])} DEX files")


if __name__ == "__main__":
    main()
