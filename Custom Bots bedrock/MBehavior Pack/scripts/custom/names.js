import { world, system } from "@minecraft/server";

const CUSTOM_NAME_CONFIG = {
    BOTS: new Set([
        "bot:army21",
        "bot:army22"
    ])
};

const CONS = [
    "b", "br", "c", "ch", "cr", "d", "dr", "f", "fl", "fr", "g", "gr",
    "h", "j", "k", "kl", "kr", "l", "m", "n", "p", "pl", "pr", "qu",
    "r", "s", "sh", "sk", "sl", "sm", "sn", "sp", "st", "str", "sw",
    "t", "th", "tr", "v", "w", "wh", "y", "z"
];

const VOW = [
    "a", "e", "i", "o", "u", "ai", "ea", "ee", "ei", "ia", "io", "oa", "oo", "ou", "ie"
];

const NAME_PARTS = [
    "Andy", "Emily", "Julia", "Joe", "Fay", "Rin", "Kyzxo", "Reluu", "Astoriatis",
    "Honu", "Budi", "Yang", "Tenebris", "Stein", "Ballern", "Latif", "Abde",
    "Aether", "Duck", "Cam", "Twee", "Tomboy", "Shadow", "Raze", "Von", "Queer",
    "Consumer", "Streamer", "Sunshine", "Iced", "Pretty", "Flying", "Sway",
    "Telamon", "Woman", "Fox", "Wolf", "Bear", "Otter", "Panda", "Koi", "Finch",
    "Robin", "Office", "Gift", "Cootie", "Property", "Crit", "Maisaur", "Smiley",
    "Ghost", "Storm", "Frost", "Ember", "Willow", "Hazel", "Juno", "Milo", "Leo",
    "Nova", "Sage", "Wren", "Ivy", "Rosa", "Kai", "Zane", "Remy", "Theo",
    // New name parts
    "Ace", "Blaze", "Crimson", "Drake", "Echo", "Fury", "Grim", "Hawk", "Iris",
    "Jax", "Knight", "Luna", "Maverick", "Night", "Onyx", "Phantom", "Quinn",
    "Raven", "Scarlet", "Titan", "Umbra", "Viper", "Wraith", "Xeno", "Yuki",
    "Zen", "Archer", "Blade", "Cipher", "Dagger", "Eagle", "Falcon", "Glitch",
    "Hunter", "Inferno", "Jester", "Karma", "Legend", "Mystic", "Nebula",
    "Oracle", "Phoenix", "Quantum", "Rogue", "Sphinx", "Tempest", "Ursa",
    "Valkyrie", "Warden", "Xander", "Yara", "Zeus", "Axl", "Bryce", "Cruz",
    "Dex", "Eli", "Finn", "Grey", "Hayes", "Idris", "Jace", "Knox", "Lane",
    "Mace", "Nash", "Orion", "Pierce", "Rex", "Shane", "Troy", "Ulysses",
    "Vance", "Wade", "Xavier", "Zion", "Atlas", "Bane", "Crow", "Dusk",
    "Ember", "Flint", "Gale", "Haze", "Jade", "Kane", "Lark", "Moss",
    "Nyx", "Oak", "Pulse", "Quake", "Rune", "Skye", "Talon", "Vale"
];

const SUFFIX_TAGS = ["EN", "x", "X", "V2", "V3", "OG", "TTV", "Jr"];

// Numbers 1 to 100
const NUMBERS = Array.from({ length: 100 }, (_, i) => String(i + 1));

const LEET_MAP = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7" };
const LEET_KEYS = Object.keys(LEET_MAP);
const LEET_VALUES = Object.values(LEET_MAP);

const CONS_LEN = CONS.length;
const VOW_LEN = VOW.length;
const NAME_PARTS_LEN = NAME_PARTS.length;
const SUFFIX_LEN = SUFFIX_TAGS.length;
const NUMBERS_LEN = NUMBERS.length;

const rand = (max) => Math.floor(Math.random() * max);
const rpick = (arr, len) => arr[Math.floor(Math.random() * len)];

const nameCache = new Map();
const MAX_CACHE_SIZE = 500;

function getCachedName(botType) {
    if (nameCache.has(botType)) {
        const cached = nameCache.get(botType);
        if (cached.length > 0) {
            return cached.pop();
        }
    }
    return null;
}

function cacheName(botType, name) {
    if (!nameCache.has(botType)) {
        nameCache.set(botType, []);
    }
    const cache = nameCache.get(botType);
    if (cache.length < MAX_CACHE_SIZE) {
        cache.push(name);
    }
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function randomWord(minSyl, maxSyl) {
    const count = rand(maxSyl - minSyl + 1) + minSyl;
    let word = "";
    for (let i = 0; i < count; i++) {
        word += rpick(CONS, CONS_LEN) + rpick(VOW, VOW_LEN);
    }
    return word;
}

function leetify(str, chance) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const lower = ch.toLowerCase();
        const index = LEET_KEYS.indexOf(lower);
        if (index !== -1 && Math.random() < chance) {
            out += LEET_VALUES[index];
        } else {
            out += ch;
        }
    }
    return out;
}

function repeatTrailingChar(str) {
    const ch = str[str.length - 1];
    const count = rand(4) + 3;
    return str + ch.repeat(count);
}

function numericName() {
    const len = rand(6) + 8;
    let s = String(rand(9) + 1);
    for (let i = 1; i < len; i++) s += String(rand(10));
    return s;
}

const NAME_POOL = new Set();
const POOL_SIZE = 5000;

function generateNameBatch(count) {
    const batch = new Set();
    while (batch.size < count) {
        batch.add(generateGamertag());
    }
    return batch;
}

const BATCH_SIZE = 1000;
for (let i = 0; i < POOL_SIZE; i += BATCH_SIZE) {
    const batch = generateNameBatch(Math.min(BATCH_SIZE, POOL_SIZE - i));
    for (const name of batch) {
        NAME_POOL.add(name);
    }
}

const NAME_ARRAY = Array.from(NAME_POOL);

function generateGamertag() {
    const style = rand(24);
    let name = "";

    switch (style) {
        case 0:
            name = randomWord(2, 4);
            break;
        case 1:
            name = randomWord(2, 4) + "_";
            break;
        case 2:
            name = capitalize(randomWord(2, 4));
            break;
        case 3:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN) + rpick(NAME_PARTS, NAME_PARTS_LEN);
            break;
        case 4:
            name = "Its" + rpick(NAME_PARTS, NAME_PARTS_LEN);
            break;
        case 5:
            name = "Itz" + rpick(NAME_PARTS, NAME_PARTS_LEN) + rpick(NAME_PARTS, NAME_PARTS_LEN);
            break;
        case 6:
            name = "ilove" + randomWord(1, 2);
            break;
        case 7:
            name = "ilove" + rpick(NAME_PARTS, NAME_PARTS_LEN).toLowerCase();
            break;
        case 8:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN) + rpick(NUMBERS, NUMBERS_LEN);
            break;
        case 9:
            name = "_" + randomWord(2, 3);
            break;
        case 10:
            name = "_" + repeatTrailingChar(capitalize(randomWord(1, 2)));
            break;
        case 11:
            name = randomWord(1, 2) + rpick(NUMBERS, NUMBERS_LEN);
            break;
        case 12:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN).toLowerCase() + rpick(NUMBERS, NUMBERS_LEN) + "_" + rpick(SUFFIX_TAGS, SUFFIX_LEN);
            break;
        case 13:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN) + "_" + rpick(SUFFIX_TAGS, SUFFIX_LEN);
            break;
        case 14:
            name = repeatTrailingChar(randomWord(2, 3));
            break;
        case 15:
            name = leetify(randomWord(1, 2), 0.5);
            break;
        case 16:
            name = numericName();
            break;
        case 17:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN) + "Von" + rpick(NAME_PARTS, NAME_PARTS_LEN);
            break;
        case 18:
            name = rpick(NAME_PARTS, NAME_PARTS_LEN) + "_" + rpick(NAME_PARTS, NAME_PARTS_LEN);
            break;
        case 19:
            name = randomWord(2, 3) + randomWord(1, 2);
            break;
        case 20:
            name = capitalize(randomWord(2, 3)) + capitalize(randomWord(1, 2));
            break;
        case 21:
            name = rpick(NUMBERS, NUMBERS_LEN) + randomWord(2, 3) + rpick(NUMBERS, NUMBERS_LEN);
            break;
        case 22:
            name = numericName();
            break;
        default:
            name = randomWord(2, 3) + rpick(NUMBERS, NUMBERS_LEN);
    }

    return name.length > 16 ? name.substring(0, 16) : name;
}

function rname() {
    const cachedName = getCachedName("default");
    if (cachedName) return cachedName;
    const newName = generateGamertag();
    cacheName("default", newName);
    return newName;
}

for (let i = 0; i < 100; i++) {
    cacheName("default", generateGamertag());
}

function isBotIgnored(bot) {
    try {
        return bot.hasTag && bot.hasTag("bot_ignore");
    } catch (e) {
        return false;
    }
}

world.afterEvents.entitySpawn.subscribe(ev => {
    const entity = ev.entity;
    const typeId = entity.typeId;
    
    if (CUSTOM_NAME_CONFIG.BOTS.has(typeId)) {
        if (isBotIgnored(entity)) return;

        system.run(() => {
            try {
                const cachedName = getCachedName(typeId) || getCachedName("default");
                if (cachedName) {
                    entity.nameTag = cachedName;
                } else {
                    entity.nameTag = generateGamertag();
                }
            } catch (e) {}
        });
    }
});

function pregenerateNamesForBotType(botType, count = 50) {
    for (let i = 0; i < count; i++) {
        cacheName(botType, generateGamertag());
    }
}

for (const botType of CUSTOM_NAME_CONFIG.BOTS) {
    pregenerateNamesForBotType(botType, 30);
}