// ============================================================
//  CHARACTERS DATABASE — 40 Mythical Companions
//  Players receive a random character at game start
//  Characters can be leveled up using Gold
// ============================================================

const CHARACTERS = [
  { id:'aetherion',   name:'Aetherion',   title:'Celestial Dragon',  emoji:'🐲', hp:45, attack:12, defense:8,  magic:15, speed:10, ability:'Star Breath',    abilityDesc:'Deals magic damage ignoring 5 defense',             element:'celestial' },
  { id:'sylphina',    name:'Sylphina',    title:'Wind Fairy',         emoji:'🧚', hp:30, attack:8,  defense:6,  magic:18, speed:15, ability:'Gale Dance',     abilityDesc:'Increases own speed by 5 for 2 turns',              element:'wind' },
  { id:'terragon',    name:'Terragon',    title:'Earth Golem',        emoji:'🗿', hp:60, attack:14, defense:18, magic:5,  speed:4,  ability:'Stone Shield',   abilityDesc:'Raises defense by 10 for 3 turns',                  element:'earth' },
  { id:'pyraflame',   name:'Pyraflame',   title:'Fire Phoenix',       emoji:'🔥', hp:40, attack:16, defense:7,  magic:12, speed:12, ability:'Blazing Rebirth',abilityDesc:'Revives with 20% HP if defeated',                   element:'fire' },
  { id:'glaciera',    name:'Glaciera',    title:'Ice Siren',          emoji:'🧊', hp:35, attack:9,  defense:8,  magic:17, speed:13, ability:'Frost Song',     abilityDesc:'Reduces enemy speed by 5 for 2 turns',              element:'ice' },
  { id:'umbros',      name:'Umbros',      title:'Shadow Wraith',      emoji:'👻', hp:38, attack:13, defense:6,  magic:14, speed:15, ability:'Shadow Strike',  abilityDesc:'Attacks twice in one turn',                         element:'shadow' },
  { id:'thundrax',    name:'Thundrax',    title:'Storm Griffin',      emoji:'⚡', hp:50, attack:15, defense:10, magic:12, speed:11, ability:'Lightning Talon',abilityDesc:'Deals attack + magic damage',                       element:'storm' },
  { id:'floralis',    name:'Floralis',    title:'Nature Dryad',       emoji:'🌿', hp:32, attack:10, defense:9,  magic:16, speed:14, ability:'Healing Bloom',  abilityDesc:'Heals 10 HP each turn for 2 turns',                 element:'nature' },
  { id:'luminara',    name:'Luminara',    title:'Light Unicorn',      emoji:'🦄', hp:42, attack:11, defense:12, magic:14, speed:12, ability:'Radiant Horn',   abilityDesc:'Deals light magic damage and blinds enemy',         element:'light' },
  { id:'krakenos',    name:'Krakenos',    title:'Sea Kraken',         emoji:'🐙', hp:70, attack:18, defense:14, magic:8,  speed:5,  ability:'Tentacle Slam',  abilityDesc:'Stuns enemy for 1 turn',                            element:'water' },
  { id:'oblivion',    name:'Oblivion',    title:'Demon Lord',         emoji:'😈', hp:40, attack:17, defense:10, magic:15, speed:8,  ability:'Hellfire',       abilityDesc:'Massive magic damage at cost of 5 HP',              element:'dark' },
  { id:'aurorion',    name:'Aurorion',    title:'Celestial Lion',     emoji:'🦁', hp:48, attack:14, defense:11, magic:13, speed:12, ability:'Roar of Courage', abilityDesc:'Raises all allies\' attack by 5 for 2 turns',      element:'celestial' },
  { id:'frostbite',   name:'Frostbite',   title:'Yeti',               emoji:'🏔️', hp:55, attack:16, defense:13, magic:6,  speed:7,  ability:'Ice Smash',      abilityDesc:'Heavy physical damage, lowers enemy defense',       element:'ice' },
  { id:'venomshade',  name:'Venomshade',  title:'Poison Basilisk',    emoji:'🐍', hp:36, attack:12, defense:9,  magic:14, speed:13, ability:'Toxic Bite',     abilityDesc:'Poisons enemy, 5 HP per turn',                      element:'poison' },
  { id:'ignis',       name:'Ignis',       title:'Lava Elemental',     emoji:'🌋', hp:45, attack:17, defense:8,  magic:12, speed:10, ability:'Molten Burst',   abilityDesc:'Fire damage + burns enemy for 2 turns',             element:'fire' },
  { id:'nimbora',     name:'Nimbora',     title:'Cloud Pegasus',      emoji:'🦋', hp:38, attack:10, defense:9,  magic:15, speed:16, ability:'Wind Dash',      abilityDesc:'Dodges the next enemy attack',                      element:'wind' },
  { id:'stoneheart',  name:'Stoneheart',  title:'Titan Gargoyle',     emoji:'🏰', hp:65, attack:15, defense:18, magic:4,  speed:5,  ability:'Fortify',        abilityDesc:'Gains double defense for 1 turn',                   element:'earth' },
  { id:'abyssia',     name:'Abyssia',     title:'Deep Sea Nymph',     emoji:'🧜', hp:33, attack:9,  defense:8,  magic:18, speed:14, ability:'Aqua Bind',      abilityDesc:'Reduces enemy speed and magic by 5',                element:'water' },
  { id:'blazewing',   name:'Blazewing',   title:'Inferno Dragonet',   emoji:'🦅', hp:40, attack:15, defense:7,  magic:13, speed:12, ability:'Flame Claw',     abilityDesc:'Deals fire physical damage and lowers enemy attack', element:'fire' },
  { id:'shadowfen',   name:'Shadowfen',   title:'Swamp Wraith',       emoji:'🌑', hp:37, attack:11, defense:8,  magic:16, speed:13, ability:'Mire Trap',      abilityDesc:'Reduces enemy speed by 5 for 3 turns',              element:'shadow' },
  { id:'moonshade',   name:'Moonshade',   title:'Lunar Vampire',      emoji:'🦇', hp:38, attack:14, defense:7,  magic:16, speed:12, ability:'Night Drain',    abilityDesc:'Steals 10 HP from enemy',                           element:'dark' },
  { id:'stormfang',   name:'Stormfang',   title:'Thunder Wolf',       emoji:'🐺', hp:44, attack:15, defense:10, magic:11, speed:14, ability:'Thunder Bite',   abilityDesc:'Deals attack + lightning damage',                   element:'storm' },
  { id:'emberclaw',   name:'Emberclaw',   title:'Fire Cat',           emoji:'🐱', hp:35, attack:16, defense:8,  magic:10, speed:15, ability:'Flame Pounce',   abilityDesc:'Attacks twice with fire bonus',                     element:'fire' },
  { id:'aqualis',     name:'Aqualis',     title:'Water Serpent',      emoji:'🌊', hp:42, attack:12, defense:9,  magic:15, speed:11, ability:'Tidal Wave',     abilityDesc:'Reduces enemy attack by 5 for 2 turns',             element:'water' },
  { id:'ironhide',    name:'Ironhide',    title:'Metal Minotaur',     emoji:'🐂', hp:60, attack:17, defense:16, magic:5,  speed:6,  ability:'Metal Bash',     abilityDesc:'Heavy attack, reduces enemy speed',                 element:'earth' },
  { id:'mystara',     name:'Mystara',     title:'Mystic Owl',         emoji:'🦉', hp:30, attack:10, defense:6,  magic:18, speed:14, ability:'Arcane Sight',   abilityDesc:'Boosts magic for 2 turns',                          element:'celestial' },
  { id:'venomfang',   name:'Venomfang',   title:'Poison Drake',       emoji:'🐲', hp:37, attack:15, defense:8,  magic:12, speed:13, ability:'Venom Spray',    abilityDesc:'Poisons all enemies for 3 turns',                   element:'poison' },
  { id:'galeon',      name:'Galeon',      title:'Wind Lion',          emoji:'🦁', hp:40, attack:13, defense:10, magic:14, speed:15, ability:'Sky Pounce',     abilityDesc:'Deals attack damage and raises own speed',          element:'wind' },
  { id:'frostclaw',   name:'Frostclaw',   title:'Ice Wolf',           emoji:'🐺', hp:45, attack:14, defense:12, magic:12, speed:10, ability:'Chill Bite',     abilityDesc:'Reduces enemy attack and speed',                    element:'ice' },
  { id:'shadowflame', name:'Shadowflame', title:'Demon Fox',          emoji:'🦊', hp:36, attack:16, defense:9,  magic:15, speed:12, ability:'Infernal Slash', abilityDesc:'Deals combined attack + magic damage',              element:'dark' },
  { id:'cindral',     name:'Cindral',     title:'Ash Dragon',         emoji:'🐉', hp:43, attack:15, defense:10, magic:13, speed:11, ability:'Ash Cloud',      abilityDesc:'Lowers enemy accuracy for 2 turns',                 element:'fire' },
  { id:'thornbark',   name:'Thornbark',   title:'Forest Ent',         emoji:'🌲', hp:55, attack:12, defense:18, magic:7,  speed:5,  ability:'Root Bind',      abilityDesc:'Immobilizes enemy for 1 turn',                      element:'nature' },
  { id:'lunaris',     name:'Lunaris',     title:'Moon Spirit',        emoji:'🌙', hp:32, attack:9,  defense:8,  magic:18, speed:15, ability:'Moonlight Heal', abilityDesc:'Restores 15 HP to self or ally',                    element:'celestial' },
  { id:'blightfang',  name:'Blightfang',  title:'Swamp Serpent',      emoji:'🐍', hp:38, attack:14, defense:8,  magic:14, speed:12, ability:'Toxic Strike',   abilityDesc:'Inflicts poison for 3 turns',                       element:'poison' },
  { id:'pyrostorm',   name:'Pyrostorm',   title:'Fire Elemental',     emoji:'🔥', hp:40, attack:17, defense:9,  magic:12, speed:10, ability:'Firestorm',      abilityDesc:'Deals fire magic damage to all enemies',            element:'fire' },
  { id:'aetherwing',  name:'Aetherwing',  title:'Sky Dragon',         emoji:'🐲', hp:45, attack:14, defense:11, magic:14, speed:13, ability:'Sky Fire',       abilityDesc:'Attack + magic damage to flying enemies',           element:'celestial' },
  { id:'netherclaw',  name:'Netherclaw',  title:'Hell Panther',       emoji:'🐆', hp:36, attack:16, defense:10, magic:13, speed:14, ability:'Shadow Pounce',  abilityDesc:'High damage, ignores 5 defense',                    element:'dark' },
  { id:'glacierhorn', name:'Glacierhorn', title:'Ice Unicorn',        emoji:'🦄', hp:42, attack:12, defense:13, magic:15, speed:11, ability:'Frozen Charge',  abilityDesc:'Heavy magic attack, reduces enemy speed',           element:'ice' },
  { id:'stormspire',  name:'Stormspire',  title:'Lightning Golem',    emoji:'⚡', hp:50, attack:16, defense:14, magic:10, speed:9,  ability:'Electro Slam',   abilityDesc:'Attack + lightning damage to one enemy',            element:'storm' },
  { id:'mireling',    name:'Mireling',    title:'Swamp Sprite',       emoji:'🌿', hp:30, attack:8,  defense:7,  magic:17, speed:16, ability:'Mud Veil',       abilityDesc:'Increases own defense and lowers enemy accuracy',   element:'nature' },
];

// Get a random character (shuffled)
function getRandomCharacter() {
  const shuffled = [...CHARACTERS].sort(()=>Math.random()-0.5);
  // Slightly randomize stats
  const base = {...shuffled[0]};
  base.hp      += Math.floor(Math.random()*6)-2;
  base.attack  += Math.floor(Math.random()*4)-1;
  base.defense += Math.floor(Math.random()*4)-1;
  base.magic   += Math.floor(Math.random()*4)-1;
  base.speed   += Math.floor(Math.random()*4)-1;
  base.level   = 1;
  base.xp      = 0;
  base.xpToNext= 100;
  base.gold    = 0;
  base.upgrades = 0;
  return base;
}

// Cost to upgrade a character
function upgradeCost(currentLevel) {
  return 50 + (currentLevel * 30);
}

// Apply level-up to character
function upgradeCharacter(char) {
  const cost = upgradeCost(char.level || 1);
  if ((char.gold || 0) < cost) return { success: false, reason: `Need ${cost} Gold` };
  char.gold  -= cost;
  char.level  = (char.level || 1) + 1;
  char.hp     += Math.floor(5 + Math.random()*4);
  char.attack += Math.floor(2 + Math.random()*2);
  char.defense+= Math.floor(1 + Math.random()*2);
  char.magic  += Math.floor(2 + Math.random()*2);
  char.speed  += Math.floor(1 + Math.random()*2);
  char.upgrades = (char.upgrades||0) + 1;
  return { success: true, cost };
}

if(typeof module !== 'undefined') module.exports = { CHARACTERS, getRandomCharacter, upgradeCost, upgradeCharacter };
