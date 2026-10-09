import { world, system } from "@minecraft/server";
import { isPlayerAllowedTarget } from "./targeting";

/*
 * Consumable training for custom bots.
 *
 * The entity has a real inventory and a native drink_potion goal in
 * custom.json. This module seeds the inventory, keeps a totem ready in the
 * offhand, and provides a guarded server-side fallback for runtimes where a
 * custom entity does not execute the native drink goal or totem animation.
 * It never injects client clicks: a potion is equipped, its real effects are
 * applied server-side, the consumed reserve slot is cleared, and the normal
 * weapon is restored.
 */

const BOT_TYPES = new Set(["bot:army21"]);
const READY_TAG = "bot_consumables_ready";
const ACTIVE_TAG = "pvp_consumable_active";
const SPECIAL_TAG = "pvp_special_active";
const PEARL_TAG = "pvp_pearl_active";
const TOTEM_ID = "minecraft:totem_of_undying";
const POTION_ID = "minecraft:potion";
const TOTAL_TOTEMS = 200;
const TOTEM_RESERVE_SLOTS = Array.from({ length: TOTAL_TOTEMS - 1 }, (_, index) => index);
const POTION_RESERVES = {
    healing: [199, 200],
    speed: [201, 202],
    fireResistance: [203],
    strength: [204]
};

const POTIONS = {
    healing: {
        data: 21,
        cooldownTicks: 70,
        durationTicks: 8,
        effects: [
            "effect @s instant_health 1 1 true",
            "effect @s regeneration 60 1 true"
        ]
    },
    speed: {
        data: 14,
        cooldownTicks: 180,
        durationTicks: 6,
        effects: [
            "effect @s speed 160 1 true"
        ]
    },
    fireResistance: {
        data: 12,
        cooldownTicks: 220,
        durationTicks: 6,
        effects: [
            "effect @s fire_resistance 300 0 true"
        ]
    },
    strength: {
        data: 31,
        cooldownTicks: 180,
        durationTicks: 6,
        effects: [
            "effect @s strength 160 0 true"
        ]
    }
};

const states = new Map();

function isValid(entity) {
    try {
        return !!entity && entity.isValid();
    } catch (error) {
        return false;
    }
}

function isBot(entity) {
    return !!entity && BOT_TYPES.has(entity.typeId);
}

function hasTag(entity, tag) {
    try {
        return entity.hasTag(tag);
    } catch (error) {
        return false;
    }
}

function runCommand(entity, command) {
    try {
        entity.runCommand(command);
        return true;
    } catch (error) {
        return false;
    }
}

function getInventory(entity) {
    try {
        const component = entity.getComponent("minecraft:inventory") || entity.getComponent("inventory");
        return component && component.container ? component.container : null;
    } catch (error) {
        return null;
    }
}

function getOffhandId(entity) {
    try {
        const component = entity.getComponent("minecraft:equippable") || entity.getComponent("equippable");
        if (!component) return "";
        for (const slot of ["Offhand", "offhand"]) {
            try {
                const item = component.getEquipment(slot);
                if (item && item.typeId) return item.typeId;
            } catch (error) {}
        }
    } catch (error) {}
    return "";
}

function clearInventorySlot(entity, slot) {
    const inventory = getInventory(entity);
    try {
        if (inventory && slot >= 0 && slot < inventory.size) {
            inventory.setItem(slot, undefined);
            return true;
        }
    } catch (error) {}
    return runCommand(entity, `replaceitem entity @s slot.inventory ${slot} air 0`);
}

function restoreWeapon(entity) {
    try {
        const tags = entity.getTags();
        const functionName = tags.includes("diamond_level") && !tags.includes("netherite_level")
            ? "sword3"
            : "sword1";
        runCommand(entity, `function ${functionName}`);
    } catch (error) {
        runCommand(entity, "function sword1");
    }
}

function createState(entity) {
    const state = {
        initialized: hasTag(entity, READY_TAG),
        active: false,
        activeUntil: 0,
        cooldowns: new Map(),
        lastTotemTick: -1000,
        lastHealth: 80,
        offhandReady: hasTag(entity, READY_TAG)
    };
    states.set(entity.id, state);
    return state;
}

function getState(entity) {
    return states.get(entity.id) || createState(entity);
}

function seedConsumables(entity, state) {
    if (!isValid(entity) || state.initialized) return;

    // The function keeps the exact total at two hundred: 199 separate reserve
    // slots plus one offhand totem. It also gives native drink_potion real
    // item stacks.
    const seeded = runCommand(entity, "function bot_consumables");
    if (!seeded) {
        // Keep a useful fallback for worlds whose command parser rejects the
        // function call while still allowing the script inventory component to
        // hold the same supplies.
        for (const slot of TOTEM_RESERVE_SLOTS) {
            runCommand(entity, `replaceitem entity @s slot.inventory ${slot} ${TOTEM_ID} 1`);
        }
        runCommand(entity, `replaceitem entity @s slot.weapon.offhand 0 ${TOTEM_ID} 1`);
        runCommand(entity, `replaceitem entity @s slot.inventory 199 ${POTION_ID} 1 21`);
        runCommand(entity, `replaceitem entity @s slot.inventory 200 ${POTION_ID} 1 21`);
        runCommand(entity, `replaceitem entity @s slot.inventory 201 ${POTION_ID} 1 14`);
        runCommand(entity, `replaceitem entity @s slot.inventory 202 ${POTION_ID} 1 14`);
        runCommand(entity, `replaceitem entity @s slot.inventory 203 ${POTION_ID} 1 12`);
        runCommand(entity, `replaceitem entity @s slot.inventory 204 ${POTION_ID} 1 31`);
    }
    try { entity.addTag(READY_TAG); } catch (error) {}
    state.initialized = true;
    state.offhandReady = true;
    system.runTimeout(() => restoreTotemToOffhand(entity), 2);
}

function restoreTotemToOffhand(entity) {
    if (!isValid(entity) || hasTag(entity, "shield_active")) return false;
    const state = getState(entity);
    const offhand = getOffhandId(entity);
    if (offhand === "minecraft:shield") return false;
    if (offhand === TOTEM_ID || (!offhand && state.offhandReady)) return true;

    const inventory = getInventory(entity);
    if (inventory) {
        for (const slot of TOTEM_RESERVE_SLOTS) {
            try {
                const item = inventory.getItem(slot);
                if (!item || item.typeId !== TOTEM_ID) continue;
                if (runCommand(entity, `replaceitem entity @s slot.weapon.offhand 0 ${TOTEM_ID} 1`)) {
                    clearInventorySlot(entity, slot);
                    state.offhandReady = true;
                    return true;
                }
            } catch (error) {}
        }
    }
    return false;
}

function findPotionSlot(entity, potionName) {
    const inventory = getInventory(entity);
    if (!inventory) return -1;
    for (const slot of POTION_RESERVES[potionName] || []) {
        try {
            const item = inventory.getItem(slot);
            if (item && item.typeId === POTION_ID) return slot;
        } catch (error) {}
    }
    return -1;
}

function getHealthValue(entity) {
    try {
        const health = entity.getComponent("minecraft:health");
        return health ? health.currentValue : 80;
    } catch (error) {
        return 80;
    }
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

function hasEffect(entity, effectName) {
    try {
        return !!entity.getEffect(effectName);
    } catch (error) {
        return false;
    }
}

function getNearestTarget(entity) {
    try {
        const entities = entity.dimension.getEntities({
            type: "minecraft:player",
            location: entity.location,
            maxDistance: 24
        });
        let nearest = null;
        let nearestDistance = Infinity;
        for (const target of entities) {
            if (!isValid(target) || hasTag(target, "pvp_ignore") || hasTag(target, "bot_ignore")) continue;
            try {
                if (target.getGameMode && target.getGameMode() === "creative") continue;
                if (!isPlayerAllowedTarget(target.name)) continue;
            } catch (error) {}
            let distance;
            try {
                const dx = target.location.x - entity.location.x;
                const dz = target.location.z - entity.location.z;
                distance = Math.sqrt(dx * dx + dz * dz);
            } catch (error) {
                continue;
            }
            if (distance < nearestDistance) {
                nearest = target;
                nearestDistance = distance;
            }
        }
        return nearest ? { entity: nearest, distance: nearestDistance } : null;
    } catch (error) {
        return null;
    }
}

function isOnFire(entity) {
    try {
        return entity.isOnFire === true;
    } catch (error) {
        return false;
    }
}

function isPotionAvailable(entity, potionName) {
    return findPotionSlot(entity, potionName) >= 0;
}

function usePotion(entity, potionName, tick) {
    const potion = POTIONS[potionName];
    const state = getState(entity);
    if (!potion || state.active || hasTag(entity, SPECIAL_TAG) || hasTag(entity, PEARL_TAG) || hasTag(entity, ACTIVE_TAG)) return false;
    if (tick < (state.cooldowns.get(potionName) || 0)) return false;

    const reserveSlot = findPotionSlot(entity, potionName);
    if (reserveSlot < 0) return false;

    state.active = true;
    state.activeUntil = tick + potion.durationTicks;
    state.cooldowns.set(potionName, tick + potion.cooldownTicks);
    try { entity.addTag(ACTIVE_TAG); } catch (error) {}

    // Equip the actual potion variant so the animation/native item path is
    // visible, then apply the same effect server-side for custom entities that
    // do not execute player input or the native drink goal.
    runCommand(entity, `replaceitem entity @s slot.weapon.mainhand 0 ${POTION_ID} 1 ${potion.data}`);
    for (const command of potion.effects) runCommand(entity, command);
    runCommand(entity, "playsound random.drink @a ~~~");
    runCommand(entity, "particle minecraft:mobspell_emitter ~ ~1 ~");

    system.runTimeout(() => {
        try {
            if (isValid(entity)) {
                clearInventorySlot(entity, reserveSlot);
                runCommand(entity, "replaceitem entity @s slot.weapon.mainhand 0 air 0");
                restoreWeapon(entity);
            }
        } catch (error) {}
        try { entity.removeTag(ACTIVE_TAG); } catch (error) {}
        state.active = false;
        state.activeUntil = 0;
    }, potion.durationTicks);
    return true;
}

function consumeFallbackTotem(entity) {
    const state = getState(entity);
    const offhand = getOffhandId(entity);
    if (state.offhandReady || offhand === TOTEM_ID) {
        state.offhandReady = false;
        // Clearing an already-consumed offhand is harmless and avoids taking a
        // second reserve item when native Bedrock handled the totem first.
        if (runCommand(entity, "replaceitem entity @s slot.weapon.offhand 0 air 0")) return true;
    }

    const inventory = getInventory(entity);
    if (!inventory) return false;
    for (const slot of TOTEM_RESERVE_SLOTS) {
        try {
            const item = inventory.getItem(slot);
            if (item && item.typeId === TOTEM_ID) return clearInventorySlot(entity, slot);
        } catch (error) {}
    }
    return false;
}

function applyFallbackTotem(entity, event) {
    const state = getState(entity);
    if (system.currentTick - state.lastTotemTick < 2) return;

    let health;
    try {
        health = entity.getComponent("minecraft:health");
        if (!health) return;
    } catch (error) {
        return;
    }

    const incomingDamage = Number(event && event.damage) || 0;
    const likelyLethal = health.currentValue <= 0.1 ||
        (state.lastHealth > 0 && incomingDamage >= state.lastHealth - 0.1);
    if (!likelyLethal) {
        state.lastHealth = health.currentValue;
        return;
    }

    // Native Bedrock normally consumes the offhand totem first. If it already
    // rescued this custom entity, just mark the offhand as consumed and refill
    // it from the reserve. Otherwise consume the offhand/reserve here before
    // restoring enough health to keep the entity alive.
    if (health.currentValue > 0.1) {
        state.offhandReady = false;
        system.runTimeout(() => restoreTotemToOffhand(entity), 1);
        state.lastHealth = health.currentValue;
        return;
    }
    if (!consumeFallbackTotem(entity)) return;
    state.lastTotemTick = system.currentTick;
    try {
        health.setCurrentValue(Math.max(1, Math.min(health.effectiveMax, health.effectiveMax * 0.45)));
    } catch (error) {
        return;
    }
    runCommand(entity, "effect @s regeneration 100 1 true");
    runCommand(entity, "effect @s absorption 100 1 true");
    runCommand(entity, "effect @s fire_resistance 160 0 true");
    runCommand(entity, "playsound random.totem @a ~~~");
    runCommand(entity, "particle minecraft:totem_particle ~ ~1 ~");
    state.lastHealth = health.currentValue;
    system.runTimeout(() => restoreTotemToOffhand(entity), 1);
}

function updateBot(entity, tick) {
    if (!isValid(entity)) return;
    const state = getState(entity);
    const currentHealth = getHealthValue(entity);
    if (currentHealth > 0) state.lastHealth = currentHealth;
    seedConsumables(entity, state);
    if (state.active) {
        if (tick >= state.activeUntil) {
            state.active = false;
            try { entity.removeTag(ACTIVE_TAG); } catch (error) {}
        }
        return;
    }

    if (tick % 10 === 0 && !hasTag(entity, SPECIAL_TAG) && !hasTag(entity, PEARL_TAG) && !hasTag(entity, "shield_active")) {
        const health = getHealthFraction(entity);
        if (health <= 0.55 && usePotion(entity, "healing", tick)) return;

        const target = getNearestTarget(entity);
        if (isOnFire(entity) && !hasEffect(entity, "fire_resistance") && usePotion(entity, "fireResistance", tick)) return;
        if (target && target.distance >= 6 && !hasEffect(entity, "speed") && usePotion(entity, "speed", tick)) return;
        if (target && target.distance <= 6 && !hasEffect(entity, "strength") && usePotion(entity, "strength", tick)) return;
    }

    // A totem is kept in the offhand after native activation or a shield use.
    if (tick % 5 === 0 && !hasTag(entity, "shield_active")) restoreTotemToOffhand(entity);
}

try {
    world.afterEvents.entitySpawn.subscribe(event => {
        if (!isBot(event.entity)) return;
        const state = getState(event.entity);
        system.runTimeout(() => seedConsumables(event.entity, state), 2);
    });
} catch (error) {}

try {
    world.afterEvents.entityHurt.subscribe(event => {
        const entity = event.hurtEntity;
        if (isBot(entity)) applyFallbackTotem(entity, event);
    });
} catch (error) {}

try {
    world.afterEvents.entityDie.subscribe(event => {
        states.delete(event.deadEntity.id);
    });
    world.afterEvents.entityRemove.subscribe(event => {
        states.delete(event.removedEntityId);
    });
} catch (error) {}

system.runInterval(() => {
    for (const botType of BOT_TYPES) {
        for (const dimensionId of ["overworld", "nether", "the_end"]) {
            try {
                const dimension = world.getDimension(dimensionId);
                for (const entity of dimension.getEntities({ type: botType })) updateBot(entity, system.currentTick);
            } catch (error) {}
        }
    }
}, 1);
