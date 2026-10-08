#!/usr/bin/env python3
"""Generate the packaged BedWars .mcstructure arenas.

The files written here are uncompressed little-endian Bedrock NBT.  They are
kept as generated binary assets in the behavior pack, while this small builder
makes the layouts reproducible and easy to inspect or revise.
"""

from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STRUCTURE_DIR = ROOT / "Custom Bots bedrock" / "MBehavior Pack" / "structures" / "bedwars"

# Bedrock structure palette entries use a block-version integer.  This is the
# version emitted by current structure exporters and is accepted by modern
# Bedrock runtimes even when the pack's minimum engine version is newer.
BLOCK_VERSION = 17879555
SIZE_X = 55
SIZE_Y = 7
SIZE_Z = 55
CENTER = 27

MAPS = {
    "skyline": {
        "base": "minecraft:stone",
        "accent": "minecraft:quartz_block",
        "trim": "minecraft:smooth_quartz",
        "light": "minecraft:sea_lantern",
        "teams": [(0, -18), (18, 0), (0, 18), (-18, 0)],
        "islands": [(0, -18), (18, 0), (0, 18), (-18, 0), (0, 0)],
    },
    "canyon": {
        "base": "minecraft:sandstone",
        "accent": "minecraft:red_sandstone",
        "trim": "minecraft:cut_sandstone",
        "light": "minecraft:orange_terracotta",
        "teams": [(-16, -16), (16, -16), (16, 16), (-16, 16)],
        "islands": [(-16, -16), (16, -16), (16, 16), (-16, 16), (0, 0)],
    },
    "ruins": {
        "base": "minecraft:deepslate",
        "accent": "minecraft:stone_bricks",
        "trim": "minecraft:cracked_stone_bricks",
        "light": "minecraft:mossy_cobblestone",
        "teams": [(0, -20), (20, 0), (0, 20), (-20, 0)],
        "islands": [(0, -20), (20, 0), (0, 20), (-20, 0), (0, 0), (10, 10), (-10, -10)],
    },
    "factory": {
        "base": "minecraft:bricks",
        "accent": "minecraft:iron_block",
        "trim": "minecraft:polished_andesite",
        "light": "minecraft:light_gray_concrete",
        "teams": [(-18, 0), (0, -18), (18, 0), (0, 18)],
        "islands": [(-18, 0), (0, -18), (18, 0), (0, 18), (0, 0), (-10, -10), (10, 10)],
    },
}


def be_u16(value: int) -> bytes:
    return struct.pack("<H", value)


def be_i32(value: int) -> bytes:
    return struct.pack("<i", value)


def string_payload(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return be_u16(len(encoded)) + encoded


def tag(tag_type: int, name: str, payload: bytes) -> bytes:
    return bytes([tag_type]) + string_payload(name) + payload


def byte_tag(name: str, value: int) -> bytes:
    return tag(1, name, struct.pack("<b", value))


def int_tag(name: str, value: int) -> bytes:
    return tag(3, name, be_i32(value))


def string_tag(name: str, value: str) -> bytes:
    return tag(8, name, string_payload(value))


def list_payload(element_type: int, values: list[bytes]) -> bytes:
    return bytes([element_type]) + be_i32(len(values)) + b"".join(values)


def list_tag(name: str, element_type: int, values: list[bytes]) -> bytes:
    return tag(9, name, list_payload(element_type, values))


def compound_payload(children: list[bytes]) -> bytes:
    return b"".join(children) + b"\x00"


def compound_tag(name: str, children: list[bytes]) -> bytes:
    return tag(10, name, compound_payload(children))


def palette_entry(name: str) -> bytes:
    return compound_payload([
        string_tag("name", name),
        compound_tag("states", []),
        int_tag("version", BLOCK_VERSION),
    ])


def add_rect(blocks: dict[tuple[int, int, int], str], x0: int, x1: int,
             y: int, z0: int, z1: int, block: str) -> None:
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for z in range(min(z0, z1), max(z0, z1) + 1):
            blocks[(x, y, z)] = block


def add_island(blocks: dict[tuple[int, int, int], str], ox: int, oz: int,
               radius: int, theme: dict[str, str], central: bool = False) -> None:
    # A broad base with a contrasting perimeter reads as a designed island,
    # while its full support layer leaves every team spawn and bed grounded.
    add_rect(blocks, CENTER + ox - radius, CENTER + ox + radius, 0,
             CENTER + oz - radius, CENTER + oz + radius, theme["base"])
    for x in range(CENTER + ox - radius, CENTER + ox + radius + 1):
        for z in range(CENTER + oz - radius, CENTER + oz + radius + 1):
            edge = abs(x - (CENTER + ox)) == radius or abs(z - (CENTER + oz)) == radius
            corner = abs(x - (CENTER + ox)) == radius and abs(z - (CENTER + oz)) == radius
            if edge:
                blocks[(x, 0, z)] = theme["accent"] if corner else theme["trim"]

    # Low corner pillars and lamps give each template a distinct silhouette
    # without occupying the center spawn or bed lane.
    if not central:
        for dx, dz in [(-radius + 1, -radius + 1), (radius - 1, radius - 1)]:
            x, z = CENTER + ox + dx, CENTER + oz + dz
            blocks[(x, 1, z)] = theme["accent"]
            blocks[(x, 2, z)] = theme["trim"]
        # Keep the center of every team island clear: the script spawns
        # fighters at y=base+1 and places the bed beside that point.
        blocks[(CENTER + ox, 1, CENTER + oz - radius + 2)] = theme["light"]
    else:
        # The center resource island has four small corner towers and an open
        # 5x5 landing area for fights and bridge approaches.
        for dx, dz in [(-5, -5), (5, -5), (5, 5), (-5, 5)]:
            x, z = CENTER + ox + dx, CENTER + oz + dz
            blocks[(x, 1, z)] = theme["accent"]
            blocks[(x, 2, z)] = theme["trim"]
        blocks[(CENTER + ox, 1, CENTER + oz)] = theme["light"]


def add_bridge(blocks: dict[tuple[int, int, int], str], a: tuple[int, int],
               b: tuple[int, int], block: str, width: int = 3) -> None:
    ax, az = a
    bx, bz = b
    steps = max(abs(bx - ax), abs(bz - az))
    if steps == 0:
        return
    for step in range(steps + 1):
        progress = step / steps
        x = round(ax + (bx - ax) * progress)
        z = round(az + (bz - az) * progress)
        if abs(bx - ax) >= abs(bz - az):
            for side in range(-(width // 2), width // 2 + 1):
                add_rect(blocks, x, x, 0, z + side, z + side, block)
        else:
            for side in range(-(width // 2), width // 2 + 1):
                add_rect(blocks, x + side, x + side, 0, z, z, block)


def make_structure(theme: dict[str, object]) -> bytes:
    blocks: dict[tuple[int, int, int], str] = {}
    teams = theme["teams"]
    islands = theme["islands"]

    for index, (ox, oz) in enumerate(islands):
        radius = 6 if index < 4 else (7 if (ox, oz) == (0, 0) else 4)
        add_island(blocks, ox, oz, radius, theme, central=(ox, oz) == (0, 0))

    # Every team has a direct, three-wide route to the central island.  The
    # structure therefore loads as a playable arena before shop/upgrade logic
    # starts, rather than as disconnected decorative slabs.
    for ox, oz in teams:
        start = (CENTER + ox, CENTER + oz)
        add_bridge(blocks, start, (CENTER, CENTER), theme["base"], width=3)
        # Add a contrasting center stripe to make each bridge readable.
        add_bridge(blocks, start, (CENTER, CENTER), theme["trim"], width=1)

    # Leave a deterministic base block beneath the resource marker. The game
    # loader uses this cell as its representative post-load verification.
    blocks[(CENTER, 0, CENTER)] = theme["base"]

    # Keep all blocks inside the declared bounds and write the X/Z/Y order
    # used by Bedrock: y * sizeZ * sizeX + z * sizeX + x.
    palette_names = ["minecraft:air"]
    for name in [theme["base"], theme["accent"], theme["trim"], theme["light"]]:
        if name not in palette_names:
            palette_names.append(name)
    palette_index = {name: index for index, name in enumerate(palette_names)}
    primary: list[int] = []
    # Bedrock flattens positions in ZYX order: X is the outer dimension,
    # followed by Y, then Z.  This is easy to get wrong when generating files;
    # using the documented order is what makes the loaded islands line up with
    # the JavaScript coordinates used for spawns and beds.
    for x in range(SIZE_X):
        for y in range(SIZE_Y):
            for z in range(SIZE_Z):
                primary.append(palette_index.get(blocks.get((x, y, z), "minecraft:air"), 0))
    secondary = [-1] * len(primary)

    palette = compound_tag("default", [
        list_tag("block_palette", 10, [palette_entry(name) for name in palette_names]),
        compound_tag("block_position_data", []),
    ])
    structure = compound_tag("structure", [
        list_tag("block_indices", 9, [
            list_payload(3, [be_i32(value) for value in primary]),
            list_payload(3, [be_i32(value) for value in secondary]),
        ]),
        list_tag("entities", 10, []),
        compound_tag("palette", [palette]),
    ])
    root = compound_payload([
        int_tag("format_version", 1),
        list_tag("size", 3, [be_i32(SIZE_X), be_i32(SIZE_Y), be_i32(SIZE_Z)]),
        structure,
        list_tag("structure_world_origin", 3, [be_i32(0), be_i32(0), be_i32(0)]),
    ])
    return b"\x0a\x00\x00" + root


def main() -> None:
    STRUCTURE_DIR.mkdir(parents=True, exist_ok=True)
    for map_id, theme in MAPS.items():
        path = STRUCTURE_DIR / f"{map_id}.mcstructure"
        path.write_bytes(make_structure(theme))
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
