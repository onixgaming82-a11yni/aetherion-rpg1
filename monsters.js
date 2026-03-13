// ============================================================
//  MONSTER DATABASE — 100 enemies + 4 bosses
//  Each entry: name, hp, attack, defense, magic, speed,
//              ability, levelRequirement, itemDrops, rarity
// ============================================================

const MONSTERS = [
  // ── TIER 1 (Lv 1-3) ──────────────────────────────────────
  { id:'goblin_grunt',   name:'Goblin Grunt',    hp:20, attack:5,  defense:3,  magic:0,  speed:6,  ability:'Quick Jab – Attacks twice',                     levelRequirement:1,  itemDrops:[{item:'Rusty Dagger',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],       xp:8,  gold:5  },
  { id:'cave_bat',       name:'Cave Bat',        hp:15, attack:3,  defense:2,  magic:0,  speed:10, ability:'Sonic Scream – Low damage to all',              levelRequirement:1,  itemDrops:[{item:'Bat Wing',rarity:'Common'},{item:'2 Gold',rarity:'Common'}],           xp:5,  gold:2  },
  { id:'shadow_rat',     name:'Shadow Rat',      hp:12, attack:3,  defense:1,  magic:0,  speed:12, ability:'Nibble – Low attack, chance to poison',         levelRequirement:1,  itemDrops:[{item:'Rat Tail',rarity:'Common'},{item:'2 Gold',rarity:'Common'}],           xp:4,  gold:2  },
  { id:'blood_rat',      name:'Blood Rat',       hp:15, attack:5,  defense:2,  magic:0,  speed:10, ability:'Bite – Chance to bleed',                        levelRequirement:1,  itemDrops:[{item:'Rat Tail',rarity:'Common'},{item:'2 Gold',rarity:'Common'}],           xp:5,  gold:2  },
  { id:'forest_spider',  name:'Forest Spider',   hp:18, attack:4,  defense:2,  magic:0,  speed:8,  ability:'Web Trap – Reduces enemy speed by 3',           levelRequirement:2,  itemDrops:[{item:'Spider Silk',rarity:'Common'},{item:'3 Gold',rarity:'Common'}],       xp:6,  gold:3  },
  { id:'stone_kobold',   name:'Stone Kobold',    hp:25, attack:6,  defense:5,  magic:0,  speed:4,  ability:'Rock Throw – Moderate attack',                  levelRequirement:2,  itemDrops:[{item:'Small Stone',rarity:'Common'},{item:'4 Gold',rarity:'Common'}],       xp:8,  gold:4  },
  { id:'swamp_slime',    name:'Swamp Slime',     hp:30, attack:5,  defense:4,  magic:0,  speed:3,  ability:'Ooze Smash – Moderate attack',                  levelRequirement:2,  itemDrops:[{item:'Slimy Goo',rarity:'Common'},{item:'3 Gold',rarity:'Common'}],        xp:9,  gold:3  },
  { id:'fire_imp',       name:'Fire Imp',        hp:22, attack:7,  defense:3,  magic:5,  speed:7,  ability:'Flame Flick – Fire dmg, chance to burn',        levelRequirement:3,  itemDrops:[{item:'Charcoal',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],         xp:10, gold:5  },
  { id:'ice_sprite',     name:'Ice Sprite',      hp:18, attack:4,  defense:2,  magic:8,  speed:8,  ability:'Frost Spark – Low magic dmg, slows enemy',      levelRequirement:3,  itemDrops:[{item:'Frost Crystal',rarity:'Common'},{item:'6 Gold',rarity:'Common'}],    xp:9,  gold:6  },
  { id:'cinder_goblin',  name:'Cinder Goblin',   hp:25, attack:7,  defense:3,  magic:5,  speed:6,  ability:'Fire Dart – Low fire magic',                    levelRequirement:3,  itemDrops:[{item:'Fire Shard',rarity:'Common'},{item:'4 Gold',rarity:'Common'}],       xp:9,  gold:4  },
  { id:'swamp_toad',     name:'Swamp Toad',      hp:25, attack:5,  defense:4,  magic:5,  speed:6,  ability:'Tongue Lash – Low dmg, chance to poison',       levelRequirement:3,  itemDrops:[{item:'Toad Leg',rarity:'Common'},{item:'4 Gold',rarity:'Common'}],        xp:8,  gold:4  },
  { id:'shadow_bat',     name:'Shadow Bat',      hp:20, attack:6,  defense:4,  magic:5,  speed:12, ability:'Dark Scream – Low magic damage',                levelRequirement:3,  itemDrops:[{item:'Bat Wing',rarity:'Common'},{item:'4 Gold',rarity:'Common'}],         xp:7,  gold:4  },
  { id:'venom_toad',     name:'Venom Toad',      hp:22, attack:6,  defense:3,  magic:5,  speed:6,  ability:'Poison Spit – Low magic dmg, poisons',          levelRequirement:3,  itemDrops:[{item:'Toad Venom',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],      xp:9,  gold:5  },
  { id:'wind_sprite',    name:'Wind Sprite',     hp:20, attack:5,  defense:4,  magic:8,  speed:12, ability:'Gust – Moderate attack + slow',                 levelRequirement:3,  itemDrops:[{item:'Feather',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],         xp:8,  gold:5  },
  // ── TIER 2 (Lv 4-6) ──────────────────────────────────────
  { id:'bandit_thief',   name:'Bandit Thief',    hp:28, attack:7,  defense:5,  magic:0,  speed:8,  ability:'Steal – Can steal 1 random item',               levelRequirement:4,  itemDrops:[{item:'Leather Gloves',rarity:'Common'},{item:'8 Gold',rarity:'Common'}],   xp:14, gold:8  },
  { id:'wind_hawk',      name:'Wind Hawk',       hp:22, attack:6,  defense:4,  magic:0,  speed:12, ability:'Gust – Light attack, may push back',            levelRequirement:4,  itemDrops:[{item:'Hawk Feather',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],    xp:10, gold:5  },
  { id:'mud_beast',      name:'Mud Beast',       hp:40, attack:8,  defense:6,  magic:0,  speed:4,  ability:'Mud Throw – Reduces enemy speed',               levelRequirement:4,  itemDrops:[{item:'Mud Clump',rarity:'Common'},{item:'6 Gold',rarity:'Common'}],      xp:14, gold:6  },
  { id:'blight_fungus',  name:'Blight Fungus',   hp:25, attack:4,  defense:4,  magic:6,  speed:3,  ability:'Spore Cloud – Low magic, chance to poison',     levelRequirement:4,  itemDrops:[{item:'Fungal Spores',rarity:'Common'},{item:'5 Gold',rarity:'Common'}],   xp:10, gold:5  },
  { id:'lightning_sprite',name:'Lightning Sprite',hp:20,attack:7, defense:3,  magic:12, speed:12, ability:'Spark Shock – Low lightning magic',             levelRequirement:4,  itemDrops:[{item:'Spark Crystal',rarity:'Common'},{item:'6 Gold',rarity:'Common'}],   xp:10, gold:6  },
  { id:'fire_beetle',    name:'Fire Beetle',     hp:28, attack:8,  defense:6,  magic:8,  speed:7,  ability:'Flame Spark – Low fire magic',                  levelRequirement:4,  itemDrops:[{item:'Fire Shard',rarity:'Rare'},{item:'8 Gold',rarity:'Common'}],       xp:12, gold:8  },
  { id:'forest_snake',   name:'Forest Snake',    hp:25, attack:8,  defense:5,  magic:0,  speed:10, ability:'Venom Bite – Chance to poison',                 levelRequirement:4,  itemDrops:[{item:'Snake Fang',rarity:'Common'},{item:'6 Gold',rarity:'Common'}],     xp:10, gold:6  },
  { id:'blood_goblin',   name:'Blood Goblin',    hp:28, attack:8,  defense:5,  magic:2,  speed:7,  ability:'Bloodlust – Raises attack by 3',               levelRequirement:5,  itemDrops:[{item:'Goblin Tooth',rarity:'Common'},{item:'6 Gold',rarity:'Common'}],   xp:12, gold:6  },
  { id:'forest_dryad',   name:'Forest Dryad',    hp:30, attack:5,  defense:5,  magic:10, speed:7,  ability:'Healing Leaves – Heals self 5 HP',             levelRequirement:5,  itemDrops:[{item:'Healing Herb',rarity:'Rare'},{item:'8 Gold',rarity:'Common'}],     xp:13, gold:8  },
  { id:'crystal_lizard', name:'Crystal Lizard',  hp:28, attack:6,  defense:8,  magic:5,  speed:6,  ability:'Crystal Spike – Moderate magic damage',         levelRequirement:5,  itemDrops:[{item:'Crystal Shard',rarity:'Rare'},{item:'10 Gold',rarity:'Common'}],   xp:13, gold:10 },
  { id:'shadow_spider',  name:'Shadow Spider',   hp:25, attack:8,  defense:4,  magic:6,  speed:10, ability:'Poison Bite – Chance to poison',               levelRequirement:5,  itemDrops:[{item:'Spider Fang',rarity:'Common'},{item:'8 Gold',rarity:'Common'}],    xp:11, gold:8  },
  { id:'fire_salamander',name:'Fire Salamander', hp:30, attack:8,  defense:5,  magic:10, speed:7,  ability:'Flame Tail – Fire damage',                      levelRequirement:5,  itemDrops:[{item:'Salamander Tail',rarity:'Rare'},{item:'10 Gold',rarity:'Common'}], xp:13, gold:10 },
  { id:'sand_scorpion',  name:'Sand Scorpion',   hp:30, attack:10, defense:8,  magic:0,  speed:8,  ability:'Sting – Chance to poison',                      levelRequirement:5,  itemDrops:[{item:'Scorpion Claw',rarity:'Common'},{item:'10 Gold',rarity:'Common'}], xp:13, gold:10 },
  { id:'stone_spider',   name:'Stone Spider',    hp:35, attack:10, defense:10, magic:0,  speed:6,  ability:'Web Slam – Reduces enemy speed',                levelRequirement:5,  itemDrops:[{item:'Spider Fang',rarity:'Common'},{item:'10 Gold',rarity:'Common'}],   xp:14, gold:10 },
  { id:'rock_beetle',    name:'Rock Beetle',     hp:30, attack:9,  defense:12, magic:0,  speed:4,  ability:'Shell Crush – Reduces enemy attack',            levelRequirement:5,  itemDrops:[{item:'Beetle Shell',rarity:'Common'},{item:'8 Gold',rarity:'Common'}],   xp:12, gold:8  },
  { id:'dark_wolf',      name:'Dark Wolf',       hp:35, attack:9,  defense:6,  magic:0,  speed:10, ability:'Fang Bite – High attack, chance to bleed',      levelRequirement:5,  itemDrops:[{item:'Wolf Pelt',rarity:'Rare'},{item:'10 Gold',rarity:'Common'}],       xp:14, gold:10 },
  { id:'lava_hound',     name:'Lava Hound',      hp:35, attack:10, defense:5,  magic:8,  speed:8,  ability:'Lava Bite – Fire attack with burn chance',      levelRequirement:6,  itemDrops:[{item:'Hound Fang',rarity:'Rare'},{item:'12 Gold',rarity:'Common'}],     xp:16, gold:12 },
  { id:'night_stalker',  name:'Night Stalker',   hp:32, attack:9,  defense:5,  magic:0,  speed:12, ability:'Shadow Slash – High attack in darkness',        levelRequirement:6,  itemDrops:[{item:'Dark Fang',rarity:'Rare'},{item:'15 Gold',rarity:'Common'}],      xp:16, gold:15 },
  { id:'stone_fang',     name:'Stone Fang',      hp:45, attack:12, defense:14, magic:0,  speed:5,  ability:'Rock Bite – High physical damage',              levelRequirement:6,  itemDrops:[{item:'Stone Fang',rarity:'Common'},{item:'12 Gold',rarity:'Common'}],   xp:17, gold:12 },
  { id:'iron_beetle',    name:'Iron Beetle',     hp:40, attack:10, defense:15, magic:0,  speed:4,  ability:'Shell Bash – Heavy physical attack',            levelRequirement:6,  itemDrops:[{item:'Beetle Shell',rarity:'Rare'},{item:'12 Gold',rarity:'Common'}],   xp:16, gold:12 },
  { id:'cave_serpent',   name:'Cave Serpent',    hp:35, attack:10, defense:6,  magic:0,  speed:8,  ability:'Venom Bite – Chance to poison',                 levelRequirement:6,  itemDrops:[{item:'Serpent Fang',rarity:'Common'},{item:'12 Gold',rarity:'Common'}], xp:15, gold:12 },
  { id:'ice_wolf',       name:'Ice Wolf',        hp:35, attack:10, defense:8,  magic:10, speed:10, ability:'Frost Bite – Lowers enemy speed',               levelRequirement:6,  itemDrops:[{item:'Wolf Pelt',rarity:'Rare'},{item:'12 Gold',rarity:'Common'}],      xp:16, gold:12 },
  { id:'mud_worm',       name:'Mud Worm',        hp:40, attack:9,  defense:7,  magic:0,  speed:5,  ability:'Swamp Crush – Lowers enemy speed',              levelRequirement:6,  itemDrops:[{item:'Worm Meat',rarity:'Common'},{item:'8 Gold',rarity:'Common'}],     xp:14, gold:8  },
  { id:'lava_beetle',    name:'Lava Beetle',     hp:35, attack:10, defense:8,  magic:10, speed:8,  ability:'Lava Bite – Fire damage',                       levelRequirement:6,  itemDrops:[{item:'Lava Shard',rarity:'Rare'},{item:'12 Gold',rarity:'Common'}],    xp:16, gold:12 },
  // ── TIER 3 (Lv 7-9) ──────────────────────────────────────
  { id:'swamp_hydra',    name:'Swamp Hydra',     hp:60, attack:12, defense:8,  magic:10, speed:6,  ability:'Poison Bite – Poisons enemy',                   levelRequirement:7,  itemDrops:[{item:'Hydra Scale',rarity:'Rare'},{item:'20 Gold',rarity:'Common'}],    xp:25, gold:20 },
  { id:'thunder_serpent',name:'Thunder Serpent', hp:40, attack:12, defense:6,  magic:10, speed:9,  ability:'Lightning Strike – Moderate magic damage',      levelRequirement:7,  itemDrops:[{item:'Serpent Fang',rarity:'Rare'},{item:'15 Gold',rarity:'Common'}],  xp:20, gold:15 },
  { id:'mud_golem',      name:'Mud Golem',       hp:50, attack:10, defense:12, magic:0,  speed:3,  ability:'Mud Slam – Reduces enemy speed',                levelRequirement:7,  itemDrops:[{item:'Mud Chunk',rarity:'Common'},{item:'10 Gold',rarity:'Common'}],   xp:18, gold:10 },
  { id:'blaze_scorpion', name:'Blaze Scorpion',  hp:40, attack:12, defense:7,  magic:10, speed:9,  ability:'Flame Sting – Fire damage and burn chance',     levelRequirement:7,  itemDrops:[{item:'Scorpion Stinger',rarity:'Rare'},{item:'12 Gold',rarity:'Common'}],xp:20,gold:12 },
  { id:'troll_brute',    name:'Troll Brute',     hp:50, attack:12, defense:10, magic:0,  speed:3,  ability:'Club Smash – Heavy attack, chance to stun',     levelRequirement:6,  itemDrops:[{item:'Troll Tooth',rarity:'Rare'},{item:'15 Gold',rarity:'Common'}],   xp:20, gold:15 },
  { id:'frost_spider',   name:'Frost Spider',    hp:28, attack:9,  defense:6,  magic:8,  speed:10, ability:'Ice Web – Slows enemy heavily',                 levelRequirement:6,  itemDrops:[{item:'Frozen Silk',rarity:'Rare'},{item:'10 Gold',rarity:'Common'}],   xp:16, gold:10 },
  { id:'storm_harpy',    name:'Storm Harpy',     hp:42, attack:12, defense:8,  magic:12, speed:14, ability:'Lightning Screech – Lightning damage to all',   levelRequirement:8,  itemDrops:[{item:'Harpy Feather',rarity:'Rare'},{item:'16 Gold',rarity:'Common'}],  xp:22, gold:16 },
  { id:'fire_drake',     name:'Fire Drake',      hp:45, attack:15, defense:8,  magic:12, speed:10, ability:'Fire Breath – High fire magic attack',          levelRequirement:8,  itemDrops:[{item:'Drake Scale',rarity:'Rare'},{item:'20 Gold',rarity:'Common'}],    xp:26, gold:20 },
  { id:'ice_gargoyle',   name:'Ice Gargoyle',    hp:50, attack:12, defense:15, magic:5,  speed:4,  ability:'Ice Slam – Heavy attack, slows enemy',          levelRequirement:8,  itemDrops:[{item:'Ice Fragment',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],   xp:24, gold:18 },
  { id:'stone_golem',    name:'Stone Golem',     hp:60, attack:14, defense:18, magic:0,  speed:2,  ability:'Rock Slam – Heavy physical attack',             levelRequirement:8,  itemDrops:[{item:'Stone Fragment',rarity:'Rare'},{item:'15 Gold',rarity:'Common'}], xp:24, gold:15 },
  { id:'cave_troll',     name:'Cave Troll',      hp:60, attack:15, defense:12, magic:0,  speed:3,  ability:'Club Slam – Heavy attack',                      levelRequirement:8,  itemDrops:[{item:'Troll Tooth',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],   xp:24, gold:18 },
  { id:'frost_drake',    name:'Frost Drake',     hp:50, attack:12, defense:10, magic:15, speed:8,  ability:'Ice Breath – Ice magic damage',                 levelRequirement:8,  itemDrops:[{item:'Drake Scale',rarity:'Epic'},{item:'20 Gold',rarity:'Common'}],    xp:26, gold:20 },
  { id:'ice_golem',      name:'Ice Golem',       hp:60, attack:12, defense:18, magic:5,  speed:3,  ability:'Frost Slam – Heavy ice damage',                 levelRequirement:8,  itemDrops:[{item:'Ice Fragment',rarity:'Epic'},{item:'20 Gold',rarity:'Common'}],   xp:26, gold:20 },
  { id:'wind_drake',     name:'Wind Drake',      hp:45, attack:14, defense:8,  magic:12, speed:12, ability:'Sky Slash – Attack + magic',                    levelRequirement:8,  itemDrops:[{item:'Drake Feather',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],  xp:24, gold:18 },
  { id:'thunder_beetle', name:'Thunder Beetle',  hp:30, attack:10, defense:8,  magic:10, speed:9,  ability:'Electric Shock – Low lightning magic',          levelRequirement:5,  itemDrops:[{item:'Spark Crystal',rarity:'Rare'},{item:'10 Gold',rarity:'Common'}],  xp:14, gold:10 },
  { id:'fire_wraith',    name:'Fire Wraith',     hp:40, attack:12, defense:6,  magic:16, speed:12, ability:'Inferno Touch – Heavy fire magic',              levelRequirement:9,  itemDrops:[{item:'Fire Essence',rarity:'Epic'},{item:'20 Gold',rarity:'Common'}],   xp:28, gold:20 },
  { id:'ice_serpent',    name:'Ice Serpent',     hp:50, attack:13, defense:9,  magic:12, speed:10, ability:'Frozen Bite – Freezes enemy briefly',           levelRequirement:9,  itemDrops:[{item:'Ice Fang',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],      xp:26, gold:18 },
  { id:'dark_assassin',  name:'Dark Assassin',   hp:38, attack:16, defense:6,  magic:5,  speed:16, ability:'Shadow Strike – High critical damage',          levelRequirement:10, itemDrops:[{item:'Assassin Dagger',rarity:'Epic'},{item:'22 Gold',rarity:'Common'}], xp:30, gold:22 },
  { id:'thunder_wolf',   name:'Thunder Wolf',    hp:45, attack:14, defense:8,  magic:10, speed:13, ability:'Lightning Bite – Lightning damage',             levelRequirement:9,  itemDrops:[{item:'Wolf Fang',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],     xp:26, gold:18 },
  { id:'venom_scorpion', name:'Venom Scorpion',  hp:45, attack:14, defense:9,  magic:6,  speed:12, ability:'Deadly Sting – Strong poison',                  levelRequirement:8,  itemDrops:[{item:'Venom Gland',rarity:'Rare'},{item:'16 Gold',rarity:'Common'}],   xp:22, gold:16 },
  { id:'ghost_spirit',   name:'Ghost Spirit',    hp:35, attack:10, defense:4,  magic:18, speed:14, ability:'Spirit Drain – Steals HP',                      levelRequirement:9,  itemDrops:[{item:'Spirit Dust',rarity:'Epic'},{item:'18 Gold',rarity:'Common'}],   xp:26, gold:18 },
  // ── TIER 4 (Lv 10-14) ────────────────────────────────────
  { id:'swamp_ogre',     name:'Swamp Ogre',      hp:70, attack:15, defense:12, magic:0,  speed:4,  ability:'Mud Smash – Slows enemy',                       levelRequirement:10, itemDrops:[{item:'Ogre Club',rarity:'Rare'},{item:'25 Gold',rarity:'Common'}],     xp:34, gold:25 },
  { id:'sand_golem',     name:'Sand Golem',      hp:55, attack:13, defense:14, magic:4,  speed:5,  ability:'Sandstorm – Reduces enemy accuracy',            levelRequirement:9,  itemDrops:[{item:'Sand Core',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],     xp:26, gold:18 },
  { id:'necro_mage',     name:'Necro Mage',      hp:35, attack:8,  defense:5,  magic:18, speed:10, ability:'Dark Bolt – Shadow magic',                      levelRequirement:10, itemDrops:[{item:'Dark Crystal',rarity:'Epic'},{item:'22 Gold',rarity:'Common'}],  xp:30, gold:22 },
  { id:'shadow_panther', name:'Shadow Panther',  hp:50, attack:18, defense:9,  magic:6,  speed:17, ability:'Dark Pounce – Massive attack',                  levelRequirement:11, itemDrops:[{item:'Panther Fang',rarity:'Epic'},{item:'25 Gold',rarity:'Common'}],  xp:36, gold:25 },
  { id:'crystal_golem',  name:'Crystal Golem',   hp:65, attack:14, defense:18, magic:10, speed:3,  ability:'Crystal Burst – Magic explosion attack',        levelRequirement:11, itemDrops:[{item:'Crystal Core',rarity:'Epic'},{item:'28 Gold',rarity:'Common'}],  xp:38, gold:28 },
  { id:'iron_golem',     name:'Iron Golem',      hp:80, attack:16, defense:20, magic:0,  speed:2,  ability:'Iron Slam – Massive physical damage',           levelRequirement:12, itemDrops:[{item:'Iron Chunk',rarity:'Epic'},{item:'30 Gold',rarity:'Common'}],    xp:42, gold:30 },
  { id:'flame_drake',    name:'Flame Drake',     hp:60, attack:18, defense:10, magic:14, speed:9,  ability:'Fire Breath – Strong fire magic',               levelRequirement:12, itemDrops:[{item:'Drake Flame Scale',rarity:'Epic'},{item:'30 Gold',rarity:'Common'}],xp:42,gold:30},
  { id:'poison_hydra',   name:'Poison Hydra',    hp:85, attack:16, defense:12, magic:14, speed:7,  ability:'Venom Spray – Poisons all enemies',             levelRequirement:13, itemDrops:[{item:'Hydra Venom',rarity:'Epic'},{item:'35 Gold',rarity:'Common'}],   xp:48, gold:35 },
  { id:'sand_worm',      name:'Sand Worm',       hp:80, attack:18, defense:12, magic:6,  speed:6,  ability:'Sand Devour – Heavy damage',                    levelRequirement:13, itemDrops:[{item:'Worm Tooth',rarity:'Rare'},{item:'30 Gold',rarity:'Common'}],    xp:44, gold:30 },
  { id:'magma_beast',    name:'Magma Beast',     hp:75, attack:20, defense:14, magic:15, speed:6,  ability:'Lava Burst – Fire explosion',                   levelRequirement:14, itemDrops:[{item:'Magma Core',rarity:'Epic'},{item:'40 Gold',rarity:'Common'}],    xp:52, gold:40 },
  { id:'bone_skeleton',  name:'Bone Skeleton',   hp:40, attack:12, defense:8,  magic:5,  speed:9,  ability:'Bone Throw – Ranged attack',                    levelRequirement:7,  itemDrops:[{item:'Bone Fragment',rarity:'Common'},{item:'12 Gold',rarity:'Common'}],xp:20, gold:12 },
  { id:'thunder_eagle',  name:'Thunder Eagle',   hp:45, attack:14, defense:7,  magic:12, speed:16, ability:'Sky Shock – Lightning strike',                  levelRequirement:9,  itemDrops:[{item:'Eagle Feather',rarity:'Rare'},{item:'18 Gold',rarity:'Common'}],  xp:24, gold:18 },
  { id:'blizzard_yeti',  name:'Blizzard Yeti',   hp:90, attack:18, defense:15, magic:10, speed:5,  ability:'Ice Smash – Freezing damage',                   levelRequirement:14, itemDrops:[{item:'Yeti Fur',rarity:'Epic'},{item:'35 Gold',rarity:'Common'}],     xp:52, gold:35 },
  // ── TIER 5 (Lv 15-19) ────────────────────────────────────
  { id:'fire_elemental', name:'Fire Elemental',  hp:60, attack:16, defense:8,  magic:18, speed:10, ability:'Flame Wave – Fire damage to all',               levelRequirement:12, itemDrops:[{item:'Fire Core',rarity:'Epic'},{item:'28 Gold',rarity:'Common'}],     xp:40, gold:28 },
  { id:'ice_elemental',  name:'Ice Elemental',   hp:60, attack:14, defense:10, magic:18, speed:9,  ability:'Frost Wave – Slows enemies',                    levelRequirement:12, itemDrops:[{item:'Ice Core',rarity:'Epic'},{item:'28 Gold',rarity:'Common'}],      xp:40, gold:28 },
  { id:'storm_elemental',name:'Storm Elemental', hp:60, attack:15, defense:9,  magic:18, speed:12, ability:'Thunder Blast – Lightning magic',               levelRequirement:12, itemDrops:[{item:'Storm Core',rarity:'Epic'},{item:'30 Gold',rarity:'Common'}],    xp:42, gold:30 },
  { id:'shadow_knight',  name:'Shadow Knight',   hp:70, attack:20, defense:14, magic:8,  speed:8,  ability:'Dark Slash – Heavy attack',                     levelRequirement:13, itemDrops:[{item:'Dark Blade',rarity:'Epic'},{item:'35 Gold',rarity:'Common'}],    xp:48, gold:35 },
  { id:'crystal_dragonling',name:'Crystal Dragonling',hp:55,attack:16,defense:14,magic:14,speed:10,ability:'Crystal Beam – Magic laser',                    levelRequirement:12, itemDrops:[{item:'Dragon Crystal',rarity:'Epic'},{item:'32 Gold',rarity:'Common'}], xp:44, gold:32 },
  { id:'thunder_golem',  name:'Thunder Golem',   hp:90, attack:20, defense:20, magic:10, speed:4,  ability:'Electric Slam – Lightning damage',              levelRequirement:15, itemDrops:[{item:'Thunder Core',rarity:'Epic'},{item:'45 Gold',rarity:'Common'}],  xp:58, gold:45 },
  { id:'blaze_phoenix',  name:'Blaze Phoenix',   hp:70, attack:18, defense:12, magic:20, speed:15, ability:'Phoenix Flame – Massive fire attack',           levelRequirement:15, itemDrops:[{item:'Phoenix Feather',rarity:'Epic'},{item:'50 Gold',rarity:'Common'}],xp:62, gold:50 },
  { id:'frozen_dragon',  name:'Frozen Dragon',   hp:95, attack:20, defense:16, magic:20, speed:8,  ability:'Ice Breath – Freezing attack',                  levelRequirement:16, itemDrops:[{item:'Dragon Ice Scale',rarity:'Epic'},{item:'55 Gold',rarity:'Common'}],xp:68,gold:55},
  { id:'golden_griffin', name:'Golden Griffin',  hp:90, attack:20, defense:16, magic:15, speed:17, ability:'Sky Strike – Powerful aerial attack',           levelRequirement:17, itemDrops:[{item:'Griffin Feather',rarity:'Epic'},{item:'65 Gold',rarity:'Common'}], xp:72, gold:65 },
  { id:'storm_dragon',   name:'Storm Dragon',    hp:110,attack:22, defense:18, magic:22, speed:12, ability:'Thunder Storm – Lightning attack all',          levelRequirement:17, itemDrops:[{item:'Storm Scale',rarity:'Mythic'},{item:'65 Gold',rarity:'Common'}],  xp:80, gold:65 },
  // ── TIER 6 (Lv 18-26) ────────────────────────────────────
  { id:'lava_titan',     name:'Lava Titan',      hp:120,attack:25, defense:20, magic:18, speed:4,  ability:'Lava Quake – Fire earth attack',                levelRequirement:18, itemDrops:[{item:'Titan Core',rarity:'Mythic'},{item:'70 Gold',rarity:'Common'}],   xp:90, gold:70 },
  { id:'shadow_reaper',  name:'Shadow Reaper',   hp:80, attack:24, defense:12, magic:20, speed:18, ability:'Soul Slash – Massive shadow damage',            levelRequirement:18, itemDrops:[{item:'Reaper Blade',rarity:'Mythic'},{item:'70 Gold',rarity:'Common'}], xp:90, gold:70 },
  { id:'ancient_treant', name:'Ancient Treant',  hp:140,attack:18, defense:24, magic:10, speed:3,  ability:'Root Crush – Immobilizes enemy',               levelRequirement:18, itemDrops:[{item:'Ancient Bark',rarity:'Epic'},{item:'60 Gold',rarity:'Common'}],   xp:85, gold:60 },
  { id:'crystal_hydra',  name:'Crystal Hydra',   hp:150,attack:22, defense:20, magic:18, speed:8,  ability:'Multi Bite – Attacks multiple times',           levelRequirement:19, itemDrops:[{item:'Hydra Crystal',rarity:'Mythic'},{item:'75 Gold',rarity:'Common'}],xp:95, gold:75 },
  { id:'nether_demon',   name:'Nether Demon',    hp:130,attack:26, defense:18, magic:22, speed:10, ability:'Hellfire – Massive fire magic',                 levelRequirement:20, itemDrops:[{item:'Demon Horn',rarity:'Mythic'},{item:'80 Gold',rarity:'Common'}],   xp:100,gold:80 },
  { id:'frost_titan',    name:'Frost Titan',     hp:160,attack:24, defense:24, magic:18, speed:5,  ability:'Ice Quake – Huge ice attack',                   levelRequirement:20, itemDrops:[{item:'Titan Ice Core',rarity:'Mythic'},{item:'85 Gold',rarity:'Common'}],xp:105,gold:85 },
  { id:'thunder_colossus',name:'Thunder Colossus',hp:170,attack:26,defense:26, magic:20, speed:4,  ability:'Lightning Crash – Massive lightning damage',    levelRequirement:21, itemDrops:[{item:'Colossus Core',rarity:'Mythic'},{item:'90 Gold',rarity:'Common'}], xp:110,gold:90 },
  { id:'void_serpent',   name:'Void Serpent',    hp:140,attack:28, defense:16, magic:24, speed:15, ability:'Void Bite – Dark magic damage',                 levelRequirement:21, itemDrops:[{item:'Void Fang',rarity:'Mythic'},{item:'90 Gold',rarity:'Common'}],   xp:110,gold:90 },
  { id:'ancient_dragon', name:'Ancient Dragon',  hp:200,attack:30, defense:22, magic:25, speed:12, ability:'Dragon Fury – Massive damage',                  levelRequirement:22, itemDrops:[{item:'Dragon Heart',rarity:'Mythic'},{item:'120 Gold',rarity:'Common'}], xp:130,gold:120},
  { id:'shadow_titan',   name:'Shadow Titan',    hp:220,attack:32, defense:24, magic:22, speed:8,  ability:'Dark Quake – Massive shadow damage',            levelRequirement:23, itemDrops:[{item:'Titan Shadow Core',rarity:'Mythic'},{item:'130 Gold',rarity:'Common'}],xp:140,gold:130},
  { id:'celestial_griffin',name:'Celestial Griffin',hp:160,attack:28,defense:20,magic:24,speed:20,ability:'Star Strike – Light magic attack',              levelRequirement:22, itemDrops:[{item:'Celestial Feather',rarity:'Mythic'},{item:'110 Gold',rarity:'Common'}],xp:125,gold:110},
  { id:'void_reaper',    name:'Void Reaper',     hp:150,attack:30, defense:18, magic:26, speed:22, ability:'Soul Harvest – Steals HP massively',            levelRequirement:23, itemDrops:[{item:'Reaper Soul Gem',rarity:'Mythic'},{item:'120 Gold',rarity:'Common'}],xp:130,gold:120},
  { id:'inferno_dragon', name:'Inferno Dragon',  hp:230,attack:35, defense:26, magic:28, speed:14, ability:'Inferno Storm – Massive fire attack',           levelRequirement:24, itemDrops:[{item:'Inferno Scale',rarity:'Mythic'},{item:'150 Gold',rarity:'Common'}], xp:155,gold:150},
  { id:'frozen_leviathan',name:'Frozen Leviathan',hp:260,attack:34,defense:30,magic:28, speed:8,  ability:'Arctic Wave – Freezing water attack',           levelRequirement:25, itemDrops:[{item:'Leviathan Ice Core',rarity:'Mythic'},{item:'160 Gold',rarity:'Common'}],xp:165,gold:160},
  { id:'storm_leviathan',name:'Storm Leviathan', hp:260,attack:36, defense:28, magic:30, speed:12, ability:'Thunder Tsunami – Lightning water attack',       levelRequirement:25, itemDrops:[{item:'Leviathan Storm Core',rarity:'Mythic'},{item:'160 Gold',rarity:'Common'}],xp:165,gold:160},
  { id:'abyss_demon',    name:'Abyss Demon',     hp:240,attack:38, defense:24, magic:32, speed:18, ability:'Abyss Flame – Dark fire magic',                 levelRequirement:26, itemDrops:[{item:'Abyss Crystal',rarity:'Mythic'},{item:'170 Gold',rarity:'Common'}], xp:175,gold:170},
  { id:'void_dragon_king',name:'Void Dragon King',hp:300,attack:42,defense:32, magic:35, speed:16, ability:'Void Apocalypse – Massive void damage',         levelRequirement:28, itemDrops:[{item:'Void King Scale',rarity:'Mythic'},{item:'200 Gold',rarity:'Common'}],xp:200,gold:200},
  { id:'world_ender_titan',name:'World Ender Titan',hp:500,attack:50,defense:40,magic:40,speed:10,ability:'Cataclysm – Huge damage to all enemies',         levelRequirement:30, itemDrops:[{item:'Titan Heart',rarity:'Mythic'},{item:'Legendary Weapon',rarity:'Mythic'},{item:'500 Gold',rarity:'Common'}],xp:300,gold:500}
];

// ============================================================
//  BOSS DATABASE — 4 Main Bosses with phases
// ============================================================
const BOSSES = [
  {
    id: 'emberlord_volkar',
    name: 'Emberlord Volkar',
    title: 'The Celestial Dragon',
    hp: 600, attack: 55, defense: 35, magic: 45, speed: 12,
    ability: 'Inferno Cataclysm',
    abilityDesc: 'Unleashes a massive fire blast hitting all enemies, burning them for 3 turns',
    levelRequirement: 32,
    xp: 500, gold: 800,
    itemDrops: [
      { item: "Volkar's Flame Core", rarity: 'Mythic' },
      { item: 'Legendary Fire Sword', rarity: 'Mythic' },
      { item: '800 Gold', rarity: 'Common' }
    ],
    phases: [
      { threshold: 1.0, name: 'Smoldering Rage',    desc: 'Volkar awakens, lava dripping from his scales.',     abilityMult: 1.0 },
      { threshold: 0.6, name: 'Blazing Wrath',       desc: 'Volkar\'s flames intensify — the air shimmers!',     abilityMult: 1.3 },
      { threshold: 0.3, name: 'Inferno Ascension',   desc: 'Volkar ascends! His attacks become catastrophic!',   abilityMult: 1.6 }
    ],
    emoji: '🐉'
  },
  {
    id: 'glacius_frozen_tyrant',
    name: 'Glacius the Frozen Tyrant',
    title: 'The Ice Sovereign',
    hp: 650, attack: 50, defense: 45, magic: 48, speed: 10,
    ability: 'Absolute Zero',
    abilityDesc: 'Freezes all enemies for 1 turn and deals heavy ice damage',
    levelRequirement: 34,
    xp: 550, gold: 900,
    itemDrops: [
      { item: 'Tyrant Ice Crown', rarity: 'Mythic' },
      { item: 'Frozen Dragon Scale Armor', rarity: 'Mythic' },
      { item: '900 Gold', rarity: 'Common' }
    ],
    phases: [
      { threshold: 1.0, name: 'Arctic Presence',    desc: 'Glacius surveys you with cold, ancient eyes.',        abilityMult: 1.0 },
      { threshold: 0.65,name: 'Blizzard Form',      desc: 'Glacius encases himself in a shell of black ice!',   abilityMult: 1.4 },
      { threshold: 0.25,name: 'Absolute Dominion',  desc: 'The temperature drops to impossible lows!',          abilityMult: 1.8 }
    ],
    emoji: '❄️'
  },
  {
    id: 'zythera_storm_queen',
    name: 'Zythera the Storm Queen',
    title: 'Mistress of Thunder',
    hp: 620, attack: 48, defense: 32, magic: 55, speed: 20,
    ability: 'Tempest Fury',
    abilityDesc: 'Summons lightning storms striking random enemies multiple times',
    levelRequirement: 35,
    xp: 580, gold: 1000,
    itemDrops: [
      { item: 'Storm Queen Feather', rarity: 'Mythic' },
      { item: 'Thunder Staff', rarity: 'Mythic' },
      { item: '1000 Gold', rarity: 'Common' }
    ],
    phases: [
      { threshold: 1.0, name: 'Gathering Storm',   desc: 'Zythera summons storm clouds above the arena.',      abilityMult: 1.0 },
      { threshold: 0.6, name: 'Eye of the Storm',  desc: 'Lightning rains down continuously!',                 abilityMult: 1.35 },
      { threshold: 0.3, name: 'Apocalypse Storm',  desc: 'Zythera becomes one with the storm itself!',         abilityMult: 1.7 }
    ],
    emoji: '⚡'
  },
  {
    id: 'malzor_abyss_king',
    name: 'Malzor the Abyss King',
    title: 'Final Boss — Lord of Darkness',
    hp: 800, attack: 65, defense: 50, magic: 60, speed: 15,
    ability: 'Abyssal Ruin',
    abilityDesc: 'Massive dark energy attack that drains 20 HP from all enemies and heals Malzor',
    levelRequirement: 40,
    xp: 1000, gold: 2000,
    itemDrops: [
      { item: 'Abyss King Crown', rarity: 'Mythic' },
      { item: 'Mythic Dark Blade', rarity: 'Mythic' },
      { item: '2000 Gold', rarity: 'Common' }
    ],
    phases: [
      { threshold: 1.0, name: 'Veiled Malice',     desc: 'Malzor rises from the abyss, reality fracturing.',   abilityMult: 1.0 },
      { threshold: 0.7, name: 'Unshackled Rage',   desc: 'Malzor sheds his mortal form — pure darkness!',      abilityMult: 1.4 },
      { threshold: 0.4, name: 'Void Incarnate',    desc: 'The abyss consumes everything around him!',           abilityMult: 1.7 },
      { threshold: 0.15,name: 'Last Breath of Evil','Malzor\'s attacks are now completely unhinged!',           abilityMult: 2.2 }
    ],
    emoji: '👿'
  }
];

// Helper: get monsters available at player level
function getMonstersForLevel(playerLevel) {
  return MONSTERS.filter(m => m.levelRequirement <= playerLevel);
}

// Helper: pick random monster for level
function getRandomMonster(playerLevel) {
  const available = getMonstersForLevel(playerLevel);
  // Bias towards higher-level monsters
  const weighted = available.map(m => ({
    ...m,
    weight: Math.max(1, 5 - Math.abs(m.levelRequirement - playerLevel))
  }));
  const total = weighted.reduce((s,m)=>s+m.weight,0);
  let r = Math.random() * total;
  for(const m of weighted){ r-=m.weight; if(r<=0) return {...m}; }
  return {...available[available.length-1]};
}

if(typeof module !== 'undefined') module.exports = { MONSTERS, BOSSES, getMonstersForLevel, getRandomMonster };
