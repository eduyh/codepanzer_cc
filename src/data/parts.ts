import {
  ChassisId,
  ChassisSpec,
  CpuId,
  CpuSpec,
  GridSize,
  MainGunId,
  MainGunSpec,
  RadarId,
  RadarSpec,
  SubWeaponId,
  SubWeaponSpec,
  TankAssembly,
} from '../types/game';

export const CHASSIS_SPECS: Record<ChassisId, ChassisSpec> = {
  light: {
    id: 'light',
    name: '軽量シャシー',
    description: '高機動・高旋回で弾を避けやすい軽量フレーム。積載量と装甲は控えめ。',
    weightLimit: 70,
    baseWeight: 20,
    maxHp: 90,
    maxSpeed: 5.6,
    accel: 0.6,
    turnRate: 6.0,
    radius: 17,
  },
  standard: {
    id: 'standard',
    name: '標準シャシー',
    description: '速度・装甲・積載量のバランスに優れた汎用フレーム。',
    weightLimit: 100,
    baseWeight: 30,
    maxHp: 130,
    maxSpeed: 3.9,
    accel: 0.42,
    turnRate: 4.2,
    radius: 20,
  },
  heavy: {
    id: 'heavy',
    name: '重量シャシー',
    description: '高いHPと豊富な積載量を誇る重戦車フレーム。移動・旋回は緩やか。',
    weightLimit: 135,
    baseWeight: 45,
    maxHp: 190,
    maxSpeed: 2.5,
    accel: 0.28,
    turnRate: 3.0,
    radius: 23,
  },
  destroyer: {
    id: 'destroyer',
    name: '超重シャシー',
    description:
      '砲塔が旋回しない固定砲塔の駆逐戦車フレーム。車体ごと狙う必要があるが、高いHPと積載量に加え主砲冷却が20%速い。',
    weightLimit: 160,
    baseWeight: 55,
    maxHp: 210,
    maxSpeed: 2.2,
    accel: 0.25,
    turnRate: 2.8,
    radius: 24,
    fixedTurret: true,
    coolingMultiplier: 1.2,
  },
};

export const MAIN_GUN_SPECS: Record<MainGunId, MainGunSpec> = {
  rapid: {
    id: 'rapid',
    name: '軽量砲',
    description: '冷却と砲塔旋回が非常に速く、近〜中距離で弾幕を張れるドッグファイト向け主砲。',
    weight: 14,
    minPower: 0.5,
    maxPower: 2.2,
    speedBonus: 3.2,
    damageMultiplier: 0.85,
    coolingRate: 0.1,
    turretTurnRate: 11.0,
  },
  standard: {
    id: 'standard',
    name: '標準砲',
    description: '威力と弾速・冷却・砲塔旋回のバランスが良い汎用主砲。',
    weight: 22,
    minPower: 0.5,
    maxPower: 3.0,
    speedBonus: 0,
    damageMultiplier: 1.0,
    coolingRate: 0.068,
    turretTurnRate: 7.5,
  },
  cannon: {
    id: 'cannon',
    name: '重量砲',
    description: '圧倒的単発威力を誇る狙撃主砲。砲塔旋回と冷却が遅く、接近戦は苦手。',
    weight: 34,
    minPower: 1.0,
    maxPower: 3.0,
    speedBonus: -1.0,
    damageMultiplier: 1.35,
    coolingRate: 0.045,
    turretTurnRate: 4.8,
  },
};

export const RADAR_MEMORY_TICKS = 28;

export const RADAR_SPECS: Record<RadarId, RadarSpec> = {
  wide: {
    id: 'wide',
    name: '広角レーダー',
    description: '視野角120°・旋回10°/tickで近距離の敵を広く見渡すレーダー。射程は480pxと短い。',
    weight: 8,
    fovDeg: 120,
    range: 480,
    turnRate: 10,
  },
  balanced: {
    id: 'balanced',
    name: '標準レーダー',
    description: '視野角50°・射程820px・旋回6°/tick。中距離戦を安定してカバーする汎用レーダー。',
    weight: 14,
    fovDeg: 50,
    range: 820,
    turnRate: 6,
  },
  long: {
    id: 'long',
    name: '狭角レーダー',
    description: '視野角18°の細い視界で1550px先まで見渡す狙撃用レーダー。旋回が3.5°/tickと遅く接近戦に弱い。',
    weight: 20,
    fovDeg: 18,
    range: 1550,
    turnRate: 3.5,
  },
};

export const CPU_SPECS: Record<CpuId, CpuSpec> = {
  mini_4x4: {
    id: 'mini_4x4',
    name: '超小型CPU (4×4 / 16step)',
    description: '4×4マス(最大16ブロック)で軽量・超シンプルに組める入門CPU。',
    weight: 4,
    gridSize: 4,
    maxStepsPerTick: 16,
  },
  compact_6x6: {
    id: 'compact_6x6',
    name: '小型CPU (6×6 / 24step)',
    description: '6×6マス(最大36ブロック)で軽量に組める基本CPU。',
    weight: 8,
    gridSize: 6,
    maxStepsPerTick: 24,
  },
  standard_8x8: {
    id: 'standard_8x8',
    name: '標準CPU (8×8 / 48step)',
    description: '8×8マス(最大64ブロック)で複雑な分岐や状態管理を組める汎用CPU。',
    weight: 16,
    gridSize: 8,
    maxStepsPerTick: 48,
  },
  large_12x12: {
    id: 'large_12x12',
    name: '大型CPU (12×12 / 96step)',
    description: '12×12マス(最大144ブロック)で大規模アルゴリズムを構築できる上位CPU。',
    weight: 26,
    gridSize: 12,
    maxStepsPerTick: 96,
  },
};

export function cpuIdForGridSize(size: GridSize): CpuId {
  switch (size) {
    case 4:
      return 'mini_4x4';
    case 6:
      return 'compact_6x6';
    case 8:
      return 'standard_8x8';
    case 12:
      return 'large_12x12';
  }
}

export const SUB_WEAPON_SPECS: Record<SubWeaponId, SubWeaponSpec> = {
  none: {
    id: 'none',
    name: '装備なし',
    description: '重量を節約して機動力や主砲に回す構成。',
    weight: 0,
    maxAmmo: 0,
    cooldownTicks: 0,
  },
  missile: {
    id: 'missile',
    name: '誘導ミサイル',
    description: '検知中の敵を緩やかに追尾するミサイルを発射（4発 / クールダウン150t）。',
    weight: 16,
    maxAmmo: 4,
    cooldownTicks: 150,
  },
  mine: {
    id: 'mine',
    name: '地雷',
    description: '自機後方に地雷を設置。敵が踏むと大ダメージ（5発 / クールダウン90t）。',
    weight: 12,
    maxAmmo: 5,
    cooldownTicks: 90,
  },
  shield: {
    id: 'shield',
    name: 'バリア',
    description: '120tの間、受けるダメージを60%軽減するバリアを展開（3回 / クールダウン240t）。',
    weight: 15,
    maxAmmo: 3,
    cooldownTicks: 240,
  },
  smoke: {
    id: 'smoke',
    name: '煙幕',
    description: '半径95pxの視界遮断煙幕を100t間展開（3回 / クールダウン180t）。',
    weight: 9,
    maxAmmo: 3,
    cooldownTicks: 180,
  },
  boost: {
    id: 'boost',
    name: '緊急ブースト',
    description: '28tの間、移動速度・加速・旋回が1.7倍になる（3回 / クールダウン160t）。',
    weight: 10,
    maxAmmo: 3,
    cooldownTicks: 160,
  },
  decoy: {
    id: 'decoy',
    name: 'デコイ',
    description: '敵レーダーに戦車として映るHP1のおとりを150t間設置（2回 / クールダウン220t）。',
    weight: 11,
    maxAmmo: 2,
    cooldownTicks: 220,
  },
};

export function calculateAssemblyWeight(assembly: TankAssembly): {
  totalWeight: number;
  weightLimit: number;
  overweight: boolean;
  overweightAmount: number;
  mobilityMultiplier: number;
} {
  const chassis = CHASSIS_SPECS[assembly.chassis];
  const gun = MAIN_GUN_SPECS[assembly.mainGun];
  const radar = RADAR_SPECS[assembly.radar];
  const cpu = CPU_SPECS[assembly.cpu];
  const sub = SUB_WEAPON_SPECS[assembly.subWeapon];

  const totalWeight = chassis.baseWeight + gun.weight + radar.weight + cpu.weight + sub.weight;
  const overweight = totalWeight > chassis.weightLimit;
  const overweightAmount = Math.max(0, totalWeight - chassis.weightLimit);
  const mobilityMultiplier = overweight
    ? Math.max(0.3, 0.8 - (overweightAmount / Math.max(1, chassis.weightLimit)) * 1.2)
    : 1;

  return {
    totalWeight,
    weightLimit: chassis.weightLimit,
    overweight,
    overweightAmount,
    mobilityMultiplier,
  };
}

