import { world, system } from "@minecraft/server";
import { isPlayerAllowedTarget } from "./targeting";

/*
 * PvP brain
 *
 * The entity JSON still owns normal path-finding and melee attacks.  This module
 * adds the actions that are difficult to express with entity components:
 *
 *   - crystal PvP: place obsidian, spawn a crystal, then pop it several times;
 *   - bridging: place a block under the bot/ahead of it when a gap is detected;
 *   - movement: face the target and strafe instead of walking in a straight line.
 *
 * Everything is guarded with small try/catch blocks because a bot can be killed
 * or unloaded between two scheduled ticks.
 */

export const PVP_CONFIG = {
    crystal: {
        enabled: true,
        comboPops: 4,
        triggerDistance: 10,
        minimumDistance: 3.25,
        popDelayTicks: 5,
        gapTicks: 7,
        cooldownTicks: 70,
        selfDistance: 3.1,
        targetMustBeGrounded: true
    },
    bridge: {
        enabled: true,
        block: "minecraft:obsidian",
        checkInterval: 2,
        maxBlocksPerBridge: 48,
        targetDistance: 40,
        clutch: true
    },
    combat: {
        enabled: true,
        checkInterval: 2,
        targetDistance: 24,
        strafe: true,
        strafeSwitchTicks: 28,
        forwardImpulse: 0.018,
        strafeImpulse: 0.022,
        retreatImpulse: 0.012
    }
};

const DIMENSION_IDS = ["overworld", "nether", "the_end"];
const AIR_BLOCKS = new Set([
    "minecraft:air",
    "minecraft:cave_air",
    "minecraft:void_air"
]);
const LIQUID_BLOCKS = new Set([
    "minecraft:water",
    "minecraft:flowing_water",
    "minecraft:lava",
    "minecraft:flowing_lava"
]);
const REPLACEABLE_BLOCKS = new Set([
    ...AIR_BLOCKS,
    ...LIQUID_BLOCKS,
    "minecraft:fire",
    "minecraft:soul_fire",
    "minecraft:short_grass",
    "minecraft:tall_grass",
    "minecraft:fern",
    "minecraft:large_fern",
    "minecraft:deadbush",
    "minecraft:snow_layer",
    "minecraft:vine",
    "minecraft:glow_lichen",
    "minecraft:seagrass",
    "minecraft:tall_seagrass"
]);
const CRYSTAL_BASES = new Set([
    "minecraft:obsidian",
    "minecraft:bedrock"
]);

const crystalStates = new Map();
const bridgeStates = new Map();
const combatStates = new Map();

function isValid(entity) {
    try {
        return !!entity && entity.isValid();
    } catch (error) {
        return false;
    }
}

function hasTag(entity, tag) {
    try {
        return entity.hasTag(tag);
    } catch (error) {
        return false;
    }
}

function isIgnoredBot(bot) {
    return hasTag(bot, "bot_ignore") || hasTag(bot, "pvp_ignore");
}

function isCreativePlayer(player) {
    try {
        return player.typeId === "minecraft:player" && player.getGameMode() === "creative";
    } catch (error) {
        return false;
    }
}

function isIgnoredTarget(player) {
    return !isValid(player) ||
        player.typeId !== "minecraft:player" ||
        isCreativePlayer(player) ||
        !isPlayerAllowedTarget(player.name) ||
        hasTag(player, "pvp_ignore") ||
        hasTag(player, "bot_ignore");
}

function distance3d(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function horizontalDistance(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function getBlock(dimension, x, y, z) {
    try {
        return dimension.getBlock({ x, y, z });
    } catch (error) {
        return null;
    }
}

function isReplaceable(block) {
    if (!block) return true;
    try {
        if (block.isAir === true) return true;
    } catch (error) {}
    return REPLACEABLE_BLOCKS.has(block.typeId);
}

function isLiquid(block) {
    return !!block && LIQUID_BLOCKS.has(block.typeId);
}

function isSolid(block) {
    if (!block || isReplaceable(block) || isLiquid(block)) return false;
    try {
        if (typeof block.isSolid === "boolean") return block.isSolid;
    } catch (error) {}
    return true;
}

function isCrystalBase(block) {
    return !!block && CRYSTAL_BASES.has(block.typeId);
}

function getBotEntities(dimension) {
    try {
        // All of the custom entities use the "bot" type family.  This also
        // makes new bot variants inherit the PvP brain without editing JS.
        return dimension.getEntities({ families: ["bot"] })
            .filter(entity => entity.typeId.startsWith("bot:"));
    } catch (error) {
        // The fallback keeps the module useful on older server API builds.
        try {
            return dimension.getEntities({ type: "bot:army21" });
        } catch (fallbackError) {
            return [];
        }
    }
}

function getNearestTarget(bot, maxDistance) {
    let nearest = null;
    let nearestDistance = maxDistance;

    try {
        const players = bot.dimension.getEntities({
            type: "minecraft:player",
            location: bot.location,
            maxDistance
        });

        for (const player of players) {
            if (isIgnoredTarget(player)) continue;
            const currentDistance = distance3d(bot.location, player.location);
            if (currentDistance < nearestDistance) {
                nearest = player;
                nearestDistance = currentDistance;
            }
        }
    } catch (error) {}

    return nearest;
}

function isGrounded(entity) {
    try {
        if (entity.isOnGround === false) return false;
        const velocity = entity.getVelocity();
        if (velocity && Math.abs(velocity.y) > 0.12) return false;

        const below = getBlock(
            entity.dimension,
            Math.floor(entity.location.x),
            Math.floor(entity.location.y) - 1,
            Math.floor(entity.location.z)
        );
        return isSolid(below);
    } catch (error) {
        return false;
    }
}

function getDirection(from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 0.001) return { x: 0, z: 0 };
    return { x: dx / length, z: dz / length };
}

function faceTarget(bot, target) {
    try {
        const dx = target.location.x - bot.location.x;
        const dz = target.location.z - bot.location.z;
        const horizontal = Math.sqrt(dx * dx + dz * dz) || 0.001;
        const dy = (target.location.y + 1.0) - (bot.location.y + 1.4);
        const yaw = Math.atan2(-dx, dz) * (180 / Math.PI);
        const pitch = Math.max(-89, Math.min(89, -Math.atan2(dy, horizontal) * (180 / Math.PI)));
        bot.setRotation({ x: pitch, y: yaw });
    } catch (error) {}
}

function runSetBlock(bot, location, blockId) {
    const command = `setblock ${location.x} ${location.y} ${location.z} ${blockId} replace`;
    try {
        bot.runCommand(command);
        return true;
    } catch (error) {
        try {
            bot.dimension.runCommand(command);
            return true;
        } catch (fallbackError) {
            return false;
        }
    }
}

function equipBlock(bot, blockId) {
    try {
        // This is only a visual hand change.  Blocks are placed by the
        // command above so a bot does not need a full player inventory.
        bot.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${blockId} 1`);
    } catch (error) {}
}

function restoreWeapon(bot) {
    try {
        const tags = bot.getTags();
        bot.runCommand(`function ${tags.includes("diamond_level") && !tags.includes("netherite_level") ? "sword3" : "sword1"}`);
    } catch (error) {}
}

function getEntityById(id) {
    if (!id) return null;
    try {
        return world.getEntity(id);
    } catch (error) {
        return null;
    }
}

function getCrystalAt(dimension, location, radius = 2.5) {
    try {
        const crystals = dimension.getEntities({
            type: "minecraft:ender_crystal",
            location,
            maxDistance: radius
        });
        let nearest = null;
        let nearestDistance = radius;
        for (const crystal of crystals) {
            const currentDistance = distance3d(location, crystal.location);
            if (currentDistance < nearestDistance) {
                nearest = crystal;
                nearestDistance = currentDistance;
            }
        }
        return nearest;
    } catch (error) {
        return null;
    }
}

function spawnCrystal(dimension, location) {
    let crystal = null;

    try {
        crystal = dimension.spawnEntity("minecraft:ender_crystal", location);
    } catch (error) {}

    if (!crystal) {
        try {
            dimension.runCommand(`summon ender_crystal ${location.x} ${location.y} ${location.z}`);
        } catch (error) {}
        crystal = getCrystalAt(dimension, location);
    }

    return crystal;
}

function getCrystalCandidates(bot, target, state) {
    const targetX = Math.floor(target.location.x);
    const targetY = Math.floor(target.location.y);
    const targetZ = Math.floor(target.location.z);
    const awayFromBot = getDirection(bot.location, target.location);
    const directions = [
        { x: Math.round(awayFromBot.x), z: Math.round(awayFromBot.z) },
        { x: -Math.round(awayFromBot.x), z: -Math.round(awayFromBot.z) },
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
        { x: 1, z: 1 },
        { x: -1, z: -1 }
    ];
    const candidates = [];
    const used = state.usedBases || [];

    for (const direction of directions) {
        if (direction.x === 0 && direction.z === 0) continue;

        for (const yOffset of [0, 1, -1]) {
            const base = {
                x: targetX + direction.x,
                y: targetY + yOffset,
                z: targetZ + direction.z
            };
            const key = `${base.x},${base.y},${base.z}`;
            if (used.includes(key)) continue;

            const baseBlock = getBlock(bot.dimension, base.x, base.y, base.z);
            const needsPlace = !isCrystalBase(baseBlock);
            if (needsPlace && !isReplaceable(baseBlock)) continue;

            // A newly placed base needs support.  Existing obsidian/bedrock is
            // allowed even when it is part of a floating PvP platform.
            const support = getBlock(bot.dimension, base.x, base.y - 1, base.z);
            if (needsPlace && !isSolid(support)) continue;

            const crystalLocation = {
                x: base.x + 0.5,
                y: base.y + 1,
                z: base.z + 0.5
            };
            const crystalSpace = getBlock(
                bot.dimension,
                base.x,
                base.y + 1,
                base.z
            );
            const crystalHeadSpace = getBlock(
                bot.dimension,
                base.x,
                base.y + 2,
                base.z
            );
            if (!isReplaceable(crystalSpace) || !isReplaceable(crystalHeadSpace)) continue;

            const selfDistance = distance3d(bot.location, crystalLocation);
            const targetDistance = distance3d(
                { x: target.location.x, y: target.location.y + 1, z: target.location.z },
                crystalLocation
            );
            if (selfDistance < PVP_CONFIG.crystal.selfDistance) continue;
            if (targetDistance > 6.5) continue;

            candidates.push({
                base,
                crystalLocation,
                needsPlace,
                score: targetDistance - Math.min(selfDistance, 8) * 0.12,
                key
            });
        }
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates;
}

function resetCrystalState(state, cooldown = 0) {
    state.phase = cooldown > 0 ? "cooldown" : "idle";
    state.nextActionTick = system.currentTick + cooldown;
    state.targetId = null;
    state.currentCrystalId = null;
    state.popsRemaining = 0;
    state.usedBases = [];
    state.token += 1;
}

function finishCrystalCombo(bot, state) {
    restoreWeapon(bot);
    resetCrystalState(state, PVP_CONFIG.crystal.cooldownTicks);
}

function damageCrystal(crystal, bot) {
    if (!isValid(crystal)) return;

    let damageSent = false;
    try {
        // The script API uses the same hard-coded end-crystal damage path as a
        // player hit, so this is the most reliable way to trigger the normal
        // explosion and attribute the pop to the bot.
        if (typeof crystal.applyDamage === "function") {
            crystal.applyDamage(10, { cause: "entityAttack", damagingEntity: bot });
            damageSent = true;
        }
    } catch (error) {}

    if (!damageSent) {
        try {
            // Include the bot as the Bedrock /damage source.  This is the
            // fallback for older script builds without applyDamage support.
            const x = Math.floor(crystal.location.x);
            const y = Math.floor(crystal.location.y);
            const z = Math.floor(crystal.location.z);
            bot.runCommand(`damage @e[type=ender_crystal,x=${x},y=${y},z=${z},r=2,c=1] 10 entity_attack entity @s`);
            damageSent = true;
        } catch (error) {}
    }

    if (!damageSent) {
        try {
            // Last fallback for builds that do not accept an entity damager in
            // a command issued by a custom entity.
            crystal.runCommand("damage @s 10 entity_attack");
            damageSent = true;
        } catch (error) {}
    }

    // Some older Bedrock builds do not expose /damage for non-living entities.
    // Try it once more and remove a stuck crystal rather than leaving combat
    // state permanently locked.
    system.runTimeout(() => {
        try {
            if (isValid(crystal)) {
                crystal.runCommand("damage @s 10 entity_attack");
            }
        } catch (error) {}
        try {
            // If the second damage attempt did not remove it, do not leave a
            // permanent crystal or a locked combo state behind.
            if (isValid(crystal)) crystal.kill();
        } catch (killError) {}
    }, 3);
}

function placeNextCrystal(bot, state, target) {
    if (!isValid(bot) || !isValid(target)) return false;

    const candidates = getCrystalCandidates(bot, target, state);
    const candidate = candidates[0];
    if (!candidate) {
        resetCrystalState(state, 20);
        return false;
    }

    state.phase = "placing";
    state.usedBases.push(candidate.key);
    state.base = candidate.base;
    state.token += 1;
    const token = state.token;

    if (candidate.needsPlace) {
        equipBlock(bot, "minecraft:obsidian");
        if (!runSetBlock(bot, candidate.base, "minecraft:obsidian")) {
            resetCrystalState(state, 20);
            return false;
        }
    }

    system.runTimeout(() => {
        try {
            if (state.token !== token) return;
            if (!isValid(bot)) return;
            if (!isValid(target)) {
                finishCrystalCombo(bot, state);
                return;
            }
            if (distance3d(bot.location, target.location) > PVP_CONFIG.crystal.triggerDistance + 3) {
                finishCrystalCombo(bot, state);
                return;
            }

            const baseBlock = getBlock(
                bot.dimension,
                candidate.base.x,
                candidate.base.y,
                candidate.base.z
            );
            if (!isCrystalBase(baseBlock)) {
                finishCrystalCombo(bot, state);
                return;
            }

            try {
                equipBlock(bot, "minecraft:end_crystal");
                const crystal = spawnCrystal(bot.dimension, candidate.crystalLocation);
                if (!crystal) {
                    finishCrystalCombo(bot, state);
                    return;
                }
                state.currentCrystalId = crystal.id;
                state.phase = "waiting";
                state.popAtTick = system.currentTick + PVP_CONFIG.crystal.popDelayTicks;
            } catch (error) {
                finishCrystalCombo(bot, state);
            }
        } catch (error) {
            finishCrystalCombo(bot, state);
        }
    }, 2);

    return true;
}

function startCrystalCombo(bot, target) {
    const state = crystalStates.get(bot.id) || {
        phase: "idle",
        nextActionTick: 0,
        targetId: null,
        currentCrystalId: null,
        popsRemaining: 0,
        usedBases: [],
        token: 0
    };
    state.targetId = target.id;
    state.popsRemaining = Math.max(1, Math.floor(PVP_CONFIG.crystal.comboPops));
    state.usedBases = [];
    state.phase = "idle";
    state.nextActionTick = system.currentTick;
    crystalStates.set(bot.id, state);
    return placeNextCrystal(bot, state, target);
}

function updateCrystalBot(bot, tick) {
    if (!PVP_CONFIG.crystal.enabled || isIgnoredBot(bot)) {
        const activeState = crystalStates.get(bot.id);
        if (activeState && activeState.phase !== "idle" && activeState.phase !== "cooldown") {
            finishCrystalCombo(bot, activeState);
        }
        return;
    }

    let state = crystalStates.get(bot.id);
    if (!state) {
        state = {
            phase: "idle",
            nextActionTick: 0,
            targetId: null,
            currentCrystalId: null,
            popsRemaining: 0,
            usedBases: [],
            token: 0
        };
        crystalStates.set(bot.id, state);
    }

    if (state.phase === "cooldown") {
        if (tick >= state.nextActionTick) {
            state.phase = "idle";
            state.usedBases = [];
        }
        return;
    }

    if (state.phase === "waiting" && tick >= state.popAtTick) {
        const crystal = getEntityById(state.currentCrystalId);
        damageCrystal(crystal, bot);
        state.currentCrystalId = null;
        state.popsRemaining -= 1;
        state.phase = "gap";
        state.nextActionTick = tick + PVP_CONFIG.crystal.gapTicks;
        if (state.popsRemaining <= 0) {
            finishCrystalCombo(bot, state);
        }
        return;
    }

    if (state.phase === "gap" && tick < state.nextActionTick) return;

    if (state.phase === "placing" || state.phase === "waiting") return;

    const target = state.targetId ? getEntityById(state.targetId) : null;
    if (target && isValid(target) && !isIgnoredTarget(target)) {
        if (state.phase === "gap") {
            if (!placeNextCrystal(bot, state, target)) finishCrystalCombo(bot, state);
            return;
        }
    }

    const newTarget = getNearestTarget(bot, PVP_CONFIG.crystal.triggerDistance);
    if (!newTarget) return;
    if (PVP_CONFIG.crystal.targetMustBeGrounded && !isGrounded(newTarget)) return;

    const targetDistance = distance3d(bot.location, newTarget.location);
    if (targetDistance < PVP_CONFIG.crystal.minimumDistance ||
        targetDistance > PVP_CONFIG.crystal.triggerDistance) return;

    startCrystalCombo(bot, newTarget);
}

function blockAtCell(dimension, cell, y) {
    return getBlock(dimension, cell.x, y, cell.z);
}

function getNextBridgeCell(bot, target) {
    const direction = getDirection(bot.location, target.location);
    const currentX = Math.floor(bot.location.x);
    const currentZ = Math.floor(bot.location.z);
    const stepX = direction.x === 0 ? 0 : (direction.x > 0 ? 1 : -1);
    const stepZ = direction.z === 0 ? 0 : (direction.z > 0 ? 1 : -1);
    const feetY = Math.floor(bot.location.y);

    // First put a block under a falling bot.  This is the small clutch that
    // keeps a bridge from ending because the bot stepped off its last block.
    const currentCell = { x: currentX, z: currentZ };
    if (!isSolid(blockAtCell(bot.dimension, currentCell, feetY - 1))) {
        return { x: currentX, y: feetY - 1, z: currentZ, direction };
    }

    for (let distance = 1; distance <= 2; distance += 1) {
        const cell = {
            x: currentX + stepX * distance,
            z: currentZ + stepZ * distance
        };
        const support = blockAtCell(bot.dimension, cell, feetY - 1);
        const footBlock = blockAtCell(bot.dimension, cell, feetY);
        if (!isSolid(support) && isReplaceable(footBlock)) {
            return { x: cell.x, y: feetY - 1, z: cell.z, direction };
        }
    }

    return null;
}

function isBridgeNeeded(bot, target) {
    if (!target || horizontalDistance(bot.location, target.location) < 4.5) return false;
    return !!getNextBridgeCell(bot, target);
}

function stopBridge(bot, state, cooldownTicks = 0) {
    if (state.active) restoreWeapon(bot);
    state.blocks = 0;
    state.lastCell = "";
    state.stalledTicks = 0;
    state.active = false;
    state.cooldownUntil = system.currentTick + cooldownTicks;
}

function updateBridgeBot(bot, tick) {
    let state = bridgeStates.get(bot.id);
    if (!state) {
        state = {
            blocks: 0,
            lastCell: "",
            stalledTicks: 0,
            active: false,
            cooldownUntil: 0
        };
        bridgeStates.set(bot.id, state);
    }

    if (!PVP_CONFIG.bridge.enabled || isIgnoredBot(bot)) {
        stopBridge(bot, state);
        return;
    }
    if (tick % Math.max(1, PVP_CONFIG.bridge.checkInterval) !== 0) return;
    if (tick < state.cooldownUntil) return;

    const target = getNearestTarget(bot, PVP_CONFIG.bridge.targetDistance);
    if (!target || !isBridgeNeeded(bot, target)) {
        stopBridge(bot, state);
        return;
    }
    if (state.blocks >= PVP_CONFIG.bridge.maxBlocksPerBridge) {
        stopBridge(bot, state, 100);
        return;
    }

    const placement = getNextBridgeCell(bot, target);
    if (!placement) {
        stopBridge(bot, state);
        return;
    }

    const key = `${placement.x},${placement.y},${placement.z}`;
    if (state.lastCell === key) {
        state.stalledTicks += PVP_CONFIG.bridge.checkInterval;
    } else {
        state.lastCell = key;
        state.stalledTicks = 0;
    }

    if (state.stalledTicks > 24) {
        stopBridge(bot, state, 40);
        return;
    }

    equipBlock(bot, PVP_CONFIG.bridge.block);
    if (runSetBlock(bot, placement, PVP_CONFIG.bridge.block)) {
        state.blocks += 1;
        state.active = true;
    }

    faceTarget(bot, target);
    try {
        const direction = placement.direction;
        bot.applyImpulse({
            x: direction.x * 0.055,
            y: 0.018,
            z: direction.z * 0.055
        });
    } catch (error) {}
}

function updateClutch(bot) {
    if (!PVP_CONFIG.bridge.enabled || !PVP_CONFIG.bridge.clutch) return;
    try {
        const velocity = bot.getVelocity();
        if (!velocity || velocity.y > -0.12) return;
        const x = Math.floor(bot.location.x);
        const y = Math.floor(bot.location.y) - 1;
        const z = Math.floor(bot.location.z);
        const block = getBlock(bot.dimension, x, y, z);
        if (isReplaceable(block)) runSetBlock(bot, { x, y, z }, PVP_CONFIG.bridge.block);
    } catch (error) {}
}

function updateCombatBot(bot, tick) {
    if (!PVP_CONFIG.combat.enabled) return;
    if (tick % Math.max(1, PVP_CONFIG.combat.checkInterval) !== 0) return;
    if (isIgnoredBot(bot)) return;

    const target = getNearestTarget(bot, PVP_CONFIG.combat.targetDistance);
    if (!target) {
        combatStates.delete(bot.id);
        return;
    }

    let state = combatStates.get(bot.id);
    if (!state) {
        state = { targetId: target.id, strafeSign: Math.random() < 0.5 ? -1 : 1, switchTick: tick };
        combatStates.set(bot.id, state);
    }
    if (state.targetId !== target.id) {
        state.targetId = target.id;
        state.switchTick = tick;
    }
    if (PVP_CONFIG.combat.strafe && tick - state.switchTick >= PVP_CONFIG.combat.strafeSwitchTicks) {
        state.strafeSign *= -1;
        state.switchTick = tick;
    }

    faceTarget(bot, target);
    const direction = getDirection(bot.location, target.location);
    const distance = horizontalDistance(bot.location, target.location);
    let forward = 0;
    if (distance > 4.2) forward = PVP_CONFIG.combat.forwardImpulse;
    if (distance < 2.1) forward = -PVP_CONFIG.combat.retreatImpulse;

    const strafe = PVP_CONFIG.combat.strafe ? PVP_CONFIG.combat.strafeImpulse * state.strafeSign : 0;
    try {
        if (bot.isOnGround !== false) {
            bot.applyImpulse({
                x: direction.x * forward - direction.z * strafe,
                y: 0,
                z: direction.z * forward + direction.x * strafe
            });
        }
    } catch (error) {}
}

function cleanupStates() {
    const activeIds = new Set();
    for (const dimensionId of DIMENSION_IDS) {
        try {
            const dimension = world.getDimension(dimensionId);
            for (const bot of getBotEntities(dimension)) activeIds.add(bot.id);
        } catch (error) {}
    }

    for (const id of crystalStates.keys()) {
        if (!activeIds.has(id)) crystalStates.delete(id);
    }
    for (const id of bridgeStates.keys()) {
        if (!activeIds.has(id)) bridgeStates.delete(id);
    }
    for (const id of combatStates.keys()) {
        if (!activeIds.has(id)) combatStates.delete(id);
    }
}

system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        try {
            const dimension = world.getDimension(dimensionId);
            for (const bot of getBotEntities(dimension)) {
                if (!isValid(bot)) continue;
                updateCrystalBot(bot, system.currentTick);
                updateBridgeBot(bot, system.currentTick);
                updateClutch(bot);
                updateCombatBot(bot, system.currentTick);
            }
        } catch (error) {}
    }
}, 1);

system.runInterval(cleanupStates, 200);

try {
    world.afterEvents.entityDie.subscribe(event => {
        const id = event.deadEntity.id;
        crystalStates.delete(id);
        bridgeStates.delete(id);
        combatStates.delete(id);
    });
    world.afterEvents.entityRemove.subscribe(event => {
        const id = event.removedEntityId;
        crystalStates.delete(id);
        bridgeStates.delete(id);
        combatStates.delete(id);
    });
} catch (error) {}
