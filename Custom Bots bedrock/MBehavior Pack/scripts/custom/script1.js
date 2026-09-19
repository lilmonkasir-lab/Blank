import { world, system } from "@minecraft/server";

/* ===============================
   BOT JOIN & LEAVE MESSAGES
   ============================== */

// Kapag nag-spawn ang bot (join message)
world.afterEvents.entitySpawn.subscribe((event) => {
    const entity = event.entity;

    if (!entity.typeId.startsWith("bot:")) return;

    system.runTimeout(() => {
        const name = entity.nameTag || entity.typeId.replace("bot:", "");
        world.sendMessage(`§e${name} joined the game`);
    }, 2);
});

// Kapag namatay ang bot (leave message)
world.afterEvents.entityDie.subscribe((event) => {
    const entity = event.deadEntity;

    if (!entity.typeId.startsWith("bot:")) return;

    const name = entity.nameTag || entity.typeId.replace("bot:", "");

    system.runTimeout(() => {
        world.sendMessage(`§e${name} left the game`);
    }, 40);
});