# Custom Bots Bedrock

Custom Bots is a Minecraft Bedrock behavior/resource pack for `bot:army21`. The bot keeps its normal entity AI and now has an additional PvP brain.

## PvP features

- **Crystal PvP:** when a target is on the ground and in range, the bot places obsidian beside the target, spawns an end crystal, breaks it with an entity attack so it explodes, and repeats the combo four times by default. Bots are protected from their own crystal blast.
- **Human-range building:** all obsidian placement is limited to a conservative five-block Bedrock survival reach; the command fallback cannot place blocks from far away.
- **Bridge building:** the bot detects gaps between itself and a target, places obsidian below and ahead of itself, and uses forward impulses to cross. It also has a small falling clutch and stops after a configurable bridge length.
- **Combat movement:** the bot aims at its target, advances at range, retreats when too close, and alternates strafing directions instead of standing still.
- Existing healing, shield, pearl, jump, critical-hit, target-permission, and equipment systems remain enabled.

## In-game settings

Give yourself a stick and use it to open **Settings**. The new menus let you toggle and tune:

- Crystal PvP, number of pops, range, self-distance, and cooldown
- Bridging, clutch blocks, maximum bridge length, and target distance
- Combat movement, strafing, target distance, and strafe timing

The runtime defaults and implementation are in:

`Custom Bots bedrock/MBehavior Pack/scripts/custom/pvp.js`

The behavior pack must be loaded with the resource pack. The packs use the existing `@minecraft/server` 1.9.0 and `@minecraft/server-ui` 1.3.0 dependencies.

## Importing the add-on

Use the provided **`Custom Bots bedrock.mcaddon`** file. Do not rename the GitHub/source repository ZIP to `.mcaddon`; that ZIP has an extra `Blank-main/` folder, so Minecraft cannot find `manifest.json` and shows **Unknown Pack Name**. To rebuild the importable file after changing the packs, run:

```bash
python3 build_mcaddon.py
```

The builder creates two correctly rooted `.mcpack` files inside the `.mcaddon` container, with `manifest.json` at the root of each pack.
