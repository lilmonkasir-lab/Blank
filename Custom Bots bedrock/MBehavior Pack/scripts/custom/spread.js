import { world, system } from "@minecraft/server";

const SPREAD_CONFIG = {
    SPREAD_RADIUS_MIN: 1.8,
    SPREAD_RADIUS_MAX: 5.5,
    SEARCH_RADIUS: 4.0,
    DELAY_TICKS: 3,
    ITEM_LIFETIME: 1200,
    CHECK_ITEM_AGE: 20
};

function getSpreadPosition(baseLocation, minDist, maxDist) {
    const angle = Math.random() * Math.PI * 2;
    const distance = minDist + Math.random() * (maxDist - minDist);
    const yOffset = Math.random() * 0.3 + 0.2;
    return {
        x: baseLocation.x + Math.cos(angle) * distance,
        y: baseLocation.y + yOffset,
        z: baseLocation.z + Math.sin(angle) * distance
    };
}

function isBlockSolid(dimension, pos) {
    try {
        const block = dimension.getBlock(pos);
        if (!block) return false;
        return block.isSolid ?? !block.isAir;
    } catch (e) {
        return false;
    }
}

function hasClearPath(dimension, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) return true;
    const steps = Math.ceil(dist / 0.25);
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const point = {
            x: start.x + dx * t,
            y: start.y + dy * t,
            z: start.z + dz * t
        };
        if (isBlockSolid(dimension, point)) return false;
    }
    return true;
}

function getClearSpreadPosition(dimension, baseLocation, minDist, maxDist) {
    const rayStart = { x: baseLocation.x, y: baseLocation.y + 0.5, z: baseLocation.z };
    for (let i = 0; i < 8; i++) {
        const candidate = getSpreadPosition(baseLocation, minDist, maxDist);
        const rayEnd = { x: candidate.x, y: baseLocation.y + 0.5, z: candidate.z };
        if (hasClearPath(dimension, rayStart, rayEnd)) {
            return candidate;
        }
    }
    return null;
}

function isBotType(botType) {
    return botType.startsWith("bot:");
}

world.afterEvents.entityDie.subscribe((event) => {
    const dead = event.deadEntity;
    if (!dead) return;

    if (!isBotType(dead.typeId)) return;

    const deathLocation = dead.location;
    const dimension = dead.dimension;
    if (!deathLocation || !dimension) return;

    system.runTimeout(() => {
        let drops = [];
        try {
            drops = dimension.getEntities({
                type: "minecraft:item",
                location: deathLocation,
                maxDistance: SPREAD_CONFIG.SEARCH_RADIUS
            });
        } catch (e) {
            return;
        }

        for (const item of drops) {
            if (!item.isValid()) continue;

            const itemComponent = item.getComponent('item');
            const itemAge = itemComponent?.age || 0;
            if (itemAge >= SPREAD_CONFIG.CHECK_ITEM_AGE) continue;

            const newPos = getClearSpreadPosition(
                dimension,
                deathLocation,
                SPREAD_CONFIG.SPREAD_RADIUS_MIN,
                SPREAD_CONFIG.SPREAD_RADIUS_MAX
            );
            if (!newPos) continue;

            try {
                item.teleport(newPos, { 
                    dimension: dimension,
                    keepVelocity: true,
                    checkForBlocks: false
                });
            } catch (e) {}
        }

        try {
            dimension.runCommand(`particle minecraft:poof ~ ~1 ~ 0.5 0.5 0.5 0.3 15`);
        } catch (e) {}

    }, SPREAD_CONFIG.DELAY_TICKS);
});