import {
  calculateAssemblyWeight,
  CHASSIS_SPECS,
  computeShellMetrics,
  MAIN_GUN_SPECS,
  RADAR_MEMORY_TICKS,
  RADAR_SPECS,
  SUB_WEAPON_SPECS,
} from '../data/parts';
import {
  ArenaConfig,
  ArenaObstacle,
  ArenaSizeId,
  BattleState,
  Mine,
  ObstacleMode,
  Projectile,
  SpawnPoint,
  TankBlueprint,
  TankRuntime,
} from '../types/game';
import { validateAndRepairBlueprint } from '../utils/blueprintGatekeeper';
import { getAutoTankColor, MAX_BATTLE_TANKS } from '../utils/codeParser';
import { runTankChipProgram } from './chipRunner';
import {
  angleToVector,
  circleIntersectsRect,
  clamp,
  distanceBetween,
  hasLineOfSight,
  normalizeAngle180,
  normalizeAngle360,
  vectorToAngle,
} from './math';

export const ARENA_WIDTH = 1400;
export const ARENA_HEIGHT = 1100;
export const DEFAULT_MAX_TICKS = 3600; // 180 seconds @ 20 TPS
export { RADAR_MEMORY_TICKS };

export const ARENA_SIZE_SPECS: Record<
  ArenaSizeId,
  { id: ArenaSizeId; label: string; shortLabel: string; width: number; height: number }
> = {
  tiny: { id: 'tiny', label: '極小 (600×480)', shortLabel: '極小', width: 600, height: 480 },
  small: { id: 'small', label: '小 (840×660)', shortLabel: '小', width: 840, height: 660 },
  medium: { id: 'medium', label: '中 (1100×860)', shortLabel: '中', width: 1100, height: 860 },
  large: { id: 'large', label: '大 (1400×1100)', shortLabel: '大', width: 1400, height: 1100 },
};

export const FOUR_PLAYER_SPAWNS: SpawnPoint[] = [
  { x: 220, y: 220, bodyAngle: 135, turretAngle: 135, radarAngle: 135 },
  { x: 1180, y: 880, bodyAngle: 315, turretAngle: 315, radarAngle: 315 },
  { x: 1180, y: 220, bodyAngle: 225, turretAngle: 225, radarAngle: 225 },
  { x: 220, y: 880, bodyAngle: 45, turretAngle: 45, radarAngle: 45 },
];

export const EIGHT_PLAYER_SPAWNS: SpawnPoint[] = [
  { x: 260, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
  { x: 1140, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
  ...FOUR_PLAYER_SPAWNS,
  { x: 700, y: 160, bodyAngle: 180, turretAngle: 180, radarAngle: 180 },
  { x: 700, y: 940, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
];

export function getSpawnsForArena(width: number, height: number): SpawnPoint[] {
  if (width === ARENA_WIDTH && height === ARENA_HEIGHT) {
    return EIGHT_PLAYER_SPAWNS;
  }
  const sx = width / ARENA_WIDTH;
  const sy = height / ARENA_HEIGHT;
  const wx = Math.round(Math.max(85, 260 * sx));
  const cx = Math.round(Math.max(85, 220 * sx));
  const cy = Math.round(Math.max(85, 220 * sy));
  const ty = Math.round(Math.max(85, 160 * sy));
  const midX = Math.round(width / 2);
  const midY = Math.round(height / 2);

  return [
    { x: wx, y: midY, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
    { x: width - wx, y: midY, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    { x: cx, y: cy, bodyAngle: 135, turretAngle: 135, radarAngle: 135 },
    { x: width - cx, y: height - cy, bodyAngle: 315, turretAngle: 315, radarAngle: 315 },
    { x: width - cx, y: cy, bodyAngle: 225, turretAngle: 225, radarAngle: 225 },
    { x: cx, y: height - cy, bodyAngle: 45, turretAngle: 45, radarAngle: 45 },
    { x: midX, y: ty, bodyAngle: 180, turretAngle: 180, radarAngle: 180 },
    { x: midX, y: height - ty, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
  ];
}

const DEFAULT_FEW_OBSTACLES: ArenaObstacle[] = [
  { id: 'tac_1', x: 380, y: 260, width: 80, height: 170 },
  { id: 'tac_2', x: 940, y: 670, width: 80, height: 170 },
  { id: 'tac_3', x: 660, y: 480, width: 80, height: 140 },
];

function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isRectSafe(
  rect: ArenaObstacle,
  placed: ArenaObstacle[],
  wallPad: number,
  spawnPad: number,
  gapPad: number,
  arenaW: number,
  arenaH: number,
  spawns: SpawnPoint[]
): boolean {
  if (
    rect.x < wallPad ||
    rect.y < wallPad ||
    rect.x + rect.width > arenaW - wallPad ||
    rect.y + rect.height > arenaH - wallPad
  ) {
    return false;
  }

  for (const sp of spawns) {
    if (circleIntersectsRect(sp.x, sp.y, spawnPad, rect)) {
      return false;
    }
  }

  for (const other of placed) {
    if (
      rect.x < other.x + other.width + gapPad &&
      rect.x + rect.width + gapPad > other.x &&
      rect.y < other.y + other.height + gapPad &&
      rect.y + rect.height + gapPad > other.y
    ) {
      return false;
    }
  }

  return true;
}

export function generateArenaObstacles(
  mode: ObstacleMode,
  seed: number = -1,
  arenaSize: ArenaSizeId = 'large'
): ArenaObstacle[] {
  if (mode === 'none') return [];

  const sizeSpec = ARENA_SIZE_SPECS[arenaSize] ?? ARENA_SIZE_SPECS.large;
  const arenaW = sizeSpec.width;
  const arenaH = sizeSpec.height;
  const isLarge = arenaW === ARENA_WIDTH && arenaH === ARENA_HEIGHT;

  if (mode === 'few' && seed === -1) {
    if (isLarge) {
      return DEFAULT_FEW_OBSTACLES.map((o) => ({ ...o }));
    }
    const sx = arenaW / ARENA_WIDTH;
    const sy = arenaH / ARENA_HEIGHT;
    return DEFAULT_FEW_OBSTACLES.map((o) => ({
      id: o.id,
      x: Math.round((o.x * sx) / 5) * 5,
      y: Math.round((o.y * sy) / 5) * 5,
      width: Math.max(32, Math.round((o.width * sx) / 4) * 4),
      height: Math.max(44, Math.round((o.height * sy) / 4) * 4),
    }));
  }

  const effectiveSeed =
    seed === -1 ? (mode === 'many' ? 1001 : mode === 'maze' ? 2002 : 303) : seed;
  const rng = mulberry32(effectiveSeed);
  const placed: ArenaObstacle[] = [];
  const spawns = getSpawnsForArena(arenaW, arenaH);

  const scale = Math.min(arenaW / ARENA_WIDTH, arenaH / ARENA_HEIGHT);
  const areaRatio = (arenaW * arenaH) / (ARENA_WIDTH * ARENA_HEIGHT);
  const baseCount = mode === 'few' ? 4 : mode === 'many' ? 9 : 11;
  const targetCount = isLarge
    ? baseCount
    : Math.max(mode === 'few' ? 2 : 4, Math.round(baseCount * Math.sqrt(areaRatio)));

  const wallPad = isLarge ? 95 : Math.max(45, Math.round(95 * scale));
  const spawnPad = isLarge ? 140 : Math.max(62, Math.round(140 * scale));
  const baseGap = mode === 'maze' || mode === 'many' ? 95 : 110;
  const gapPad = isLarge ? baseGap : Math.max(46, Math.round(baseGap * scale));
  const maxAttempts = 900;
  const gridSnap = isLarge ? 20 : 10;

  for (let attempt = 0; attempt < maxAttempts && placed.length < targetCount; attempt++) {
    let width: number;
    let height: number;
    if (mode === 'maze') {
      const horizontal = attempt % 2 === 0;
      const rawLen = 150 + Math.floor(rng() * 4) * 20;
      const len = isLarge ? rawLen : Math.max(70, Math.round(rawLen * scale));
      const thick = isLarge ? 36 : Math.max(24, Math.round(36 * scale));
      width = horizontal ? len : thick;
      height = horizontal ? thick : len;
    } else {
      const rawW = 70 + Math.floor(rng() * 5) * 12;
      const rawH = 85 + Math.floor(rng() * 6) * 14;
      width = isLarge ? rawW : Math.max(36, Math.round(rawW * scale));
      height = isLarge ? rawH : Math.max(44, Math.round(rawH * scale));
    }

    const availW = arenaW - wallPad * 2 - width;
    const availH = arenaH - wallPad * 2 - height;
    if (availW <= 0 || availH <= 0) continue;

    const rawX = wallPad + rng() * availW;
    const rawY = wallPad + rng() * availH;
    const x = Math.round(rawX / gridSnap) * gridSnap;
    const y = Math.round(rawY / gridSnap) * gridSnap;

    const cand: ArenaObstacle = {
      id: `obs_${mode}_${placed.length + 1}`,
      x,
      y,
      width,
      height,
    };
    if (isRectSafe(cand, placed, wallPad, spawnPad, gapPad, arenaW, arenaH, spawns)) {
      placed.push(cand);
    }
  }

  return placed;
}

let nextEntitySeq = 1;
function makeEntityId(prefix: string): string {
  nextEntitySeq += 1;
  return `${prefix}_${nextEntitySeq}`;
}

export function createTankRuntime(
  id: string,
  team: 'player' | 'enemy',
  rawBlueprint: TankBlueprint,
  spawn: SpawnPoint,
  hpScale = 1
): TankRuntime {
  const blueprint = validateAndRepairBlueprint(rawBlueprint).blueprint;
  const chassis = CHASSIS_SPECS[blueprint.assembly.chassis];
  const sub = SUB_WEAPON_SPECS[blueprint.assembly.subWeapon];
  const bodyAngle = normalizeAngle360(spawn.bodyAngle);
  const turretAngle = normalizeAngle360(spawn.turretAngle ?? bodyAngle);
  const radarAngle = normalizeAngle360(spawn.radarAngle ?? turretAngle);
  const maxHp = Math.max(1, Math.round(chassis.maxHp * hpScale));

  return {
    id,
    team,
    blueprint,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    speed: 0,
    bodyAngle,
    turretAngle,
    radarAngle,
    hp: maxHp,
    maxHp,
    gunHeat: 0,
    subAmmo: sub.maxAmmo,
    subCooldown: 0,
    shieldTicks: 0,
    boostTicks: 0,
    recoil: 0,
    radarLock: false,
    radarSweepDir: 1,
    underLock: false,
    detectedEnemy: null,
    enemyDist: null,
    lastHitTick: -999,
    lastAttackHitTick: -999,
    lastHitAngle: null,
    wallHitCooldown: 0,
    killedById: null,
    counters: { A: 0, B: 0 },
    loopCounters: {},
    loopStack: [],
    moveState: null,
    sleepState: null,
    activePrintSpeech: null,
    mode: 0,
    trace: { visited: [], edges: [], stepsUsed: 0, truncated: false },
    lastCommands: {
      targetSpeedRatio: 0,
      bodyTurnDelta: 0,
      turretTurnDelta: 0,
      radarTurnDelta: 0,
      firePower: null,
      useSubWeapon: false,
    },
    stats: {
      shotsFired: 0,
      shotsHit: 0,
      damageDealt: 0,
      damageTaken: 0,
      wallHits: 0,
    },
  };
}

export function createBattleState(options: {
  player: TankBlueprint;
  enemy?: TankBlueprint;
  enemies?: TankBlueprint[];
  obstacles?: ArenaObstacle[];
  arenaSize?: ArenaSizeId;
  maxTicks?: number;
  playerSpawn?: SpawnPoint;
  enemySpawn?: SpawnPoint;
  enemySpawns?: SpawnPoint[];
  enemyHpScale?: number;
  teamBattle?: boolean;
}): BattleState {
  const sizeSpec = ARENA_SIZE_SPECS[options.arenaSize ?? 'large'] ?? ARENA_SIZE_SPECS.large;
  const arena: ArenaConfig = {
    sizeId: sizeSpec.id,
    width: sizeSpec.width,
    height: sizeSpec.height,
    maxTicks: options.maxTicks ?? DEFAULT_MAX_TICKS,
    obstacles: options.obstacles ?? [],
    teamBattle: Boolean(options.teamBattle),
  };

  const defaultSpawns = getSpawnsForArena(arena.width, arena.height);
  const pSpawn: SpawnPoint = options.playerSpawn ?? defaultSpawns[0];
  const eSpawn: SpawnPoint = options.enemySpawn ?? defaultSpawns[1];

  const enemyList = (
    options.enemies && options.enemies.length > 0
      ? options.enemies
      : options.enemy
        ? [options.enemy]
        : []
  ).slice(0, MAX_BATTLE_TANKS - 1);

  const playerBp: TankBlueprint = {
    ...options.player,
    color: getAutoTankColor(0),
  };
  const tanks: TankRuntime[] = [
    createTankRuntime('player', 'player', playerBp, pSpawn),
  ];

  enemyList.forEach((rawEnemy, idx) => {
    const slot = idx + 1;
    const enemyBp: TankBlueprint = {
      ...rawEnemy,
      color: getAutoTankColor(slot),
    };
    const explicitSpawn = options.enemySpawns?.[idx];
    const spawn =
      explicitSpawn ??
      (slot === 1 && enemyList.length === 1 && options.enemySpawn
        ? eSpawn
        : defaultSpawns[slot]);
    const tankId = slot === 1 ? 'enemy' : `enemy_${slot}`;
    tanks.push(createTankRuntime(tankId, 'enemy', enemyBp, spawn, options.enemyHpScale ?? 1));
  });

  return {
    tick: 0,
    arena,
    tanks,
    projectiles: [],
    mines: [],
    smokes: [],
    decoys: [],
    explosions: [],
    status: 'running',
    winnerId: null,
    winType: null,
    endReason: null,
  };
}

function updateRadarScan(
  tank: TankRuntime,
  candidates: TankRuntime[],
  state: BattleState
): void {
  const radar = RADAR_SPECS[tank.blueprint.assembly.radar];
  const smokes = state.smokes ?? [];
  const decoys = state.decoys ?? [];
  let bestTarget: {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    speed: number;
    heading: number;
    hp: number;
  } | null = null;
  let bestDist = Infinity;
  let bestBearing = 0;

  for (const other of candidates) {
    if (other.id === tank.id || other.hp <= 0) continue;
    if (state.arena.teamBattle && other.team === tank.team) continue;
    const dist = distanceBetween(tank.x, tank.y, other.x, other.y);
    if (dist > radar.range || dist >= bestDist) continue;

    const absBearing = vectorToAngle(other.x - tank.x, other.y - tank.y);
    const diff = Math.abs(normalizeAngle180(absBearing - tank.radarAngle));
    if (diff > radar.fovDeg / 2) continue;

    if (!hasLineOfSight(tank.x, tank.y, other.x, other.y, state.arena.obstacles, smokes)) {
      continue;
    }

    bestTarget = {
      id: other.id,
      x: other.x,
      y: other.y,
      vx: other.vx,
      vy: other.vy,
      speed: other.speed,
      heading: other.bodyAngle,
      hp: other.hp,
    };
    bestDist = dist;
    bestBearing = absBearing;
  }

  for (const decoy of decoys) {
    if (decoy.ownerId === tank.id || decoy.hp <= 0 || decoy.ttl <= 0) continue;
    if (state.arena.teamBattle && decoy.team === tank.team) continue;
    const dist = distanceBetween(tank.x, tank.y, decoy.x, decoy.y);
    if (dist > radar.range || dist >= bestDist) continue;

    const absBearing = vectorToAngle(decoy.x - tank.x, decoy.y - tank.y);
    const diff = Math.abs(normalizeAngle180(absBearing - tank.radarAngle));
    if (diff > radar.fovDeg / 2) continue;

    if (!hasLineOfSight(tank.x, tank.y, decoy.x, decoy.y, state.arena.obstacles, smokes)) {
      continue;
    }

    bestTarget = {
      id: decoy.id,
      x: decoy.x,
      y: decoy.y,
      vx: 0,
      vy: 0,
      speed: 0,
      heading: 0,
      hp: decoy.hp,
    };
    bestDist = dist;
    bestBearing = absBearing;
  }

  if (!bestTarget) {
    tank.radarLock = false;
    if (!tank.detectedEnemy || state.tick - tank.detectedEnemy.lastSeenTick > RADAR_MEMORY_TICKS) {
      tank.detectedEnemy = null;
      tank.enemyDist = null;
    }
    return;
  }

  const roundedDist = Math.round(bestDist);
  tank.radarLock = true;
  tank.enemyDist = roundedDist;
  tank.counters.ENEMY_DIST = roundedDist;
  tank.detectedEnemy = {
    id: bestTarget.id,
    x: bestTarget.x,
    y: bestTarget.y,
    vx: bestTarget.vx,
    vy: bestTarget.vy,
    speed: bestTarget.speed,
    heading: bestTarget.heading,
    distance: bestDist,
    bearingFromBody: normalizeAngle180(bestBearing - tank.bodyAngle),
    bearingFromTurret: normalizeAngle180(bestBearing - tank.turretAngle),
    absoluteBearing: bestBearing,
    hp: bestTarget.hp,
    lastSeenTick: state.tick,
  };
}

function resolveObstaclePush(
  tank: TankRuntime,
  radius: number,
  obstacles: ArenaObstacle[]
): { hit: boolean; nx: number; ny: number } {
  let hit = false;
  let totalNx = 0;
  let totalNy = 0;
  for (const obs of obstacles) {
    if (!circleIntersectsRect(tank.x, tank.y, radius, obs)) continue;
    hit = true;
    const closestX = clamp(tank.x, obs.x, obs.x + obs.width);
    const closestY = clamp(tank.y, obs.y, obs.y + obs.height);
    const dx = tank.x - closestX;
    const dy = tank.y - closestY;
    const d = Math.hypot(dx, dy);

    if (d < 1e-5) {
      // Tank center is inside obstacle: push out nearest edge
      const leftPen = tank.x - obs.x;
      const rightPen = obs.x + obs.width - tank.x;
      const topPen = tank.y - obs.y;
      const bottomPen = obs.y + obs.height - tank.y;
      const minPen = Math.min(leftPen, rightPen, topPen, bottomPen);
      if (minPen === leftPen) {
        tank.x = obs.x - radius;
        totalNx -= 1;
      } else if (minPen === rightPen) {
        tank.x = obs.x + obs.width + radius;
        totalNx += 1;
      } else if (minPen === topPen) {
        tank.y = obs.y - radius;
        totalNy -= 1;
      } else {
        tank.y = obs.y + obs.height + radius;
        totalNy += 1;
      }
    } else {
      const nx = dx / d;
      const ny = dy / d;
      const overlap = radius - d;
      tank.x += nx * overlap;
      tank.y += ny * overlap;
      totalNx += nx;
      totalNy += ny;
    }
  }
  return { hit, nx: totalNx, ny: totalNy };
}

export type ArmorHitZone = 'front' | 'side' | 'rear';

export function getDirectionalArmorMultiplier(
  bodyAngle: number,
  incomingBearing: number
): { zone: ArmorHitZone; multiplier: number } {
  const rel = Math.abs(normalizeAngle180(incomingBearing - bodyAngle));
  if (rel <= 45) {
    return { zone: 'front', multiplier: 0.8 };
  }
  if (rel >= 135) {
    return { zone: 'rear', multiplier: 1.25 };
  }
  return { zone: 'side', multiplier: 1.0 };
}

function applyDamage(
  victim: TankRuntime,
  rawDamage: number,
  attacker: TankRuntime | undefined,
  tick: number
): number {
  const wasAlive = victim.hp > 0;
  const mitigation = victim.shieldTicks > 0 ? 0.4 : 1.0;
  const actual = rawDamage * mitigation;
  victim.hp = Math.max(0, victim.hp - actual);
  victim.lastHitTick = tick;
  victim.stats.damageTaken += actual;
  if (attacker) {
    attacker.stats.damageDealt += actual;
  }
  if (wasAlive && victim.hp <= 0) {
    victim.killedById = attacker ? attacker.id : 'environment';
  }
  return actual;
}

export function stepBattleTick(state: BattleState): BattleState {
  if (state.status === 'finished') return state;

  state.tick += 1;
  const tick = state.tick;

  // 1. Update explosions decay
  state.explosions = state.explosions.filter((ex) => {
    ex.age += 1;
    return ex.age < ex.maxAge;
  });

  // 2. Radar scan phase for all alive tanks
  for (const tank of state.tanks) {
    if (tank.hp <= 0) continue;
    updateRadarScan(tank, state.tanks, state);
  }
  for (const tank of state.tanks) {
    if (tank.hp <= 0) {
      tank.underLock = false;
      continue;
    }
    tank.underLock = state.tanks.some(
      (other) =>
        other.id !== tank.id &&
        other.hp > 0 &&
        other.detectedEnemy?.id === tank.id &&
        state.tick - other.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS
    );
  }

  // 3. Chip program execution & tank physics/actions
  for (const tank of state.tanks) {
    if (tank.hp <= 0) continue;

    const chassis = CHASSIS_SPECS[tank.blueprint.assembly.chassis];
    const gun = MAIN_GUN_SPECS[tank.blueprint.assembly.mainGun];
    const radar = RADAR_SPECS[tank.blueprint.assembly.radar];
    const sub = SUB_WEAPON_SPECS[tank.blueprint.assembly.subWeapon];

    // Decay timers & cooling
    tank.gunHeat = Math.max(0, tank.gunHeat - gun.coolingRate * (chassis.coolingMultiplier ?? 1));
    tank.subCooldown = Math.max(0, tank.subCooldown - 1);
    tank.shieldTicks = Math.max(0, tank.shieldTicks - 1);
    tank.boostTicks = Math.max(0, tank.boostTicks - 1);
    tank.recoil = Math.max(0, tank.recoil - 0.12);
    tank.wallHitCooldown = Math.max(0, tank.wallHitCooldown - 1);

    // Run 2D chip program
    const { commands, trace } = runTankChipProgram(
      tank,
      tick,
      state.arena,
      state.projectiles,
      state.tanks
    );
    tank.trace = trace;
    tank.lastCommands = commands;
    if (trace.printOutputs && trace.printOutputs.length > 0) {
      tank.activePrintSpeech = { lines: trace.printOutputs, tick };
    } else if (tank.activePrintSpeech && tick - tank.activePrintSpeech.tick > 18) {
      tank.activePrintSpeech = null;
    }

    // 3-Axis Independent Rotations & Weight / Boost Modifiers
    const { mobilityMultiplier } = calculateAssemblyWeight(tank.blueprint.assembly);
    const boostFactor = tank.boostTicks > 0 ? 1.7 : 1.0;
    const effectiveMaxSpeed = chassis.maxSpeed * mobilityMultiplier * boostFactor;
    const effectiveAccel = chassis.accel * mobilityMultiplier * boostFactor;
    const effectiveTurnRate = chassis.turnRate * mobilityMultiplier * boostFactor;

    const speedFactor = 1 - 0.2 * (Math.abs(tank.speed) / Math.max(0.1, effectiveMaxSpeed));
    const maxBodyTurn = effectiveTurnRate * speedFactor;
    const actualBodyTurn = clamp(commands.bodyTurnDelta, -maxBodyTurn, maxBodyTurn);
    tank.bodyAngle = normalizeAngle360(tank.bodyAngle + actualBodyTurn);

    if (chassis.fixedTurret) {
      tank.turretAngle = tank.bodyAngle;
    } else {
      const actualTurretTurn = clamp(
        commands.turretTurnDelta,
        -gun.turretTurnRate,
        gun.turretTurnRate
      );
      tank.turretAngle = normalizeAngle360(tank.turretAngle + actualTurretTurn);
    }

    const actualRadarTurn = clamp(commands.radarTurnDelta, -radar.turnRate, radar.turnRate);
    tank.radarAngle = normalizeAngle360(tank.radarAngle + actualRadarTurn);

    // Acceleration & movement
    const targetSpeed = commands.targetSpeedRatio * effectiveMaxSpeed;
    const speedDiff = targetSpeed - tank.speed;
    const accelStep = clamp(speedDiff, -effectiveAccel, effectiveAccel);
    tank.speed += accelStep;

    const moveVec = angleToVector(tank.bodyAngle);
    tank.vx = moveVec.dx * tank.speed;
    tank.vy = moveVec.dy * tank.speed;
    tank.x += tank.vx;
    tank.y += tank.vy;

    // Wall & obstacle collisions
    let collidedWall = false;
    let wallNx = 0;
    let wallNy = 0;
    const r = chassis.radius;
    if (tank.x < r) {
      tank.x = r;
      collidedWall = true;
      wallNx += 1;
    } else if (tank.x > state.arena.width - r) {
      tank.x = state.arena.width - r;
      collidedWall = true;
      wallNx -= 1;
    }
    if (tank.y < r) {
      tank.y = r;
      collidedWall = true;
      wallNy += 1;
    } else if (tank.y > state.arena.height - r) {
      tank.y = state.arena.height - r;
      collidedWall = true;
      wallNy -= 1;
    }

    const obsPush = resolveObstaclePush(tank, r, state.arena.obstacles);
    if (obsPush.hit) {
      collidedWall = true;
      wallNx += obsPush.nx;
      wallNy += obsPush.ny;
    }

    if (collidedWall) {
      const nLen = Math.hypot(wallNx, wallNy);
      if (nLen > 1e-6) {
        const nx = wallNx / nLen;
        const ny = wallNy / nLen;
        const preImpactSpeed = Math.abs(tank.speed);
        const intoWallSpeed = Math.max(0, -(tank.vx * nx + tank.vy * ny));

        // Slide along the wall by removing the inward normal velocity component
        const slideVx = tank.vx + intoWallSpeed * nx;
        const slideVy = tank.vy + intoWallSpeed * ny;
        tank.vx = slideVx;
        tank.vy = slideVy;
        tank.speed = (tank.speed >= 0 ? 1 : -1) * Math.hypot(slideVx, slideVy);

        if (intoWallSpeed > 1.2) {
          const isHeadOn = preImpactSpeed > 0.6 && intoWallSpeed >= preImpactSpeed * 0.75;
          const rand = mulberry32((tick + 1) * 2654435761 ^ Math.round(tank.x * 13 + tank.y * 31));

          if (tank.wallHitCooldown <= 0) {
            tank.stats.wallHits += 1;
            if (tank.hp > 1) {
              applyDamage(tank, Math.min(tank.hp - 1, intoWallSpeed * 0.12), undefined, tick);
            }
            tank.wallHitCooldown = 18;
            if (isHeadOn) {
              const sign = rand() < 0.5 ? -1 : 1;
              tank.bodyAngle = normalizeAngle360(tank.bodyAngle + sign * (12 + rand() * 14));
            }
          } else if (tank.wallHitCooldown % 6 === 0) {
            // Consecutive collision while cooldown is active: slightly nudge angle to unstick
            const sign = rand() < 0.5 ? -1 : 1;
            tank.bodyAngle = normalizeAngle360(tank.bodyAngle + sign * (10 + rand() * 10));
          }
        }
      }
    }

    if (chassis.fixedTurret) {
      tank.turretAngle = tank.bodyAngle;
    }

    // Main gun firing
    if (commands.firePower !== null && tank.gunHeat <= 0.0001) {
      const metrics = computeShellMetrics(
        tank.blueprint.assembly.mainGun,
        commands.firePower,
        tank.blueprint.assembly.chassis
      );
      const power = metrics.power;
      const bulletSpeed = metrics.bulletSpeed;
      const damage = metrics.damage;
      tank.gunHeat = metrics.gunHeat;
      tank.recoil = 1.0;
      tank.stats.shotsFired += 1;

      const dir = angleToVector(tank.turretAngle);
      const muzzleDist = r + 14;
      state.projectiles.push({
        id: makeEntityId('shell'),
        ownerId: tank.id,
        kind: 'shell',
        x: tank.x + dir.dx * muzzleDist,
        y: tank.y + dir.dy * muzzleDist,
        vx: dir.dx * bulletSpeed,
        vy: dir.dy * bulletSpeed,
        angle: tank.turretAngle,
        speed: bulletSpeed,
        power,
        damage,
        color: tank.blueprint.color,
        ttl: 260,
      });
    }

    // Sub weapon activation
    if (
      commands.useSubWeapon &&
      tank.blueprint.assembly.subWeapon !== 'none' &&
      tank.subAmmo > 0 &&
      tank.subCooldown <= 0
    ) {
      tank.subAmmo -= 1;
      tank.subCooldown = sub.cooldownTicks;

      if (tank.blueprint.assembly.subWeapon === 'shield') {
        tank.shieldTicks = 120;
      } else if (tank.blueprint.assembly.subWeapon === 'boost') {
        tank.boostTicks = 50;
      } else if (tank.blueprint.assembly.subWeapon === 'smoke') {
        if (!state.smokes) state.smokes = [];
        state.smokes.push({
          id: makeEntityId('smoke'),
          ownerId: tank.id,
          x: tank.x,
          y: tank.y,
          radius: 95,
          ttl: 100,
          maxTtl: 100,
        });
      } else if (tank.blueprint.assembly.subWeapon === 'decoy') {
        if (!state.decoys) state.decoys = [];
        const sideDir = angleToVector(tank.bodyAngle + 45);
        state.decoys.push({
          id: makeEntityId('decoy'),
          ownerId: tank.id,
          team: tank.team,
          x: clamp(tank.x + sideDir.dx * (r + 24), r + 10, state.arena.width - r - 10),
          y: clamp(tank.y + sideDir.dy * (r + 24), r + 10, state.arena.height - r - 10),
          radius: r,
          hp: 25,
          ttl: 150,
          maxTtl: 150,
          color: tank.blueprint.color,
        });
      } else if (tank.blueprint.assembly.subWeapon === 'mine') {
        tank.stats.shotsFired += 1;
        const backDir = angleToVector(tank.bodyAngle + 180);
        state.mines.push({
          id: makeEntityId('mine'),
          ownerId: tank.id,
          x: clamp(tank.x + backDir.dx * (r + 14), 20, state.arena.width - 20),
          y: clamp(tank.y + backDir.dy * (r + 14), 20, state.arena.height - 20),
          armTicks: 30,
          ttl: 900,
          damage: 22,
          color: tank.blueprint.color,
        });
      } else if (tank.blueprint.assembly.subWeapon === 'missile') {
        tank.stats.shotsFired += 1;
        const dir = angleToVector(tank.turretAngle);
        const missileSpeed = 7.5;
        state.projectiles.push({
          id: makeEntityId('missile'),
          ownerId: tank.id,
          kind: 'missile',
          x: tank.x + dir.dx * (r + 16),
          y: tank.y + dir.dy * (r + 16),
          vx: dir.dx * missileSpeed,
          vy: dir.dy * missileSpeed,
          angle: tank.turretAngle,
          speed: missileSpeed,
          power: 2.5,
          damage: 16,
          color: '#f59e0b',
          ttl: 260,
        });
      }
    }
  }

  // 4. Tank-to-Tank collision (all alive pairs)
  for (let i = 0; i < state.tanks.length; i++) {
    const t1 = state.tanks[i];
    if (t1.hp <= 0) continue;
    const r1 = CHASSIS_SPECS[t1.blueprint.assembly.chassis].radius;
    for (let j = i + 1; j < state.tanks.length; j++) {
      const t2 = state.tanks[j];
      if (t2.hp <= 0) continue;
      const r2 = CHASSIS_SPECS[t2.blueprint.assembly.chassis].radius;
      const dist = distanceBetween(t1.x, t1.y, t2.x, t2.y);
      const minDist = r1 + r2;
      if (dist < minDist && dist > 1e-5) {
        const overlap = (minDist - dist) / 2;
        const nx = (t2.x - t1.x) / dist;
        const ny = (t2.y - t1.y) / dist;
        t1.x -= nx * overlap;
        t1.y -= ny * overlap;
        t2.x += nx * overlap;
        t2.y += ny * overlap;
        if (!(state.arena.teamBattle && t1.team === t2.team)) {
          applyDamage(t1, 0.6, undefined, tick);
          applyDamage(t2, 0.6, undefined, tick);
        }
        t1.speed *= 0.4;
        t2.speed *= 0.4;
      }
    }
  }

  // 5. Update Projectiles & Hit Detection
  const survivingProjectiles: Projectile[] = [];
  for (const proj of state.projectiles) {
    proj.ttl -= 1;
    if (proj.ttl <= 0) continue;

    // Gentle homing for missiles (nearest alive opponent)
    if (proj.kind === 'missile') {
      const owner = state.tanks.find((t) => t.id === proj.ownerId);
      let target: TankRuntime | null = null;
      let minDist = Infinity;
      for (const candidate of state.tanks) {
        if (candidate.id === proj.ownerId || candidate.hp <= 0) continue;
        if (state.arena.teamBattle && owner && candidate.team === owner.team) continue;
        const d = distanceBetween(candidate.x, candidate.y, proj.x, proj.y);
        if (d < minDist) {
          minDist = d;
          target = candidate;
        }
      }
      if (target) {
        const desiredAngle = vectorToAngle(target.x - proj.x, target.y - proj.y);
        const turn = clamp(normalizeAngle180(desiredAngle - proj.angle), -2.2, 2.2);
        proj.angle = normalizeAngle360(proj.angle + turn);
        const vec = angleToVector(proj.angle);
        proj.vx = vec.dx * proj.speed;
        proj.vy = vec.dy * proj.speed;
      }
    }

    proj.x += proj.vx;
    proj.y += proj.vy;

    // Arena boundary hit
    if (
      proj.x < 0 ||
      proj.x > state.arena.width ||
      proj.y < 0 ||
      proj.y > state.arena.height
    ) {
      state.explosions.push({
        id: makeEntityId('exp'),
        x: clamp(proj.x, 0, state.arena.width),
        y: clamp(proj.y, 0, state.arena.height),
        radius: 12,
        color: '#94a3b8',
        age: 0,
        maxAge: 14,
      });
      continue;
    }

    // Obstacle hit
    const hitObs = state.arena.obstacles.some((obs) =>
      circleIntersectsRect(proj.x, proj.y, 4, obs)
    );
    if (hitObs) {
      state.explosions.push({
        id: makeEntityId('exp'),
        x: proj.x,
        y: proj.y,
        radius: 14,
        color: '#cbd5e1',
        age: 0,
        maxAge: 16,
      });
      continue;
    }

    // Tank hit
    const attacker = state.tanks.find((t) => t.id === proj.ownerId);
    let hitTank: TankRuntime | null = null;
    for (const tank of state.tanks) {
      if (tank.id === proj.ownerId || tank.hp <= 0) continue;
      if (state.arena.teamBattle && attacker && tank.team === attacker.team) continue;
      const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
      if (distanceBetween(proj.x, proj.y, tank.x, tank.y) <= r + 4) {
        hitTank = tank;
        break;
      }
    }

    if (hitTank) {
      if (attacker) attacker.stats.shotsHit += 1;
      const incomingBearing = normalizeAngle360(proj.angle + 180);
      const armor = getDirectionalArmorMultiplier(hitTank.bodyAngle, incomingBearing);
      hitTank.lastHitZone = armor.zone;
      hitTank.lastAttackHitTick = tick;
      hitTank.lastHitAngle = incomingBearing;
      applyDamage(hitTank, proj.damage * armor.multiplier, attacker, tick);
      const sparkRadius =
        armor.zone === 'front'
          ? 16 + proj.power * 4
          : armor.zone === 'rear'
            ? 28 + proj.power * 8
            : 22 + proj.power * 6;
      const sparkColor =
        armor.zone === 'front'
          ? '#38bdf8'
          : armor.zone === 'rear'
            ? '#f97316'
            : proj.kind === 'missile'
              ? '#f97316'
              : '#facc15';
      const sparkMaxAge = armor.zone === 'front' ? 18 : armor.zone === 'rear' ? 26 : 22;
      state.explosions.push({
        id: makeEntityId('exp'),
        x: proj.x,
        y: proj.y,
        radius: sparkRadius,
        color: sparkColor,
        age: 0,
        maxAge: sparkMaxAge,
      });
      continue;
    }

    // Decoy hit
    let hitDecoy = false;
    for (const decoy of state.decoys ?? []) {
      if (decoy.ownerId === proj.ownerId || decoy.hp <= 0) continue;
      if (state.arena.teamBattle && attacker && decoy.team === attacker.team) continue;
      if (distanceBetween(proj.x, proj.y, decoy.x, decoy.y) <= decoy.radius + 4) {
        decoy.hp = Math.max(0, decoy.hp - proj.damage);
        hitDecoy = true;
        state.explosions.push({
          id: makeEntityId('exp'),
          x: decoy.x,
          y: decoy.y,
          radius: decoy.hp <= 0 ? 28 : 16,
          color: decoy.color,
          age: 0,
          maxAge: decoy.hp <= 0 ? 20 : 12,
        });
        break;
      }
    }
    if (hitDecoy) continue;

    survivingProjectiles.push(proj);
  }
  state.projectiles = survivingProjectiles;

  // Update Smokes & Decoys
  if (state.smokes && state.smokes.length > 0) {
    state.smokes = state.smokes
      .map((s) => ({ ...s, ttl: s.ttl - 1 }))
      .filter((s) => s.ttl > 0);
  }
  if (state.decoys && state.decoys.length > 0) {
    state.decoys = state.decoys
      .map((d) => ({ ...d, ttl: d.ttl - 1 }))
      .filter((d) => d.hp > 0 && d.ttl > 0);
  }

  // 6. Update Mines
  const survivingMines: Mine[] = [];
  for (const mine of state.mines) {
    mine.ttl -= 1;
    if (mine.ttl <= 0) continue;
    mine.armTicks = Math.max(0, mine.armTicks - 1);

    let triggered = false;
    if (mine.armTicks <= 0) {
      const owner = state.tanks.find((t) => t.id === mine.ownerId);
      for (const tank of state.tanks) {
        if (tank.id === mine.ownerId || tank.hp <= 0) continue;
        if (state.arena.teamBattle && owner && tank.team === owner.team) continue;
        const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
        if (distanceBetween(mine.x, mine.y, tank.x, tank.y) <= r + 14) {
          if (owner) owner.stats.shotsHit += 1;
          applyDamage(tank, mine.damage, owner, tick);
          state.explosions.push({
            id: makeEntityId('exp'),
            x: mine.x,
            y: mine.y,
            radius: 42,
            color: '#ef4444',
            age: 0,
            maxAge: 28,
          });
          triggered = true;
          break;
        }
      }
    }
    if (!triggered) survivingMines.push(mine);
  }
  state.mines = survivingMines;

  const hasActiveCombatContribution = (t: TankRuntime): boolean =>
    t.stats.shotsFired > 0 && t.stats.damageDealt > 0;

  // 7. Check Win / Draw / Timeout conditions
  const aliveTanks = state.tanks.filter((t) => t.hp > 0);
  if (state.arena.teamBattle) {
    const alivePlayers = aliveTanks.filter((t) => t.team === 'player');
    const aliveEnemies = aliveTanks.filter((t) => t.team === 'enemy');
    if (alivePlayers.length === 0 && aliveEnemies.length === 0) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'draw';
      state.endReason = '相打ち (Double KO)';
    } else if (aliveEnemies.length === 0) {
      const winner = alivePlayers[0];
      state.status = 'finished';
      if (!hasActiveCombatContribution(winner)) {
        state.winnerId = 'draw';
        state.winType = 'draw';
        state.endReason = '攻撃なし・有効打なしのため引き分け（敵機自滅）';
      } else {
        const directKill = state.tanks.some(
          (t) => t.team === 'enemy' && t.killedById === winner.id
        );
        state.winnerId = winner.id;
        if (directKill) {
          state.winType = 'elimination';
          state.endReason = `${winner.blueprint.name} の敵チーム全滅勝利！`;
        } else {
          state.winType = 'decision';
          state.endReason = `${winner.blueprint.name} の判定勝利（敵機自滅）`;
        }
      }
    } else if (alivePlayers.length === 0) {
      const playerTank = state.tanks.find((t) => t.team === 'player');
      if (playerTank) {
        state.explosions.push({
          id: makeEntityId('exp'),
          x: playerTank.x,
          y: playerTank.y,
          radius: 65,
          color: '#ef4444',
          age: 0,
          maxAge: 45,
        });
      }
      state.status = 'finished';
      state.winnerId = aliveEnemies[0].id;
      state.winType = 'defeat';
      const enemiesHadHit = state.tanks.some(
        (t) => t.team === 'enemy' && hasActiveCombatContribution(t)
      );
      state.endReason = enemiesHadHit ? '敵チームの撃破勝利！' : '自機の自滅による敗北…';
    } else if (state.tick >= state.arena.maxTicks) {
      state.status = 'finished';
      const playerTank = alivePlayers[0];
      const playerRatio = playerTank.hp / playerTank.maxHp;
      const enemyTanksAll = state.tanks.filter((t) => t.team === 'enemy');
      const enemyAvgRatio =
        enemyTanksAll.reduce((sum, t) => sum + Math.max(0, t.hp) / t.maxHp, 0) /
        Math.max(1, enemyTanksAll.length);
      const anyCombat = state.tanks.some(hasActiveCombatContribution);
      const playerActive = hasActiveCombatContribution(playerTank);
      const enemyActive = enemyTanksAll.some(hasActiveCombatContribution);
      if (
        !anyCombat ||
        Math.abs(playerRatio - enemyAvgRatio) < 0.001 ||
        (playerRatio > enemyAvgRatio && !playerActive) ||
        (enemyAvgRatio > playerRatio && !enemyActive)
      ) {
        state.winnerId = 'draw';
        state.winType = 'draw';
        state.endReason = anyCombat ? '時間切れ引き分け' : '時間切れ引き分け（有効打なし）';
      } else if (playerRatio > enemyAvgRatio) {
        state.winnerId = 'player';
        state.winType = 'decision';
        state.endReason = `時間切れ判定勝 (${playerTank.blueprint.name})`;
      } else {
        state.winnerId = aliveEnemies[0].id;
        state.winType = 'defeat';
        state.endReason = '時間切れ判定負 (敵チーム優勢)';
      }
    }
  } else if (aliveTanks.length === 0) {
    state.status = 'finished';
    state.winnerId = 'draw';
    state.winType = 'draw';
    state.endReason = '相打ち (Double KO)';
  } else if (aliveTanks.length === 1) {
    const winner = aliveTanks[0];
    const loser = state.tanks.find((t) => t.id !== winner.id);
    if (loser) {
      state.explosions.push({
        id: makeEntityId('exp'),
        x: loser.x,
        y: loser.y,
        radius: 65,
        color: '#ef4444',
        age: 0,
        maxAge: 45,
      });
    }
    state.status = 'finished';
    if (winner.team === 'player') {
      if (!hasActiveCombatContribution(winner)) {
        state.winnerId = 'draw';
        state.winType = 'draw';
        state.endReason =
          state.tanks.length > 2
            ? '攻撃なし・有効打なしのため引き分け（敵機同士討ち）'
            : '攻撃なし・有効打なしのため引き分け（敵機自滅）';
      } else {
        const directKill = state.tanks.some(
          (t) => t.id !== winner.id && t.killedById === winner.id
        );
        state.winnerId = winner.id;
        if (directKill) {
          state.winType = 'elimination';
          state.endReason = `${winner.blueprint.name} の撃破勝利！`;
        } else {
          state.winType = 'decision';
          state.endReason =
            state.tanks.length > 2
              ? `${winner.blueprint.name} の生存判定勝利！`
              : `${winner.blueprint.name} の判定勝利（敵機自滅）`;
        }
      }
    } else {
      state.winnerId = winner.id;
      state.winType = 'defeat';
      state.endReason = hasActiveCombatContribution(winner)
        ? `${winner.blueprint.name} の撃破勝利！`
        : '自機の自滅による敗北…';
    }
  } else if (state.tick >= state.arena.maxTicks) {
    state.status = 'finished';
    const anyCombat = state.tanks.some(hasActiveCombatContribution);
    const ranked = [...state.tanks]
      .map((tank) => ({ tank, ratio: tank.hp > 0 ? tank.hp / tank.maxHp : -1 }))
      .sort((a, b) => b.ratio - a.ratio);
    if (!anyCombat) {
      state.winnerId = 'draw';
      state.winType = 'draw';
      state.endReason = '時間切れ引き分け（有効打なし）';
    } else if (ranked.length >= 2 && Math.abs(ranked[0].ratio - ranked[1].ratio) < 0.001) {
      state.winnerId = 'draw';
      state.winType = 'draw';
      state.endReason = '時間切れ引き分け';
    } else if (ranked.length >= 1) {
      const winner = ranked[0].tank;
      if (!hasActiveCombatContribution(winner)) {
        state.winnerId = 'draw';
        state.winType = 'draw';
        state.endReason = '時間切れ引き分け（有効打なし）';
      } else {
        state.winnerId = winner.id;
        state.winType = winner.team === 'player' ? 'decision' : 'defeat';
        state.endReason = `時間切れ判定勝 (${winner.blueprint.name})`;
      }
    }
  }

  return state;
}
