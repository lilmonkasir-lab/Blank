# Custom Bots Bedrock

Custom Bots is a Minecraft Bedrock behavior/resource pack for `bot:army21`. The bot keeps its normal entity AI and now has an additional PvP brain.

## PvP features

- **Crystal PvP:** when a target is on the ground and in range, the bot places obsidian beside the target, spawns an end crystal, breaks it with an entity attack so it explodes, and repeats the combo three times by default. Bots are protected from their own crystal blast.
- **Human-range building:** all obsidian placement is limited to a conservative five-block Bedrock survival reach; the command fallback cannot place blocks from far away.
- **Bridge building:** the bot detects real gaps between itself and a target, places one obsidian block at a time, waits for its movement before placing the next block, and stops after a configurable bridge length. Random clutch/air placement is off by default.
- **Mace and wind-charge combat:** at close range the bot equips a mace, jumps, and adds a falling smash hit; at mid-range it launches a real Bedrock wind-charge projectile with a short velocity lead before closing in. Special attacks are cooldown-gated and return to sword/crystal behavior.
- **Native sword combat timing:** the entity's delayed melee attack is tuned to a conservative 0.25-second attack duration. Bedrock script does not inject client input; it relies on the entity's native attack component.
- **Competitive movement:** the bot maintains target lock, alternates continuous circle strafing, uses a short hit-select approach delay, counters for a few ticks after being hit, performs a small jump reset after damage, and simulates W-tap/S-tap sprint resets after successful sword hits.
- **Utility switching:** at roughly four to five blocks it can simulate a fishing-rod knockback cast and immediately return to the sword. When a target has an equipped shield, it briefly switches to an axe before restoring the sword/Mace path. These are server-side approximations where Bedrock does not expose player input or a reliable summonable fishing hook.
- **Reachable trapping:** low-health or fleeing targets can be trapped with at most two reachable `minecraft:web` placements per target, only when the destination is replaceable and has solid support. No far-away, stationary, or random air placement is used.
- **Combat movement:** the bot aims at its target, advances at range, retreats when too close, and alternates strafing directions instead of standing still.
- Existing healing, shield, pearl, jump, critical-hit, target-permission, and equipment systems remain enabled.

## In-game settings

Give yourself a stick and use it to open **Settings**. The new menus let you toggle and tune:

- Crystal PvP, number of pops, range, self-distance, and cooldown
- Bridging, clutch blocks, maximum bridge length, and target distance
- Mace smash and wind-charge combat
- Combat movement, strafing, target distance, and strafe timing
- Advanced combat timing, sprint/jump reset behavior, projectile leading, axe shield disable, rod utility, and reachable traps
- **Mini Games & Party:** the Settings stick now opens a party menu with four-digit party codes, invitations, and lobby membership. The host can start FFA, Team Battle (real players versus bots), or BedWars Lite with configurable bots, starter kits, team beds, and respawns while beds survive.
- **BedWars maps and economy:** BedWars offers a party-wide vote over Skyline, Canyon, Ruins, and Factory. Each map is a separate packaged Bedrock `.mcstructure` under `MBehavior Pack/structures/bedwars/`, loaded by its namespaced structure ID at a fresh coordinate rather than drawn as the old generic sandstone fill. The loader keeps the arena chunks ticking, verifies a representative marker and every team spawn/bed footprint, and only then teleports players; a command fallback is used only for older worlds missing the structures, and a failed verification aborts safely. Players receive timed iron, gold, diamond, and emerald resources and can open **Shop & Upgrades** to buy wool, stone, end stone, weapons, armor, golden apples, Sharpness, Protection, Haste, and Forge team upgrades.

The runtime defaults and implementation are in:

`Custom Bots bedrock/MBehavior Pack/scripts/custom/pvp.js`

The behavior pack must be loaded with the resource pack. The packs use the existing `@minecraft/server` 1.9.0 and `@minecraft/server-ui` 1.3.0 dependencies.

Mini-games are lightweight Bedrock scripting modes rather than a hosted server network: parties are stored in memory and use a four-digit code, games start around the host's current location, and a world reload clears the party list. Arenas are temporary, their generated region and ticking area are removed when the match ends, and the player/bot mini-game tags are removed so normal PvP resumes.

## Importing the add-on

Use the provided **`Custom Bots bedrock.mcaddon`** file. Do not rename the GitHub/source repository ZIP to `.mcaddon`; that ZIP has an extra `Blank-main/` folder, so Minecraft cannot find `manifest.json` and shows **Unknown Pack Name**. To rebuild the importable file after changing the packs, run:

```bash
python3 build_mcaddon.py
```

The builder creates two correctly rooted `.mcpack` files inside the `.mcaddon` container, with `manifest.json` at the root of each pack.
