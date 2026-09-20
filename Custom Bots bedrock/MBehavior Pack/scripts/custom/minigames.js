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
        gameId: null
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

function getTeamSpawn(origin, team, teamCount) {
    const angle = (Math.PI * 2 * team) / Math.max(1, teamCount);
    return {
        x: origin.x + Math.cos(angle) * 10,
        y: origin.y,
        z: origin.z + Math.sin(angle) * 10
    };
}

function getRingSpawn(origin, index, total, radius = 7) {
    const angle = (Math.PI * 2 * index) / Math.max(1, total);
    return {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y,
        z: origin.z + Math.sin(angle) * radius
    };
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

function placeBed(game, team) {
    const location = {
        x: Math.floor(team.spawn.x),
        y: Math.floor(team.spawn.y),
        z: Math.floor(team.spawn.z)
    };
    const block = getBlock(game.dimension, location);
    if (block && (block.typeId === "minecraft:air" || block.isAir === true)) {
        const command = `setblock ${location.x} ${location.y} ${location.z} minecraft:bed`;
        try {
            game.dimension.runCommand(command);
            team.bed = { x: location.x, y: location.y, z: location.z, active: true };
            return true;
        } catch (error) {
            try {
                game.dimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} bed`);
                team.bed = { x: location.x, y: location.y, z: location.z, active: true };
                return true;
            } catch (fallbackError) {}
        }
    }
    team.bed = { x: location.x, y: location.y, z: location.z, active: false };
    return false;
}

function isBedPresent(game, bed) {
    if (!bed || !bed.active) return false;
    const block = getBlock(game.dimension, bed);
    return !!block && (block.typeId === "minecraft:bed" || block.typeId.endsWith(":bed"));
}

function removeBed(game, bed) {
    if (!bed) return;
    const block = getBlock(game.dimension, bed);
    if (block && (block.typeId === "minecraft:bed" || block.typeId.endsWith(":bed"))) {
        try {
            game.dimension.runCommand(`setblock ${bed.x} ${bed.y} ${bed.z} air`);
        } catch (error) {}
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
            spawn: getTeamSpawn(game.origin, index, teamCount),
            bed: null,
            bedActive: mode === "bedwars"
        });
    }

    for (let index = 0; index < combatants.length; index += 1) {
        const combatant = combatants[index];
        let team = index % teamCount;
        if (mode === "team") team = combatant.isBot ? 1 : 0;
        const teamSpawn = teams[team].spawn;
        const spawn = mode === "ffa"
            ? getRingSpawn(game.origin, index, combatants.length, 7)
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

function startGame(host, mode, botCount, giveKits = true) {
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
        dimension,
        dimensionId: originLocation.dimensionId,
        members: [],
        teams: [],
        createdTick: system.currentTick,
        lastStatusTick: system.currentTick,
        botCount: safeBotCount,
        giveKits: giveKits !== false
    };

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
    games.set(game.id, game);
    party.status = "playing";
    party.gameId = game.id;

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

    if (mode === "bedwars") {
        for (const team of game.teams) {
            placeBed(game, team);
        }
    }

    notifyParty(party, `§a${modeName(mode)} started with ${game.members.filter(member => !member.eliminated).length} fighters.`);
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
        checkBeds(game);
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

function showJoinPartyMenu(player) {
    const form = new ModalFormData()
        .title("Join Party")
        .textField("Enter the four-digit party code", "1234", "");
    form.show(player).then(response => {
        if (response.canceled) {
            showMiniGamesMenu(player);
            return;
        }
        if (joinParty(player, response.formValues[0])) showMiniGamesMenu(player);
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
        showGameOptions(player, modes[response.selection]);
    }).catch(() => {});
}

function showGameOptions(player, mode) {
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
        startGame(player, mode, bots, giveKits);
        showMiniGamesMenu(player);
    }).catch(() => {});
}

function showGameMenu(player, game) {
    const party = parties.get(game.partyCode);
    const alive = getAliveMembers(game).length;
    const body = `${modeName(game.mode)}\n${modeDescription(game.mode)}\n\nAlive: ${alive}\nParty: ${party ? party.code : "-"}`;
    const form = new ActionFormData()
        .title("Mini Game Running")
        .body(body)
        .button("Leave Match");
    if (game.hostId === player.id) form.button("End Match");
    form.button("Close");
    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === 0) leaveGame(player);
        else if (game.hostId === player.id && response.selection === 1) endGame(game, `§e${player.name} ended the match.`);
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
    const form = new ActionFormData()
        .title("Mini Games & Party")
        .body(`${hostText}\nCode: §f${party.code}\nMembers: ${memberNames}\n\nShare the code with your friend.`)
        .button("Start Mini Game")
        .button("Invite Friend")
        .button(`Invitations (${invites.length})`)
        .button("Leave Party");
    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === 0) showStartModeMenu(player);
        else if (response.selection === 1) showInviteMenu(player);
        else if (response.selection === 2) showInvitationsMenu(player);
        else leaveParty(player);
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
