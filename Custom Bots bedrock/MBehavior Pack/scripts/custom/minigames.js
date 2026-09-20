import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

/*
 * Lightweight party and mini-game layer.
 *
 * Bedrock add-ons do not have a server-side friends/invite service or private
 * world instances. Parties therefore use a short code, and games run in a
 * temporary arena around the party host. The modes are deliberately small and
 * safe to stop: FFA, Team Battle (real players versus bots), and BedWars Lite
 * with team beds and respawns while a bed remains.
 */

const MAX_PARTY_SIZE = 4;
const MAX_BOTS = 8;
const DEFAULT_BOTS = 4;
const GAME_TAG = "minigame_active";
const PLAYER_TAG = "minigame_player";
const BOT_TAG = "minigame_bot";
const GAME_ID_TAG_PREFIX = "minigame_game_";
const TEAM_TAG_PREFIX = "minigame_team_";
const TEAM_NAMES = ["Red", "Blue", "Green", "Yellow"];
const TEAM_COLORS = ["§c", "§9", "§a", "§e"];

// Maps are packaged Bedrock structures. They are loaded at a fresh coordinate
// near the host so two matches do not share the same beds or islands.
const BEDWARS_MAPS = [
    {
        id: "skyline",
        name: "Skyline",
        description: "Four sky islands with a central diamond island.",
        teamOffsets: [{ x: 0, z: -18 }, { x: 18, z: 0 }, { x: 0, z: 18 }, { x: -18, z: 0 }],
        islandOffsets: [{ x: 0, z: -18 }, { x: 18, z: 0 }, { x: 0, z: 18 }, { x: -18, z: 0 }, { x: 0, z: 0 }],
        baseBlock: "minecraft:stone",
        accentBlock: "minecraft:quartz_block",
        structureMarker: "minecraft:sea_lantern"
    },
    {
        id: "canyon",
        name: "Canyon",
        description: "Sandstone bases in a diagonal canyon layout.",
        teamOffsets: [{ x: -16, z: -16 }, { x: 16, z: -16 }, { x: 16, z: 16 }, { x: -16, z: 16 }],
        islandOffsets: [{ x: -16, z: -16 }, { x: 16, z: -16 }, { x: 16, z: 16 }, { x: -16, z: 16 }, { x: 0, z: 0 }],
        baseBlock: "minecraft:sandstone",
        accentBlock: "minecraft:red_sandstone",
        structureMarker: "minecraft:orange_terracotta"
    },
    {
        id: "ruins",
        name: "Ruins",
        description: "Deepslate ruins with close side routes and a middle island.",
        teamOffsets: [{ x: 0, z: -20 }, { x: 20, z: 0 }, { x: 0, z: 20 }, { x: -20, z: 0 }],
        islandOffsets: [{ x: 0, z: -20 }, { x: 20, z: 0 }, { x: 0, z: 20 }, { x: -20, z: 0 }, { x: 0, z: 0 }, { x: 10, z: 10 }, { x: -10, z: -10 }],
        baseBlock: "minecraft:deepslate",
        accentBlock: "minecraft:stone_bricks",
        structureMarker: "minecraft:mossy_cobblestone"
    },
    {
        id: "factory",
        name: "Factory",
        description: "A square factory ring with a busy emerald center.",
        teamOffsets: [{ x: -18, z: 0 }, { x: 0, z: -18 }, { x: 18, z: 0 }, { x: 0, z: 18 }],
        islandOffsets: [{ x: -18, z: 0 }, { x: 0, z: -18 }, { x: 18, z: 0 }, { x: 0, z: 18 }, { x: 0, z: 0 }, { x: -10, z: -10 }, { x: 10, z: 10 }],
        baseBlock: "minecraft:bricks",
        accentBlock: "minecraft:iron_block",
        structureMarker: "minecraft:light_gray_concrete"
    }
];
const MAP_ORIGIN_OFFSETS = [
    { x: 64, z: 0 }, { x: -64, z: 0 }, { x: 0, z: 64 }, { x: 0, z: -64 },
    { x: 96, z: 48 }, { x: -96, z: -48 }, { x: 48, z: -96 }, { x: -48, z: 96 }
];

const parties = new Map();
const playerPartyCodes = new Map();
const pendingInvites = new Map();
const games = new Map();
const playerGames = new Map();
let nextGameId = 1;

function isValid(entity) {
    try {
        return !!entity && entity.isValid();
    } catch (error) {
        return false;
    }
}

function getPlayerById(id) {
    if (!id) return null;
    try {
        for (const player of world.getPlayers()) {
            if (player.id === id) return player;
        }
    } catch (error) {}
    return null;
}

function getPlayerByName(name) {
    if (!name) return null;
    try {
        for (const player of world.getPlayers()) {
            if (player.name === name) return player;
        }
    } catch (error) {}
    return null;
}

function getEntityById(id) {
    if (!id) return null;
    try {
        return world.getEntity(id);
    } catch (error) {
        return null;
    }
}

function safeMessage(player, message) {
    try {
        if (isValid(player)) player.sendMessage(message);
    } catch (error) {}
}

function safeCommand(entity, command) {
    try {
        if (isValid(entity)) {
            entity.runCommand(command);
            return true;
        }
    } catch (error) {}
    return false;
}

function safeAddTag(entity, tag) {
    try {
        entity.addTag(tag);
        return;
    } catch (error) {}
    safeCommand(entity, `tag @s add ${tag}`);
}

function safeRemoveTag(entity, tag) {
    try {
        entity.removeTag(tag);
        return;
    } catch (error) {}
    safeCommand(entity, `tag @s remove ${tag}`);
}

function getDimension(id) {
    try {
        return world.getDimension(id);
    } catch (error) {
        return null;
    }
}

function getLocation(entity) {
    try {
        return {
            x: entity.location.x,
            y: entity.location.y,
            z: entity.location.z,
            dimensionId: entity.dimension.id
        };
    } catch (error) {
        return null;
    }
}

function teleportEntity(entity, location, dimension) {
    if (!isValid(entity) || !location || !dimension) return false;
    try {
        entity.teleport(
            { x: location.x, y: location.y, z: location.z },
            { dimension, keepVelocity: false, checkForBlocks: true }
        );
        return true;
    } catch (error) {
        return false;
    }
}

function getPartyForPlayer(player) {
    const code = playerPartyCodes.get(player.id);
    if (!code) return null;
    const party = parties.get(code);
    if (!party) {
        playerPartyCodes.delete(player.id);
        return null;
    }
    if (!party.memberIds.includes(player.id)) {
        playerPartyCodes.delete(player.id);
        return null;
    }
    return party;
}

function getGameForPlayer(player) {
    const gameId = playerGames.get(player.id);
    if (!gameId) return null;
    const game = games.get(gameId);
    if (!game) {
        playerGames.delete(player.id);
        return null;
    }
    return game;
}

function generatePartyCode() {
    let code = "";
    do {
        code = String(1000 + Math.floor(Math.random() * 9000));
    } while (parties.has(code));
    return code;
}

function partyMembers(party) {
    return party.memberIds
        .map(id => getPlayerById(id))
        .filter(player => !!player);
}

function notifyParty(party, message) {
    for (const player of partyMembers(party)) safeMessage(player, message);
}

function getPendingInviteCodes(player) {
    const invites = pendingInvites.get(player.id);
    if (!invites) return [];
    const valid = [];
    for (const code of invites) {
        const party = parties.get(code);
        if (party && party.status === "lobby" && party.memberIds.length < MAX_PARTY_SIZE) {
            valid.push(code);
        }
    }
    if (valid.length === 0) pendingInvites.delete(player.id);
    else pendingInvites.set(player.id, new Set(valid));
    return valid;
}

function createParty(player) {
    if (getPartyForPlayer(player)) {
        safeMessage(player, "§eYou are already in a party.");
        return;
    }
    if (getGameForPlayer(player)) {
        safeMessage(player, "§cLeave your current match first.");
        return;
    }

    const code = generatePartyCode();
    const party = {
        code,
        hostId: player.id,
        hostName: player.name,
        memberIds: [player.id],
        status: "lobby",
        gameId: null,
        mapVoteSession: null
    };
    parties.set(code, party);
    playerPartyCodes.set(player.id, code);
    safeMessage(player, `§aParty created. Your party code is §f${code}§a.`);
}

function joinParty(player, code) {
    const normalized = String(code || "").replace(/\D/g, "").slice(0, 4);
    const party = parties.get(normalized);
    if (!party) {
        safeMessage(player, "§cThat party code is not active.");
        return false;
    }
    if (getPartyForPlayer(player)) {
        safeMessage(player, "§cLeave your current party before joining another.");
        return false;
    }
    if (getGameForPlayer(player)) {
        safeMessage(player, "§cLeave your current match first.");
        return false;
    }
    if (party.status !== "lobby") {
        safeMessage(player, "§cThat party is already in a match.");
        return false;
    }
    if (party.memberIds.length >= MAX_PARTY_SIZE) {
        safeMessage(player, "§cThat party is full.");
        return false;
    }

    party.memberIds.push(player.id);
    playerPartyCodes.set(player.id, party.code);
    const invites = pendingInvites.get(player.id);
    if (invites) {
        invites.delete(party.code);
        if (invites.size === 0) pendingInvites.delete(player.id);
    }
    notifyParty(party, `§a${player.name} joined the party.`);
    return true;
}

function leaveParty(player) {
    const party = getPartyForPlayer(player);
    if (!party) {
        safeMessage(player, "§eYou are not in a party.");
        return;
    }
    if (party.gameId) {
        leaveGame(player);
        return;
    }

    party.memberIds = party.memberIds.filter(id => id !== player.id);
    playerPartyCodes.delete(player.id);
    safeMessage(player, "§eYou left the party.");

    if (party.hostId === player.id && party.memberIds.length > 0) {
        party.hostId = party.memberIds[0];
        const newHost = getPlayerById(party.hostId);
        party.hostName = newHost ? newHost.name : "player";
        notifyParty(party, `§e${party.hostName} is now the party host.`);
    }
    if (party.memberIds.length === 0) parties.delete(party.code);
    else notifyParty(party, `${player.name} left the party.`);
}

function invitePlayer(host, target) {
    const party = getPartyForPlayer(host);
    if (!party || party.hostId !== host.id) {
        safeMessage(host, "§cOnly the party host can invite players.");
        return;
    }
    if (party.status !== "lobby" || party.memberIds.length >= MAX_PARTY_SIZE) {
        safeMessage(host, "§cThe party cannot accept another player right now.");
        return;
    }
    if (getPartyForPlayer(target) || getGameForPlayer(target)) {
        safeMessage(host, "§cThat player is already in a party or match.");
        return;
    }

    let invites = pendingInvites.get(target.id);
    if (!invites) {
        invites = new Set();
        pendingInvites.set(target.id, invites);
    }
    invites.add(party.code);
    safeMessage(target, `§b${host.name} invited you to a party. Open Settings > Mini Games and choose Invitations. Code: §f${party.code}`);
    safeMessage(host, `§aInvitation sent to ${target.name}.`);
}

function modeName(mode) {
    if (mode === "bedwars") return "BedWars Lite";
    if (mode === "team") return "Team Battle";
    return "FFA";
}

function modeDescription(mode) {
    if (mode === "bedwars") return "Teams have beds, respawns, blocks, and a last-team-standing objective.";
    if (mode === "team") return "Your party is the player team. Bots are the enemy team.";
    return "Every player and bot fights for themselves.";
}

function getMapById(mapId) {
    return BEDWARS_MAPS.find(map => map.id === mapId) || BEDWARS_MAPS[0];
}

function getRandomMap() {
    return BEDWARS_MAPS[Math.floor(Math.random() * BEDWARS_MAPS.length)];
}

function getMapOrigin(game) {
    const offset = MAP_ORIGIN_OFFSETS[(game.id + Math.floor(Math.random() * MAP_ORIGIN_OFFSETS.length)) % MAP_ORIGIN_OFFSETS.length];
    const y = Math.min(110, Math.max(50, Math.floor(game.origin.y) + 25));
    return {
        x: Math.floor(game.origin.x) + offset.x + 0.5,
        y,
        z: Math.floor(game.origin.z) + offset.z + 0.5
    };
}

function getTeamSpawn(origin, team, teamCount, map) {
    const configured = map && map.teamOffsets && map.teamOffsets[team];
    const angle = (Math.PI * 2 * team) / Math.max(1, teamCount);
    const offset = configured || { x: Math.cos(angle) * 18, z: Math.sin(angle) * 18 };
    return {
        x: origin.x + offset.x,
        y: origin.y + 1,
        z: origin.z + offset.z
    };
}

function getRingSpawn(origin, index, total, radius = 2) {
    const angle = (Math.PI * 2 * index) / Math.max(1, total);
    return {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + 1,
        z: origin.z + Math.sin(angle) * radius
    };
}

function getMapIslandSpawn(game, index) {
    const offsets = game.map && game.map.teamOffsets ? game.map.teamOffsets : [];
    if (offsets.length === 0) return getRingSpawn(game.mapOrigin || game.origin, index, 1, 2);
    const island = offsets[index % offsets.length];
    const extra = Math.floor(index / offsets.length);
    return {
        x: game.mapOrigin.x + island.x + (extra % 2) * 2 - 1,
        y: game.mapOrigin.y + 1,
        z: game.mapOrigin.z + island.z + Math.floor(extra / 2) * 2 - 1
    };
}

function runMapCommand(game, command) {
    try {
        game.dimension.runCommand(command);
        return true;
    } catch (error) {
        return false;
    }
}

function loadMapStructure(game, map, baseY) {
    const region = game.generatedRegion;
    const structureName = `bedwars:${map.id}`;
    const loadX = region.minX;
    const loadZ = region.minZ;
    const commands = [
        // The short form is supported by older Bedrock command parsers.
        `structure load ${structureName} ${loadX} ${baseY} ${loadZ}`,
        `structure load ${structureName} ${loadX} ${baseY} ${loadZ} 0_degrees none false true false 100`,
        `structure load ${structureName} ${loadX} ${baseY} ${loadZ} 0_degrees none block_by_block 0 false true false 100`
    ];
    for (const command of commands) {
        if (!runMapCommand(game, command)) continue;
        const center = getBlock(game.dimension, {
            x: Math.floor(game.mapOrigin.x),
            y: baseY,
            z: Math.floor(game.mapOrigin.z)
        });
        const marker = getBlock(game.dimension, {
            x: Math.floor(game.mapOrigin.x),
            y: baseY + 1,
            z: Math.floor(game.mapOrigin.z)
        });
        if (center && marker && center.typeId === map.baseBlock && marker.typeId === map.structureMarker && verifyMapSpawns(game, map, baseY)) {
            game.mapSource = "mcstructure";
            return true;
        }
    }
    return false;
}

function buildMap(game) {
    const map = getMapById(game.mapId);
    const baseY = Math.floor(game.mapOrigin.y);
    const allOffsets = map.islandOffsets || [];
    const radius = 27;
    game.generatedRegion = {
        minX: Math.floor(game.mapOrigin.x) - radius,
        maxX: Math.floor(game.mapOrigin.x) + radius,
        minY: baseY - 1,
        maxY: baseY + 8,
        minZ: Math.floor(game.mapOrigin.z) - radius,
        maxZ: Math.floor(game.mapOrigin.z) + radius
    };
    // Random arena origins can be outside the player's simulation distance.
    // Keep the complete structure region loaded while it is built and cleaned
    // up; the named area is removed in cleanupMap.
    game.tickingAreaName = `minigame_arena_${game.id}`;
    runMapCommand(game, `tickingarea remove ${game.tickingAreaName}`);
    game.tickingAreaCreated = runMapCommand(
        game,
        `tickingarea add circle ${Math.floor(game.mapOrigin.x)} ${baseY} ${Math.floor(game.mapOrigin.z)} 4 ${game.tickingAreaName} true`
    );

    // Prefer a real Bedrock structure from BP/structures/bedwars. The command
    // fallback keeps older worlds usable if a structure file was not copied.
    let built = loadMapStructure(game, map, baseY);
    if (!built) {
        // A thin air clearing keeps the fallback arena playable without
        // deleting a large amount of terrain. The region is removed later.
        runMapCommand(game, `fill ${game.generatedRegion.minX} ${baseY + 1} ${game.generatedRegion.minZ} ${game.generatedRegion.maxX} ${game.generatedRegion.maxY} ${game.generatedRegion.maxZ} air`);
        for (const offset of allOffsets) {
            const x = Math.floor(game.mapOrigin.x + offset.x);
            const z = Math.floor(game.mapOrigin.z + offset.z);
            runMapCommand(game, `fill ${x - 4} ${baseY} ${z - 4} ${x + 4} ${baseY} ${z + 4} ${map.baseBlock}`);
            runMapCommand(game, `fill ${x - 3} ${baseY + 1} ${z - 3} ${x + 3} ${baseY + 1} ${z + 3} air`);
            runMapCommand(game, `setblock ${x - 3} ${baseY} ${z - 3} ${map.accentBlock}`);
            runMapCommand(game, `setblock ${x + 3} ${baseY} ${z + 3} ${map.accentBlock}`);
        }
        const center = getBlock(game.dimension, {
            x: Math.floor(game.mapOrigin.x),
            y: baseY,
            z: Math.floor(game.mapOrigin.z)
        });
        built = !!center && center.typeId === map.baseBlock && verifyMapSpawns(game, map, baseY);
        game.mapSource = built ? "command-fallback" : "failed";
    }

    // Central resource markers are visible landmarks. The actual resources
    // are awarded by the tick loop so the shop works without custom blocks.
    const centerX = Math.floor(game.mapOrigin.x);
    const centerZ = Math.floor(game.mapOrigin.z);
    runMapCommand(game, `setblock ${centerX} ${baseY + 1} ${centerZ} minecraft:emerald_block replace`);
    runMapCommand(game, `setblock ${centerX + 2} ${baseY + 1} ${centerZ} minecraft:diamond_block replace`);
    game.mapName = map.name;
    game.mapBuilt = built;
    return built;
}

function cleanupMap(game) {
    const region = game.generatedRegion;
    if (!region) return;
    runMapCommand(game, `fill ${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ} air`);
    if (game.tickingAreaCreated && game.tickingAreaName) {
        runMapCommand(game, `tickingarea remove ${game.tickingAreaName}`);
        game.tickingAreaCreated = false;
    }
}

function addGameTags(entity, game, member) {
    safeAddTag(entity, GAME_TAG);
    safeAddTag(entity, `${GAME_ID_TAG_PREFIX}${game.id}`);
    safeAddTag(entity, `${TEAM_TAG_PREFIX}${member.team}`);
    if (member.isBot) safeAddTag(entity, BOT_TAG);
    else safeAddTag(entity, PLAYER_TAG);
}

function removeGameTags(entity, member, game) {
    if (!entity) return;
    safeRemoveTag(entity, GAME_TAG);
    safeRemoveTag(entity, `${GAME_ID_TAG_PREFIX}${game.id}`);
    safeRemoveTag(entity, `${TEAM_TAG_PREFIX}${member.team}`);
    if (member.isBot) safeRemoveTag(entity, BOT_TAG);
    else safeRemoveTag(entity, PLAYER_TAG);
}

function giveStarterKit(entity, mode, isBot, enabled = true) {
    if (!isValid(entity) || !enabled) return;
    if (!isBot) {
        safeCommand(entity, "give @s minecraft:iron_sword 1");
        safeCommand(entity, "give @s minecraft:bow 1");
        safeCommand(entity, "give @s minecraft:arrow 16");
        safeCommand(entity, "give @s minecraft:wool 64");
        safeCommand(entity, "give @s minecraft:bread 8");
        if (mode === "bedwars") safeCommand(entity, "give @s minecraft:stone_pickaxe 1");
    } else {
        // The custom bot's existing sword functions keep its normal tier and
        // enchantments. Do not clear a user's inventory or a bot's equipment.
        safeCommand(entity, "function sword1");
    }
}

function getBlock(dimension, location) {
    try {
        return dimension.getBlock({
            x: Math.floor(location.x),
            y: Math.floor(location.y),
            z: Math.floor(location.z)
        });
    } catch (error) {
        return null;
    }
}

function isAirBlock(block) {
    return !!block && (block.typeId === "minecraft:air" || block.isAir === true);
}

function verifyMapSpawns(game, map, baseY) {
    for (const offset of map.teamOffsets || []) {
        const x = Math.floor(game.mapOrigin.x + offset.x);
        const z = Math.floor(game.mapOrigin.z + offset.z);
        const support = getBlock(game.dimension, { x, y: baseY, z });
        if (!support || isAirBlock(support)) return false;
        // Check the team spawn and the two cells used by the real bed before
        // any player or bot is teleported into the arena.
        for (const checkX of [x, x + 1, x + 2]) {
            const cell = getBlock(game.dimension, { x: checkX, y: baseY + 1, z });
            if (!cell || !isAirBlock(cell)) return false;
        }
    }
    return true;
}

function placeBed(game, team) {
    // A Bedrock bed is a two-block structure. Put the foot beside the spawn
    // point and explicitly place both permutations so it is a real bed that
    // can be broken and detected, not just a decorative single block.
    const foot = {
        x: Math.floor(team.spawn.x) + 1,
        y: Math.floor(team.spawn.y),
        z: Math.floor(team.spawn.z)
    };
    const head = { x: foot.x + 1, y: foot.y, z: foot.z };
    const footBlock = getBlock(game.dimension, foot);
    const headBlock = getBlock(game.dimension, head);
    const footSupport = getBlock(game.dimension, { x: foot.x, y: foot.y - 1, z: foot.z });
    const headSupport = getBlock(game.dimension, { x: head.x, y: head.y - 1, z: head.z });
    if (!isAirBlock(footBlock) || !isAirBlock(headBlock) || !footSupport || !headSupport || isAirBlock(footSupport) || isAirBlock(headSupport)) {
        team.bed = { ...foot, head, active: false };
        return false;
    }

    const footCommand = `setblock ${foot.x} ${foot.y} ${foot.z} minecraft:bed ["direction"=3,"head_piece_bit"=false] replace`;
    const headCommand = `setblock ${head.x} ${head.y} ${head.z} minecraft:bed ["direction"=3,"head_piece_bit"=true] replace`;
    let placed = runMapCommand(game, footCommand) && runMapCommand(game, headCommand);
    if (!placed) {
        // Older Bedrock command parsers accept the block name but not the
        // explicit state array. Try the legacy form once before giving up.
        placed = runMapCommand(game, `setblock ${foot.x} ${foot.y} ${foot.z} bed replace`) &&
            runMapCommand(game, `setblock ${head.x} ${head.y} ${head.z} bed replace`);
    }
    const actualFoot = getBlock(game.dimension, foot);
    const actualHead = getBlock(game.dimension, head);
    const validBed = placed && actualFoot && actualHead &&
        actualFoot.typeId.endsWith(":bed") && actualHead.typeId.endsWith(":bed");
    team.bed = { ...foot, head, active: !!validBed };
    return !!validBed;
}

function isBedPresent(game, bed) {
    if (!bed || !bed.active || !bed.head) return false;
    const footBlock = getBlock(game.dimension, bed);
    const headBlock = getBlock(game.dimension, bed.head);
    return !!footBlock && !!headBlock && footBlock.typeId.endsWith(":bed") && headBlock.typeId.endsWith(":bed");
}

function removeBed(game, bed) {
    if (!bed) return;
    const footBlock = getBlock(game.dimension, bed);
    const headBlock = bed.head ? getBlock(game.dimension, bed.head) : null;
    if (footBlock && footBlock.typeId.endsWith(":bed")) {
        runMapCommand(game, `setblock ${bed.x} ${bed.y} ${bed.z} air replace`);
    }
    if (headBlock && headBlock.typeId.endsWith(":bed")) {
        runMapCommand(game, `setblock ${bed.head.x} ${bed.head.y} ${bed.head.z} air replace`);
    }
}

function createGameMember(entity, isBot, team, spawn, returnLocation = null) {
    return {
        id: entity.id,
        name: entity.name || (isBot ? `Bot ${team + 1}` : "player"),
        isBot,
        team,
        spawn,
        returnLocation,
        alive: true,
        eliminated: false,
        respawnAt: 0,
        respawning: false
    };
}

function buildGameTeams(game, combatants, mode) {
    let teamCount;
    if (mode === "ffa") teamCount = combatants.length;
    else if (mode === "team") teamCount = 2;
    else teamCount = Math.min(4, Math.max(2, combatants.length));

    const teams = [];
    for (let index = 0; index < teamCount; index += 1) {
        teams.push({
            index,
            name: TEAM_NAMES[index] || `Team ${index + 1}`,
            spawn: getTeamSpawn(game.mapOrigin || game.origin, index, teamCount, game.map),
            bed: null,
            bedActive: mode === "bedwars",
            upgrades: { sharpness: 0, protection: 0, haste: 0, forge: 0 }
        });
    }

    for (let index = 0; index < combatants.length; index += 1) {
        const combatant = combatants[index];
        let team = index % teamCount;
        if (mode === "team") team = combatant.isBot ? 1 : 0;
        const teamSpawn = teams[team].spawn;
        const spawn = mode === "ffa"
            ? getMapIslandSpawn(game, index)
            : {
                x: teamSpawn.x + ((index % 2) - 0.5) * 2,
                y: teamSpawn.y,
                z: teamSpawn.z + (Math.floor(index / 2) % 2) * 2
            };
        combatant.team = team;
        combatant.spawn = spawn;
        if (mode === "ffa") teams[team].bedActive = false;
    }
    game.teams = teams;
}

function findMember(game, entityId, name = "") {
    return game.members.find(member => member.id === entityId || (name && member.name === name));
}

function spawnGameBot(game, member) {
    try {
        const bot = game.dimension.spawnEntity("bot:army21", member.spawn);
        if (!bot) return false;
        member.id = bot.id;
        member.name = bot.name || `Bot ${member.team + 1}`;
        addGameTags(bot, game, member);
        giveStarterKit(bot, game.mode, true, game.giveKits);
        return true;
    } catch (error) {
        try {
            game.dimension.runCommand(`summon bot:army21 ${member.spawn.x} ${member.spawn.y} ${member.spawn.z}`);
            const bots = game.dimension.getEntities({ type: "bot:army21", location: member.spawn, maxDistance: 2 });
            const bot = bots[0];
            if (!bot) return false;
            member.id = bot.id;
            member.name = bot.name || `Bot ${member.team + 1}`;
            addGameTags(bot, game, member);
            giveStarterKit(bot, game.mode, true, game.giveKits);
            return true;
        } catch (fallbackError) {
            return false;
        }
    }
}

function startGame(host, mode, botCount, giveKits = true, mapId = "") {
    const party = getPartyForPlayer(host);
    if (!party || party.hostId !== host.id) {
        safeMessage(host, "§cOnly the party host can start a mini game.");
        return;
    }
    if (party.status !== "lobby") {
        safeMessage(host, "§cThis party is already in a match.");
        return;
    }
    const players = partyMembers(party);
    if (players.length === 0) {
        safeMessage(host, "§cNo online party members are available.");
        return;
    }
    const safeBotCount = Math.max(0, Math.min(MAX_BOTS, Math.floor(Number(botCount) || 0)));
    if (mode === "team" && safeBotCount === 0) {
        safeMessage(host, "§cTeam Battle needs at least one bot so there is an enemy team.");
        return;
    }
    if (mode !== "team" && players.length + safeBotCount < 2) {
        safeMessage(host, "§cAdd at least one friend or one bot for this mode.");
        return;
    }
    const originLocation = getLocation(host);
    if (!originLocation) {
        safeMessage(host, "§cThe game could not find your location.");
        return;
    }
    const dimension = getDimension(originLocation.dimensionId);
    if (!dimension) {
        safeMessage(host, "§cThis dimension is not available for a mini game.");
        return;
    }

    const game = {
        id: nextGameId++,
        mode,
        status: "active",
        partyCode: party.code,
        hostId: host.id,
        hostName: host.name,
        origin: {
            x: Math.floor(originLocation.x) + 0.5,
            y: Math.floor(originLocation.y),
            z: Math.floor(originLocation.z) + 0.5
        },
        mapId: mapId || getRandomMap().id,
        mapOrigin: null,
        mapName: "",
        generatedRegion: null,
        tickingAreaName: "",
        tickingAreaCreated: false,
        resourceTick: 0,
        dimension,
        dimensionId: originLocation.dimensionId,
        members: [],
        teams: [],
        createdTick: system.currentTick,
        lastStatusTick: system.currentTick,
        botCount: safeBotCount,
        giveKits: giveKits !== false
    };

    game.map = getMapById(game.mapId);
    game.mapOrigin = getMapOrigin(game);
    buildMap(game);
    if (!game.mapBuilt) {
        cleanupMap(game);
        safeMessage(host, "§cThe BedWars map could not load. Check that the structure files are installed and try again in a clear area.");
        return;
    }

    const combatants = [];
    for (const player of players) {
        const member = createGameMember(player, false, 0, null, getLocation(player));
        combatants.push(member);
        game.members.push(member);
    }
    for (let index = 0; index < safeBotCount; index += 1) {
        combatants.push({
            id: null,
            name: `Bot ${index + 1}`,
            isBot: true,
            team: 0,
            spawn: null,
            returnLocation: null,
            alive: true,
            eliminated: false,
            respawnAt: 0,
            respawning: false
        });
    }

    buildGameTeams(game, combatants, mode);
    if (mode === "bedwars") {
        const bedsPlaced = game.teams.every(team => placeBed(game, team));
        if (!bedsPlaced) {
            for (const team of game.teams) removeBed(game, team.bed);
            cleanupMap(game);
            safeMessage(host, "§cBedWars could not place every bed in this area. No one was teleported; try starting again in a clear location.");
            return;
        }
    }

    games.set(game.id, game);
    party.status = "playing";
    party.gameId = game.id;
    party.mapVoteSession = null;

    for (const member of game.members) {
        const player = getPlayerById(member.id);
        if (!player) continue;
        addGameTags(player, game, member);
        playerGames.set(player.id, game.id);
        teleportEntity(player, member.spawn, dimension);
        giveStarterKit(player, mode, false, game.giveKits);
    }

    for (const member of combatants) {
        if (member.isBot) {
            game.members.push(member);
            if (!spawnGameBot(game, member)) {
                member.eliminated = true;
                member.alive = false;
            }
        }
    }

    notifyParty(party, `§a${modeName(mode)} on ${game.mapName} started with ${game.members.filter(member => !member.eliminated).length} fighters.`);
    notifyParty(party, `§7Map coordinates: ${Math.floor(game.mapOrigin.x)} ${Math.floor(game.mapOrigin.y)} ${Math.floor(game.mapOrigin.z)}`);
    if (safeBotCount === 0) notifyParty(party, "§eNo bots were added. You can still run a player-only match.");
}

function getAliveMembers(game) {
    return game.members.filter(member => !member.eliminated && member.alive);
}

function getActiveTeams(game) {
    const active = new Set();
    for (const member of getAliveMembers(game)) active.add(member.team);
    return active;
}

function markMemberEliminated(game, member, message = "") {
    if (!member || member.eliminated) return;
    member.eliminated = true;
    member.alive = false;
    member.respawning = false;
    const entity = isValid(getPlayerById(member.id)) ? getPlayerById(member.id) : null;
    if (entity) removeGameTags(entity, member, game);
    if (message) notifyParty(parties.get(game.partyCode), `§c${member.name} ${message}`);
}

function scheduleRespawn(game, member) {
    if (!member || member.eliminated || member.respawning) return;
    member.respawning = true;
    member.respawnAt = system.currentTick + 40;
    member.alive = true;
    const party = parties.get(game.partyCode);
    if (party) notifyParty(party, `§e${member.name} will respawn because the ${TEAM_NAMES[member.team]} bed is still alive.`);
}

function respawnMember(game, member) {
    if (!member || member.eliminated) return;
    const team = game.teams[member.team];
    if (!team || (game.mode === "bedwars" && !team.bedActive)) {
        markMemberEliminated(game, member, "was eliminated.");
        return;
    }

    if (member.isBot) {
        if (spawnGameBot(game, member)) {
            member.alive = true;
            member.respawning = false;
        } else {
            markMemberEliminated(game, member, "could not respawn and was eliminated.");
        }
        return;
    }

    const player = getPlayerById(member.id) || getPlayerByName(member.name);
    if (!player) {
        // A disconnected player is removed from the active match, but stays in
        // the party lobby for the next game.
        markMemberEliminated(game, member, "left the match.");
        return;
    }
    member.id = player.id;
    playerGames.set(player.id, game.id);
    addGameTags(player, game, member);
    teleportEntity(player, member.spawn, game.dimension);
    safeCommand(player, "effect @s regeneration 2 2 true");
    member.alive = true;
    member.respawning = false;
    safeMessage(player, "§aRespawned. Protect your bed.");
}

function checkBeds(game) {
    if (game.mode !== "bedwars") return;
    const party = parties.get(game.partyCode);
    for (const team of game.teams) {
        if (!team.bedActive || !team.bed) continue;
        if (!isBedPresent(game, team.bed)) {
            team.bedActive = false;
            team.bed.active = false;
            if (party) notifyParty(party, `§c${TEAM_COLORS[team.index]}${team.name} bed destroyed! That team no longer respawns.`);
        }
    }
}

function evaluateGame(game) {
    const party = parties.get(game.partyCode);
    if (!party) return;
    const activeMembers = getAliveMembers(game);
    if (game.mode === "ffa") {
        if (activeMembers.length <= 1) {
            const winner = activeMembers[0];
            endGame(game, winner ? `§a${winner.name} won the FFA!` : "§eThe FFA ended with no winner.");
        }
        return;
    }

    const activeTeams = getActiveTeams(game);
    if (activeTeams.size <= 1) {
        const winnerTeam = activeTeams.size === 1 ? Array.from(activeTeams)[0] : -1;
        const winnerName = winnerTeam >= 0 ? TEAM_NAMES[winnerTeam] || `Team ${winnerTeam + 1}` : "nobody";
        endGame(game, `§a${winnerName} won ${modeName(game.mode)}!`);
    }
}

function tickGames() {
    for (const game of games.values()) {
        if (game.status !== "active") continue;
        game.resourceTick += 5;
        checkBeds(game);
        if (game.resourceTick % 20 === 0) {
            generateResources(game);
            applyTeamUpgrades(game);
        }
        for (const member of game.members) {
            if (member.eliminated || !member.respawning || system.currentTick < member.respawnAt) continue;
            respawnMember(game, member);
        }
        if (system.currentTick - game.lastStatusTick >= 100) {
            game.lastStatusTick = system.currentTick;
            evaluateGame(game);
        } else {
            evaluateGame(game);
        }
    }
}

function leaveGame(player) {
    const game = getGameForPlayer(player);
    if (!game) {
        safeMessage(player, "§eYou are not in a mini-game.");
        return;
    }
    if (game.hostId === player.id) {
        endGame(game, `§e${player.name} ended the match.`);
        return;
    }
    const member = findMember(game, player.id, player.name);
    if (member) markMemberEliminated(game, member, "left the match.");
    playerGames.delete(player.id);
    if (member && member.returnLocation) {
        teleportEntity(player, member.returnLocation, getDimension(member.returnLocation.dimensionId));
    }
    safeMessage(player, "§eYou left the mini-game.");
    evaluateGame(game);
}

function endGame(game, reason) {
    if (!game || game.status === "ending") return;
    game.status = "ending";
    const party = parties.get(game.partyCode);
    if (party) notifyParty(party, reason);

    for (const team of game.teams) {
        if (team.bed) removeBed(game, team.bed);
    }

    for (const member of game.members) {
        const entity = member.isBot ? getEntityById(member.id) : (getPlayerById(member.id) || getPlayerByName(member.name));
        if (entity && isValid(entity)) {
            removeGameTags(entity, member, game);
            if (member.isBot) {
                try { entity.kill(); } catch (error) { safeCommand(entity, "kill @s"); }
            } else if (member.returnLocation) {
                teleportEntity(entity, member.returnLocation, getDimension(member.returnLocation.dimensionId));
                safeMessage(entity, "§eMini-game finished. You returned to your start location.");
            }
        }
        playerGames.delete(member.id);
    }

    cleanupMap(game);

    if (party) {
        const oldMemberIds = party.memberIds.slice();
        const currentMemberIds = game.members
            .filter(member => !member.isBot)
            .map(member => getPlayerByName(member.name) || getPlayerById(member.id))
            .filter(player => !!player)
            .map(player => player.id);
        for (const oldId of oldMemberIds) {
            if (!currentMemberIds.includes(oldId)) playerPartyCodes.delete(oldId);
        }
        for (const currentId of currentMemberIds) playerPartyCodes.set(currentId, party.code);
        const currentHost = getPlayerByName(game.hostName);
        if (currentHost && currentMemberIds.includes(currentHost.id)) party.hostId = currentHost.id;
        party.memberIds = currentMemberIds;
        party.status = "lobby";
        party.gameId = null;
    }
    games.delete(game.id);
}

function beginMapVote(party) {
    const shuffled = BEDWARS_MAPS.slice().sort(() => Math.random() - 0.5);
    party.mapVoteSession = {
        options: shuffled.slice(0, Math.min(3, shuffled.length)).map(map => map.id),
        votes: new Map(),
        complete: false,
        winnerId: null
    };
    notifyParty(party, "§bBedWars map vote started. Open Mini Games & Party and choose Vote BedWars Map.");
}

function resolveMapVote(party) {
    const session = party && party.mapVoteSession;
    if (!session || session.complete) return session ? session.winnerId : null;
    const counts = new Map(session.options.map(id => [id, 0]));
    for (const mapId of session.votes.values()) {
        if (counts.has(mapId)) counts.set(mapId, counts.get(mapId) + 1);
    }
    const highest = Math.max(...counts.values());
    const winners = session.options.filter(id => counts.get(id) === highest);
    session.winnerId = winners[Math.floor(Math.random() * Math.max(1, winners.length))] || session.options[0];
    session.complete = true;
    const map = getMapById(session.winnerId);
    notifyParty(party, `§aMap vote complete: ${map.name}. The host can now start BedWars.`);
    return session.winnerId;
}

function showMapVoteMenu(player) {
    const party = getPartyForPlayer(player);
    const session = party && party.mapVoteSession;
    if (!party || !session) {
        safeMessage(player, "§eThere is no active map vote.");
        showMiniGamesMenu(player);
        return;
    }
    const form = new ActionFormData()
        .title("Vote BedWars Map")
        .body(`Votes submitted: ${session.votes.size}/${party.memberIds.length}`)
        .button("Back");
    for (const mapId of session.options) {
        const map = getMapById(mapId);
        const votes = Array.from(session.votes.values()).filter(vote => vote === mapId).length;
        form.button(`${map.name} (${votes})\n${map.description}`);
    }
    form.show(player).then(response => {
        if (response.canceled || response.selection === 0) {
            showMiniGamesMenu(player);
            return;
        }
        const mapId = session.options[response.selection - 1];
        if (mapId && !session.complete) {
            session.votes.set(player.id, mapId);
            if (session.votes.size >= party.memberIds.filter(id => !!getPlayerById(id)).length) {
                resolveMapVote(party);
            } else {
                notifyParty(party, `§7${player.name} voted for ${getMapById(mapId).name}.`);
            }
        }
        showMiniGamesMenu(player);
    }).catch(() => {});
}

function showJoinPartyMenu(player) {
    const form = new ModalFormData()
        .title("Join Party")
        .textField("Enter the four-digit party code", "1234", "");
    form.show(player).then(response => {
        if (response.canceled) {
            showMiniGamesMenu(player);
            return;
        }
        joinParty(player, response.formValues[0]);
        showMiniGamesMenu(player);
    }).catch(() => {});
}

function showInvitationsMenu(player) {
    const codes = getPendingInviteCodes(player);
    if (codes.length === 0) {
        safeMessage(player, "§eYou have no pending party invitations.");
        showMiniGamesMenu(player);
        return;
    }
    const form = new ActionFormData().title("Party Invitations").body("Accept or decline an invitation.");
    form.button("Back");
    for (const code of codes) {
        const party = parties.get(code);
        form.button(`Accept ${party.hostName} (${code})`);
        form.button(`Decline ${party.hostName} (${code})`);
    }
    form.show(player).then(response => {
        if (response.canceled || response.selection === 0) {
            showMiniGamesMenu(player);
            return;
        }
        const index = response.selection - 1;
        const code = codes[Math.floor(index / 2)];
        if (index % 2 === 0) joinParty(player, code);
        else {
            const invites = pendingInvites.get(player.id);
            if (invites) {
                invites.delete(code);
                if (invites.size === 0) pendingInvites.delete(player.id);
            }
            safeMessage(player, "§eInvitation declined.");
        }
        showMiniGamesMenu(player);
    }).catch(() => {});
}

function showInviteMenu(player) {
    const party = getPartyForPlayer(player);
    if (!party || party.hostId !== player.id) {
        safeMessage(player, "§cOnly the party host can invite players.");
        showMiniGamesMenu(player);
        return;
    }
    const candidates = world.getPlayers().filter(candidate =>
        candidate.id !== player.id && !getPartyForPlayer(candidate) && !getGameForPlayer(candidate)
    );
    if (candidates.length === 0) {
        safeMessage(player, "§eNo available online players to invite.");
        showMiniGamesMenu(player);
        return;
    }
    const form = new ActionFormData().title("Invite Friend").body("Choose an online player.").button("Back");
    for (const candidate of candidates) form.button(candidate.name);
    form.show(player).then(response => {
        if (response.canceled || response.selection === 0) {
            showMiniGamesMenu(player);
            return;
        }
        invitePlayer(player, candidates[response.selection - 1]);
        showMiniGamesMenu(player);
    }).catch(() => {});
}

function showStartModeMenu(player) {
    const party = getPartyForPlayer(player);
    if (!party || party.hostId !== player.id) {
        safeMessage(player, "§cOnly the party host can start a game.");
        showMiniGamesMenu(player);
        return;
    }
    const form = new ActionFormData()
        .title("Choose Mini Game")
        .body("Pick a mode, then choose how many bots to add.")
        .button("BedWars Lite")
        .button("FFA")
        .button("Team Battle: Players vs Bots")
        .button("Back");
    form.show(player).then(response => {
        if (response.canceled || response.selection === 3) {
            showMiniGamesMenu(player);
            return;
        }
        const modes = ["bedwars", "ffa", "team"];
        const mode = modes[response.selection];
        if (mode === "bedwars") {
            const party = getPartyForPlayer(player);
            if (!party.mapVoteSession) beginMapVote(party);
            if (!party.mapVoteSession.complete) {
                showMapVoteMenu(player);
                return;
            }
            showGameOptions(player, mode, party.mapVoteSession.winnerId);
            return;
        }
        showGameOptions(player, mode, "");
    }).catch(() => {});
}

function showGameOptions(player, mode, mapId = "") {
    const form = new ModalFormData()
        .title(modeName(mode))
        .toggle("Give starter kits", true)
        .slider("Bots", 0, MAX_BOTS, 1, DEFAULT_BOTS);
    form.show(player).then(response => {
        if (response.canceled) {
            showStartModeMenu(player);
            return;
        }
        const giveKits = response.formValues[0];
        const bots = response.formValues[1];
        startGame(player, mode, bots, giveKits, mapId);
        showMiniGamesMenu(player);
    }).catch(() => {});
}

const SHOP_ITEMS = [
    { id: "wool", label: "16 Wool", cost: { item: "minecraft:iron_ingot", amount: 4 } },
    { id: "stone", label: "8 Stone", cost: { item: "minecraft:iron_ingot", amount: 8 } },
    { id: "endstone", label: "8 End Stone", cost: { item: "minecraft:iron_ingot", amount: 16 } },
    { id: "iron_sword", label: "Iron Sword", cost: { item: "minecraft:gold_ingot", amount: 7 } },
    { id: "bow", label: "Bow", cost: { item: "minecraft:gold_ingot", amount: 12 } },
    { id: "arrows", label: "8 Arrows", cost: { item: "minecraft:gold_ingot", amount: 2 } },
    { id: "iron_armor", label: "Iron Armor", cost: { item: "minecraft:gold_ingot", amount: 12 } },
    { id: "golden_apple", label: "Golden Apple", cost: { item: "minecraft:gold_ingot", amount: 4 } },
    { id: "sharpness", label: "Team Sharpness I", cost: { item: "minecraft:diamond", amount: 8 }, max: 1 },
    { id: "protection", label: "Team Protection", cost: { item: "minecraft:diamond", amount: 8 }, max: 3 },
    { id: "haste", label: "Team Haste", cost: { item: "minecraft:diamond", amount: 4 }, max: 2 },
    { id: "forge", label: "Team Forge", cost: { item: "minecraft:diamond", amount: 4 }, max: 3 }
];

function getGameMemberForPlayer(game, player) {
    return findMember(game, player.id, player.name);
}

function countItem(entity, itemId) {
    try {
        const inventory = entity.getComponent("minecraft:inventory") || entity.getComponent("inventory");
        const container = inventory && inventory.container;
        if (!container) return 0;
        let total = 0;
        for (let slot = 0; slot < container.size; slot += 1) {
            const item = container.getItem(slot);
            if (item && item.typeId === itemId) total += item.amount;
        }
        return total;
    } catch (error) {
        return 0;
    }
}

function chargeItem(entity, itemId, amount) {
    if (countItem(entity, itemId) < amount) return false;
    // Currency items have no data value in Bedrock. The inventory check above
    // prevents a failed command from consuming more than the player owns.
    return safeCommand(entity, `clear @s ${itemId} 0 ${amount}`);
}

function giveShopItem(player, itemId, amount) {
    return safeCommand(player, `give @s ${itemId} ${amount}`);
}

function equipIronArmor(player) {
    safeCommand(player, "replaceitem entity @s slot.armor.head 0 minecraft:iron_helmet 1");
    safeCommand(player, "replaceitem entity @s slot.armor.chest 0 minecraft:iron_chestplate 1");
    safeCommand(player, "replaceitem entity @s slot.armor.legs 0 minecraft:iron_leggings 1");
    safeCommand(player, "replaceitem entity @s slot.armor.feet 0 minecraft:iron_boots 1");
}

function applySharpnessUpgrade(player, level) {
    // The upgrade is team-owned. Enchant the sword in the main hand when the
    // purchase is made; future sword purchases are enchanted on purchase too.
    try {
        if (player.typeId && player.typeId.startsWith("bot:")) safeCommand(player, "function sword1");
        else safeCommand(player, "replaceitem entity @s slot.weapon.mainhand 0 minecraft:iron_sword 1");
    } catch (error) {}
    safeCommand(player, `enchant @s sharpness ${level}`);
}

function applySharpnessToTeam(game, teamIndex, level) {
    for (const member of game.members) {
        if (member.team !== teamIndex || member.eliminated || member.respawning) continue;
        const entity = member.isBot ? getEntityById(member.id) : (getPlayerById(member.id) || getPlayerByName(member.name));
        if (entity) applySharpnessUpgrade(entity, level);
    }
}

function costText(item) {
    const names = {
        "minecraft:iron_ingot": "iron",
        "minecraft:gold_ingot": "gold",
        "minecraft:diamond": "diamonds"
    };
    return `${item.cost.amount} ${names[item.cost.item] || item.cost.item}`;
}

function resourceSummary(player) {
    return `Iron ${countItem(player, "minecraft:iron_ingot")}  Gold ${countItem(player, "minecraft:gold_ingot")}  Diamonds ${countItem(player, "minecraft:diamond")}  Emeralds ${countItem(player, "minecraft:emerald")}`;
}

function purchaseShopItem(player, game, itemId) {
    const member = getGameMemberForPlayer(game, player);
    if (!member || member.eliminated || member.respawning) return;
    const item = SHOP_ITEMS.find(shopItem => shopItem.id === itemId);
    if (!item) return;
    const team = game.teams[member.team];
    const currentLevel = team && team.upgrades[item.id] !== undefined ? team.upgrades[item.id] : 0;
    if (item.max !== undefined && currentLevel >= item.max) {
        safeMessage(player, "§eThat team upgrade is already maxed.");
        return;
    }
    if (!chargeItem(player, item.cost.item, item.cost.amount)) {
        safeMessage(player, `§cYou need ${costText(item)}.`);
        return;
    }

    if (item.id === "wool") giveShopItem(player, "minecraft:wool", 16);
    else if (item.id === "stone") giveShopItem(player, "minecraft:stone", 8);
    else if (item.id === "endstone") giveShopItem(player, "minecraft:end_stone", 8);
    else if (item.id === "iron_sword") {
        giveShopItem(player, "minecraft:iron_sword", 1);
        if (team && team.upgrades.sharpness > 0) applySharpnessUpgrade(player, team.upgrades.sharpness);
    }
    else if (item.id === "bow") giveShopItem(player, "minecraft:bow", 1);
    else if (item.id === "arrows") giveShopItem(player, "minecraft:arrow", 8);
    else if (item.id === "iron_armor") equipIronArmor(player);
    else if (item.id === "golden_apple") giveShopItem(player, "minecraft:golden_apple", 1);
    else if (team && team.upgrades[item.id] !== undefined) {
        team.upgrades[item.id] += 1;
        if (item.id === "sharpness") applySharpnessToTeam(game, member.team, team.upgrades[item.id]);
        notifyParty(parties.get(game.partyCode), `§b${TEAM_NAMES[member.team]} bought ${item.label}.`);
    }
    safeMessage(player, `§aPurchased ${item.label}.`);
}

function showShopMenu(player, game) {
    const member = getGameMemberForPlayer(game, player);
    if (!member || member.eliminated) return;
    const team = game.teams[member.team];
    const upgrades = team ? team.upgrades : {};
    const form = new ActionFormData()
        .title("BedWars Shop")
        .body(`${game.mapName}\n${resourceSummary(player)}\nTeam upgrades: Sharpness ${upgrades.sharpness || 0}, Protection ${upgrades.protection || 0}, Haste ${upgrades.haste || 0}, Forge ${upgrades.forge || 0}`)
        .button("Back");
    for (const item of SHOP_ITEMS) {
        const level = upgrades[item.id] || 0;
        const levelText = item.max !== undefined ? ` [${level}/${item.max}]` : "";
        form.button(`${item.label}${levelText}\n${costText(item)}`);
    }
    form.show(player).then(response => {
        if (response.canceled || response.selection === 0) {
            showGameMenu(player, game);
            return;
        }
        const item = SHOP_ITEMS[response.selection - 1];
        if (item) purchaseShopItem(player, game, item.id);
        showShopMenu(player, game);
    }).catch(() => {});
}

function generateResources(game) {
    if (game.mode !== "bedwars") return;
    for (const team of game.teams) {
        const level = team.upgrades.forge || 0;
        const teamMembers = game.members.filter(member => member.team === team.index && !member.eliminated && !member.respawning && !member.isBot);
        for (const member of teamMembers) {
            const player = getPlayerById(member.id) || getPlayerByName(member.name);
            if (!player) continue;
            giveShopItem(player, "minecraft:iron_ingot", 1 + Math.min(2, level));
            if (game.resourceTick % 40 === 0) giveShopItem(player, "minecraft:gold_ingot", 1 + (level >= 2 ? 1 : 0));
            if (game.resourceTick % 100 === 0) giveShopItem(player, "minecraft:diamond", 1);
            if (game.resourceTick % 200 === 0) giveShopItem(player, "minecraft:emerald", 1);
        }
    }
}

function applyTeamUpgrades(game) {
    for (const member of game.members) {
        if (member.eliminated || member.respawning) continue;
        const entity = member.isBot ? getEntityById(member.id) : (getPlayerById(member.id) || getPlayerByName(member.name));
        const team = game.teams[member.team];
        if (!entity || !team) continue;
        if (team.upgrades.protection > 0) safeCommand(entity, `effect @s resistance 2 ${Math.min(2, team.upgrades.protection - 1)} true`);
        if (team.upgrades.haste > 0) safeCommand(entity, `effect @s haste 2 ${Math.min(2, team.upgrades.haste - 1)} true`);
    }
}

function showGameMenu(player, game) {
    const party = parties.get(game.partyCode);
    const alive = getAliveMembers(game).length;
    const mapText = game.mapName ? `\nMap: ${game.mapName} at ${Math.floor(game.mapOrigin.x)} ${Math.floor(game.mapOrigin.y)} ${Math.floor(game.mapOrigin.z)}` : "";
    const body = `${modeName(game.mode)}\n${modeDescription(game.mode)}${mapText}\n\nAlive: ${alive}\nParty: ${party ? party.code : "-"}`;
    const form = new ActionFormData()
        .title("Mini Game Running")
        .body(body);
    const shopIndex = game.mode === "bedwars" ? 0 : -1;
    if (shopIndex >= 0) form.button("Shop & Upgrades");
    const leaveIndex = shopIndex >= 0 ? 1 : 0;
    form.button("Leave Match");
    const endIndex = game.hostId === player.id ? leaveIndex + 1 : -1;
    if (endIndex >= 0) form.button("End Match");
    form.button("Close");
    form.show(player).then(response => {
        if (response.canceled) return;
        if (shopIndex >= 0 && response.selection === shopIndex) showShopMenu(player, game);
        else if (response.selection === leaveIndex) leaveGame(player);
        else if (endIndex >= 0 && response.selection === endIndex) endGame(game, `§e${player.name} ended the match.`);
    }).catch(() => {});
}

export function showMiniGamesMenu(player) {
    if (!isValid(player)) return;
    const game = getGameForPlayer(player);
    if (game) {
        showGameMenu(player, game);
        return;
    }

    const party = getPartyForPlayer(player);
    const invites = getPendingInviteCodes(player);
    if (!party) {
        const form = new ActionFormData()
            .title("Mini Games & Party")
            .body("Create a party, share the four-digit code with your friend, and start a game against bots.")
            .button("Create Party")
            .button("Join Party by Code")
            .button(`Invitations (${invites.length})`);
        form.show(player).then(response => {
            if (response.canceled) return;
            if (response.selection === 0) {
                createParty(player);
                showMiniGamesMenu(player);
            } else if (response.selection === 1) showJoinPartyMenu(player);
            else showInvitationsMenu(player);
        }).catch(() => {});
        return;
    }

    const memberNames = partyMembers(party).map(member => member.name).join(", ");
    const hostText = party.hostId === player.id ? "You are host" : `Host: ${party.hostName}`;
    const voteSession = party.mapVoteSession;
    let body = `${hostText}\nCode: §f${party.code}\nMembers: ${memberNames}\n\nShare the code with your friend.`;
    if (voteSession) {
        const voteName = voteSession.complete ? getMapById(voteSession.winnerId).name : `${voteSession.votes.size}/${party.memberIds.length} votes`;
        body += `\nBedWars map vote: ${voteName}`;
    }
    const form = new ActionFormData()
        .title("Mini Games & Party")
        .body(body)
        .button("Start Mini Game");
    const voteButtonIndex = voteSession ? 1 : -1;
    if (voteSession) form.button("Vote BedWars Map");
    const inviteButtonIndex = voteSession ? 2 : 1;
    form.button("Invite Friend");
    const invitesButtonIndex = inviteButtonIndex + 1;
    form.button(`Invitations (${invites.length})`);
    const leaveButtonIndex = invitesButtonIndex + 1;
    form.button("Leave Party");
    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === 0) showStartModeMenu(player);
        else if (voteSession && response.selection === voteButtonIndex) showMapVoteMenu(player);
        else if (response.selection === inviteButtonIndex) showInviteMenu(player);
        else if (response.selection === invitesButtonIndex) showInvitationsMenu(player);
        else if (response.selection === leaveButtonIndex) leaveParty(player);
    }).catch(() => {});
}

try {
    world.afterEvents.entityDie.subscribe(event => {
        const dead = event.deadEntity;
        for (const game of games.values()) {
            const member = findMember(game, dead.id, dead.name || "");
            if (!member || member.eliminated || member.respawning) continue;
            if (game.mode === "bedwars" && game.teams[member.team]?.bedActive) {
                scheduleRespawn(game, member);
            } else {
                markMemberEliminated(game, member, "was eliminated.");
            }
            evaluateGame(game);
        }
    });
} catch (error) {}

try {
    world.afterEvents.entityRemove.subscribe(event => {
        const removedId = event.removedEntityId;
        for (const game of games.values()) {
            if (game.status !== "active") continue;
            const member = findMember(game, removedId);
            if (!member || member.eliminated) continue;
            if (member.isBot) {
                markMemberEliminated(game, member, "was removed from the match.");
            } else {
                markMemberEliminated(game, member, "left the match.");
            }
            evaluateGame(game);
        }
    });
} catch (error) {}

system.runInterval(tickGames, 5);

system.runInterval(() => {
    for (const [code, party] of parties) {
        // Keep the roster stable while a match is respawning players or bots.
        if (party.gameId) continue;
        const liveMemberIds = party.memberIds.filter(id => !!getPlayerById(id));
        party.memberIds = liveMemberIds;
        if (party.memberIds.length === 0) parties.delete(code);
    }
    for (const [playerId, invites] of pendingInvites) {
        for (const code of invites) {
            if (!parties.has(code)) invites.delete(code);
        }
        if (invites.size === 0) pendingInvites.delete(playerId);
    }
}, 200);

export function cleanupMiniGamePlayer(player) {
    const game = getGameForPlayer(player);
    if (game) leaveGame(player);
    const party = getPartyForPlayer(player);
    if (party && !party.gameId) leaveParty(player);
}
