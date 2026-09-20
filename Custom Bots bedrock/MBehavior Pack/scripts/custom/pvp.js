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
 *   - movement and timing: target lock, circle strafing, hit-select/counter
 *     movement, jump resets, and server-side W-tap/S-tap simulation;
 *   - utility: velocity-led wind charges, short rod knockback simulation,
 *     shield-aware axe switching, and reachable low-health traps.
 *
 * Everything is guarded with small try/catch blocks because a bot can be killed
 * or unloaded between two scheduled ticks. Bedrock does not expose literal
 * player clicks or a reliable summonable fishing hook, so those two mechanics
 * are deliberately conservative server-side approximations.
 */

export const PVP_CONFIG = {
    // Conservative Bedrock survival reach. All block placement in this
    // module is rejected beyond this distance.
    placementReach: 5.0,
    crystal: {
        enabled: true,
        comboPops: 3,
        triggerDistance: 10,
        minimumDistance: 3.0,
        popDelayTicks: 5,
        gapTicks: 9,
        cooldownTicks: 90,
        selfDistance: 4.0,
        targetMustBeGrounded: true
    },
    mace: {
        enabled: true,
        minimumDistance: 2.5,
        maximumDistance: 3.8,
        cooldownTicks: 90,
        activeTicks: 20,
        jumpImpulse: 0.55,
        forwardImpulse: 0.04,
        smashBonusDamage: 5
    },
    windCharge: {
        enabled: true,
        minimumDistance: 10.5,
        maximumDistance: 14.0,
        cooldownTicks: 100,
        activeTicks: 8,
        power: 1.25
    },
    mechanics: {
        enabled: true,
        sprintReset: true,
        jumpReset: true,
        hitSelect: true,
        predictedProjectiles: true
    },
    axe: {
        enabled: true,
        maximumDistance: 4.5,
        activeTicks: 10,
        cooldownTicks: 70
    },
    rod: {
        enabled: true,
        minimumDistance: 4.0,
        maximumDistance: 5.0,
        activeTicks: 6,
        cooldownTicks: 90
    },
    trap: {
        enabled: true,
        block: "minecraft:web",
        minimumHealthFraction: 0.45,
        cooldownTicks: 40,
        maxPlacementsPerTarget: 2
    },
    bridge: {
        enabled: true,
        block: "minecraft:obsidian",
        checkInterval: 2,
        maxBlocksPerBridge: 24,
        targetDistance: 32,
        clutch: false
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
const maceStates = new Map();
const windChargeStates = new Map();
const axeStates = new Map();
const rodStates = new Map();
const trapStates = new Map();
const bridgeStates = new Map();
const combatStates = new Map();
const CRYSTAL_PROTECTION_TAG = "bot_crystal_protected";
const CRYSTAL_PROTECTION_TICKS = 20;

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

const PVP_ACTION_TAG = "pvp_special_active";
const PEARL_ACTION_TAG = "pvp_pearl_active";

function setPvpActionActive(bot, active) {
    try {
        if (active) bot.addTag(PVP_ACTION_TAG);
        else bot.removeTag(PVP_ACTION_TAG);
        return;
    } catch (error) {
        try {
            bot.runCommand(`tag @s ${active ? "add" : "remove"} ${PVP_ACTION_TAG}`);
        } catch (fallbackError) {}
    }
}

function isExternalActionBusy(bot) {
    return hasTag(bot, PEARL_ACTION_TAG);
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
        (!isPlayerAllowedTarget(player.name) && !hasTag(player, "minigame_player")) ||
        hasTag(player, "pvp_ignore") ||
        hasTag(player, "bot_ignore");
}

function getMiniGameTeamTag(entity) {
    try {
        const tags = entity.getTags();
        return tags.find(tag => tag.startsWith("minigame_team_")) || null;
    } catch (error) {
        return null;
    }
}

function isMiniGameTargetAllowed(bot, player) {
    if (!hasTag(bot, "minigame_active")) return true;
    // A mini-game bot should not wander out of the temporary match and attack
    // unrelated players elsewhere in the world.
    if (!hasTag(player, "minigame_player")) return false;
    const botTeamTag = getMiniGameTeamTag(bot);
    if (botTeamTag && hasTag(player, botTeamTag)) return false;
    return true;
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
    // A missing block means the chunk/query is unavailable, not that an air
    // block was found. Treating it as replaceable causes floating air-places.
    if (!block) return false;
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
            if (isIgnoredTarget(player) || !isMiniGameTargetAllowed(bot, player)) continue;
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

function getEntityVelocity(entity) {
    try {
        return entity.getVelocity() || { x: 0, y: 0, z: 0 };
    } catch (error) {
        return { x: 0, y: 0, z: 0 };
    }
}

function getPredictedTargetLocation(target, projectileSpeed, origin) {
    const velocity = getEntityVelocity(target);
    const distance = origin ? distance3d(origin, target.location) : 0;
    // The lead is deliberately short. It is enough to compensate for a
    // strafing player's current velocity without aiming through a wall or
    // predicting a long, unreliable future path.
    const travelTicks = Math.max(1, Math.min(8, distance / Math.max(0.1, projectileSpeed)));
    return {
        x: target.location.x + velocity.x * travelTicks,
        y: target.location.y + velocity.y * travelTicks,
        z: target.location.z + velocity.z * travelTicks
    };
}

function getEquippedItemId(entity, slotName) {
    try {
        const equippable = entity.getComponent("minecraft:equippable") || entity.getComponent("equippable");
        if (!equippable) return "";
        const item = equippable.getEquipment(slotName);
        return item && item.typeId ? item.typeId : "";
    } catch (error) {
        return "";
    }
}

function isTargetShielding(target) {
    // Stable Bedrock APIs expose the equipped shield, but not every version
    // exposes the live blocking animation. Treat an equipped offhand shield as
    // a conservative signal and also accept a mainhand shield.
    return getEquippedItemId(target, "Offhand") === "minecraft:shield" ||
        getEquippedItemId(target, "offhand") === "minecraft:shield" ||
        getEquippedItemId(target, "Mainhand") === "minecraft:shield" ||
        getEquippedItemId(target, "mainhand") === "minecraft:shield";
}

function getHealthFraction(entity) {
    try {
        const health = entity.getComponent("minecraft:health");
        if (!health || health.effectiveMax <= 0) return 1;
        return Math.max(0, Math.min(1, health.currentValue / health.effectiveMax));
    } catch (error) {
        return 1;
    }
}

function canReachPlacement(bot, location) {
    try {
        const eyeLocation = {
            x: bot.location.x,
            y: bot.location.y + 1.62,
            z: bot.location.z
        };
        const blockCenter = {
            x: location.x + 0.5,
            y: location.y + 0.5,
            z: location.z + 0.5
        };
        return distance3d(eyeLocation, blockCenter) <= PVP_CONFIG.placementReach + 0.05;
    } catch (error) {
        return false;
    }
}

function runSetBlock(bot, location, blockId) {
    // Commands are used for reliable block placement, but the range check
    // happens first so this cannot become a long-distance placement exploit.
    if (!canReachPlacement(bot, location)) return false;

    // Never replace a solid block or place into an unloaded/unknown cell.
    // This is the final guard against repeated floating air placement.
    const existing = getBlock(bot.dimension, location.x, location.y, location.z);
    if (!existing || !isReplaceable(existing)) return false;

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

function equipItem(bot, itemId) {
    try {
        bot.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 ${itemId} 1`);
    } catch (error) {}
}

function equipBlock(bot, blockId) {
    // This is only a visual hand change. Blocks are placed by the command
    // above so a bot does not need a full player inventory.
    equipItem(bot, blockId);
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
    const candidateKeys = new Set();

    for (const direction of directions) {
        if (direction.x === 0 && direction.z === 0) continue;

        for (const yOffset of [0, 1, -1]) {
            const base = {
                x: targetX + direction.x,
                y: targetY + yOffset,
                z: targetZ + direction.z
            };
            const key = `${base.x},${base.y},${base.z}`;
            if (candidateKeys.has(key)) continue;
            candidateKeys.add(key);

            // A real player must be able to reach the block used for the
            // crystal. This also prevents the command fallback from placing
            // obsidian beside a target several blocks away.
            if (!canReachPlacement(bot, base)) continue;

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
    setPvpActionActive(bot, false);
    restoreWeapon(bot);
    resetCrystalState(state, PVP_CONFIG.crystal.cooldownTicks);
}

function isCrystalBusy(bot) {
    const state = crystalStates.get(bot.id);
    return !!state && (state.phase === "placing" || state.phase === "waiting" || state.phase === "gap");
}

function isBridgeBusy(bot) {
    const state = bridgeStates.get(bot.id);
    return !!state && (state.active || state.waitingForMovement);
}

function isMaceBusy(bot) {
    return maceStates.get(bot.id)?.phase === "active";
}

function isWindChargeBusy(bot) {
    return windChargeStates.get(bot.id)?.phase === "active";
}

function isAxeBusy(bot) {
    return axeStates.get(bot.id)?.phase === "active";
}

function isRodBusy(bot) {
    return rodStates.get(bot.id)?.phase === "active";
}

function isSpecialActionBusy(bot) {
    return isCrystalBusy(bot) || isBridgeBusy(bot) || isMaceBusy(bot) ||
        isWindChargeBusy(bot) || isAxeBusy(bot) || isRodBusy(bot);
}

function finishMaceAttack(bot, state) {
    setPvpActionActive(bot, false);
    restoreWeapon(bot);
    state.phase = "cooldown";
    state.cooldownUntil = system.currentTick + PVP_CONFIG.mace.cooldownTicks;
    state.targetId = null;
    state.didSmash = false;
    state.wasAirborne = false;
}

function startMaceAttack(bot, target, tick) {
    const state = maceStates.get(bot.id) || {
        phase: "idle",
        cooldownUntil: 0,
        targetId: null,
        endTick: 0,
        canSmashAfterTick: 0,
        didSmash: false,
        wasAirborne: false
    };

    state.phase = "active";
    state.targetId = target.id;
    state.endTick = tick + PVP_CONFIG.mace.activeTicks;
    state.canSmashAfterTick = tick + 5;
    state.didSmash = false;
    state.wasAirborne = false;
    maceStates.set(bot.id, state);
    setPvpActionActive(bot, true);

    equipItem(bot, "minecraft:mace");
    faceTarget(bot, target);
    try {
        const direction = getDirection(bot.location, target.location);
        bot.applyImpulse({
            x: direction.x * PVP_CONFIG.mace.forwardImpulse,
            y: PVP_CONFIG.mace.jumpImpulse,
            z: direction.z * PVP_CONFIG.mace.forwardImpulse
        });
    } catch (error) {}
}

function applyMaceSmash(attacker, victim, state) {
    if (!isValid(victim)) return false;
    try {
        victim.applyDamage(PVP_CONFIG.mace.smashBonusDamage, {
            cause: "entityAttack",
            damagingEntity: attacker
        });
        state.didSmash = true;
        return true;
    } catch (error) {
        return false;
    }
}

function updateMaceBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.mace.enabled || isIgnoredBot(bot)) {
        const state = maceStates.get(bot.id);
        if (state && state.phase === "active") finishMaceAttack(bot, state);
        return;
    }

    let state = maceStates.get(bot.id);
    if (!state) {
        state = {
            phase: "idle",
            cooldownUntil: 0,
            targetId: null,
            endTick: 0,
            canSmashAfterTick: 0,
            didSmash: false,
            wasAirborne: false
        };
        maceStates.set(bot.id, state);
    }

    if (state.phase === "cooldown") {
        if (tick >= state.cooldownUntil) state.phase = "idle";
        else return;
    }

    if (state.phase === "active") {
        const target = getEntityById(state.targetId);
        if (target && isValid(target) && !isIgnoredTarget(target)) {
            faceTarget(bot, target);
            if (state.wasAirborne && bot.isOnGround === true &&
                tick >= state.canSmashAfterTick && horizontalDistance(bot.location, target.location) <= 4.5) {
                // Native melee normally creates the hit event. This landing
                // fallback keeps mace combat working on custom entities whose
                // AI does not report a falling hit consistently.
                applyMaceSmash(bot, target, state);
            }
        }
        if (bot.isOnGround === false) state.wasAirborne = true;
        if (tick >= state.endTick || state.didSmash) finishMaceAttack(bot, state);
        return;
    }

    if (isCrystalBusy(bot) || isBridgeBusy(bot) || isWindChargeBusy(bot) ||
        isAxeBusy(bot) || isRodBusy(bot)) return;
    if (bot.isOnGround === false) return;

    const target = getNearestTarget(bot, PVP_CONFIG.mace.maximumDistance);
    if (!target || isTargetShielding(target)) return;
    const distance = horizontalDistance(bot.location, target.location);
    if (distance < PVP_CONFIG.mace.minimumDistance ||
        distance > PVP_CONFIG.mace.maximumDistance) return;

    startMaceAttack(bot, target, tick);
}

function finishAxeAttack(bot, state) {
    setPvpActionActive(bot, false);
    restoreWeapon(bot);
    state.handledTargetId = state.targetId;
    state.phase = "cooldown";
    state.cooldownUntil = system.currentTick + PVP_CONFIG.axe.cooldownTicks;
    state.targetId = null;
}

function startAxeAttack(bot, target, tick) {
    const state = axeStates.get(bot.id) || {
        phase: "idle",
        cooldownUntil: 0,
        targetId: null,
        handledTargetId: null,
        endTick: 0
    };
    state.phase = "active";
    state.targetId = target.id;
    state.endTick = tick + PVP_CONFIG.axe.activeTicks;
    axeStates.set(bot.id, state);
    setPvpActionActive(bot, true);
    equipItem(bot, "minecraft:netherite_axe");
    faceTarget(bot, target);
}

function updateAxeBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.axe.enabled || isIgnoredBot(bot)) {
        const state = axeStates.get(bot.id);
        if (state && state.phase === "active") finishAxeAttack(bot, state);
        return;
    }

    let state = axeStates.get(bot.id);
    if (!state) {
        state = {
            phase: "idle",
            cooldownUntil: 0,
            targetId: null,
            handledTargetId: null,
            endTick: 0
        };
        axeStates.set(bot.id, state);
    }

    if (state.phase === "cooldown") {
        if (tick >= state.cooldownUntil) state.phase = "idle";
        else return;
    }

    if (state.phase === "active") {
        const target = getEntityById(state.targetId);
        if (target && isValid(target) && !isIgnoredTarget(target)) faceTarget(bot, target);
        if (tick >= state.endTick || !target || !isValid(target)) finishAxeAttack(bot, state);
        return;
    }

    // Axe mode is only a short shield-disabling window. It cannot interrupt
    // crystal placement, bridging, mace timing, wind charges, or a rod cast.
    if (isCrystalBusy(bot) || isBridgeBusy(bot) || isMaceBusy(bot) ||
        isWindChargeBusy(bot) || isRodBusy(bot)) return;

    const target = getNearestTarget(bot, PVP_CONFIG.axe.maximumDistance);
    if (!target) return;
    const shielding = isTargetShielding(target);
    if (!shielding) {
        state.handledTargetId = null;
        return;
    }
    if (state.handledTargetId === target.id) return;
    const distance = horizontalDistance(bot.location, target.location);
    if (distance < 2.0 || distance > PVP_CONFIG.axe.maximumDistance) return;

    startAxeAttack(bot, target, tick);
}

function finishRodAction(bot, state) {
    setPvpActionActive(bot, false);
    restoreWeapon(bot);
    state.phase = "cooldown";
    state.cooldownUntil = system.currentTick + PVP_CONFIG.rod.cooldownTicks;
    state.targetId = null;
}

function applyRodKnockback(bot, target) {
    if (!isValid(target)) return;
    try {
        const direction = getDirection(bot.location, target.location);
        target.applyKnockback(direction.x, direction.z, 0.18, 0.04);
    } catch (error) {}
}

function startRodAction(bot, target, tick) {
    const state = rodStates.get(bot.id) || {
        phase: "idle",
        cooldownUntil: 0,
        targetId: null,
        impactTick: 0,
        endTick: 0,
        didImpact: false
    };
    state.phase = "active";
    state.targetId = target.id;
    state.impactTick = tick + 1;
    state.endTick = tick + PVP_CONFIG.rod.activeTicks;
    state.didImpact = false;
    rodStates.set(bot.id, state);
    setPvpActionActive(bot, true);
    equipItem(bot, "minecraft:fishing_rod");
    faceTarget(bot, target);
}

function updateRodBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.rod.enabled || isIgnoredBot(bot)) {
        const state = rodStates.get(bot.id);
        if (state && state.phase === "active") finishRodAction(bot, state);
        return;
    }

    let state = rodStates.get(bot.id);
    if (!state) {
        state = {
            phase: "idle",
            cooldownUntil: 0,
            targetId: null,
            impactTick: 0,
            endTick: 0,
            didImpact: false
        };
        rodStates.set(bot.id, state);
    }

    if (state.phase === "cooldown") {
        if (tick >= state.cooldownUntil) state.phase = "idle";
        else return;
    }

    if (state.phase === "active") {
        const target = getEntityById(state.targetId);
        if (target && isValid(target) && !isIgnoredTarget(target)) {
            faceTarget(bot, target);
            if (!state.didImpact && tick >= state.impactTick) {
                applyRodKnockback(bot, target);
                state.didImpact = true;
            }
        }
        if (tick >= state.endTick || !target || !isValid(target)) finishRodAction(bot, state);
        return;
    }

    if (isCrystalBusy(bot) || isBridgeBusy(bot) || isMaceBusy(bot) ||
        isWindChargeBusy(bot) || isAxeBusy(bot)) return;

    const target = getNearestTarget(bot, PVP_CONFIG.rod.maximumDistance);
    if (!target || isTargetShielding(target)) return;
    const distance = horizontalDistance(bot.location, target.location);
    if (distance < PVP_CONFIG.rod.minimumDistance || distance > PVP_CONFIG.rod.maximumDistance) return;

    startRodAction(bot, target, tick);
}

function getTrapCell(bot, target) {
    const direction = getDirection(bot.location, target.location);
    const targetX = Math.floor(target.location.x + direction.x * 0.65);
    const targetY = Math.floor(target.location.y);
    const targetZ = Math.floor(target.location.z + direction.z * 0.65);
    const candidates = [
        { x: targetX, y: targetY, z: targetZ },
        { x: Math.floor(target.location.x), y: targetY, z: Math.floor(target.location.z) }
    ];

    for (const cell of candidates) {
        const existing = getBlock(bot.dimension, cell.x, cell.y, cell.z);
        const support = getBlock(bot.dimension, cell.x, cell.y - 1, cell.z);
        if (existing && isReplaceable(existing) && isSolid(support) && canReachPlacement(bot, cell)) {
            return cell;
        }
    }
    return null;
}

function updateTrapBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.trap.enabled || isIgnoredBot(bot)) return;
    if (isCrystalBusy(bot) || isBridgeBusy(bot) || isMaceBusy(bot) ||
        isWindChargeBusy(bot) || isAxeBusy(bot) || isRodBusy(bot)) return;

    const target = getNearestTarget(bot, 6.5);
    if (!target) return;
    const velocity = getEntityVelocity(target);
    const direction = getDirection(bot.location, target.location);
    const movingAway = velocity.x * direction.x + velocity.z * direction.z > 0.045;
    const lowHealth = getHealthFraction(target) <= PVP_CONFIG.trap.minimumHealthFraction;
    if (!lowHealth && !movingAway) return;

    let state = trapStates.get(bot.id);
    if (!state || state.targetId !== target.id) {
        state = { targetId: target.id, cooldownUntil: 0, placements: 0 };
        trapStates.set(bot.id, state);
    }
    if (tick < state.cooldownUntil || state.placements >= PVP_CONFIG.trap.maxPlacementsPerTarget) return;

    const cell = getTrapCell(bot, target);
    if (!cell || !runSetBlock(bot, cell, PVP_CONFIG.trap.block)) return;
    state.placements += 1;
    state.cooldownUntil = tick + PVP_CONFIG.trap.cooldownTicks;
}

function getWindChargeAt(dimension, location, radius = 2.5) {
    try {
        const projectiles = dimension.getEntities({
            type: "minecraft:wind_charge_projectile",
            location,
            maxDistance: radius
        });
        let nearest = null;
        let nearestDistance = radius;
        for (const projectile of projectiles) {
            const currentDistance = distance3d(location, projectile.location);
            if (currentDistance < nearestDistance) {
                nearest = projectile;
                nearestDistance = currentDistance;
            }
        }
        return nearest;
    } catch (error) {
        return null;
    }
}

function spawnWindCharge(dimension, location) {
    let projectile = null;
    try {
        projectile = dimension.spawnEntity("minecraft:wind_charge_projectile", location);
    } catch (error) {}

    if (!projectile) {
        try {
            dimension.runCommand(`summon wind_charge_projectile ${location.x} ${location.y} ${location.z}`);
        } catch (error) {}
        projectile = getWindChargeAt(dimension, location);
    }
    return projectile;
}

function finishWindCharge(bot, state) {
    setPvpActionActive(bot, false);
    restoreWeapon(bot);
    state.phase = "cooldown";
    state.cooldownUntil = system.currentTick + PVP_CONFIG.windCharge.cooldownTicks;
    state.targetId = null;
}

function startWindCharge(bot, target, tick) {
    const state = windChargeStates.get(bot.id) || {
        phase: "idle",
        cooldownUntil: 0,
        targetId: null,
        endTick: 0
    };
    state.phase = "active";
    state.cooldownUntil = 0;
    state.targetId = target.id;
    state.endTick = tick + PVP_CONFIG.windCharge.activeTicks;
    windChargeStates.set(bot.id, state);
    setPvpActionActive(bot, true);

    equipItem(bot, "minecraft:wind_charge");
    const direction = getDirection(bot.location, target.location);
    const start = {
        x: bot.location.x + direction.x * 0.8,
        y: bot.location.y + 1.35,
        z: bot.location.z + direction.z * 0.8
    };
    const targetPoint = PVP_CONFIG.mechanics.enabled && PVP_CONFIG.mechanics.predictedProjectiles
        ? getPredictedTargetLocation(target, 1.25, bot.location)
        : {
            x: target.location.x,
            y: target.location.y,
            z: target.location.z
        };
    targetPoint.y += 1.0;
    const dx = targetPoint.x - start.x;
    const dy = targetPoint.y - start.y;
    const dz = targetPoint.z - start.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const flight = { x: dx / length, y: dy / length, z: dz / length };

    const projectile = spawnWindCharge(bot.dimension, start);
    if (!projectile) {
        finishWindCharge(bot, state);
        return;
    }

    try {
        const yaw = Math.atan2(-flight.x, flight.z) * (180 / Math.PI);
        const pitch = -Math.atan2(flight.y, Math.sqrt(flight.x * flight.x + flight.z * flight.z)) * (180 / Math.PI);
        projectile.setRotation({ x: pitch, y: yaw });
        projectile.applyImpulse({
            x: flight.x * PVP_CONFIG.windCharge.power,
            y: flight.y * PVP_CONFIG.windCharge.power,
            z: flight.z * PVP_CONFIG.windCharge.power
        });
    } catch (error) {}
}

function updateWindChargeBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.windCharge.enabled || isIgnoredBot(bot)) {
        const activeState = windChargeStates.get(bot.id);
        if (activeState && activeState.phase === "active") finishWindCharge(bot, activeState);
        return;
    }

    let state = windChargeStates.get(bot.id);
    if (!state) {
        state = { phase: "idle", cooldownUntil: 0, targetId: null, endTick: 0 };
        windChargeStates.set(bot.id, state);
    }

    if (state.phase === "cooldown") {
        if (tick >= state.cooldownUntil) state.phase = "idle";
        else return;
    }
    if (state.phase === "active") {
        const target = getEntityById(state.targetId);
        if (target && isValid(target) && !isIgnoredTarget(target)) faceTarget(bot, target);
        if (tick >= state.endTick) finishWindCharge(bot, state);
        return;
    }

    if (isCrystalBusy(bot) || isBridgeBusy(bot) || isMaceBusy(bot) ||
        isAxeBusy(bot) || isRodBusy(bot)) return;

    const target = getNearestTarget(bot, PVP_CONFIG.windCharge.maximumDistance);
    if (!target || !isGrounded(target)) return;
    const distance = horizontalDistance(bot.location, target.location);
    if (distance < PVP_CONFIG.windCharge.minimumDistance ||
        distance > PVP_CONFIG.windCharge.maximumDistance) return;

    startWindCharge(bot, target, tick);
}

function protectBotFromCrystalExplosion(bot) {
    try {
        bot.addTag(CRYSTAL_PROTECTION_TAG);
    } catch (error) {
        try {
            bot.runCommand(`tag @s add ${CRYSTAL_PROTECTION_TAG}`);
        } catch (fallbackError) {}
    }

    // This is a short fallback for Bedrock builds that do not apply the
    // damage_sensor filter to crystal explosions consistently. It expires on
    // its own and is refreshed only when this bot is about to pop a crystal.
    try {
        bot.runCommand("effect @s resistance 1 5 true");
    } catch (error) {}

    system.runTimeout(() => {
        try {
            if (!isValid(bot)) return;
            bot.removeTag(CRYSTAL_PROTECTION_TAG);
        } catch (error) {
            try {
                if (isValid(bot)) bot.runCommand(`tag @s remove ${CRYSTAL_PROTECTION_TAG}`);
            } catch (fallbackError) {}
        }
    }, CRYSTAL_PROTECTION_TICKS);
}

function damageCrystal(crystal, bot) {
    if (!isValid(crystal)) return;

    // The tag is consumed by the damage_sensor component on bot:army21. It is
    // active before the damage call, so the bot ignores this crystal's blast
    // while players and other mobs still receive normal explosion damage.
    protectBotFromCrystalExplosion(bot);

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
    state.base = candidate.base;
    setPvpActionActive(bot, true);
    state.token += 1;
    const token = state.token;

    if (candidate.needsPlace) {
        equipBlock(bot, "minecraft:obsidian");
        if (!runSetBlock(bot, candidate.base, "minecraft:obsidian")) {
            finishCrystalCombo(bot, state);
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

            if (!canReachPlacement(bot, candidate.base)) {
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
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.crystal.enabled || isIgnoredBot(bot)) {
        const activeState = crystalStates.get(bot.id);
        if (activeState && activeState.phase !== "idle" && activeState.phase !== "cooldown") {
            finishCrystalCombo(bot, activeState);
        }
        return;
    }

    // Do not swap away from a mace, wind charge, or bridge block halfway
    // through that action. Normal sword and crystal logic resumes afterward.
    if (isBridgeBusy(bot) || isMaceBusy(bot) || isWindChargeBusy(bot) ||
        isAxeBusy(bot) || isRodBusy(bot)) return;

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

    // Only use the falling clutch when it is explicitly enabled. This avoids
    // placing a block under a bot that is simply jumping or walking normally.
    const currentCell = { x: currentX, z: currentZ };
    const currentSupport = blockAtCell(bot.dimension, currentCell, feetY - 1);
    if (!currentSupport) return null;
    if (!isSolid(currentSupport)) {
        const currentFootBlock = blockAtCell(bot.dimension, currentCell, feetY);
        if (PVP_CONFIG.bridge.clutch && currentFootBlock && isReplaceable(currentFootBlock)) {
            return { x: currentX, y: feetY - 1, z: currentZ, direction };
        }
        return null;
    }

    for (let distance = 1; distance <= 2; distance += 1) {
        const cell = {
            x: currentX + stepX * distance,
            z: currentZ + stepZ * distance
        };
        const support = blockAtCell(bot.dimension, cell, feetY - 1);
        const footBlock = blockAtCell(bot.dimension, cell, feetY);
        if (support && footBlock && !isSolid(support) && isReplaceable(footBlock)) {
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
    if (state.active) {
        setPvpActionActive(bot, false);
        restoreWeapon(bot);
    }
    state.blocks = 0;
    state.lastCell = "";
    state.stalledTicks = 0;
    state.active = false;
    state.waitingForMovement = false;
    state.lastBuildPosition = null;
    state.lastBuildTick = 0;
    state.cooldownUntil = system.currentTick + cooldownTicks;
}

function nudgeAcrossBridge(bot, target) {
    faceTarget(bot, target);
    try {
        const direction = getDirection(bot.location, target.location);
        bot.applyImpulse({
            x: direction.x * 0.035,
            y: 0.008,
            z: direction.z * 0.035
        });
    } catch (error) {}
}

function updateBridgeBot(bot, tick) {
    let state = bridgeStates.get(bot.id);
    if (!state) {
        state = {
            blocks: 0,
            lastCell: "",
            stalledTicks: 0,
            active: false,
            waitingForMovement: false,
            lastBuildPosition: null,
            lastBuildTick: 0,
            cooldownUntil: 0
        };
        bridgeStates.set(bot.id, state);
    }

    if (!PVP_CONFIG.bridge.enabled || isIgnoredBot(bot)) {
        stopBridge(bot, state);
        return;
    }
    if (isExternalActionBusy(bot)) {
        stopBridge(bot, state);
        return;
    }
    if (tick % Math.max(1, PVP_CONFIG.bridge.checkInterval) !== 0) return;
    if (tick < state.cooldownUntil) return;
    if (isCrystalBusy(bot) || isMaceBusy(bot) || isWindChargeBusy(bot) ||
        isAxeBusy(bot) || isRodBusy(bot)) return;

    const target = getNearestTarget(bot, PVP_CONFIG.bridge.targetDistance);
    if (!target || !isBridgeNeeded(bot, target)) {
        stopBridge(bot, state);
        return;
    }
    if (state.blocks >= PVP_CONFIG.bridge.maxBlocksPerBridge) {
        stopBridge(bot, state, 100);
        return;
    }

    // Never queue another block just because the bot has not moved yet. The
    // old loop filled an entire 48-block runway while the bot was stuck at one
    // edge. A human places the next block only after stepping forward.
    if (state.waitingForMovement && state.lastBuildPosition) {
        const moved = horizontalDistance(bot.location, state.lastBuildPosition);
        if (moved < 0.65) {
            if (tick - state.lastBuildTick > 30) {
                stopBridge(bot, state, 40);
                return;
            }
            nudgeAcrossBridge(bot, target);
            return;
        }
        state.waitingForMovement = false;
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
    if (!runSetBlock(bot, placement, PVP_CONFIG.bridge.block)) {
        stopBridge(bot, state, 40);
        return;
    }

    state.blocks += 1;
    state.active = true;
    setPvpActionActive(bot, true);
    state.waitingForMovement = true;
    state.lastBuildPosition = { x: bot.location.x, z: bot.location.z };
    state.lastBuildTick = tick;
    nudgeAcrossBridge(bot, target);
}

function updateClutch(bot) {
    if (!PVP_CONFIG.bridge.enabled || !PVP_CONFIG.bridge.clutch) return;
    const bridgeState = bridgeStates.get(bot.id);
    if (!bridgeState || !bridgeState.active) return;
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

function applySprintReset(attacker, victim) {
    if (!PVP_CONFIG.mechanics.enabled || !PVP_CONFIG.mechanics.sprintReset ||
        !isValid(attacker) || !isValid(victim)) return;
    if (isMaceBusy(attacker) || isWindChargeBusy(attacker) || isAxeBusy(attacker) ||
        isRodBusy(attacker) || isCrystalBusy(attacker) || isBridgeBusy(attacker) ||
        isExternalActionBusy(attacker)) return;

    const direction = getDirection(attacker.location, victim.location);
    try {
        // Bedrock script cannot inject a literal W/S key press. A tiny
        // backward impulse followed by a forward impulse is the safe server
        // side equivalent and leaves native melee responsible for damage.
        attacker.applyImpulse({
            x: -direction.x * 0.032,
            y: 0,
            z: -direction.z * 0.032
        });
    } catch (error) {}

    system.runTimeout(() => {
        if (!isValid(attacker) || !isValid(victim)) return;
        if (isMaceBusy(attacker) || isWindChargeBusy(attacker) || isAxeBusy(attacker) ||
            isRodBusy(attacker) || isCrystalBusy(attacker) || isBridgeBusy(attacker) ||
            isExternalActionBusy(attacker)) return;
        try {
            const nextDirection = getDirection(attacker.location, victim.location);
            attacker.applyImpulse({
                x: nextDirection.x * 0.042,
                y: 0,
                z: nextDirection.z * 0.042
            });
        } catch (error) {}
    }, 1);
}

function updateCombatBot(bot, tick) {
    if (isExternalActionBusy(bot)) return;
    if (!PVP_CONFIG.combat.enabled) return;
    if (tick % Math.max(1, PVP_CONFIG.combat.checkInterval) !== 0) return;
    if (isIgnoredBot(bot)) return;

    let state = combatStates.get(bot.id);
    let target = state && state.targetId ? getEntityById(state.targetId) : null;
    if (!target || !isValid(target) || isIgnoredTarget(target) ||
        distance3d(bot.location, target.location) > PVP_CONFIG.combat.targetDistance) {
        target = getNearestTarget(bot, PVP_CONFIG.combat.targetDistance);
    }
    if (!target) {
        combatStates.delete(bot.id);
        return;
    }

    if (!state) {
        state = {
            targetId: target.id,
            strafeSign: Math.random() < 0.5 ? -1 : 1,
            switchTick: tick,
            engageAfterTick: tick + (PVP_CONFIG.mechanics.enabled && PVP_CONFIG.mechanics.hitSelect ? 3 : 0),
            counterUntil: 0
        };
        combatStates.set(bot.id, state);
    }
    if (state.targetId !== target.id) {
        state.targetId = target.id;
        state.switchTick = tick;
        state.engageAfterTick = tick + (PVP_CONFIG.mechanics.enabled && PVP_CONFIG.mechanics.hitSelect ? 3 : 0);
        state.counterUntil = 0;
    }
    if (PVP_CONFIG.combat.strafe && tick - state.switchTick >= PVP_CONFIG.combat.strafeSwitchTicks) {
        state.strafeSign *= -1;
        state.switchTick = tick;
    }

    faceTarget(bot, target);
    const specialBusy = isSpecialActionBusy(bot);
    if (specialBusy) return;

    if (!isBridgeBusy(bot) && tick % 40 === 0) {
        // Recover the normal sword after a completed special attack and make
        // sure native melee AI always has its usual weapon available.
        restoreWeapon(bot);
    }

    // Hit-select is represented as a short movement/approach delay. Native
    // Bedrock target acquisition remains in charge of the actual attack, so
    // this does not inject client clicks or duplicate melee damage.
    if (PVP_CONFIG.mechanics.enabled && PVP_CONFIG.mechanics.hitSelect && tick < (state.engageAfterTick || 0)) return;

    const direction = getDirection(bot.location, target.location);
    const distance = horizontalDistance(bot.location, target.location);
    const countering = tick < (state.counterUntil || 0);
    let forward = 0;
    if (distance > 4.2) forward = PVP_CONFIG.combat.forwardImpulse;
    if (distance < 2.1 && !countering) forward = -PVP_CONFIG.combat.retreatImpulse;
    if (countering) forward = Math.max(forward, 0.045);

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

world.afterEvents.entityHitEntity.subscribe(event => {
    const attacker = event.damagingEntity;
    const victim = event.hitEntity;
    if (!attacker || !victim) return;

    if (attacker.typeId && attacker.typeId.startsWith("bot:") &&
        victim.typeId === "minecraft:player") {
        applySprintReset(attacker, victim);
    }

    const state = maceStates.get(attacker.id);
    if (!state || state.phase !== "active" || state.didSmash) return;
    if (state.targetId !== victim.id || system.currentTick < state.canSmashAfterTick) return;

    let descending = false;
    try {
        const velocity = attacker.getVelocity();
        descending = !!velocity && velocity.y < -0.05;
    } catch (error) {}
    if (!descending && !state.wasAirborne) return;

    applyMaceSmash(attacker, victim, state);
});

try {
    world.afterEvents.entityHurt.subscribe(event => {
        const bot = event.hurtEntity;
        if (!bot || !bot.typeId || !bot.typeId.startsWith("bot:") || !isValid(bot)) return;

        if (PVP_CONFIG.mechanics.enabled && PVP_CONFIG.mechanics.jumpReset) {
            try {
                const velocity = getEntityVelocity(bot);
                if (bot.isOnGround !== false && velocity.y < 0.12) {
                    // Jump-reset is a small upward impulse after a confirmed
                    // hurt event, not a permanent flight or random jump loop.
                    bot.applyImpulse({ x: 0, y: 0.34, z: 0 });
                }
            } catch (error) {}
        }

        const damageSource = event.damageSource || {};
        const attacker = damageSource.damagingEntity || event.damagingEntity;
        if (!attacker || attacker.typeId !== "minecraft:player" || isIgnoredTarget(attacker)) return;

        let state = combatStates.get(bot.id);
        if (!state) {
            state = {
                targetId: attacker.id,
                strafeSign: Math.random() < 0.5 ? -1 : 1,
                switchTick: system.currentTick,
                engageAfterTick: system.currentTick,
                counterUntil: system.currentTick + 10
            };
            combatStates.set(bot.id, state);
        } else {
            state.targetId = attacker.id;
            state.engageAfterTick = system.currentTick;
            state.counterUntil = system.currentTick + 10;
            state.strafeSign *= -1;
        }
    });
} catch (error) {}

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
    for (const id of maceStates.keys()) {
        if (!activeIds.has(id)) maceStates.delete(id);
    }
    for (const id of windChargeStates.keys()) {
        if (!activeIds.has(id)) windChargeStates.delete(id);
    }
    for (const id of axeStates.keys()) {
        if (!activeIds.has(id)) axeStates.delete(id);
    }
    for (const id of rodStates.keys()) {
        if (!activeIds.has(id)) rodStates.delete(id);
    }
    for (const id of trapStates.keys()) {
        if (!activeIds.has(id)) trapStates.delete(id);
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
                const tick = system.currentTick;
                // Movement/utility priorities run before weapon selection. Each
                // state machine refuses to interrupt an action already in
                // progress, so the bot returns to native sword AI cleanly.
                updateBridgeBot(bot, tick);
                updateClutch(bot);
                updateAxeBot(bot, tick);
                updateRodBot(bot, tick);
                updateTrapBot(bot, tick);
                updateMaceBot(bot, tick);
                updateWindChargeBot(bot, tick);
                updateCrystalBot(bot, tick);
                updateCombatBot(bot, tick);
            }
        } catch (error) {}
    }
}, 1);

system.runInterval(cleanupStates, 200);

try {
    world.afterEvents.entityDie.subscribe(event => {
        const id = event.deadEntity.id;
        crystalStates.delete(id);
        maceStates.delete(id);
        windChargeStates.delete(id);
        axeStates.delete(id);
        rodStates.delete(id);
        trapStates.delete(id);
        bridgeStates.delete(id);
        combatStates.delete(id);
    });
    world.afterEvents.entityRemove.subscribe(event => {
        const id = event.removedEntityId;
        crystalStates.delete(id);
        maceStates.delete(id);
        windChargeStates.delete(id);
        axeStates.delete(id);
        rodStates.delete(id);
        trapStates.delete(id);
        bridgeStates.delete(id);
        combatStates.delete(id);
    });
} catch (error) {}
