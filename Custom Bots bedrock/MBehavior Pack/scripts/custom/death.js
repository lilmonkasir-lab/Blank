import { world, system } from "@minecraft/server";

function getDeathMessage(cause) {
    switch(cause) {
        case "entityAttack":
            return "was slain";
        case "entityAttackNoAggro":
            return "was slain";
        case "projectile":
            return "was shot";
        case "trident":
            return "was impaled";
        case "maceSmash":
            return "was smashed";
        case "thorns":
            return "was killed by thorns";
        case "potion":
            return "was killed by a potion";
        case "magic":
            return "was killed by magic";
        case "instantHurt":
            return "was killed by magic";
        case "fall":
            return "fell from a high place";
        case "fallingBlock":
            return "was crushed by a falling block";
        case "fire":
            return "went up in flames";
        case "fireTick":
            return "burned to death";
        case "lava":
            return "tried to swim in lava";
        case "drowning":
            return "drowned";
        case "freeze":
            return "froze to death";
        case "magma":
            return "burned on magma";
        case "hotFloor":
            return "burned on magma";
        case "cactus":
            return "was pricked to death";
        case "sweetBerry":
            return "was prickled by sweet berries";
        case "blockExplosion":
            return "was blown up";
        case "entityExplosion":
            return "was blown up";
        case "dragon":
            return "was slain by the Ender Dragon";
        case "wither":
            return "withered away";
        case "witherSkull":
            return "was blasted by a Wither";
        case "guardian":
            return "was killed by a Guardian";
        case "elderGuardian":
            return "was killed by an Elder Guardian";
        case "piston":
            return "was squished by a piston";
        case "sting":
            return "was stung to death";
        case "suffocation":
            return "suffocated";
        case "lightning":
            return "was struck by lightning";
        case "fireworks":
            return "exploded";
        case "poison":
            return "was poisoned";
        case "cramming":
            return "was squished too much";
        case "dryout":
            return "dried out";
        case "starve":
            return "starved to death";
        case "void":
            return "fell out of the world";
        case "suicide":
            return "died";
        case "unknown":
            return "died";
        case "entityDismount":
            return "died";
        case "fallAccident":
            return "had a fatal fall";
        case "flyIntoWall":
            return "flew into a wall";
        default:
            return "died";
    }
}

function getBotName(entity) {
    if (entity.nameTag && entity.nameTag !== "") {
        return entity.nameTag;
    }

    let name = entity.typeId.replace("bot:", "");
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function getItemCustomName(item) {
    if (!item) return null;
    
    try {
        const displayName = item.getComponent("minecraft:display_name");
        if (displayName && displayName.nameTag && displayName.nameTag !== "") {
            return displayName.nameTag;
        }
        return null;
    } catch {
        return null;
    }
}

function getPlayerName(entity) {
    if (!entity) return null;
    
    if (entity.typeId === "minecraft:player") {
        return entity.nameTag || "A player";
    }
    
    if (entity.typeId?.startsWith("bot:")) {
        return getBotName(entity);
    }
    
    return null;
}

world.afterEvents.entityDie.subscribe(ev => {
    const dead = ev.deadEntity;
    const damage = ev.damageSource;
    const killer = damage.damagingEntity;

    if (!dead) return;

    const deadIsBot = dead.typeId?.startsWith("bot:");
    const killerIsBot = killer?.typeId?.startsWith("bot:");

    if (!deadIsBot && !killerIsBot && damage.cause !== "blockExplosion" && damage.cause !== "entityExplosion") return;

    const victimName = dead.typeId === "minecraft:player"
        ? (dead.nameTag || "A player")
        : getBotName(dead);

    let customItemName = null;
    let killerName = null;
    
    if (killer) {
        killerName = getPlayerName(killer);
        
        try {
            const inventory = killer.getComponent("minecraft:inventory");
            if (inventory) {
                const container = inventory.container;
                if (container) {
                    const heldItem = container.getItem(killer.selectedSlotIndex);
                    if (heldItem) {
                        const name = getItemCustomName(heldItem);
                        if (name) customItemName = name;
                    }
                }
            }
        } catch {}
    }

    if (damage.cause === "blockExplosion" || damage.cause === "entityExplosion") {
        world.sendMessage(`${victimName} was blown up`);
        return;
    }

    if (!killer) {
        const message = getDeathMessage(damage.cause);
        world.sendMessage(`${victimName} ${message}`);
        return;
    }

    if (!killerName) {
        killerName = killer.typeId === "minecraft:player"
            ? (killer.nameTag || "A player")
            : getBotName(killer);
    }

    let deathMessage = "";

    if (damage.cause === "dragon") {
        deathMessage = `${victimName} was slain by the Ender Dragon`;
    } else if (damage.cause === "witherSkull") {
        deathMessage = `${victimName} was blasted by a Wither`;
    } else if (damage.cause === "thorns") {
        deathMessage = `${victimName} was killed by thorns`;
    } else if (damage.cause === "guardian" || damage.cause === "elderGuardian") {
        deathMessage = `${victimName} was killed by ${killerName}`;
    } else if (damage.cause === "sting") {
        deathMessage = `${victimName} was stung by ${killerName}`;
    } else if (damage.cause === "potion") {
        deathMessage = `${victimName} was killed by ${killerName}'s potion`;
    } else if (damage.cause === "piston") {
        deathMessage = `${victimName} was squished by ${killerName}`;
    } else if (damage.cause === "suffocation") {
        deathMessage = `${victimName} suffocated`;
    } else if (damage.cause === "cramming") {
        deathMessage = `${victimName} was squished too much`;
    } else if (damage.cause === "entityAttack" || damage.cause === "entityAttackNoAggro") {
        if (customItemName) {
            deathMessage = `${victimName} was slain by ${killerName} using ${customItemName}`;
        } else {
            deathMessage = `${victimName} was slain by ${killerName}`;
        }
    } else {
        const action = getDeathMessage(damage.cause);
        
        if (customItemName) {
            deathMessage = `${victimName} ${action} by ${killerName} using ${customItemName}`;
        } else {
            deathMessage = `${victimName} ${action} by ${killerName}`;
        }
    }

    world.sendMessage(deathMessage);
});