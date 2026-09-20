import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const SCRIPT_CONFIGS = {};

import "./custom/crit";
import "./custom/names";
import "./custom/death";
import "./custom/spread";
import "./custom/script1";
import { PVP_CONFIG } from "./custom/pvp";
import { showMiniGamesMenu } from "./custom/minigames";
import {
    TARGET_CONFIG,
    isPlayerAllowedTarget,
    getOnlinePlayerNames
} from "./custom/targeting";

(function() {
    const HEAL_BOTS = [
        "bot:army21"
    ];

    const HEAL_FUNCTION = "heal";
    const HEAL_PARTICLE_COMMAND = "particle bot:eat_golden_apple ~ ~1.5 ~";
    const HEAL_TRIGGER = 12;
    const HEAL_SETTINGS = { cooldownSeconds: 1.9 };
    const HEAL_PARTICLE_DURATION = 30;
    const HEAL_NOATTACK_DURATION = 40;
    const HEAL_NOATTACK_EVENT = "bot:start_heal";
    const HEAL_RESUME_ATTACK_EVENT = "bot:end_heal";

    const HEAL_SWORD_FUNCTIONS = {
        "bot:army21": "sword1"
    };

    const HEAL_LEVEL_SWORD_FUNCTIONS = {
        "diamond_level": "sword3",
        "netherite_level": "sword1"
    };

    const HEAL_CHANCE = {
        "bot:army21": 0.1
    };

    SCRIPT_CONFIGS.heal = { chance: HEAL_CHANCE, settings: HEAL_SETTINGS };

    const healCooldowns = new Map();
    const healSwordTimers = new Map();
    const isHealingMap = new Map();

    function getHealChance(botType) { return HEAL_CHANCE[botType] || 0.6; }
    function isHealOnCooldown(botId) {
        const lastRun = healCooldowns.get(botId);
        if (!lastRun) return false;
        return (system.currentTick - lastRun) < HEAL_SETTINGS.cooldownSeconds * 20;
    }
    function setHealCooldown(botId) { healCooldowns.set(botId, system.currentTick); }
    function getHealBotHealth(bot) {
        try {
            const healthComp = bot.getComponent("health");
            return healthComp ? healthComp.currentValue : 20;
        } catch { return 20; }
    }
    function spawnHealParticle(bot) {
        try { bot.runCommand(HEAL_PARTICLE_COMMAND); } catch(e) {}
    }

    function disableHealAttack(bot) {
        try {
            const botType = bot.typeId;
            const namespace = botType.replace("bot:", "");
            bot.triggerEvent(HEAL_NOATTACK_EVENT);
            try { bot.triggerEvent(`${namespace}:start_heal`); } catch(e) {}
            isHealingMap.set(bot.id, true);
        } catch(e) {}
    }

    function resumeHealAttack(bot) {
        try {
            const botType = bot.typeId;
            const namespace = botType.replace("bot:", "");
            bot.triggerEvent(HEAL_RESUME_ATTACK_EVENT);
            try { bot.triggerEvent(`${namespace}:end_heal`); } catch(e) {}
            isHealingMap.delete(bot.id);
        } catch(e) {}
    }

    function runHeal(bot) {
        try {
            disableHealAttack(bot);
            bot.runCommand(`function ${HEAL_FUNCTION}`);
            setHealCooldown(bot.id);
            for (let i = 0; i < HEAL_PARTICLE_DURATION; i += 5) {
                system.runTimeout(() => {
                    try { if (bot.isValid()) { spawnHealParticle(bot); } } catch(e) {}
                }, i);
            }
            scheduleHealAttackResume(bot.id, bot);
        } catch(e) {
            isHealingMap.delete(bot.id);
        }
    }

    function getHealLevelSword(bot) {
        try {
            const tags = bot.getTags();
            if (tags.includes("netherite_level")) {
                return HEAL_LEVEL_SWORD_FUNCTIONS["netherite_level"];
            }
            if (tags.includes("diamond_level")) {
                return HEAL_LEVEL_SWORD_FUNCTIONS["diamond_level"];
            }
        } catch (e) {}
        return null;
    }

    function runHealSword(bot) {
        const botType = bot.typeId;
        const levelSword = getHealLevelSword(bot);
        const swordFunction = levelSword || HEAL_SWORD_FUNCTIONS[botType] || "sword1";
        try { bot.runCommand(`function ${swordFunction}`); } catch(e) {}
    }

    function scheduleHealAttackResume(botId, bot) {
        const existingTimer = healSwordTimers.get(botId);
        if (existingTimer) { system.clearRun(existingTimer); }
        healSwordTimers.set(botId, system.runTimeout(() => {
            try {
                if (bot.isValid()) {
                    resumeHealAttack(bot);
                    runHealSword(bot);
                }
            } catch(e) {}
            healSwordTimers.delete(botId);
            isHealingMap.delete(botId);
        }, HEAL_NOATTACK_DURATION));
    }

    function isBotHealing(botId) { return isHealingMap.get(botId) || false; }

    system.runInterval(() => {
        for (const botType of HEAL_BOTS) {
            try {
                const bots = world.getDimension("overworld").getEntities({ type: botType });
                for (const bot of bots) {
                    if (!bot.isValid()) continue;
                    const botId = bot.id;
                    if (isBotHealing(botId)) {
                    }
                }
            } catch(e) {}
        }
    }, 5);

    system.runInterval(() => {
        for (const botType of HEAL_BOTS) {
            try {
                const bots = world.getDimension("overworld").getEntities({ type: botType });
                for (const bot of bots) {
                    if (!bot.isValid()) continue;
                    const botId = bot.id;
                    if (isBotHealing(botId)) continue;
                    const health = getHealBotHealth(bot);
                    if (isHealOnCooldown(botId)) continue;
                    if (health > HEAL_TRIGGER) continue;
                    if (Math.random() > getHealChance(botType)) continue;
                    runHeal(bot);
                }
            } catch(e) {}
        }
    }, 10);

    world.afterEvents.entityRemove.subscribe((event) => {
        const entityId = event.removedEntityId;
        healCooldowns.delete(entityId);
        isHealingMap.delete(entityId);
        const timer = healSwordTimers.get(entityId);
        if (timer) { system.clearRun(timer); healSwordTimers.delete(entityId); }
    });

    system.runInterval(() => {
        const currentTick = system.currentTick;
        for (const [botId, healStartTime] of healCooldowns) {
            if (currentTick - healStartTime > 200) {
                if (isHealingMap.has(botId)) {
                    try {
                        const bot = world.getEntity(botId);
                        if (bot && bot.isValid()) {
                            resumeHealAttack(bot);
                            runHealSword(bot);
                        }
                    } catch(e) {}
                    isHealingMap.delete(botId);
                }
            }
        }
    }, 100);
})();

(function() {
    const SHIELD_CONFIG = {
        BOTS: ["bot:army21"],
        SHIELD_FUNCTION: {
            "bot:army21": "shield1"
        },
        SHIELD_CHANCE: {
            "bot:army21": 0.1
        },
        SHIELD_COOLDOWN: {
            "bot:army21": { min: 50, max: 100 }
        },
        ENEMIES: {
            "bot:army21": [
                "minecraft:player"
            ]
        },
        CHECK_INTERVAL: 10,
        TRIGGER_DISTANCE_MIN: 1,
        TRIGGER_DISTANCE_MAX: 4
    };

    SCRIPT_CONFIGS.shield = SHIELD_CONFIG;

    const shieldCooldownMap = new Map();

    function getRandomShieldCooldown(botType) {
        const cooldown = SHIELD_CONFIG.SHIELD_COOLDOWN[botType] || { min: 40, max: 100 };
        return cooldown.min + Math.floor(Math.random() * (cooldown.max - cooldown.min));
    }

    function setShieldCooldown(entityId, botType, tick) {
        const duration = getRandomShieldCooldown(botType);
        shieldCooldownMap.set(entityId, { startTick: tick, duration: duration });
    }

    function isShieldOnCooldown(entityId, tick) {
        const data = shieldCooldownMap.get(entityId);
        if (!data) return false;
        return (data.startTick + data.duration) - tick > 0;
    }

    function getShieldFunction(botType) { 
        return SHIELD_CONFIG.SHIELD_FUNCTION[botType] || "shield1"; 
    }

    function getShieldChance(botType) { 
        return SHIELD_CONFIG.SHIELD_CHANCE[botType] || 0.3; 
    }

    function getDistanceToTarget(a, b) {
        const dx = b.location.x - a.location.x;
        const dz = b.location.z - a.location.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    function getEventNamespace(botType) { 
        return botType.replace("bot:", ""); 
    }

    function executeShield(bot) {
        const botType = bot.typeId;
        const shieldFunction = getShieldFunction(botType);
        const namespace = getEventNamespace(botType);
    
        try { 
            bot.runCommand(`event entity @s ${namespace}:try_shield`);
            bot.runCommand(`function ${shieldFunction}`);
        } catch (e) {
            try { bot.runCommand(`function ${shieldFunction}`); } catch (e2) {}
        }
    
        system.runTimeout(() => {
            try {
                if (bot.isValid()) { 
                    bot.runCommand(`event entity @s ${namespace}:shield_end`);
                }
            } catch (e) {}
        }, 20);
    }

    world.afterEvents.entityHurt.subscribe((event) => {
        const victim = event.hurtEntity;
        const attacker = event.damageSource.damagingEntity;
    
        if (!attacker) return;
    
        const botTypes = ["bot:army21"];
        if (!botTypes.includes(attacker.typeId)) return;
    
        const attackerType = attacker.typeId;
    
        const enemyTypes = SHIELD_CONFIG.ENEMIES[attackerType] || [];
        let isEnemy = false;
    
        for (const enemyType of enemyTypes) {
            if (victim.typeId === enemyType || victim.typeId.includes(enemyType)) {
                isEnemy = true;
                break;
            }
        }
    
        if (!isEnemy) return;
    
        if (victim.typeId === "minecraft:player") {
            const playerName = victim.name;
            if (!isPlayerAllowedTarget(playerName)) return;
        }
    
        const dist = getDistanceToTarget(attacker, victim);
        if (dist < SHIELD_CONFIG.TRIGGER_DISTANCE_MIN || dist > SHIELD_CONFIG.TRIGGER_DISTANCE_MAX) return;
    
        if (isShieldOnCooldown(attacker.id, system.currentTick)) return;
    
        if (Math.random() < getShieldChance(attackerType)) {
            executeShield(attacker);
            setShieldCooldown(attacker.id, attackerType, system.currentTick);
        }
    });

    world.afterEvents.entityDie.subscribe((event) => { 
        shieldCooldownMap.delete(event.deadEntity.id); 
    });

    try { 
        world.afterEvents.entityRemove.subscribe((event) => { 
            shieldCooldownMap.delete(event.removedEntityId); 
        }); 
    } catch (e) {}
})();

(function() {
    const PEARL_CONFIG = {
        enabled: true,
        BOTS: ["bot:army21"],
        PEARL_CHANCE: {
            "bot:army21": {
                "default": 0.1,
                "diamond_level": 0.15,
                "netherite_level": 0.2
            }
        },
        PEARL_COOLDOWN: {
            "bot:army21": {
                "default": { min: 80, max: 200 },
                "diamond_level": { min: 60, max: 160 },
                "netherite_level": { min: 40, max: 120 }
            }
        },
        ENEMIES: {
            "bot:army21": [
                "minecraft:player"
            ]
        },
        CHECK_INTERVAL: 10,
        TRIGGER_DISTANCE_MIN: 3.0,
        TRIGGER_DISTANCE_MAX: 64,
        SPAWN_DELAY: 2
    };

    SCRIPT_CONFIGS.pearl = PEARL_CONFIG;

    const pearlCooldownMap = new Map();
    const spawnCooldownMap = new Map();
    const pearlExecutionMap = new Map();

    function isPearlEnabled() {
        return PEARL_CONFIG.enabled === true;
    }

    function togglePearl(enabled) {
        PEARL_CONFIG.enabled = enabled;
        return PEARL_CONFIG.enabled;
    }

    function getBotLevel(entity) {
        try {
            const botType = entity.typeId;
            const tags = entity.getTags();
            if (tags.includes("netherite_level")) return "netherite_level";
            if (tags.includes("diamond_level")) return "diamond_level";
            return "default";
        } catch {
            return "default";
        }
    }

    function getRandomPearlCooldown(botType, level = "default") {
        const cooldownConfig = PEARL_CONFIG.PEARL_COOLDOWN[botType];
        if (!cooldownConfig) {
            return 80 + Math.floor(Math.random() * 60);
        }
        if (cooldownConfig[level]) {
            const cd = cooldownConfig[level];
            return cd.min + Math.floor(Math.random() * (cd.max - cd.min));
        }
        if (cooldownConfig.default) {
            const cd = cooldownConfig.default;
            return cd.min + Math.floor(Math.random() * (cd.max - cd.min));
        }
        return 80 + Math.floor(Math.random() * 60);
    }

    function setPearlCooldown(entityId, botType, level, tick) {
        const duration = getRandomPearlCooldown(botType, level);
        pearlCooldownMap.set(entityId, {
            startTick: tick,
            duration: duration
        });
    }

    function isPearlOnCooldown(entityId, tick) {
        const data = pearlCooldownMap.get(entityId);
        if (!data) return false;
        const remaining = (data.startTick + data.duration) - tick;
        return remaining > 0;
    }

    function getPearlChance(botType, level = "default") {
        const chanceConfig = PEARL_CONFIG.PEARL_CHANCE[botType];
        if (typeof chanceConfig === 'number') {
            return chanceConfig;
        }
        if (chanceConfig && chanceConfig[level] !== undefined) {
            return chanceConfig[level];
        }
        if (chanceConfig && chanceConfig.default !== undefined) {
            return chanceConfig.default;
        }
        return 0.1;
    }

    function getDistanceToTarget(a, b) {
        const dx = b.location.x - a.location.x;
        const dz = b.location.z - a.location.z;
        const dy = b.location.y - a.location.y;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function isEntityOnGroundStrict(entity) {
        try {
            if (!entity || !entity.isValid()) return false;
            if (entity.typeId === "minecraft:player") {
                try {
                    if (entity.getGameMode() === "creative") return false;
                } catch (e) {}
                if (entity.isFlying === true) return false;
                try {
                    if (entity.hasComponent("minecraft:elytra_flight")) {
                        const velocity = entity.getVelocity();
                        if (velocity) {
                            if (Math.abs(velocity.y) > 0.05 || !entity.isOnGround) {
                                return false;
                            }
                        }
                    }
                } catch (e) {}
                try {
                    const blockBelow = entity.dimension.getBlock({
                        x: Math.floor(entity.location.x),
                        y: Math.floor(entity.location.y) - 0.1,
                        z: Math.floor(entity.location.z)
                    });
                    if (blockBelow && (blockBelow.typeId === "minecraft:water" || 
                        blockBelow.typeId === "minecraft:flowing_water" ||
                        blockBelow.typeId === "minecraft:lava" ||
                        blockBelow.typeId === "minecraft:flowing_lava")) {
                        return false;
                    }
                } catch (e) {}
            }
            if (!entity.isOnGround) return false;
            try {
                const velocity = entity.getVelocity();
                if (velocity) {
                    if (Math.abs(velocity.y) > 0.1) {
                        return false;
                    }
                }
            } catch (e) {}
            try {
                const blockBelow = entity.dimension.getBlock({
                    x: Math.floor(entity.location.x),
                    y: Math.floor(entity.location.y) - 0.2,
                    z: Math.floor(entity.location.z)
                });
                if (!blockBelow || blockBelow.typeId === "minecraft:air") {
                    return false;
                }
            } catch (e) {
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    function isTargetReallyOnGround(target) {
        try {
            if (!target.isOnGround) return false;
            const velocity = target.getVelocity();
            if (velocity && Math.abs(velocity.y) > 0.05) return false;
            const blockBelow = target.dimension.getBlock({
                x: Math.floor(target.location.x),
                y: Math.floor(target.location.y) - 0.2,
                z: Math.floor(target.location.z)
            });
            if (!blockBelow) return false;
            const blockId = blockBelow.typeId;
            if (blockId === "minecraft:air" || 
                blockId === "minecraft:cave_air" || 
                blockId === "minecraft:void_air") {
                return false;
            }
            if (target.typeId === "minecraft:player") {
                if (target.isFlying === true) return false;
                try {
                    if (target.hasComponent("minecraft:elytra_flight")) {
                        return false;
                    }
                } catch (e) {}
            }
            return true;
        } catch {
            return false;
        }
    }

    function getNearestEnemyPearl(bot) {
        let nearest = null;
        let nearestDist = PEARL_CONFIG.TRIGGER_DISTANCE_MAX;

        const botType = bot.typeId;
        const enemyTypes = PEARL_CONFIG.ENEMIES[botType] || ["minecraft:player"];

        for (const enemyType of enemyTypes) {
            try {
                const entities = bot.dimension.getEntities({
                    type: enemyType,
                    location: bot.location,
                    maxDistance: PEARL_CONFIG.TRIGGER_DISTANCE_MAX
                });

                for (const target of entities) {
                    if (target.id === bot.id) continue;
                    if (target.typeId === "minecraft:player") {
                        if (target.getGameMode() === "creative") continue;
                        const playerName = target.name;
                        if (!isPlayerAllowedTarget(playerName)) continue;
                    }

                    if (!isEntityOnGroundStrict(target) || !isTargetReallyOnGround(target)) {
                        continue;
                    }

                    const dist = getDistanceToTarget(bot, target);
                    if (dist >= PEARL_CONFIG.TRIGGER_DISTANCE_MIN &&
                        dist <= PEARL_CONFIG.TRIGGER_DISTANCE_MAX &&
                        dist < nearestDist) {
                        nearestDist = dist;
                        nearest = target;
                    }
                }
            } catch {}
        }

        return nearest;
    }

    function getAllBotTypes() {
        return Object.keys(PEARL_CONFIG.ENEMIES);
    }

    function getEventNamespace(botType) {
        return botType.replace("bot:", "");
    }

    function aimPearlAtPredictedTarget(bot, target) {
        try {
            if (!PVP_CONFIG.mechanics.enabled || !PVP_CONFIG.mechanics.predictedProjectiles ||
                !target || !target.isValid()) return;
            const velocity = target.getVelocity() || { x: 0, y: 0, z: 0 };
            const dx = target.location.x - bot.location.x;
            const dy = target.location.y - bot.location.y;
            const dz = target.location.z - bot.location.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const travelTicks = Math.max(1, Math.min(8, distance / 1.5));
            const point = {
                x: target.location.x + velocity.x * travelTicks,
                y: target.location.y + 1.0 + velocity.y * travelTicks,
                z: target.location.z + velocity.z * travelTicks
            };
            const aimX = point.x - bot.location.x;
            const aimY = point.y - (bot.location.y + 1.4);
            const aimZ = point.z - bot.location.z;
            const horizontal = Math.sqrt(aimX * aimX + aimZ * aimZ) || 0.001;
            bot.setRotation({
                x: -Math.atan2(aimY, horizontal) * (180 / Math.PI),
                y: Math.atan2(-aimX, aimZ) * (180 / Math.PI)
            });
        } catch (error) {}
    }

    function setPearlActionActive(bot, active) {
        try {
            if (active) bot.addTag("pvp_pearl_active");
            else bot.removeTag("pvp_pearl_active");
        } catch (error) {
            try {
                bot.runCommand(`tag @s ${active ? "add" : "remove"} pvp_pearl_active`);
            } catch (fallbackError) {}
        }
    }

    function executePearlSequence(bot, target) {
        const entityId = bot.id;
        const namespace = getEventNamespace(bot.typeId);
        const level = getBotLevel(bot);
    
        if (pearlExecutionMap.has(entityId)) {
            return;
        }
        try {
            if (bot.hasTag("pvp_special_active")) return;
        } catch (error) {}
    
        pearlExecutionMap.set(entityId, true);
        setPearlActionActive(bot, true);
    
        try {
            bot.runCommand(`replaceitem entity @s slot.weapon.mainhand 0 minecraft:ender_pearl`);
        
            system.runTimeout(() => {
                try {
                    if (bot.isValid()) {
                        aimPearlAtPredictedTarget(bot, target);
                        bot.runCommand(`event entity @s ${namespace}:throw_ender_pearl`);
                    }
                } catch (e) {}
            }, 6);
        
            system.runTimeout(() => {
                try {
                    if (bot.isValid()) {
                        if (level === "diamond_level") {
                            bot.runCommand(`function sword3`);
                        } else if (level === "netherite_level") {
                            bot.runCommand(`function sword1`);
                        } else {
                            bot.runCommand(`function sword1`);
                        }
                    }
                } catch (e) {} finally {
                    setPearlActionActive(bot, false);
                    pearlExecutionMap.delete(entityId);
                }
            }, 10);
        
        } catch (e) {
            setPearlActionActive(bot, false);
            pearlExecutionMap.delete(entityId);
        }
    }

    world.afterEvents.entitySpawn.subscribe((event) => {
        const entity = event.entity;
        const botTypes = getAllBotTypes();

        if (botTypes.includes(entity.typeId)) {
            const tick = system.currentTick;
            spawnCooldownMap.set(entity.id, tick);

            system.runTimeout(() => {
                spawnCooldownMap.delete(entity.id);
            }, PEARL_CONFIG.SPAWN_DELAY * 20);
        }
    });

    system.runInterval(() => {
        if (!isPearlEnabled()) return;
        
        const tick = system.currentTick;
        const dimension = world.getDimension("overworld");

        const allBotTypes = getAllBotTypes();

        for (const botType of allBotTypes) {
            try {
                const entities = dimension.getEntities({ type: botType });

                for (const entity of entities) {
                    try {
                        if (!entity.isValid()) continue;

                        const spawnTime = spawnCooldownMap.get(entity.id);
                        if (spawnTime !== undefined) continue;

                        if (pearlExecutionMap.has(entity.id)) continue;

                        if (isPearlOnCooldown(entity.id, tick)) continue;

                        const enemy = getNearestEnemyPearl(entity);
                        if (!enemy) continue;

                        if (!isEntityOnGroundStrict(enemy) || !isTargetReallyOnGround(enemy)) {
                            continue;
                        }

                        const level = getBotLevel(entity);
                        const chance = getPearlChance(botType, level);

                        if (Math.random() < chance) {
                            executePearlSequence(entity, enemy);
                            setPearlCooldown(entity.id, botType, level, tick);
                        }

                    } catch (e) {}
                }
            } catch (e) {}
        }
    }, PEARL_CONFIG.CHECK_INTERVAL);

    system.runInterval(() => {
        const tick = system.currentTick;

        for (const [id, data] of pearlCooldownMap) {
            if (tick - data.startTick > 400) {
                pearlCooldownMap.delete(id);
            }
        }

        for (const [id, spawnTick] of spawnCooldownMap) {
            if (tick - spawnTick > PEARL_CONFIG.SPAWN_DELAY * 20) {
                spawnCooldownMap.delete(id);
            }
        }
    
        for (const [id] of pearlExecutionMap) {
            pearlExecutionMap.delete(id);
        }
    }, 200);

    world.afterEvents.entityDie.subscribe((event) => {
        pearlCooldownMap.delete(event.deadEntity.id);
        spawnCooldownMap.delete(event.deadEntity.id);
        pearlExecutionMap.delete(event.deadEntity.id);
    });

    try {
        world.afterEvents.entityRemove.subscribe((event) => {
            pearlCooldownMap.delete(event.removedEntityId);
            spawnCooldownMap.delete(event.removedEntityId);
            pearlExecutionMap.delete(event.removedEntityId);
        });
    } catch (e) {}
})();

(function() {
    const LEVEL_CONFIG = {
        diamond: {
            chance: 0.1,
            cooldownMin: 20,
            cooldownMax: 40
        },
        netherite: {
            chance: 0.2,
            cooldownMin: 10,
            cooldownMax: 40
        }
    };

    SCRIPT_CONFIGS.sneak = LEVEL_CONFIG;

    const sneakCooldowns = new Map();
    const entityLevelCache = new Map();

    function getArmyLevel(entity) {
        try {
            if (!entity.typeId || !entity.typeId.startsWith("bot:army")) return null;
            const cachedLevel = entityLevelCache.get(entity.id);
            if (cachedLevel) return cachedLevel;
            const tags = entity.getTags();
            let level = null;
            if (tags.includes("netherite_level")) {
                level = "netherite";
            } else if (tags.includes("diamond_level")) {
                level = "diamond";
            } else {
                return null;
            }
            entityLevelCache.set(entity.id, level);
            return level;
        } catch {
            return null;
        }
    }

    function playSneakAnimation(entity) {
        try {
            entity.runCommand(`playanimation @s animation.humanoid.sneak1`);
        } catch(e) {}
    }

    function getRandomCooldown(level) {
        const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.diamond;
        return config.cooldownMin + Math.floor(Math.random() * (config.cooldownMax - config.cooldownMin));
    }

    function getSneakChance(level) {
        const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.diamond;
        return config.chance;
    }

    function isOnCooldown(entityId, currentTick) {
        const data = sneakCooldowns.get(entityId);
        if (!data) return false;
        return (currentTick - data.startTick) < data.duration;
    }

    function setCooldown(entityId, level, currentTick) {
        const duration = getRandomCooldown(level);
        sneakCooldowns.set(entityId, {
            startTick: currentTick,
            duration: duration,
            level: level
        });
    }

    world.afterEvents.entityHurt.subscribe((event) => {
        const hurtEntity = event.hurtEntity;
        const damageSource = event.damageSource;
        const damagingEntity = damageSource.damagingEntity;
    
        if (!hurtEntity || !hurtEntity.isValid()) return;
    
        const level = getArmyLevel(hurtEntity);
        if (!level) return;
    
        if (damagingEntity && damagingEntity.isValid()) {
            if (damagingEntity.typeId === "minecraft:player" && 
                damagingEntity.getGameMode() === "creative") {
                return;
            }
        }
    
        const currentTick = system.currentTick;
        const entityId = hurtEntity.id;
    
        if (isOnCooldown(entityId, currentTick)) return;
    
        const chance = getSneakChance(level);
    
        if (Math.random() < chance) {
            playSneakAnimation(hurtEntity);
            setCooldown(entityId, level, currentTick);
        }
    });

    system.runInterval(() => {
        const currentTick = system.currentTick;
        for (const [id, data] of sneakCooldowns) {
            if (currentTick - data.startTick > data.duration * 2) {
                sneakCooldowns.delete(id);
                entityLevelCache.delete(id);
            }
        }
    }, 200);

    world.afterEvents.entityDie.subscribe((event) => {
        sneakCooldowns.delete(event.deadEntity.id);
        entityLevelCache.delete(event.deadEntity.id);
    });

    try {
        world.afterEvents.entityRemove.subscribe((event) => {
            sneakCooldowns.delete(event.removedEntityId);
            entityLevelCache.delete(event.removedEntityId);
        });
    } catch (e) {}
})();

(function() {
    const JUMP_CONFIG = {
        triggerDistance: 3.0,
        walkSpeed: 0.01,
        jumpHeight: 0.41,
        jumpForwardDistance: 1.5,
        jumpForwardSpeed: 0.05,
        jumpChance: 1.0,
        jumpCooldown: 11,
        jumpSidewaysChance: 0.0,
        jumpSidewaysAngleDeg: 0,
        jumpSidewaysMinDistance: 0,
        jumpSidewaysMaxDistance: 0,
        enemies: {
            "bot:army21": [
                "minecraft:player"
            ]
        }
    };

    const JUMP_BOTS = Object.keys(JUMP_CONFIG.enemies);

    SCRIPT_CONFIGS.jump = JUMP_CONFIG;

    function isTargetIgnored(target) {
        try {
            const tags = target.getTags();
            if (tags.includes("bot")) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    function isBotIgnored(bot) {
        try {
            const tags = bot.getTags();
            if (tags.includes("bot_ignore")) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    class BotState {
        constructor(botId) {
            this.botId = botId;
            this.isJumpingForward = false;
            this.jumpTarget = null;
            this.jumpStartTick = 0;
            this.jumpStartPos = null;
            this.jumpEndPos = null;
            this.jumpDirection = null;
            this.jumpProgress = 0;
            this.hasJumped = false;
            this.jumpComplete = false;
            this.lastJumpTick = 0;
            this.currentYaw = 0;
            this.targetYaw = 0;
            this.initialYaw = 0;
            this.jumpSideDirection = 0;
            this.jumpTargetDistance = 0;
            this.lockedYaw = 0;
            this.yawLocked = false;
        }

        canJump(tick) {
            return tick - this.lastJumpTick >= JUMP_CONFIG.jumpCooldown;
        }
    }

    const botStates = new Map();

    function getEnemies(botType) {
        return JUMP_CONFIG.enemies[botType] || [];
    }

    function getNearestEnemy(bot) {
        let nearest = null;
        let nearestDist = JUMP_CONFIG.triggerDistance;
        const enemies = getEnemies(bot.typeId);

        for (const enemyType of enemies) {
            const targets = bot.dimension.getEntities({
                type: enemyType,
                location: bot.location,
                maxDistance: JUMP_CONFIG.triggerDistance
            });

            for (const target of targets) {
                try {
                    if (target.id === bot.id) continue;
                    if (isCreativePlayer(target)) continue;
                    if (isTargetIgnored(target)) continue;

                    if (target.typeId === "minecraft:player") {
                        const playerName = target.name;
                        if (!isPlayerAllowedTarget(playerName)) continue;
                    }

                    const dist = getDistanceTo(bot, target);
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        nearest = target;
                    }
                } catch {}
            }
        }
        return nearest;
    }

    function getDistanceTo(a, b) {
        const dx = b.location.x - a.location.x;
        const dz = b.location.z - a.location.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    function isOnGround(entity) {
        try {
            return entity.isOnGround === true;
        } catch { return false; }
    }

    function isCreativePlayer(entity) {
        try {
            if (entity.typeId !== "minecraft:player") return false;
            for (const player of world.getPlayers()) {
                if (player.id === entity.id) {
                    return player.getGameMode() === "creative";
                }
            }
        } catch {}
        return false;
    }

    function getYawToTarget(from, to) {
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        return Math.atan2(-dx, dz) * (180 / Math.PI);
    }

    function lerpAngle(from, to, amount) {
        let diff = to - from;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return from + diff * amount;
    }

    function smoothRotate(entity, targetYaw, state, speed = 0.2) {
        if (!state) {
            entity.setRotation({ x: 0, y: targetYaw });
            return;
        }
    
        state.targetYaw = targetYaw;
        state.currentYaw = lerpAngle(state.currentYaw, targetYaw, speed);
        entity.setRotation({ x: 0, y: state.currentYaw });
    }

    function startJumpForward(state, bot, target, tick) {
        if (!isOnGround(bot)) return false;
        if (isTargetIgnored(target)) return false;
    
        state.isJumpingForward = true;
        state.jumpTarget = target;
        state.jumpStartTick = tick;
        state.hasJumped = false;
        state.jumpComplete = false;
        state.jumpProgress = 0;
        state.lastJumpTick = tick;
        state.yawLocked = false;
    
        state.jumpStartPos = { 
            x: bot.location.x, 
            y: bot.location.y, 
            z: bot.location.z 
        };
    
        const dx = target.location.x - bot.location.x;
        const dz = target.location.z - bot.location.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
    
        state.jumpSideDirection = 0;
    
        if (dist > 0.1) {
            const angle = Math.atan2(dz, dx);
            const sidewaysRad = JUMP_CONFIG.jumpSidewaysAngleDeg * (Math.PI / 180);
            const finalAngle = angle + sidewaysRad * state.jumpSideDirection;
            state.jumpDirection = {
                x: Math.cos(finalAngle),
                z: Math.sin(finalAngle)
            };
        } else {
            const rot = bot.getRotation();
            const yawRad = rot.y * (Math.PI / 180);
            state.jumpDirection = {
                x: -Math.sin(yawRad),
                z: Math.cos(yawRad)
            };
        }
    
        state.jumpTargetDistance = state.jumpSideDirection !== 0
            ? JUMP_CONFIG.jumpSidewaysMinDistance + Math.random() * (JUMP_CONFIG.jumpSidewaysMaxDistance - JUMP_CONFIG.jumpSidewaysMinDistance)
            : JUMP_CONFIG.jumpForwardDistance;
    
        state.jumpEndPos = {
            x: state.jumpStartPos.x + state.jumpDirection.x * state.jumpTargetDistance,
            z: state.jumpStartPos.z + state.jumpDirection.z * state.jumpTargetDistance
        };
    
        const targetYaw = Math.atan2(-state.jumpDirection.x, state.jumpDirection.z) * (180 / Math.PI);
        state.lockedYaw = targetYaw;
        state.currentYaw = targetYaw;
        state.targetYaw = targetYaw;
        state.initialYaw = targetYaw;
        state.yawLocked = true;
    
        bot.setRotation({ x: 0, y: targetYaw });
    
        return true;
    }

    function updateJumpForward(state, bot, tick) {
        if (!state.isJumpingForward) return;
    
        if (state.yawLocked) {
            bot.setRotation({ x: 0, y: state.lockedYaw });
        }
    
        if (!state.hasJumped && isOnGround(bot)) {
            bot.applyImpulse({ x: 0, y: JUMP_CONFIG.jumpHeight, z: 0 });
            state.hasJumped = true;
        }
    
        if (state.hasJumped && !state.jumpComplete) {
            if (!isOnGround(bot)) {
                const currentPos = { x: bot.location.x, z: bot.location.z };
                const dx = currentPos.x - state.jumpStartPos.x;
                const dz = currentPos.z - state.jumpStartPos.z;
                const distMoved = Math.sqrt(dx * dx + dz * dz);
                state.jumpProgress = Math.min(distMoved / state.jumpTargetDistance, 1);
            
                if (distMoved < state.jumpTargetDistance) {
                    const forwardSpeed = JUMP_CONFIG.jumpForwardSpeed;
                    const impulseX = state.jumpDirection.x * forwardSpeed;
                    const impulseZ = state.jumpDirection.z * forwardSpeed;
                    bot.applyImpulse({ x: impulseX * 0.5, y: 0, z: impulseZ * 0.5 });
                }
            
            } else if (state.hasJumped) {
                const currentPos = { x: bot.location.x, z: bot.location.z };
                const dx = currentPos.x - state.jumpStartPos.x;
                const dz = currentPos.z - state.jumpStartPos.z;
                const distMoved = Math.sqrt(dx * dx + dz * dz);
            
                if (distMoved >= 1.0 || tick - state.jumpStartTick > 30) {
                    state.jumpComplete = true;
                    state.isJumpingForward = false;
                    state.yawLocked = false;
                }
            }
        }
    
        if (state.yawLocked && state.hasJumped && !state.jumpComplete) {
            bot.setRotation({ x: 0, y: state.lockedYaw });
        }
    
        if (tick - state.jumpStartTick > 40) {
            state.isJumpingForward = false;
            state.jumpComplete = true;
            state.yawLocked = false;
        }
    }

    system.runInterval(() => {
        const tick = system.currentTick;

        for (const botType of JUMP_BOTS) {
            const bots = world.getDimension("overworld").getEntities({ type: botType });

            for (const bot of bots) {
                try {
                    if (isBotIgnored(bot)) continue;
                
                    let state = botStates.get(bot.id);
                    if (!state) {
                        state = new BotState(bot.id);
                        botStates.set(bot.id, state);
                    }

                    if (state.isJumpingForward) {
                        updateJumpForward(state, bot, tick);
                        continue;
                    }

                    if (!isOnGround(bot)) continue;

                    const target = getNearestEnemy(bot);
                    if (!target) continue;
                
                    if (isTargetIgnored(target)) continue;

                    if (!state.canJump(tick)) continue;

                    if (Math.random() < JUMP_CONFIG.jumpChance) {
                        startJumpForward(state, bot, target, tick);
                    }

                } catch {}
            }
        }

        if (tick % 200 === 0) {
            const active = new Set();
            for (const botType of JUMP_BOTS) {
                for (const e of world.getDimension("overworld").getEntities({ type: botType })) {
                    active.add(e.id);
                }
            }
            for (const id of botStates.keys()) {
                if (!active.has(id)) botStates.delete(id);
            }
        }
    }, 1);

    world.afterEvents.entityDie.subscribe((event) => {
        botStates.delete(event.deadEntity.id);
    });

    try {
        world.afterEvents.entityRemove.subscribe((event) => {
            botStates.delete(event.removedEntityId);
        });
    } catch (e) {}
})();

(function() {
    const SETTINGS_ITEM = "minecraft:stick";

    function showMainMenu(player) {
        const form = new ActionFormData()
            .title("Settings")
            .body("Select script to edit")
            .button("Heal")
            .button("Shield")
            .button("Pearl")
            .button("Sneak")
            .button("Jump")
            .button("Mace & Wind Charge")
            .button("Crystal PvP")
            .button("Bridge")
            .button("Combat Movement")
            .button("Advanced Combat")
            .button("Mini Games & Party")
            .button("Target Permission");

        form.show(player).then((response) => {
            if (response.canceled) return;
            switch (response.selection) {
                case 0: showHealMenu(player); break;
                case 1: showShieldMenu(player); break;
                case 2: showPearlMenu(player); break;
                case 3: showSneakMenu(player); break;
                case 4: showJumpMenu(player); break;
                case 5: showMaceWindMenu(player); break;
                case 6: showCrystalPvpMenu(player); break;
                case 7: showBridgeMenu(player); break;
                case 8: showCombatMovementMenu(player); break;
                case 9: showAdvancedCombatMenu(player); break;
                case 10: showMiniGamesMenu(player); break;
                case 11: showTargetMenu(player); break;
            }
        });
    }

    function showMaceWindMenu(player) {
        const mace = PVP_CONFIG.mace;
        const wind = PVP_CONFIG.windCharge;
        const form = new ModalFormData()
            .title("Mace & Wind Charge")
            .toggle("Enable mace smash attacks", mace.enabled)
            .toggle("Enable wind charge attacks", wind.enabled)
            .slider("Mace cooldown (ticks)", 20, 160, 5, mace.cooldownTicks)
            .slider("Wind charge cooldown (ticks)", 20, 160, 5, wind.cooldownTicks)
            .slider("Mace smash bonus damage", 0, 10, 1, mace.smashBonusDamage);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [maceEnabled, windEnabled, maceCooldown, windCooldown, bonusDamage] = response.formValues;
            mace.enabled = maceEnabled;
            wind.enabled = windEnabled;
            mace.cooldownTicks = maceCooldown;
            wind.cooldownTicks = windCooldown;
            mace.smashBonusDamage = bonusDamage;
            player.sendMessage(`§aMace ${maceEnabled ? "enabled" : "disabled"}, wind charge ${windEnabled ? "enabled" : "disabled"}`);
            showMainMenu(player);
        });
    }

    function showCrystalPvpMenu(player) {
        const crystal = PVP_CONFIG.crystal;
        const form = new ModalFormData()
            .title("Crystal PvP")
            .toggle("Enable crystal combos", crystal.enabled)
            .slider("Pops per combo", 1, 6, 1, crystal.comboPops)
            .slider("Trigger distance", 4, 16, 1, crystal.triggerDistance)
            .slider("Minimum self distance", 2, 6.5, 0.25, crystal.selfDistance)
            .slider("Cooldown (ticks)", 20, 240, 5, crystal.cooldownTicks);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [enabled, pops, distance, selfDistance, cooldown] = response.formValues;
            crystal.enabled = enabled;
            crystal.comboPops = Math.max(1, Math.floor(pops));
            crystal.triggerDistance = distance;
            crystal.selfDistance = selfDistance;
            crystal.cooldownTicks = cooldown;
            player.sendMessage(`§aCrystal PvP ${enabled ? "enabled" : "disabled"} (${crystal.comboPops} pops per combo)`);
            showMainMenu(player);
        });
    }

    function showBridgeMenu(player) {
        const bridge = PVP_CONFIG.bridge;
        const form = new ModalFormData()
            .title("Bridge Settings")
            .toggle("Enable bridging", bridge.enabled)
            .toggle("Place a clutch block while falling", bridge.clutch)
            .slider("Maximum blocks per bridge", 8, 96, 8, bridge.maxBlocksPerBridge)
            .slider("Target distance", 16, 80, 4, bridge.targetDistance);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [enabled, clutch, maxBlocks, targetDistance] = response.formValues;
            bridge.enabled = enabled;
            bridge.clutch = clutch;
            bridge.maxBlocksPerBridge = Math.max(8, Math.floor(maxBlocks));
            bridge.targetDistance = targetDistance;
            player.sendMessage(`§aBridging ${enabled ? "enabled" : "disabled"}`);
            showMainMenu(player);
        });
    }

    function showCombatMovementMenu(player) {
        const combat = PVP_CONFIG.combat;
        const form = new ModalFormData()
            .title("Combat Movement")
            .toggle("Enable PvP movement", combat.enabled)
            .toggle("Strafe around targets", combat.strafe)
            .slider("Target distance", 8, 40, 2, combat.targetDistance)
            .slider("Switch strafe side (ticks)", 8, 80, 4, combat.strafeSwitchTicks);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [enabled, strafe, targetDistance, switchTicks] = response.formValues;
            combat.enabled = enabled;
            combat.strafe = strafe;
            combat.targetDistance = targetDistance;
            combat.strafeSwitchTicks = switchTicks;
            player.sendMessage(`§aPvP movement ${enabled ? "enabled" : "disabled"}`);
            showMainMenu(player);
        });
    }

    function showAdvancedCombatMenu(player) {
        const mechanics = PVP_CONFIG.mechanics;
        const axe = PVP_CONFIG.axe;
        const rod = PVP_CONFIG.rod;
        const trap = PVP_CONFIG.trap;
        const form = new ModalFormData()
            .title("Advanced Combat")
            .toggle("Enable advanced timing", mechanics.enabled)
            .toggle("Sprint reset after sword hits", mechanics.sprintReset)
            .toggle("Hit-select delay and counter", mechanics.hitSelect)
            .toggle("Jump reset after damage", mechanics.jumpReset)
            .toggle("Lead Wind Charge/projectiles", mechanics.predictedProjectiles)
            .toggle("Axe shield disable", axe.enabled)
            .toggle("Rod utility at four to five blocks", rod.enabled)
            .toggle("Reachable low-health traps", trap.enabled);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [enabled, sprintReset, hitSelect, jumpReset, predictedProjectiles, axeEnabled, rodEnabled, trapEnabled] = response.formValues;
            mechanics.enabled = enabled;
            mechanics.sprintReset = sprintReset;
            mechanics.hitSelect = hitSelect;
            mechanics.jumpReset = jumpReset;
            mechanics.predictedProjectiles = predictedProjectiles;
            axe.enabled = axeEnabled;
            rod.enabled = rodEnabled;
            trap.enabled = trapEnabled;
            player.sendMessage(`§aAdvanced combat ${enabled ? "enabled" : "disabled"}`);
            showMainMenu(player);
        });
    }

    function showTargetMenu(player) {
        const form = new ActionFormData()
            .title("Target Permission")
            .body(`Current Mode: ${TARGET_CONFIG.targetingMode.toUpperCase()}\nAllowed Players: ${TARGET_CONFIG.allowedTargets.size > 0 ? Array.from(TARGET_CONFIG.allowedTargets).join(", ") : "None"}`)
            .button("Back")
            .button("Target All Players")
            .button("Target Specific Player");

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            if (response.selection === 0) {
                showMainMenu(player);
            } else if (response.selection === 1) {
                TARGET_CONFIG.targetingMode = "all";
                TARGET_CONFIG.allowedTargets.clear();
                TARGET_CONFIG.botTargets.clear();
                player.sendMessage("§aAll players are now allowed targets");
                showTargetMenu(player);
            } else if (response.selection === 2) {
                showPlayerSelection(player);
            }
        });
    }

    function showPlayerSelection(player) {
        const onlinePlayers = getOnlinePlayerNames();
        
        if (onlinePlayers.length === 0) {
            player.sendMessage("§cNo online players found");
            showTargetMenu(player);
            return;
        }

        const form = new ActionFormData()
            .title("Select Target Player")
            .body("Choose which player the bot should attack")
            .button("Back");

        for (const playerName of onlinePlayers) {
            const isSelected = TARGET_CONFIG.allowedTargets.has(playerName);
            form.button(`${playerName} ${isSelected ? "✓" : ""}`);
        }

        form.show(player).then((response) => {
            if (response.canceled) {
                showTargetMenu(player);
                return;
            }
            if (response.selection === 0) {
                showTargetMenu(player);
                return;
            }

            const selectedPlayer = onlinePlayers[response.selection - 1];
            
            TARGET_CONFIG.targetingMode = "specific";
            TARGET_CONFIG.allowedTargets.clear();
            TARGET_CONFIG.allowedTargets.add(selectedPlayer);
            TARGET_CONFIG.botTargets.clear();
            
            for (const botType of ["bot:army21"]) {
                const bots = world.getDimension("overworld").getEntities({ type: botType });
                for (const bot of bots) {
                    TARGET_CONFIG.botTargets.set(bot.id, selectedPlayer);
                }
            }
            
            player.sendMessage(`§aBot will now only target: ${selectedPlayer}`);
            showTargetMenu(player);
        });
    }

    function showHealMenu(player) {
        const heal = SCRIPT_CONFIGS.heal;
        if (!heal) return;
        const bots = Object.keys(heal.chance);

        const form = new ActionFormData()
            .title("Heal Settings")
            .body(`Global cooldown: ${heal.settings.cooldownSeconds}s`)
            .button("Back")
            .button("Edit Global Cooldown");

        for (const bot of bots) {
            form.button(`${bot} (chance: ${heal.chance[bot]})`);
        }

        form.show(player).then((response) => {
            if (response.canceled) return;
            if (response.selection === 0) {
                showMainMenu(player);
            } else if (response.selection === 1) {
                showHealCooldownEditor(player);
            } else {
                const bot = bots[response.selection - 2];
                showHealChanceEditor(player, bot);
            }
        });
    }

    function showHealCooldownEditor(player) {
        const heal = SCRIPT_CONFIGS.heal;
        const form = new ModalFormData()
            .title("Heal - Global Cooldown")
            .slider("Cooldown (seconds)", 0, 10, 0.1, heal.settings.cooldownSeconds);

        form.show(player).then((response) => {
            if (response.canceled) {
                showHealMenu(player);
                return;
            }
            heal.settings.cooldownSeconds = response.formValues[0];
            player.sendMessage(`Heal cooldown set to ${response.formValues[0]}s`);
            showHealMenu(player);
        });
    }

    function showHealChanceEditor(player, bot) {
        const heal = SCRIPT_CONFIGS.heal;
        const form = new ModalFormData()
            .title(`Heal - ${bot}`)
            .slider("Chance", 0, 1, 0.05, heal.chance[bot]);

        form.show(player).then((response) => {
            if (response.canceled) {
                showHealMenu(player);
                return;
            }
            heal.chance[bot] = response.formValues[0];
            player.sendMessage(`Heal chance for ${bot} set to ${response.formValues[0]}`);
            showHealMenu(player);
        });
    }

    function showShieldMenu(player) {
        const shield = SCRIPT_CONFIGS.shield;
        if (!shield) return;
        const bots = shield.BOTS;

        const form = new ActionFormData()
            .title("Shield Settings")
            .button("Back");

        for (const bot of bots) {
            const chance = shield.SHIELD_CHANCE[bot];
            form.button(`${bot} (chance: ${chance})`);
        }

        form.show(player).then((response) => {
            if (response.canceled) return;
            if (response.selection === 0) {
                showMainMenu(player);
            } else {
                const bot = bots[response.selection - 1];
                showShieldEditor(player, bot);
            }
        });
    }

    function showShieldEditor(player, bot) {
        const shield = SCRIPT_CONFIGS.shield;
        const cd = shield.SHIELD_COOLDOWN[bot] || { min: 40, max: 100 };

        const form = new ModalFormData()
            .title(`Shield - ${bot}`)
            .slider("Chance", 0, 1, 0.05, shield.SHIELD_CHANCE[bot])
            .slider("Cooldown Min (ticks)", 0, 400, 5, cd.min)
            .slider("Cooldown Max (ticks)", 0, 400, 5, cd.max);

        form.show(player).then((response) => {
            if (response.canceled) {
                showShieldMenu(player);
                return;
            }
            const [chance, min, max] = response.formValues;
            shield.SHIELD_CHANCE[bot] = chance;
            shield.SHIELD_COOLDOWN[bot] = { min: Math.min(min, max), max: Math.max(min, max) };
            player.sendMessage(`Shield settings updated for ${bot}`);
            showShieldMenu(player);
        });
    }

    function showPearlMenu(player) {
        const pearl = SCRIPT_CONFIGS.pearl;
        if (!pearl) return;
        const bots = Object.keys(pearl.PEARL_CHANCE);

        const form = new ActionFormData()
            .title("Pearl Settings")
            .body(`Status: ${pearl.enabled ? "ON" : "OFF"}`)
            .button("Back")
            .button(`Turn ${pearl.enabled ? "OFF" : "ON"}`);

        for (const bot of bots) {
            form.button(bot);
        }

        form.show(player).then((response) => {
            if (response.canceled) return;
            if (response.selection === 0) {
                showMainMenu(player);
            } else if (response.selection === 1) {
                pearl.enabled = !pearl.enabled;
                player.sendMessage(`Pearl system ${pearl.enabled ? "ENABLED" : "DISABLED"}`);
                showPearlMenu(player);
            } else {
                const bot = bots[response.selection - 2];
                showPearlTierMenu(player, bot);
            }
        });
    }

    function showPearlTierMenu(player, bot) {
        const pearl = SCRIPT_CONFIGS.pearl;
        const tiers = Object.keys(pearl.PEARL_CHANCE[bot]);

        const form = new ActionFormData()
            .title(`Pearl - ${bot}`)
            .button("Back");

        for (const tier of tiers) {
            const chance = pearl.PEARL_CHANCE[bot][tier];
            form.button(`${tier} (chance: ${chance})`);
        }

        form.show(player).then((response) => {
            if (response.canceled) return;
            if (response.selection === 0) {
                showPearlMenu(player);
            } else {
                const tier = tiers[response.selection - 1];
                showPearlEditor(player, bot, tier);
            }
        });
    }

    function showPearlEditor(player, bot, tier) {
        const pearl = SCRIPT_CONFIGS.pearl;
        const cd = (pearl.PEARL_COOLDOWN[bot] && pearl.PEARL_COOLDOWN[bot][tier]) || { min: 40, max: 100 };

        const form = new ModalFormData()
            .title(`Pearl - ${bot} - ${tier}`)
            .slider("Chance", 0, 1, 0.05, pearl.PEARL_CHANCE[bot][tier])
            .slider("Cooldown Min (ticks)", 0, 400, 5, cd.min)
            .slider("Cooldown Max (ticks)", 0, 400, 5, cd.max);

        form.show(player).then((response) => {
            if (response.canceled) {
                showPearlTierMenu(player, bot);
                return;
            }
            const [chance, min, max] = response.formValues;
            pearl.PEARL_CHANCE[bot][tier] = chance;
            if (!pearl.PEARL_COOLDOWN[bot]) pearl.PEARL_COOLDOWN[bot] = {};
            pearl.PEARL_COOLDOWN[bot][tier] = { min: Math.min(min, max), max: Math.max(min, max) };
            player.sendMessage(`Pearl settings updated for ${bot} (${tier})`);
            showPearlTierMenu(player, bot);
        });
    }

    function showSneakMenu(player) {
        const sneak = SCRIPT_CONFIGS.sneak;
        if (!sneak) return;
        const tiers = Object.keys(sneak);

        const form = new ActionFormData()
            .title("Sneak Settings")
            .button("Back");

        for (const tier of tiers) {
            form.button(`${tier} (chance: ${sneak[tier].chance})`);
        }

        form.show(player).then((response) => {
            if (response.canceled) return;
            if (response.selection === 0) {
                showMainMenu(player);
            } else {
                const tier = tiers[response.selection - 1];
                showSneakEditor(player, tier);
            }
        });
    }

    function showSneakEditor(player, tier) {
        const sneak = SCRIPT_CONFIGS.sneak;
        const data = sneak[tier];

        const form = new ModalFormData()
            .title(`Sneak - ${tier}`)
            .slider("Chance", 0, 1, 0.05, data.chance)
            .slider("Cooldown Min (ticks)", 0, 200, 5, data.cooldownMin)
            .slider("Cooldown Max (ticks)", 0, 200, 5, data.cooldownMax);

        form.show(player).then((response) => {
            if (response.canceled) {
                showSneakMenu(player);
                return;
            }
            const [chance, min, max] = response.formValues;
            sneak[tier].chance = chance;
            sneak[tier].cooldownMin = Math.min(min, max);
            sneak[tier].cooldownMax = Math.max(min, max);
            player.sendMessage(`Sneak settings updated for ${tier}`);
            showSneakMenu(player);
        });
    }

    function showJumpMenu(player) {
        const jump = SCRIPT_CONFIGS.jump;
        if (!jump) return;

        const form = new ModalFormData()
            .title("Jump Settings")
            .slider("Jump Chance", 0, 1, 0.05, jump.jumpChance)
            .slider("Jump Cooldown (ticks)", 0, 100, 1, jump.jumpCooldown)
            .slider("Trigger Distance (blocks)", 0, 20, 0.5, jump.triggerDistance);

        form.show(player).then((response) => {
            if (response.canceled) {
                showMainMenu(player);
                return;
            }
            const [chance, cooldown, distance] = response.formValues;
            jump.jumpChance = chance;
            jump.jumpCooldown = cooldown;
            jump.triggerDistance = distance;
            player.sendMessage(`Jump settings updated`);
            showMainMenu(player);
        });
    }

    world.afterEvents.itemUse.subscribe((event) => {
        const { source, itemStack } = event;
        if (itemStack.typeId !== SETTINGS_ITEM) return;
        if (source.typeId !== "minecraft:player") return;
        showMainMenu(source);
    });
})();