// Tunables for weapons, classes and the Terminator (终结者) zombie-mode rules.

export const RULES = {
  prepTime: 20,          // 倒计时 20 秒后出现生化幽灵
  roundTime: 180,        // 回合时长
  endTime: 7,            // 结算展示
  zombieRespawn: 2.5,    // 非近战击杀 → 复活
  hunterRatio: 0.2,      // 剩余人类 ≤ 20% 时可按 E 变身幽灵猎手
  moraleThreshold: 3,    // 剩余 ≤3 名人类时 攻击力 +10%
  moraleBonus: 0.1,
  evolveAt: [3, 5],      // 感染 3 / 5 人进化
  winTarget: 7,
  supplyInterval: 35,
};

export const WEAPONS = {
  ak47: {
    name: 'AK-47', slot: 1, kind: 'gun', dmg: 42, head: 2.6, rpm: 600, mag: 30, reserve: 300, reload: 2.4,
    spread: { base: 0.0035, move: 0.035, air: 0.12, crouch: 0.55, shot: 0.0042, max: 0.06, recover: 5.5 },
    recoil: { pitch: 0.0105, yaw: 0.0055 }, knock: 1.25, speed: 0.95, range: 220, auto: true, sound: 'shot_ak47', reloadSound: 'reload_rifle',
  },
  m4a1: {
    name: 'M4A1', slot: 1, kind: 'gun', dmg: 36, head: 2.8, rpm: 720, mag: 30, reserve: 300, reload: 2.3,
    spread: { base: 0.0028, move: 0.03, air: 0.11, crouch: 0.55, shot: 0.0033, max: 0.05, recover: 6.5 },
    recoil: { pitch: 0.0085, yaw: 0.0042 }, knock: 1.0, speed: 0.97, range: 220, auto: true, sound: 'shot_m4a1', reloadSound: 'reload_rifle',
  },
  mg3: {
    name: 'MG3', slot: 1, kind: 'gun', dmg: 34, head: 2.4, rpm: 950, mag: 120, reserve: 480, reload: 4.2,
    spread: { base: 0.006, move: 0.05, air: 0.14, crouch: 0.5, shot: 0.0026, max: 0.07, recover: 5 },
    recoil: { pitch: 0.0075, yaw: 0.007 }, knock: 0.95, speed: 0.86, range: 200, auto: true, sound: 'shot_mg3', reloadSound: 'reload_mg',
  },
  deagle: {
    name: 'Desert Eagle', slot: 2, kind: 'gun', dmg: 70, head: 3.0, rpm: 260, mag: 7, reserve: 70, reload: 1.8,
    spread: { base: 0.003, move: 0.03, air: 0.12, crouch: 0.6, shot: 0.02, max: 0.06, recover: 7 },
    recoil: { pitch: 0.03, yaw: 0.008 }, knock: 1.8, speed: 1.0, range: 150, auto: false, sound: 'shot_deagle', reloadSound: 'reload_pistol',
  },
  knife: {
    name: 'M9 军刀', slot: 3, kind: 'melee', speed: 1.08,
    light: { dmg: 260, range: 1.9, rate: 0.42, angle: 0.62 },
    heavy: { dmg: 700, range: 1.6, rate: 1.05, angle: 0.5 },
  },
  grenade: { name: 'HE 手雷', slot: 4, kind: 'grenade', speed: 1.0, dmg: 900, radius: 7, knock: 14, fuse: 1.6 },
  claws: {
    name: '利爪', slot: 3, kind: 'melee', speed: 1.0,
    light: { dmg: 120, range: 1.9, rate: 0.5, angle: 0.7 },
    heavy: { dmg: 250, range: 2.5, rate: 1.1, angle: 0.55 },
  },
  fists: {
    name: '电击', slot: 3, kind: 'melee', speed: 1.0,
    light: { dmg: 260, range: 2.4, rate: 0.55, angle: 0.75 },
    heavy: { dmg: 600, range: 3.3, rate: 1.2, angle: 0.6 },
  },
  blade: {
    name: '猎手之刃', slot: 3, kind: 'melee', speed: 1.0,
    light: { dmg: 1900, range: 2.5, rate: 0.55, angle: 0.75 },
    heavy: { dmg: 4600, range: 3.0, rate: 1.2, angle: 0.6 },
  },
};

export const PRIMARIES = ['ak47', 'm4a1', 'mg3'];

// Character classes
export const CLASSES = {
  human: { team: 'H', hp: 100, speed: 5.0, jump: 7.0, radius: 0.35, height: 1.8, crouch: 1.25, gravity: 20, label: '佣兵' },
  hunter: { team: 'H', hp: 2500, speed: 5.9, jump: 7.6, radius: 0.37, height: 1.9, crouch: 1.3, gravity: 20, label: '幽灵猎手' },
  zombie: { team: 'Z', hp: 3200, speed: 5.55, jump: 8.3, radius: 0.4, height: 1.95, crouch: 1.35, gravity: 20, label: '生化幽灵' },
  mother: { team: 'Z', hp: 5200, speed: 5.65, jump: 8.3, radius: 0.42, height: 2.05, crouch: 1.4, gravity: 20, label: '母体幽灵' },
  terminator: { team: 'Z', hp: 9000, speed: 5.9, jump: 8.0, radius: 0.55, height: 2.5, crouch: 1.8, gravity: 20, label: '终结者' },
};

export const ZOMBIE_LEVEL_HP = [1, 1.4, 1.85];     // hp multiplier by evolve level
export const ZOMBIE_LEVEL_SPEED = [1, 1.04, 1.08];

export const SKILLS = {
  sprint: { name: '疾跑', dur: 3.5, cd: 16, speedMul: 1.45 },       // 普通幽灵 G
  shield: { name: '能量护盾', dur: 4.0, cd: 22, speedMul: 1.3 },    // 终结者 G
};

export const JUMP_CAPS = { H: 1.45, Z: 1.95 }; // nav: reachable ledge height incl. crouch-jump

export const BOT_NAMES = [
  '夜寂', '冷锋', '猎狐者', '灵狐者', '潜伏者', '保卫者', '刀锋', '炼狱天使', '寂静岭', '枪王之王',
  '暴走萝莉', '小猪佩奇', '战神', '无敌小刀', '一枪入魂', '萌新求带', '老六', '钟楼守望', '酒馆老板', '邮差',
  '沙漠之鹰', '毁灭', '雷神', '夜枭', '黑骑士', '孤狼', '北极熊', '断刃', '疾风', '无名氏',
];

export const HUMAN_SKINS = 4;
