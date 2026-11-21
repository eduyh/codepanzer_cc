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
  ArenaTarget,
  ArenaTile,
  BattleState,
  ChassisId,
  LearningGoalRule,
  Mine,
  ObstacleMode,
  Projectile,
  SpawnPoint,
  TankBlueprint,
  TankRuntime,
} from '../types/game';
import { validateAndRepairBlueprint } from '../utils/blueprintGatekeeper';
import { getAutoTankColor, MAX_BATTLE_TANKS } from '../utils/codeParser';
import { isTankInTileKind, runTankChipProgram } from './chipRunner';
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

function areAllied(
  a: { team: 'player' | 'enemy'; teamId?: string },
  b: { team: 'player' | 'enemy'; teamId?: string },
  arena: ArenaConfig
): boolean {
  if (arena.multiTeamMode && a.teamId && b.teamId) {
    return a.teamId === b.teamId;
  }
  return Boolean(arena.teamBattle && a.team === b.team);
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
    lastAimAngle: null,
    lastAimTick: -999,
    wallHitCooldown: 0,
    killedById: null,
    counters: { A: 0, B: 0 },
    loopCounters: {},
    loopStack: [],
    moveState: null,
    sleepState: null,
    turnState: null,
    fireState: null,
    halted: false,
    tileEdgeState: {},
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
      kills: 0,
      eliminatedAtTick: null,
      ruleScore: 0,
    },
  };
}

export function createBattleState(options: {
  player: TankBlueprint;
  enemy?: TankBlueprint;
  enemies?: TankBlueprint[];
  obstacles?: ArenaObstacle[];
  tiles?: ArenaTile[];
  targets?: ArenaTarget[];
  learningRule?: LearningGoalRule;
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
    ...(options.tiles ? { tiles: options.tiles.map((t) => ({ ...t })) } : {}),
    ...(options.targets
      ? {
          targets: options.targets.map((t) => ({
            ...t,
            ...(t.patrol ? { patrol: { ...t.patrol } } : {}),
          })),
        }
      : {}),
    ...(options.learningRule ? { learningRule: { ...options.learningRule } } : {}),
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
  const radarRangeMult = clamp(state.arena.radarRangeMult ?? 1.0, 0.2, 1.0);
  const effectiveRange = radar.range * radarRangeMult;
  const targetMode = state.arena.radarTargetMode ?? 'default';
  const smokes = state.smokes ?? [];
  const decoys = state.decoys ?? [];
  interface RadarCandidate {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    speed: number;
    heading: number;
    hp: number;
  }
  let bestTarget: RadarCandidate | null = null;
  let bestDist = Infinity;
  let bestBearing = 0;

  const considerCandidate = (candidate: RadarCandidate): void => {
    const dist = distanceBetween(tank.x, tank.y, candidate.x, candidate.y);
    if (dist > effectiveRange || dist >= bestDist) return;

    const absBearing = vectorToAngle(candidate.x - tank.x, candidate.y - tank.y);
    const diff = Math.abs(normalizeAngle180(absBearing - tank.radarAngle));
    if (diff > radar.fovDeg / 2) return;

    if (!hasLineOfSight(tank.x, tank.y, candidate.x, candidate.y, state.arena.obstacles, smokes)) {
      return;
    }

    bestTarget = candidate;
    bestDist = dist;
    bestBearing = absBearing;
  };

  if (targetMode === 'default') {
    for (const other of candidates) {
      if (other.id === tank.id || other.hp <= 0) continue;
      if (areAllied(other, tank, state.arena)) continue;
      considerCandidate({
        id: other.id,
        x: other.x,
        y: other.y,
        vx: other.vx,
        vy: other.vy,
        speed: other.speed,
        heading: other.bodyAngle,
        hp: other.hp,
      });
    }

    for (const decoy of decoys) {
      if (decoy.ownerId === tank.id || decoy.hp <= 0 || decoy.ttl <= 0) continue;
      if (areAllied(decoy, tank, state.arena)) continue;
      considerCandidate({
        id: decoy.id,
        x: decoy.x,
        y: decoy.y,
        vx: 0,
        vy: 0,
        speed: 0,
        heading: 0,
        hp: decoy.hp,
      });
    }
  }

  if (targetMode === 'ball_only') {
    const ball = state.football;
    if (ball) {
      const speed = Math.hypot(ball.vx, ball.vy);
      considerCandidate({
        id: 'football',
        x: ball.x,
        y: ball.y,
        vx: ball.vx,
        vy: ball.vy,
        speed,
        heading: speed > 1e-4 ? vectorToAngle(ball.vx, ball.vy) : 0,
        hp: 100,
      });
    }
  } else if (
    state.arena.targets &&
    (targetMode === 'targets_only' || tank.team === 'player')
  ) {
    for (const tgt of state.arena.targets) {
      if (tgt.popped) continue;
      if (targetMode === 'default' && tgt.kind !== 'shoot_balloon') continue;
      const vx = tgt.vx ?? 0;
      const vy = tgt.vy ?? 0;
      const speed = Math.hypot(vx, vy);
      considerCandidate({
        id: tgt.id,
        x: tgt.x,
        y: tgt.y,
        vx,
        vy,
        speed,
        heading: speed > 1e-4 ? vectorToAngle(vx, vy) : 0,
        hp: tgt.hp,
      });
    }
  }

  if (
    tank.detectedEnemy &&
    state.arena.targets?.some((tgt) => tgt.id === tank.detectedEnemy?.id && tgt.popped)
  ) {
    tank.detectedEnemy = null;
    tank.enemyDist = null;
  }

  if (!bestTarget) {
    tank.radarLock = false;
    if (!tank.detectedEnemy || state.tick - tank.detectedEnemy.lastSeenTick > RADAR_MEMORY_TICKS) {
      tank.detectedEnemy = null;
      tank.enemyDist = null;
    }
    return;
  }

  const matched = bestTarget as RadarCandidate;
  const roundedDist = Math.round(bestDist);
  tank.radarLock = true;
  tank.enemyDist = roundedDist;
  tank.counters.ENEMY_DIST = roundedDist;
  tank.detectedEnemy = {
    id: matched.id,
    x: matched.x,
    y: matched.y,
    vx: matched.vx,
    vy: matched.vy,
    speed: matched.speed,
    heading: matched.heading,
    distance: bestDist,
    bearingFromBody: normalizeAngle180(bestBearing - tank.bodyAngle),
    bearingFromTurret: normalizeAngle180(bestBearing - tank.turretAngle),
    absoluteBearing: bestBearing,
    hp: matched.hp,
    lastSeenTick: state.tick,
  };
}

export function resolveObstaclePush(
  tank: { x: number; y: number },
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

interface ChassisCollisionProfile {
  bounceFactor: number;
  deflectDegScale: number;
  maxDeflectDeg: number;
  minDeflectDeg: number;
}

const CHASSIS_COLLISION_PROFILES: Record<ChassisId, ChassisCollisionProfile> = {
  light: { bounceFactor: 1.1, deflectDegScale: 1.25, maxDeflectDeg: 32, minDeflectDeg: 6 },
  standard: { bounceFactor: 0.95, deflectDegScale: 1.0, maxDeflectDeg: 26, minDeflectDeg: 5 },
  heavy: { bounceFactor: 0.8, deflectDegScale: 0.85, maxDeflectDeg: 20, minDeflectDeg: 4 },
  destroyer: { bounceFactor: 0.65, deflectDegScale: 0.7, maxDeflectDeg: 18, minDeflectDeg: 3 },
};

function clampTankToArenaAndObstacles(
  tank: TankRuntime,
  radius: number,
  arena: ArenaConfig
): void {
  tank.x = clamp(tank.x, radius, arena.width - radius);
  tank.y = clamp(tank.y, radius, arena.height - radius);
  if (arena.obstacles.length > 0) {
    resolveObstaclePush(tank, radius, arena.obstacles);
    tank.x = clamp(tank.x, radius, arena.width - radius);
    tank.y = clamp(tank.y, radius, arena.height - radius);
  }
}

function applyTankImpactPhysics(
  tank: TankRuntime,
  outNx: number,
  outNy: number,
  massShare: number,
  approachSpeed: number,
  otherSpeedAbs: number,
  otherBoosted: boolean,
  streak: number,
  rand: () => number,
  tieSign: 1 | -1,
  gravityMult = 1.0,
  bounceMult = 1.0
): void {
  const chassisId = tank.blueprint.assembly.chassis;
  const chassis = CHASSIS_SPECS[chassisId];
  const profile = CHASSIS_COLLISION_PROFILES[chassisId];
  const { mobilityMultiplier } = calculateAssemblyWeight(tank.blueprint.assembly);
  const boostFactor = tank.boostTicks > 0 ? 1.7 : 1.0;
  const maxSpd = chassis.maxSpeed * mobilityMultiplier * boostFactor * gravityMult * Math.max(1, bounceMult);

  const h = angleToVector(tank.bodyAngle);
  const dot = h.dx * outNx + h.dy * outNy; // +1 = facing collision, < 0.35 = struck from side/rear
  const cross = h.dx * outNy - h.dy * outNx; // > 0 = other tank on right -> turn left (-)

  const alongVel = dot * tank.speed;
  const awaySign = dot >= 0 ? -1 : 1;
  const streakScale = streak > 0 ? 1 + streak * 0.35 : 1;
  if (alongVel > -0.1) {
    // Moving into or pressed against the other tank: rebound away along the tank axis
    const baseBounce = streak > 0 ? 1.5 + approachSpeed * 0.5 : 0.95 + approachSpeed * 0.38;
    const rebound = clamp(
      baseBounce * (0.55 + 0.75 * massShare) * profile.bounceFactor * streakScale * bounceMult,
      (streak > 0 ? 0.85 : 0.55) * bounceMult,
      maxSpd * 1.15
    );
    tank.speed = awaySign * rebound;
  } else {
    // Moving away from contact normal: shove further away along -outN
    tank.speed = clamp(
      tank.speed + awaySign * approachSpeed * massShare * 0.45 * bounceMult,
      -maxSpd * 1.1,
      maxSpd * 1.15
    );
  }

  // Angular deflection: follow physical glance direction once >= ~4.5 deg off-center;
  // for dead-center hits, use a stable time-bucketed seeded sign so consecutive bounces pass rather than ping-pong.
  const turnSign = Math.abs(cross) >= 0.08 ? (cross > 0 ? -1 : 1) : tieSign;
  const isFlankOrRearHit = dot < 0.35;
  const isFasterAttacker = otherBoosted || otherSpeedAbs > Math.abs(tank.speed) + 0.6;
  const flankLoopholeMult =
    isFlankOrRearHit && isFasterAttacker ? (otherBoosted ? 2.25 : 1.65) : isFlankOrRearHit ? 1.25 : 1.0;
  const headOnHeavyStabilizer =
    !isFlankOrRearHit &&
    streak === 0 &&
    (chassisId === 'destroyer' || chassisId === 'heavy') &&
    massShare < 0.45
      ? 0.5
      : 1.0;

  const rawDeg =
    (streak > 0 ? 6.5 + approachSpeed * 1.7 : 4.2 + approachSpeed * 1.35 + rand() * 2.8) *
    (0.55 + massShare * 0.9) *
    profile.deflectDegScale *
    flankLoopholeMult *
    headOnHeavyStabilizer *
    (1 + streak * 0.25);
  const minDeflect =
    isFlankOrRearHit && isFasterAttacker
      ? Math.max(profile.minDeflectDeg, 10)
      : (streak > 0 ? Math.max(profile.minDeflectDeg, 9) : profile.minDeflectDeg) *
        headOnHeavyStabilizer *
        (1 + streak * 0.22);
  const maxDeflect =
    isFlankOrRearHit && isFasterAttacker
      ? Math.max(profile.maxDeflectDeg, 24)
      : profile.maxDeflectDeg * (1 + streak * 0.18);
  const turnDeg = clamp(rawDeg, minDeflect, Math.min(42, maxDeflect));

  tank.bodyAngle = normalizeAngle360(tank.bodyAngle + turnSign * turnDeg);
  if (chassis.fixedTurret) {
    tank.turretAngle = tank.bodyAngle;
  }
}

function resolveTankCollisions(state: BattleState, tick: number): void {
  for (let i = 0; i < state.tanks.length; i++) {
    const t1 = state.tanks[i];
    if (t1.hp <= 0) continue;
    const c1 = t1.blueprint.assembly.chassis;
    const r1 = CHASSIS_SPECS[c1].radius;
    const w1 = Math.max(20, calculateAssemblyWeight(t1.blueprint.assembly).totalWeight);

    for (let j = i + 1; j < state.tanks.length; j++) {
      const t2 = state.tanks[j];
      if (t2.hp <= 0) continue;
      const c2 = t2.blueprint.assembly.chassis;
      const r2 = CHASSIS_SPECS[c2].radius;
      const w2 = Math.max(20, calculateAssemblyWeight(t2.blueprint.assembly).totalWeight);

      const minDist = r1 + r2;
      const rawDx = t2.x - t1.x;
      const rawDy = t2.y - t1.y;
      const dist = Math.hypot(rawDx, rawDy);
      if (dist >= minDist) continue;

      const rand = mulberry32(
        ((tick + 1) * 1664525) ^ Math.round(t1.x * 17 + t1.y * 23 + t2.x * 31 + t2.y * 43)
      );

      let nx: number;
      let ny: number;
      if (dist <= 1e-5) {
        const fallbackVec = angleToVector(normalizeAngle360(t1.bodyAngle + (rand() < 0.5 ? 90 : -90)));
        nx = fallbackVec.dx;
        ny = fallbackVec.dy;
      } else {
        nx = rawDx / dist;
        ny = rawDy / dist;
      }

      const relVx = t1.vx - t2.vx;
      const relVy = t1.vy - t2.vy;
      const approachSpeed = Math.max(0, relVx * nx + relVy * ny);

      // Detect rapid repeated collisions so opposing AIs (even identical heavy/destroyers) break out of lockstep
      const s1Streak =
        t1.lastTankCollisionTick !== undefined && tick - t1.lastTankCollisionTick <= 36
          ? Math.min(4, (t1.tankCollisionStreak ?? 0) + 1)
          : 0;
      const s2Streak =
        t2.lastTankCollisionTick !== undefined && tick - t2.lastTankCollisionTick <= 36
          ? Math.min(4, (t2.tankCollisionStreak ?? 0) + 1)
          : 0;
      const s1 = Math.abs(t1.speed);
      const s2 = Math.abs(t2.speed);
      t1.lastCollisionImpactSpeed =
        t1.lastTankCollisionTick === tick && t1.lastCollisionImpactSpeed !== undefined
          ? Math.max(t1.lastCollisionImpactSpeed, s1)
          : s1;
      t2.lastCollisionImpactSpeed =
        t2.lastTankCollisionTick === tick && t2.lastCollisionImpactSpeed !== undefined
          ? Math.max(t2.lastCollisionImpactSpeed, s2)
          : s2;
      t1.lastTankCollisionTick = tick;
      t2.lastTankCollisionTick = tick;
      if (!areAllied(t1, t2, state.arena)) {
        t1.lastCollidedTankId = t2.id;
        t2.lastCollidedTankId = t1.id;
      }
      t1.tankCollisionStreak = s1Streak;
      t2.tankCollisionStreak = s2Streak;
      const maxStreak = Math.max(s1Streak, s2Streak);
      const streakScale = 1 + maxStreak * 0.45;

      const weightSum = w1 + w2;
      const share1 = w2 / weightSum;
      const share2 = w1 / weightSum;

      const b1 = t1.boostTicks > 0;
      const b2 = t2.boostTicks > 0;
      const windowSeed = ((Math.floor(tick / 45) + 1) * 2654435761) ^ (i * 97 + j * 193);
      const tieSign: 1 | -1 = mulberry32(windowSeed)() < 0.5 ? -1 : 1;

      const gravityMult = clamp(state.arena.gravitySpeedMult ?? 1.0, 0.5, 1.5);
      const bounceMult = Math.max(0.5, state.arena.tankBounceMult ?? 1.0);
      applyTankImpactPhysics(
        t1,
        nx,
        ny,
        share1,
        approachSpeed,
        s2,
        b2,
        s1Streak,
        rand,
        tieSign,
        gravityMult,
        bounceMult
      );
      applyTankImpactPhysics(
        t2,
        -nx,
        -ny,
        share2,
        approachSpeed,
        s1,
        b1,
        s2Streak,
        rand,
        tieSign,
        gravityMult,
        bounceMult
      );

      // Push apart along normal + tangential slip (realistic first impact, strong deadlock break on streak >= 1)
      const overlap = minDist - dist;
      const extraSep =
        (maxStreak > 0
          ? clamp((9.5 + approachSpeed * 2.0) * streakScale, 9.5, 44.0)
          : clamp(1.8 + approachSpeed * 0.65, 1.8, 12.0)) * bounceMult;
      const totalPush = overlap + extraSep;
      const tx = -ny;
      const ty = nx;
      const h1 = angleToVector(t1.bodyAngle);
      const latSign = h1.dx * tx + h1.dy * ty >= 0 ? 1 : -1;
      const lateralSlip =
        maxStreak > 0
          ? clamp((7.5 + approachSpeed * 1.25) * streakScale, 7.5, 32.0)
          : clamp(0.8 + approachSpeed * 0.25, 0.8, 5.0);

      t1.x = t1.x - nx * totalPush * share1 + tx * latSign * lateralSlip * share1;
      t1.y = t1.y - ny * totalPush * share1 + ty * latSign * lateralSlip * share1;
      t2.x = t2.x + nx * totalPush * share2 - tx * latSign * lateralSlip * share2;
      t2.y = t2.y + ny * totalPush * share2 - ty * latSign * lateralSlip * share2;

      // Wall & obstacle safeguard: keep inside arena & outside obstacles, then transfer leftover separation if pinned
      clampTankToArenaAndObstacles(t1, r1, state.arena);
      clampTankToArenaAndObstacles(t2, r2, state.arena);
      const postDx = t2.x - t1.x;
      const postDy = t2.y - t1.y;
      const postDist = Math.hypot(postDx, postDy);
      if (postDist < minDist && postDist > 1e-5) {
        const pnx = postDx / postDist;
        const pny = postDy / postDist;
        const remain = minDist - postDist + 2.0;
        t1.x -= pnx * remain * 0.5;
        t1.y -= pny * remain * 0.5;
        t2.x += pnx * remain * 0.5;
        t2.y += pny * remain * 0.5;
        clampTankToArenaAndObstacles(t1, r1, state.arena);
        clampTankToArenaAndObstacles(t2, r2, state.arena);
      }

      if (!state.arena.disableTankDamage && !areAllied(t1, t2, state.arena)) {
        const baseImpact = approachSpeed > 0.4 ? 0.35 + approachSpeed * 0.48 : 0.2;
        const d1 = clamp(baseImpact * clamp(w2 / w1, 0.5, 1.9) * (b2 ? 1.25 : 1.0), 0.2, 7.0);
        const d2 = clamp(baseImpact * clamp(w1 / w2, 0.5, 1.9) * (b1 ? 1.25 : 1.0), 0.2, 7.0);
        if (t1.hp > 1) {
          applyDamage(t1, Math.min(t1.hp - 1, d1), undefined, tick);
        }
        if (t2.hp > 1) {
          applyDamage(t2, Math.min(t2.hp - 1, d2), undefined, tick);
        }
      }
    }
  }
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

export function applyDamage(
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
    victim.stats.eliminatedAtTick = tick;
    if (attacker && attacker.id !== victim.id) {
      attacker.stats.kills = (attacker.stats.kills ?? 0) + 1;
    }
  }
  return actual;
}

function isFootballOwnGoalAim(tank: TankRuntime, state: BattleState): boolean {
  const fb = state.football;
  if (!fb) return false;
  const dx = angleToVector(tank.turretAngle).dx;
  const teamKey = tank.teamId ?? tank.id;
  if (teamKey === fb.westTeamId) {
    return dx < -0.001;
  }
  if (teamKey === fb.eastTeamId) {
    return dx > 0.001;
  }
  return false;
}

/**
 * Compute a tank's match contribution score excluding the +120 winner bonus.
 * Shared by timeout decision evaluation and match report scoring so rankings and MVP stay aligned.
 */
export function computeTankBaseContribution(
  tank: TankRuntime,
  totalTicks: number
): number {
  const isAlive = tank.hp > 0;
  const survivedTicks = isAlive
    ? totalTicks
    : (tank.stats.eliminatedAtTick ?? totalTicks);
  const kills = tank.stats.kills ?? 0;
  const damageDealt = Math.round(tank.stats.damageDealt * 10) / 10;
  const shotsFired = tank.stats.shotsFired;
  const shotsHit = tank.stats.shotsHit;
  const hitRatePercent =
    shotsFired > 0 ? Math.round((shotsHit / shotsFired) * 1000) / 10 : null;
  const ruleScore = Math.round((tank.stats.ruleScore ?? 0) * 10) / 10;

  const survivalBonus = Math.round(
    (survivedTicks / Math.max(1, totalTicks)) * 60
  );
  const accuracyBonus =
    shotsFired >= 3 && hitRatePercent !== null ? Math.round(hitRatePercent * 0.4) : 0;
  const aliveBonus = isAlive ? 40 : 0;

  return (
    aliveBonus +
    survivalBonus +
    kills * 100 +
    Math.round(damageDealt * 1.2) +
    accuracyBonus +
    Math.round(ruleScore * 10)
  );
}

function evaluateMultiTeamBattleState(state: BattleState): void {
  const aliveTanks = state.tanks.filter((t) => t.hp > 0);
  const hasLethalOuterWall =
    state.arena.outerWallMode === 'damage' ||
    state.arena.outerWallMode === 'damage_bounce';
  const hasContribution = (t: TankRuntime): boolean =>
    state.arena.disableWeapons
      ? t.stats.damageDealt > 0 ||
        t.stats.damageTaken > 0 ||
        (t.stats.ruleScore ?? 0) > 0 ||
        t.stats.wallHits > 0 ||
        Math.hypot(t.vx, t.vy) > 0.01
      : (t.stats.shotsFired > 0 && t.stats.damageDealt > 0) ||
        (t.stats.ruleScore ?? 0) > 0 ||
        (hasLethalOuterWall && (t.stats.damageTaken > 0 || t.stats.wallHits > 0));

  const getTeamKey = (t: TankRuntime): string => t.teamId ?? t.id;
  const distinctTeams = Array.from(new Set(state.tanks.map(getTeamKey)));
  const aliveTeamIds = Array.from(new Set(aliveTanks.map(getTeamKey)));

  const getTeamScore = (teamKey: string): number => {
    if (state.ruleTeamScores && state.ruleTeamScores[teamKey] !== undefined) {
      return state.ruleTeamScores[teamKey];
    }
    return state.tanks
      .filter((t) => getTeamKey(t) === teamKey)
      .reduce((acc, t) => acc + (t.stats.ruleScore ?? 0), 0);
  };

  const getTeamLabel = (teamKey: string): string => {
    if (state.ruleTeamLabels?.[teamKey]) return state.ruleTeamLabels[teamKey];
    const member = state.tanks.find((t) => getTeamKey(t) === teamKey);
    if (!member) return teamKey;
    return member.playerName || member.blueprint.name;
  };

  const pickBestTankInTeam = (teamKey: string): TankRuntime => {
    const members = state.tanks.filter((t) => getTeamKey(t) === teamKey);
    return [...members].sort((a, b) => {
      const aAlive = a.hp > 0 ? 1 : 0;
      const bAlive = b.hp > 0 ? 1 : 0;
      if (bAlive !== aAlive) return bAlive - aAlive;
      const contribDiff =
        computeTankBaseContribution(b, state.tick) -
        computeTankBaseContribution(a, state.tick);
      if (contribDiff !== 0) return contribDiff;
      if (b.stats.damageDealt !== a.stats.damageDealt) {
        return b.stats.damageDealt - a.stats.damageDealt;
      }
      return b.hp / b.maxHp - a.hp / a.maxHp;
    })[0];
  };

  if (aliveTeamIds.length === 0 && !state.arena.scoreOnlyVictory) {
    state.status = 'finished';
    state.winnerId = 'draw';
    state.winType = 'draw';
    state.endReason = '相打ち (Double KO)';
    return;
  }

  if (
    !state.arena.continueUntilTimeout &&
    distinctTeams.length >= 2 &&
    aliveTeamIds.length === 1
  ) {
    const winTeamId = aliveTeamIds[0];
    const winner = pickBestTankInTeam(winTeamId);
    if (!state.arena.disableWeapons && !state.tanks.some(hasContribution)) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'draw';
      state.endReason = '攻撃なし・有効打なしのため引き分け';
    } else {
      state.status = 'finished';
      state.winnerId = winner.id;
      state.winType = 'elimination';
      const ownerTag = winner.playerName || winner.blueprint.author || 'PLAYER';
      state.endReason = `${winner.blueprint.name} (${ownerTag}) の撃破勝利！`;
    }
    return;
  }

  const allDeadWithScoreRule =
    aliveTeamIds.length === 0 && Boolean(state.arena.scoreOnlyVictory);
  if (state.tick < state.arena.maxTicks && !allDeadWithScoreRule) {
    return;
  }

  if (state.arena.scoreOnlyVictory) {
    const teamScores = distinctTeams
      .map((teamKey) => ({
        teamKey,
        ruleScoreSum: getTeamScore(teamKey),
      }))
      .sort((a, b) => b.ruleScoreSum - a.ruleScoreSum);

    const tiedTop =
      teamScores.length < 2 ||
      Math.abs(teamScores[0].ruleScoreSum - teamScores[1].ruleScoreSum) < 0.001;
    const topTeam = teamScores[0];
    const topScore = topTeam ? Math.round(topTeam.ruleScoreSum) : 0;
    const winLabel = topTeam ? getTeamLabel(topTeam.teamKey) : '';

    state.status = 'finished';
    if (tiedTop) {
      state.winnerId = 'draw';
      state.winType = 'draw';
    } else {
      const winner = pickBestTankInTeam(topTeam.teamKey);
      state.winnerId = winner.id;
      state.winType = 'decision';
    }

    if (state.football) {
      const fb = state.football;
      const westScore = Math.round(getTeamScore(fb.westTeamId));
      const eastScore = Math.round(getTeamScore(fb.eastTeamId));
      const scoreLine = `${fb.westTeamLabel} ${westScore} - ${eastScore} ${fb.eastTeamLabel}`;
      state.endReason = tiedTop
        ? `${scoreLine}（引き分け）`
        : `${scoreLine}（${winLabel} の勝利！）`;
    } else if (state.arena.ruleId === 'domination') {
      state.endReason = tiedTop
        ? `陣取り引き分け（同数 ${topScore}マス）`
        : `${winLabel} の陣取り勝利！（占領 ${topScore}マス）`;
    } else if (state.arena.ruleId === 'balloon_hunt') {
      state.endReason = tiedTop
        ? `風船割り引き分け（同点 ${topScore}pt）`
        : `${winLabel} の勝利！（風船 ${topScore}pt）`;
    } else {
      state.endReason = tiedTop ? '時間切れ引き分け' : `${winLabel} の勝利！`;
    }
    return;
  }

  const anyContribution = state.tanks.some(hasContribution);
  const teamScores = distinctTeams
    .map((teamKey) => {
      const members = state.tanks.filter((t) => getTeamKey(t) === teamKey);
      const aliveCount = members.filter((t) => t.hp > 0).length;
      const baseContribSum = members.reduce(
        (acc, t) => acc + computeTankBaseContribution(t, state.tick),
        0
      );
      const avgHpRatio =
        members.reduce((acc, t) => acc + Math.max(0, t.hp) / t.maxHp, 0) /
        Math.max(1, members.length);
      const damageSum = members.reduce((acc, t) => acc + t.stats.damageDealt, 0);
      return { teamKey, membersCount: members.length, aliveCount, baseContribSum, avgHpRatio, damageSum };
    })
    .sort((a, b) => {
      if (b.aliveCount !== a.aliveCount) {
        return b.aliveCount - a.aliveCount;
      }
      if (b.baseContribSum !== a.baseContribSum) {
        return b.baseContribSum - a.baseContribSum;
      }
      if (Math.abs(b.damageSum - a.damageSum) >= 0.1) {
        return b.damageSum - a.damageSum;
      }
      return b.avgHpRatio - a.avgHpRatio;
    });

  const tiedTop =
    teamScores.length >= 2 &&
    teamScores[0].aliveCount === teamScores[1].aliveCount &&
    teamScores[0].baseContribSum === teamScores[1].baseContribSum &&
    Math.abs(teamScores[0].damageSum - teamScores[1].damageSum) < 0.1 &&
    Math.abs(teamScores[0].avgHpRatio - teamScores[1].avgHpRatio) < 0.001;

  if (!anyContribution || tiedTop || teamScores.length === 0) {
    state.status = 'finished';
    state.winnerId = 'draw';
    state.winType = 'draw';
    state.endReason = anyContribution
      ? '時間切れ引き分け'
      : '時間切れ引き分け（有効打なし）';
  } else {
    const topTeam = teamScores[0];
    const winner = pickBestTankInTeam(topTeam.teamKey);
    const decidedBySurvivors =
      teamScores.length >= 2 && topTeam.aliveCount > teamScores[1].aliveCount;
    const displayName =
      topTeam.membersCount > 1 ? getTeamLabel(topTeam.teamKey) : winner.blueprint.name;
    state.status = 'finished';
    state.winnerId = winner.id;
    state.winType = 'decision';
    state.endReason = decidedBySurvivors
      ? `時間切れ判定勝 (${displayName} / 生存数優位)`
      : `時間切れ判定勝 (${displayName} / 貢献度判定)`;
  }
}

export function stepBattleTick(
  state: BattleState,
  ruleTickHook?: (state: BattleState) => void
): BattleState {
  if (state.status === 'finished') return state;

  state.tick += 1;
  const tick = state.tick;

  // 1. Update explosions decay
  state.explosions = state.explosions.filter((ex) => {
    ex.age += 1;
    return ex.age < ex.maxAge;
  });

  if (state.football && state.football.kickoffFreezeTicks > 0) {
    state.football.kickoffFreezeTicks -= 1;
    if (state.arena.multiTeamMode && state.tick >= state.arena.maxTicks) {
      evaluateMultiTeamBattleState(state);
    }
    return state;
  }

  // 1b. Update moving patrol targets (Learning Mode moving balloons)
  if (state.arena.targets) {
    for (const tgt of state.arena.targets) {
      if (tgt.popped || !tgt.patrol) {
        tgt.vx = 0;
        tgt.vy = 0;
        continue;
      }
      const { ax, ay, bx, by, speed } = tgt.patrol;
      const dir = tgt.patrol.dir ?? 1;
      const destX = dir > 0 ? bx : ax;
      const destY = dir > 0 ? by : ay;
      const dx = destX - tgt.x;
      const dy = destY - tgt.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= speed || dist < 1e-6) {
        tgt.vx = destX - tgt.x;
        tgt.vy = destY - tgt.y;
        tgt.x = destX;
        tgt.y = destY;
        tgt.patrol.dir = dir > 0 ? -1 : 1;
      } else {
        tgt.vx = (dx / dist) * speed;
        tgt.vy = (dy / dist) * speed;
        tgt.x += tgt.vx;
        tgt.y += tgt.vy;
      }
    }
  }

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
    tank.outerWallBounceCooldown = Math.max(0, (tank.outerWallBounceCooldown ?? 0) - 1);

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

    // 3-Axis Independent Rotations & Weight / Boost / Gravity / Floor-Zone Modifiers
    const { mobilityMultiplier } = calculateAssemblyWeight(tank.blueprint.assembly);
    const boostFactor = tank.boostTicks > 0 ? 1.7 : 1.0;
    const gravityMult = clamp(state.arena.gravitySpeedMult ?? 1.0, 0.5, 1.5);
    const gravityTurretMult = 1 + (gravityMult - 1) * 0.5;
    const inSlowZone = isTankInTileKind(tank, state.arena, 'slow');
    const zoneMoveMult = inSlowZone ? 0.45 : 1.0;
    const zoneTurnMult = inSlowZone ? 0.6 : 1.0;
    const combinedMoveMult = Math.max(0.25, gravityMult * zoneMoveMult);
    const combinedBodyTurnMult = Math.max(0.35, gravityMult * zoneTurnMult);
    const effectiveMaxSpeed = chassis.maxSpeed * mobilityMultiplier * boostFactor * combinedMoveMult;
    const effectiveAccel = chassis.accel * mobilityMultiplier * boostFactor * combinedMoveMult;
    const effectiveTurnRate = chassis.turnRate * mobilityMultiplier * boostFactor * combinedBodyTurnMult;

    const speedFactor = 1 - 0.2 * (Math.abs(tank.speed) / Math.max(0.1, effectiveMaxSpeed));
    const maxBodyTurn = effectiveTurnRate * speedFactor;
    const actualBodyTurn = clamp(commands.bodyTurnDelta, -maxBodyTurn, maxBodyTurn);
    tank.bodyAngle = normalizeAngle360(tank.bodyAngle + actualBodyTurn);

    if (chassis.fixedTurret) {
      tank.turretAngle = tank.bodyAngle;
    } else {
      const effectiveTurretTurnRate = gun.turretTurnRate * gravityTurretMult;
      const actualTurretTurn = clamp(
        commands.turretTurnDelta,
        -effectiveTurretTurnRate,
        effectiveTurretTurnRate
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
    const preWallVx = tank.vx;
    const preWallVy = tank.vy;
    let collidedWall = false;
    let hitOuterWall = false;
    let wallNx = 0;
    let wallNy = 0;
    let outerNx = 0;
    let outerNy = 0;
    const r = chassis.radius;
    if (tank.x < r) {
      tank.x = r;
      collidedWall = true;
      hitOuterWall = true;
      wallNx += 1;
      outerNx += 1;
    } else if (tank.x > state.arena.width - r) {
      tank.x = state.arena.width - r;
      collidedWall = true;
      hitOuterWall = true;
      wallNx -= 1;
      outerNx -= 1;
    }
    if (tank.y < r) {
      tank.y = r;
      collidedWall = true;
      hitOuterWall = true;
      wallNy += 1;
      outerNy += 1;
    } else if (tank.y > state.arena.height - r) {
      tank.y = state.arena.height - r;
      collidedWall = true;
      hitOuterWall = true;
      wallNy -= 1;
      outerNy -= 1;
    }

    const obsPush = resolveObstaclePush(tank, r, state.arena.obstacles);
    if (obsPush.hit) {
      collidedWall = true;
      wallNx += obsPush.nx;
      wallNy += obsPush.ny;
    }

    const outerMode = state.arena.outerWallMode ?? 'normal';
    const handleCustomOuterWall =
      hitOuterWall &&
      outerMode !== 'normal' &&
      (tank.outerWallBounceCooldown ?? 0) <= 0;

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

        if (intoWallSpeed > 1.2 && !handleCustomOuterWall) {
          const isHeadOn = preImpactSpeed > 0.6 && intoWallSpeed >= preImpactSpeed * 0.75;
          const rand = mulberry32((tick + 1) * 2654435761 ^ Math.round(tank.x * 13 + tank.y * 31));

          if (tank.wallHitCooldown <= 0) {
            tank.stats.wallHits += 1;
            if (!state.arena.disableTankDamage && tank.hp > 1) {
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

    if (handleCustomOuterWall) {
      const outerLen = Math.hypot(outerNx, outerNy);
      const onx = outerLen > 1e-6 ? outerNx / outerLen : 0;
      const ony = outerLen > 1e-6 ? outerNy / outerLen : 0;

      if (outerMode === 'damage' || outerMode === 'damage_bounce') {
        if (!state.arena.disableTankDamage) {
          const pusher =
            tank.lastCollidedTankId &&
            tank.lastTankCollisionTick !== undefined &&
            tick - tank.lastTankCollisionTick <= 40
              ? state.tanks.find((t) => t.id === tank.lastCollidedTankId)
              : undefined;
          applyDamage(tank, 24, pusher, tick);
        }
        tank.stats.wallHits += 1;
        state.explosions.push({
          id: makeEntityId('exp'),
          x: tank.x,
          y: tank.y,
          radius: 36,
          color: '#ef4444',
          age: 0,
          maxAge: 22,
        });
        tank.outerWallBounceCooldown = 16;
      }

      if ((outerMode === 'bounce' || outerMode === 'damage_bounce') && tank.hp > 0 && outerLen > 1e-6) {
        tank.x += onx * 36;
        tank.y += ony * 36;
        clampTankToArenaAndObstacles(tank, r, state.arena);

        const preLen = Math.hypot(preWallVx, preWallVy);
        const inDx = preLen > 0.05 ? preWallVx / preLen : -onx;
        const inDy = preLen > 0.05 ? preWallVy / preLen : -ony;
        const vn = inDx * onx + inDy * ony;
        const refDx = inDx - 2 * vn * onx;
        const refDy = inDy - 2 * vn * ony;
        const blendDx = refDx + 0.65 * onx;
        const blendDy = refDy + 0.65 * ony;
        const bounceAngle =
          Math.hypot(blendDx, blendDy) > 1e-5
            ? vectorToAngle(blendDx, blendDy)
            : vectorToAngle(onx, ony);

        tank.bodyAngle = normalizeAngle360(bounceAngle);
        if (chassis.fixedTurret) {
          tank.turretAngle = tank.bodyAngle;
        }
        tank.speed = Math.max(Math.abs(preLen) * 1.15, effectiveMaxSpeed * 1.25);
        const bv = angleToVector(tank.bodyAngle);
        tank.vx = bv.dx * tank.speed;
        tank.vy = bv.dy * tank.speed;
        state.explosions.push({
          id: makeEntityId('exp'),
          x: tank.x,
          y: tank.y,
          radius: 30,
          color: outerMode === 'damage_bounce' ? '#f97316' : '#facc15',
          age: 0,
          maxAge: 18,
        });
        tank.outerWallBounceCooldown = Math.max(tank.outerWallBounceCooldown ?? 0, 14);
      }
    }

    if (chassis.fixedTurret) {
      tank.turretAngle = tank.bodyAngle;
    }

    const inNoWeaponZone = isTankInTileKind(tank, state.arena, 'no_weapon');
    const ownGoalFireBlocked = isFootballOwnGoalAim(tank, state);

    // Main gun firing
    if (
      tank.hp > 0 &&
      !state.arena.disableWeapons &&
      !inNoWeaponZone &&
      !ownGoalFireBlocked &&
      commands.firePower !== null &&
      tank.gunHeat <= 0.0001
    ) {
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
      tank.hp > 0 &&
      !state.arena.disableWeapons &&
      !state.arena.disableSubWeapons &&
      !inNoWeaponZone &&
      !(ownGoalFireBlocked && tank.blueprint.assembly.subWeapon === 'missile') &&
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
          ...(tank.teamId ? { teamId: tank.teamId } : {}),
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

  // 4. Tank-to-Tank physical collision: mass-weighted knockback, bounce, anti-deadlock & wall/obstacle clamp
  resolveTankCollisions(state, tick);

  // 4b. Learning Arena Tiles & Ram-Balloon Interactions
  if (state.arena.tiles || state.arena.targets) {
    for (const tank of state.tanks) {
      if (tank.hp <= 0) continue;
      if (!state.arena.multiTeamMode && tank.team !== 'player') continue;
      const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
      for (const tile of state.arena.tiles ?? []) {
        const inside =
          tank.x >= tile.x &&
          tank.x <= tile.x + tile.width &&
          tank.y >= tile.y &&
          tank.y <= tile.y + tile.height;
        if (!inside) continue;
        if (tank.team === 'player' && tile.kind === 'checkpoint' && !tile.visited) {
          tile.visited = true;
          state.explosions.push({
            id: makeEntityId('exp'),
            x: tile.x + tile.width / 2,
            y: tile.y + tile.height / 2,
            radius: 26,
            color: '#22c55e',
            age: 0,
            maxAge: 18,
          });
        } else if (tile.kind === 'hazard') {
          tank.speed *= 0.65;
          if (!state.arena.disableTankDamage) {
            applyDamage(tank, 1.5, undefined, tick);
          }
        }
      }
      if (!state.arena.allowBalloonRamPop && tank.team !== 'player') continue;
      for (const tgt of state.arena.targets ?? []) {
        if (tgt.popped) continue;
        if (!state.arena.allowBalloonRamPop && tgt.kind !== 'ram_balloon') continue;
        if (distanceBetween(tank.x, tank.y, tgt.x, tgt.y) <= r + tgt.radius) {
          tgt.popped = true;
          tgt.hp = 0;
          if (state.arena.multiTeamMode) {
            tank.stats.ruleScore = (tank.stats.ruleScore ?? 0) + (tgt.points ?? 1);
          }
          state.explosions.push({
            id: makeEntityId('exp'),
            x: tgt.x,
            y: tgt.y,
            radius: 38,
            color: tgt.color ?? '#f43f5e',
            age: 0,
            maxAge: 24,
          });
        }
      }
    }
  }

  // 5. Update Projectiles & Hit Detection
  const survivingProjectiles: Projectile[] = [];
  for (const proj of state.projectiles) {
    proj.ttl -= 1;
    if (proj.ttl <= 0) continue;

    // Gentle homing for missiles (respects radarTargetMode)
    if (proj.kind === 'missile') {
      const targetMode = state.arena.radarTargetMode ?? 'default';
      let targetPoint: { x: number; y: number } | null = null;
      if (targetMode === 'targets_only') {
        let minDist = Infinity;
        for (const tgt of state.arena.targets ?? []) {
          if (tgt.popped) continue;
          const d = distanceBetween(tgt.x, tgt.y, proj.x, proj.y);
          if (d < minDist) {
            minDist = d;
            targetPoint = { x: tgt.x, y: tgt.y };
          }
        }
      } else if (targetMode === 'ball_only') {
        if (state.football) {
          targetPoint = { x: state.football.x, y: state.football.y };
        }
      } else {
        const owner = state.tanks.find((t) => t.id === proj.ownerId);
        let minDist = Infinity;
        for (const candidate of state.tanks) {
          if (candidate.id === proj.ownerId || candidate.hp <= 0) continue;
          if (owner && areAllied(candidate, owner, state.arena)) continue;
          const d = distanceBetween(candidate.x, candidate.y, proj.x, proj.y);
          if (d < minDist) {
            minDist = d;
            targetPoint = { x: candidate.x, y: candidate.y };
          }
        }
      }
      if (targetPoint) {
        const desiredAngle = vectorToAngle(targetPoint.x - proj.x, targetPoint.y - proj.y);
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

    // Shoot-Balloon hit (Learning Mode & Balloon Hunt target)
    const attacker = state.tanks.find((t) => t.id === proj.ownerId);
    let hitBalloon = false;
    for (const tgt of state.arena.targets ?? []) {
      if (tgt.popped) continue;
      if (state.arena.radarTargetMode !== 'targets_only' && tgt.kind !== 'shoot_balloon') continue;
      if (distanceBetween(proj.x, proj.y, tgt.x, tgt.y) <= tgt.radius + 5) {
        tgt.hp = Math.max(0, tgt.hp - proj.damage);
        if (tgt.hp <= 0) {
          tgt.popped = true;
          if (attacker && state.arena.multiTeamMode) {
            attacker.stats.ruleScore = (attacker.stats.ruleScore ?? 0) + (tgt.points ?? 1);
          }
        }
        if (attacker) attacker.stats.shotsHit += 1;
        state.explosions.push({
          id: makeEntityId('exp'),
          x: tgt.x,
          y: tgt.y,
          radius: tgt.popped ? 38 : 16,
          color: tgt.color ?? '#f43f5e',
          age: 0,
          maxAge: 22,
        });
        hitBalloon = true;
        break;
      }
    }
    if (hitBalloon) continue;

    // Football hit (Combat Football)
    if (state.football) {
      const ball = state.football;
      if (distanceBetween(proj.x, proj.y, ball.x, ball.y) <= ball.radius + 5) {
        const pMag = Math.max(1e-5, Math.hypot(proj.vx, proj.vy));
        const pvx = proj.vx / pMag;
        const pvy = proj.vy / pMag;
        const dx = ball.x - proj.x;
        const dy = ball.y - proj.y;
        const dMag = Math.max(1e-5, Math.hypot(dx, dy));
        const bx = pvx * 0.75 + (dx / dMag) * 0.25;
        const by = pvy * 0.75 + (dy / dMag) * 0.25;
        const bLen = Math.max(1e-5, Math.hypot(bx, by));
        const kick = 4.2 + proj.power * 2.6;
        ball.vx += (bx / bLen) * kick;
        ball.vy += (by / bLen) * kick;
        const speed = Math.hypot(ball.vx, ball.vy);
        if (speed > 15.5) {
          ball.vx = (ball.vx / speed) * 15.5;
          ball.vy = (ball.vy / speed) * 15.5;
        }
        ball.lastTouchTankId = proj.ownerId;
        ball.lastTouchTeamId = attacker?.teamId ?? null;
        if (attacker) attacker.stats.shotsHit += 1;
        state.explosions.push({
          id: makeEntityId('exp'),
          x: proj.x,
          y: proj.y,
          radius: 24,
          color: '#facc15',
          age: 0,
          maxAge: 18,
        });
        continue;
      }
    }

    // Tank hit
    let hitTank: TankRuntime | null = null;
    for (const tank of state.tanks) {
      if (tank.id === proj.ownerId || tank.hp <= 0) continue;
      if (attacker && areAllied(tank, attacker, state.arena)) continue;
      const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
      if (distanceBetween(proj.x, proj.y, tank.x, tank.y) <= r + 4) {
        hitTank = tank;
        break;
      }
    }

    if (hitTank) {
      if (state.arena.disableTankDamage) {
        state.explosions.push({
          id: makeEntityId('exp'),
          x: proj.x,
          y: proj.y,
          radius: 14,
          color: '#38bdf8',
          age: 0,
          maxAge: 14,
        });
        continue;
      }
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
      if (attacker && areAllied(decoy, attacker, state.arena)) continue;
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
        if (owner && areAllied(tank, owner, state.arena)) continue;
        const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
        if (distanceBetween(mine.x, mine.y, tank.x, tank.y) <= r + 14) {
          if (!state.arena.disableTankDamage) {
            if (owner) owner.stats.shotsHit += 1;
            applyDamage(tank, mine.damage, owner, tick);
          }
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

  if (ruleTickHook) {
    ruleTickHook(state);
    if ((state.status as BattleState['status']) === 'finished') {
      return state;
    }
  }

  const hasActiveCombatContribution = (t: TankRuntime): boolean =>
    t.stats.shotsFired > 0 && t.stats.damageDealt > 0;

  // 7. Check Win / Draw / Timeout conditions
  if (state.arena.learningRule) {
    const rule = state.arena.learningRule;
    const playerTank = state.tanks.find((t) => t.team === 'player');
    if (!playerTank || playerTank.hp <= 0) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'defeat';
      state.endReason = '機体がダメージを受けて停止しました';
      return state;
    }
    if (rule.maxWallHits !== undefined && playerTank.stats.wallHits > rule.maxWallHits) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'defeat';
      state.endReason = `壁・障害物に接触しました（無接触上限 ${rule.maxWallHits}回）`;
      return state;
    }
    const tiles = state.arena.tiles ?? [];
    const targets = state.arena.targets ?? [];
    const checkpointsOk =
      !rule.requireAllCheckpoints ||
      tiles.every((t) => t.kind !== 'checkpoint' || Boolean(t.visited));
    const targetsOk =
      !rule.requireAllTargetsPopped || targets.every((t) => Boolean(t.popped));
    const enemiesOk =
      !rule.requireEnemiesDefeated ||
      state.tanks.every((t) => t.team !== 'enemy' || t.hp <= 0);
    const onGoalTile = tiles.some(
      (t) =>
        t.kind === 'goal' &&
        playerTank.x >= t.x &&
        playerTank.x <= t.x + t.width &&
        playerTank.y >= t.y &&
        playerTank.y <= t.y + t.height
    );
    const stoppedOk = !rule.requireStop || Math.abs(playerTank.speed) < 0.25;

    if (
      checkpointsOk &&
      targetsOk &&
      enemiesOk &&
      (!rule.reachGoalTile || (onGoalTile && stoppedOk))
    ) {
      state.status = 'finished';
      state.winnerId = 'player';
      state.winType = 'mission';
      state.endReason = 'ミッションクリア！';
    } else if (
      playerTank.halted &&
      Math.abs(playerTank.speed) < 0.05 &&
      state.projectiles.length === 0
    ) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'defeat';
      state.endReason = 'stop() で停止しましたがクリア条件を満たしていません';
    } else if (state.tick >= state.arena.maxTicks) {
      state.status = 'finished';
      state.winnerId = 'draw';
      state.winType = 'defeat';
      state.endReason = '制限時間切れ（ミッション未達成）';
    }
    return state;
  }

  const aliveTanks = state.tanks.filter((t) => t.hp > 0);
  if (state.arena.multiTeamMode) {
    evaluateMultiTeamBattleState(state);
  } else if (state.arena.teamBattle) {
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

function cloneCallStack(
  stack?: Array<{
    returnCoord: { x: number; y: number } | null;
    callerCoord: { x: number; y: number };
    subKey: string;
  }>
) {
  return stack?.map((f) => ({
    returnCoord: f.returnCoord ? { ...f.returnCoord } : null,
    callerCoord: { ...f.callerCoord },
    subKey: f.subKey,
  }));
}

export function cloneBattleStateForStep(prev: BattleState): BattleState {
  return {
    ...prev,
    arena: {
      ...prev.arena,
      ...(prev.arena.tiles ? { tiles: prev.arena.tiles.map((tl) => ({ ...tl })) } : {}),
      ...(prev.arena.targets
        ? {
            targets: prev.arena.targets.map((tg) => ({
              ...tg,
              ...(tg.patrol ? { patrol: { ...tg.patrol } } : {}),
            })),
          }
        : {}),
      ...(prev.arena.learningRule ? { learningRule: { ...prev.arena.learningRule } } : {}),
    },
    tanks: prev.tanks.map((t) => ({
      ...t,
      stats: { ...t.stats },
      counters: { ...t.counters },
      loopCounters: { ...t.loopCounters },
      loopStack: t.loopStack?.map((f) => ({
        coord: { ...f.coord },
        callStack: cloneCallStack(f.callStack),
      })),
      detectedEnemy: t.detectedEnemy ? { ...t.detectedEnemy } : null,
      moveState: t.moveState
        ? {
            coord: { ...t.moveState.coord },
            speedRatio: t.moveState.speedRatio,
            remainingTicks: t.moveState.remainingTicks,
            callStack: cloneCallStack(t.moveState.callStack),
          }
        : null,
      sleepState: t.sleepState
        ? {
            coord: { ...t.sleepState.coord },
            remainingTicks: t.sleepState.remainingTicks,
            callStack: cloneCallStack(t.sleepState.callStack),
          }
        : null,
      turnState: t.turnState
        ? {
            ...t.turnState,
            coord: { ...t.turnState.coord },
            callStack: cloneCallStack(t.turnState.callStack),
          }
        : null,
      fireState: t.fireState
        ? {
            ...t.fireState,
            coord: { ...t.fireState.coord },
            callStack: cloneCallStack(t.fireState.callStack),
          }
        : null,
      tileEdgeState: t.tileEdgeState ? { ...t.tileEdgeState } : undefined,
      activePrintSpeech: t.activePrintSpeech
        ? { lines: [...t.activePrintSpeech.lines], tick: t.activePrintSpeech.tick }
        : null,
    })),
    projectiles: prev.projectiles.map((p) => ({ ...p })),
    mines: prev.mines.map((m) => ({ ...m })),
    ...(prev.smokes ? { smokes: prev.smokes.map((s) => ({ ...s })) } : {}),
    ...(prev.decoys ? { decoys: prev.decoys.map((d) => ({ ...d })) } : {}),
    ...(prev.territoryGrid
      ? {
          territoryGrid: {
            ...prev.territoryGrid,
            owners: [...prev.territoryGrid.owners],
            blocked: [...prev.territoryGrid.blocked],
            teamColors: { ...prev.territoryGrid.teamColors },
            teamLabels: { ...prev.territoryGrid.teamLabels },
          },
        }
      : {}),
    ...(prev.football
      ? {
          football: {
            ...prev.football,
            kickoffSpawns: Object.fromEntries(
              Object.entries(prev.football.kickoffSpawns).map(([k, v]) => [k, { ...v }])
            ),
            lastGoalBanner: prev.football.lastGoalBanner
              ? { ...prev.football.lastGoalBanner }
              : null,
          },
        }
      : {}),
    ...(prev.ruleTeamScores ? { ruleTeamScores: { ...prev.ruleTeamScores } } : {}),
    ...(prev.ruleTeamLabels ? { ruleTeamLabels: { ...prev.ruleTeamLabels } } : {}),
    ...(prev.ruleTeamColors ? { ruleTeamColors: { ...prev.ruleTeamColors } } : {}),
    explosions: prev.explosions.map((e) => ({ ...e })),
  };
}
