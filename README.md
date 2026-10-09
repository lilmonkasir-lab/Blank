# Custom Bots Bedrock

Custom Bots is a Minecraft Bedrock behavior/resource pack for `bot:army21`. The bot keeps its normal entity AI and now has an additional PvP brain. Bots use a 40-health pool so they do not disappear after only a few hits.

## PvP features

- **Fast crystal PvP:** when a target is on the ground and in range, the bot places obsidian beside the target, spawns an end crystal, and pops it with a valid server-side entity attack after a one-tick placement/pop window. Three-pop combos have a short cooldown, while self-damage protection and the five-block reach limit remain enabled. Bots are protected from their own crystal blast.
- **Human-range building:** all obsidian placement is limited to a conservative five-block Bedrock survival reach; the command fallback cannot place blocks from far away.
- **Bridge building:** the bot detects real gaps between itself and a target, places one obsidian block at a time, waits for its movement before placing the next block, and stops after a configurable bridge length. Random clutch/air placement is off by default.
- **Mace, spear, and wind-charge combat:** at close range the bot equips a mace, attempts Density V, Breach IV, and Wind Burst III preparation, jumps, tracks its peak/fall distance, and applies a falling smash bonus only on a real descending/landing window. At spear range it equips a Netherite Spear, attempts Lunge III preparation, lunges toward the target, and performs a server-side jab. At mid-range it launches a real Bedrock wind-charge projectile with a short velocity lead before closing in. Special attacks are cooldown-gated and return to sword/crystal behavior; enchant/item support remains runtime-dependent on the target Bedrock release.
- **Fishing-rod pull:** the bot aims a visible server-side fishing-hook projectile at its locked target and confirms the hit against that same target, then pulls the enemy toward the bot with target-to-bot knockback. This avoids missed hooks caused by custom-entity projectile physics while keeping the action within the normal four-to-five-block rod range.
- **Native sword combat timing:** the entity's delayed melee attack is tuned to a conservative 0.25-second attack duration. Bedrock script does not inject client input; it relies on the entity's native attack component.
- **Competitive movement:** the bot maintains target lock, alternates continuous circle strafing, uses a short hit-select approach delay, counters for a few ticks after being hit, performs a small jump reset after damage, and simulates W-tap/S-tap sprint resets after successful sword hits.
- **Utility switching:** at roughly four to five blocks it uses the targeted fishing-rod pull sequence and immediately returns to the sword/crystal path. When a target has an equipped shield, it briefly switches to an axe before restoring the sword/Mace path. These are server-side approximations where Bedrock does not expose literal player input.
- **Reachable trapping:** low-health or fleeing targets can be trapped with at most two reachable `minecraft:web` placements per target, only when the destination is replaceable and has solid support. No far-away, stationary, or random air placement is used.
- **Explosive combat sequences:** bots alternate between placing a reachable rail, spawning a TNT minecart, and sending a server-side flame-arrow projectile, and placing TNT followed by reachable fire placement while holding Flint and Steel. The sequences are short state machines with cooldowns and return to ordinary sword/crystal combat instead of blocking it.
- **Notch-apple healing:** the bot heal function now equips an enchanted golden apple and applies its absorption, regeneration, resistance, and fire-resistance effects instead of using a normal golden apple.
- **Potion use and totems:** every bot has a real 32-slot inventory seeded with healing, swiftness, strength, and fire-resistance potions. The native `drink_potion` goal and a guarded server-side fallback use them at health and combat thresholds. Each bot receives exactly twelve Totems of Undying: eleven inventory reserves plus one offhand totem; the reserve is moved into the offhand after a native activation, with a health/effect fallback for custom-entity runtimes.
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
- **BedWars maps and economy:** BedWars offers a party-wide vote over Skyline, Canyon, Ruins, and Factory. Each map is a separate, valid Bedrock `.mcstructure` under `MBehavior Pack/structures/bedwars/`, using Bedrock's documented ZYX block-index order and loaded by its namespaced structure ID. Arenas are placed roughly 256–430 blocks away from the host, with a ticking area keeping the distant chunks loaded. The loader verifies a representative marker and every team spawn/bed footprint before teleporting anyone; a failed verification aborts safely instead of using a misleading void arena. A temporary invisible barrier floor and perimeter stop players falling onto the flat world, and only touching the dedicated floor barrier is lethal. Players receive timed iron, gold, diamond, and emerald resources and can open **Shop & Upgrades** to buy wool, stone, end stone, weapons, armor, Notch apples, Sharpness, Protection, Haste, and Forge team upgrades. Winning players and teammates receive a green **Victory** title, team-color winner text, and fireworks at their return locations.

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
