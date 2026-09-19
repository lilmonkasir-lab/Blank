import { world, system } from "@minecraft/server";

const SETTINGS = {
    critMultiplier: 1.5,
    soundNames: ["custom_sound.crit", "custom_sound.crit2", "custom_sound.crit3"],
    soundVolume: 1.0,
    soundPitch: 1.0,
    enableSound: true,
    enableParticles: true,
    critKnockbackBonus: 0.30,
    critCooldown: 8
};

const ENDER_PEARL_ID = "minecraft:ender_pearl";

const BOT_IDS = [
    "bot:army21",
    "bot:army22"
];

const lastCrit = new Map();

function isBotIgnored(bot) {
    try {
        return bot.hasTag && bot.hasTag("bot_ignore");
    } catch (e) {
        return false;
    }
}

function getSwordFunction(bot) {
    try {
        const tags = bot.getTags();
        if (tags.includes("netherite_level")) return "sword1";
        if (tags.includes("diamond_level")) return "sword3";
        return "sword1";
    } catch {
        return "sword1";
    }
}

function getRandomCritSound() {
    const randomIndex = Math.floor(Math.random() * SETTINGS.soundNames.length);
    return SETTINGS.soundNames[randomIndex];
}

function isAirborne(entity) {
    try {
        const vel = entity.getVelocity();
        return !entity.isOnGround || Math.abs(vel.y) > 0.1;
    } catch {
        return false;
    }
}

function wasJustInAir(entity) {
    try {
        const vel = entity.getVelocity();
        return Math.abs(vel.y) > 0.05;
    } catch {
        return false;
    }
}

function onCooldown(entity) {
    const last = lastCrit.get(entity.id);
    if (!last) return false;
    return (system.currentTick - last) < SETTINGS.critCooldown;
}

function playCritEffects(attacker, location) {
    try {
        if (SETTINGS.enableSound) {
            const selectedSound = getRandomCritSound();
            world.playSound(selectedSound, location, {
                volume: SETTINGS.soundVolume,
                pitch: SETTINGS.soundPitch
            });
        }

        if (SETTINGS.enableParticles) {
            attacker.dimension.spawnParticle("minecraft:crit_emitter", location);
        }
    } catch(e) {}
}

function critKnockback(attacker, victim) {
    try {
        const dx = victim.location.x - attacker.location.x;
        const dz = victim.location.z - attacker.location.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        victim.applyKnockback(dx / len, dz / len, SETTINGS.critKnockbackBonus, 0.05);
    } catch(e) {}
}

world.afterEvents.projectileHitBlock.subscribe((event) => {
    handlePearlHit(event, "block");
});

world.afterEvents.projectileHitEntity.subscribe((event) => {
    handlePearlHit(event, "entity");
});

function handlePearlHit(event, hitType) {
    try {
        const { projectile, source, location, dimension } = event;

        if (!projectile) {
            return;
        }

        if (projectile.typeId !== ENDER_PEARL_ID) return;

        if (!source) {
            return;
        }

        if (!BOT_IDS.includes(source.typeId)) return;
        
        if (isBotIgnored(source)) return;

        teleportBot(source, location, dimension);
        
    } catch (e) {
    }
}

function teleportBot(entity, location, dimension) {
    system.run(() => {
        try {
            if (!entity.isValid()) {
                return;
            }

            const entityId = entity.id;

            try {
                dimension.runCommand(`playsound custom_sound.tp @a ${entity.location.x} ${entity.location.y} ${entity.location.z}`);
                dimension.runCommand(`particle minecraft:teleport ~ ~1.5 ~ 0.5 0.5 0.5 0.5 20`);
            } catch (e) {}

            entity.teleport(location, {
                dimension: dimension,
                keepVelocity: false,
                checkForBlocks: true
            });

            try {
                dimension.runCommand(`playsound custom_sound.tp @a ${location.x} ${location.y} ${location.z}`);
                dimension.runCommand(`particle minecraft:teleport ~ ~1.5 ~ 0.5 0.5 0.5 0.5 20`);
            } catch (e) {}

            system.runTimeout(() => {
                try {
                    const bot = world.getEntity(entityId);
                    if (bot && bot.isValid()) {
                        const swordFunction = getSwordFunction(bot);
                        try {
                            bot.runCommand(`function ${swordFunction}`);
                        } catch (swordError) {}
                    }
                } catch (e) {}
            }, 10);

        } catch (e) {}
    });
}

world.afterEvents.entityHitEntity.subscribe(event => {
    const attacker = event.damagingEntity;
    const victim = event.hitEntity;
    const damage = event.damage;

    if (!attacker || !attacker.typeId) return;
    if (!attacker.typeId.startsWith("bot:")) return;

    if (onCooldown(attacker)) return;

    const inAir = isAirborne(attacker);
    const justInAir = wasJustInAir(attacker);
    const isCrit = inAir || justInAir;

    if (!isCrit) return;

    const critDamage = damage * SETTINGS.critMultiplier;
    const extraDamage = critDamage - damage;

    try {
        if (extraDamage > 0) {
            victim.applyDamage(extraDamage, {
                cause: "entityAttack",
                damagingEntity: attacker
            });
        }
    } catch(e) {}

    playCritEffects(attacker, victim.location);
    critKnockback(attacker, victim);

    lastCrit.set(attacker.id, system.currentTick);
});

world.afterEvents.entityRemove.subscribe(event => {
    lastCrit.delete(event.removedEntityId);
});