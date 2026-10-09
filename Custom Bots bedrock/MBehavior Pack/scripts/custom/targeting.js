import { world } from "@minecraft/server";

// Shared by the existing settings menu and the PvP brain so every combat
// action respects the same target-permission setting.
export const TARGET_CONFIG = {
    botTargets: new Map(),
    allowedTargets: new Set(),
    targetingMode: "all"
};

export function isPlayerAllowedTarget(playerName) {
    if (TARGET_CONFIG.targetingMode === "all") return true;
    return TARGET_CONFIG.allowedTargets.has(playerName);
}

export function getOnlinePlayerNames() {
    return world.getPlayers().map(player => player.name);
}
