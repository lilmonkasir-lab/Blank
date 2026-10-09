#!/usr/bin/env python3
"""Build a Bedrock .mcaddon with correctly rooted behavior/resource packs.

Minecraft expects a .mcaddon to contain one or more .mcpack zip files. Each
inner .mcpack must have manifest.json at its own archive root; zipping the
repository folder itself creates the "Unknown Pack Name" screen.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "Custom Bots bedrock.mcaddon"
PACKS = (
    (ROOT / "Custom Bots bedrock" / "MBehavior Pack", "Custom Bots Behavior.mcpack"),
    (ROOT / "Custom Bots bedrock" / "MResources Pack", "Custom Bots Resources.mcpack"),
)
EXPECTED_STRUCTURES = {
    "structures/bedwars/skyline.mcstructure",
    "structures/bedwars/canyon.mcstructure",
    "structures/bedwars/ruins.mcstructure",
    "structures/bedwars/factory.mcstructure",
}


def make_pack(source: Path) -> bytes:
    manifest_path = source / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Missing pack manifest: {manifest_path}")

    # Parse it before creating the archive so a typo cannot produce another
    # opaque import failure in Bedrock.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("header", {}).get("name"):
        raise ValueError(f"Pack has no header.name: {manifest_path}")

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file():
                continue
            # Never put a parent directory before manifest.json. The pack
            # archive must open with manifest.json at its root.
            archive.write(path, path.relative_to(source).as_posix())

    with zipfile.ZipFile(io.BytesIO(stream.getvalue())) as check:
        names = set(check.namelist())
        if "manifest.json" not in names:
            raise ValueError(f"manifest.json is not at the archive root: {source}")
        if source.name == "MBehavior Pack" and not EXPECTED_STRUCTURES.issubset(names):
            missing = sorted(EXPECTED_STRUCTURES - names)
            raise ValueError(f"Behavior pack is missing BedWars structures: {missing}")
    return stream.getvalue()


def main() -> None:
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as addon:
        for source, filename in PACKS:
            addon.writestr(filename, make_pack(source))

    with zipfile.ZipFile(OUTPUT) as addon:
        names = set(addon.namelist())
        expected = {filename for _, filename in PACKS}
        if names != expected:
            raise ValueError(f"Unexpected .mcaddon contents: {sorted(names)}")

    print(f"Built {OUTPUT}")
    print("Contains:")
    for _, filename in PACKS:
        print(f"  - {filename}")


if __name__ == "__main__":
    main()
