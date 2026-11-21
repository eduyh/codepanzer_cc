import {
  CHASSIS_SPECS,
  computeShellMetrics,
  MAIN_GUN_SPECS,
  RADAR_SPECS,
  SUB_WEAPON_SPECS,
} from '../data/parts';
import {
  ArenaConfig,
  ArenaObstacle,
  ArenaSizeId,
  ArenaTile,
  BattleState,
  GridSize,
  ObstacleMode,
  OuterWallMode,
  TankBlueprint,
  TankRuntime,
} from '../types/game';
import { validateAndRepairBlueprint } from '../utils/blueprintGatekeeper';
import {
  cpuIdForGridSize,
} from '../data/parts';
import {
  getAutoTankColor,
  looksLikePythonSource,
  parsePythonSourceWithAutoSize,
  sanitizeAuthorName,
  sanitizeTankName,
} from '../utils/codeParser';
import {
  decodeShareCode,
  validateAndNormalizeBlueprint,
} from '../utils/share';
import {
  circleIntersectsRect,
  clamp,
  hasLineOfSight,
  normalizeAngle180,
  normalizeAngle360,
  vectorToAngle,
} from './math';
import {
  applyDamage,
  ARENA_SIZE_SPECS,
  computeTankBaseContribution,
  createTankRuntime,
  generateArenaObstacles,
  getSpawnsForArena,
  resolveObstaclePush,
  stepBattleTick,
} from './simulator';

export type BattlefieldFormat = 'battle_royale' | 'team_match' | 'tournament' | 'league';

export type BattlefieldRuleId =
  | 'elimination'
  | 'ramming_derby'
  | 'domination'
  | 'balloon_hunt'
  | 'tank_soccer'
  | 'bounty_hunt';

export type CpuRegulationId =
  | 'any'
  | 'only_4x4'
  | 'max_6x6'
  | 'max_8x8'
  | 'only_6x6'
  | 'only_8x8'
  | 'pair_6x6_4x4';

export type ArenaZoneMode = 'none' | 'slow' | 'no_weapon' | 'ice' | 'cooldown' | 'mixed';

export type GravityPresetId = 'high_2' | 'high_1' | 'normal' | 'low_1' | 'low_2';

export type SandstormPresetId = 'none' | 'light' | 'medium' | 'heavy' | 'extreme';

export interface BattlefieldRosterEntry {
  entryId: string;
  playerName: string;
  basePlayerName?: string;
  machineName: string;
  blueprint: TankBlueprint;
  sourceLabel: string;
  teamSlot?: number; // 0..3 for Team A..D
  enabled: boolean;
  isPreset?: boolean;
}

export interface BattlefieldConfig {
  format: BattlefieldFormat;
  ruleId: BattlefieldRuleId;
  cpuRegulation: CpuRegulationId;
  disableWeapons: boolean;
  disableSubWeapons: boolean;
  outerWallMode: OuterWallMode;
  zoneMode: ArenaZoneMode;
  gravityPreset: GravityPresetId;
  sandstormPreset: SandstormPresetId;
  arenaSize: ArenaSizeId;
  obstacleMode: ObstacleMode;
  obstacleSeed: number;
  maxSeconds: number;
  teamUnitSize: 1 | 2;
  seriesFormat?: 'bo1' | 'bo3';
  randomizeSeedPerMatch?: boolean;
}

export interface BattlefieldParticipant {
  entry: BattlefieldRosterEntry;
  teamId: string;
  teamLabel: string;
  teamColor: string;
  slotIndex: number;
}

export interface BattlefieldRuleSpec {
  id: BattlefieldRuleId;
  name: string;
  shortLabel: string;
  description: string;
  ready: boolean;
  recommendedDisableWeapons?: boolean;
  setupArena?: (state: BattleState, config: BattlefieldConfig) => void;
  onTick?: (state: BattleState, config: BattlefieldConfig) => void;
  computeContributionLabel?: (tank: TankRuntime) => string;
}

export interface CpuRegulationSpec {
  id: CpuRegulationId;
  label: string;
  description: string;
}

export const CPU_REGULATION_SPECS: Record<CpuRegulationId, CpuRegulationSpec> = {
  any: {
    id: 'any',
    label: '無制限（全CPU許可）',
    description: '4×4 / 6×6 / 8×8 / 12×12 すべての機体が出場できます。',
  },
  only_4x4: {
    id: 'only_4x4',
    label: '4×4 限定',
    description: '超小型CPU (4×4) のみ出場可能。',
  },
  max_6x6: {
    id: 'max_6x6',
    label: '6×6 以下',
    description: '4×4 または 6×6 の機体が出場可能。',
  },
  max_8x8: {
    id: 'max_8x8',
    label: '8×8 以下',
    description: '4×4 / 6×6 / 8×8 の機体が出場可能（12×12 不可）。',
  },
  only_6x6: {
    id: 'only_6x6',
    label: '6×6 限定',
    description: '小型CPU (6×6) のみ出場可能。',
  },
  only_8x8: {
    id: 'only_8x8',
    label: '8×8 限定',
    description: '標準CPU (8×8) のみ出場可能。',
  },
  pair_6x6_4x4: {
    id: 'pair_6x6_4x4',
    label: '6×6 + 4×4 ペア限定',
    description: '2機ペア戦用：1機目は6×6以下、2機目は4×4の編成が条件です。',
  },
};

export const RAMMING_DAMAGE_MULTIPLIER = 3;

export function computeRammingDamage(tank: TankRuntime): number {
  const gunSpec = MAIN_GUN_SPECS[tank.blueprint.assembly.mainGun] ?? MAIN_GUN_SPECS.standard;
  const maxFirepower = computeShellMetrics(
    gunSpec.id,
    gunSpec.maxPower,
    tank.blueprint.assembly.chassis
  ).damage;
  const impactSpeed = Math.max(0, tank.lastCollisionImpactSpeed ?? Math.abs(tank.speed));
  const boostBonus = tank.boostTicks > 0 ? 0.25 : 0;
  const speedFactor = Math.min(1.5, 0.3 + (impactSpeed / 3.5) * 0.7 + boostBonus);
  return maxFirepower * RAMMING_DAMAGE_MULTIPLIER * speedFactor;
}

function getDesiredBalloonCount(sizeId?: ArenaSizeId): number {
  if (sizeId === 'tiny' || sizeId === 'small') return 4;
  if (sizeId === 'medium') return 6;
  return 8;
}

function makeRuleBalloonId(tick: number, serial: number): string {
  return `bf_balloon_${tick}_${serial}`;
}

function spawnRuleBalloon(
  state: BattleState,
  config: BattlefieldConfig,
  serial: number
) {
  const w = state.arena.width;
  const h = state.arena.height;
  const rng = createZoneRng(
    (config.obstacleSeed >= 0 ? config.obstacleSeed + 101 : 4242) * 131 +
      state.tick * 97 +
      serial * 37
  );
  const isGold = rng() < 0.25;
  const radius = isGold ? 17 : 20;
  const pad = Math.max(52, radius + 34);
  let bestX = w / 2;
  let bestY = h / 2;

  for (let attempt = 0; attempt < 60; attempt++) {
    const cx = pad + rng() * Math.max(20, w - pad * 2);
    const cy = pad + rng() * Math.max(20, h - pad * 2);
    const hitObs = state.arena.obstacles.some((o) =>
      circleIntersectsRect(cx, cy, radius + 14, o)
    );
    if (hitObs) continue;
    const nearTank = state.tanks.some(
      (t) => t.hp > 0 && Math.hypot(t.x - cx, t.y - cy) < radius + 72
    );
    if (nearTank && attempt < 40) continue;
    const nearOther = (state.arena.targets ?? []).some(
      (tg) => !tg.popped && Math.hypot(tg.x - cx, tg.y - cy) < radius + tg.radius + 36
    );
    if (nearOther && attempt < 45) continue;
    bestX = cx;
    bestY = cy;
    break;
  }

  let patrol:
    | { ax: number; ay: number; bx: number; by: number; speed: number; dir?: 1 | -1 }
    | undefined;
  if (isGold) {
    const angle = rng() * Math.PI * 2;
    const span = Math.min(130, Math.min(w, h) * 0.2);
    const bx = Math.max(pad, Math.min(w - pad, bestX + Math.cos(angle) * span));
    const by = Math.max(pad, Math.min(h - pad, bestY + Math.sin(angle) * span));
    const midpointObs = state.arena.obstacles.some((o) =>
      circleIntersectsRect((bestX + bx) / 2, (bestY + by) / 2, radius + 6, o) ||
      circleIntersectsRect(bx, by, radius + 10, o)
    );
    if (!midpointObs && Math.hypot(bx - bestX, by - bestY) >= 40) {
      patrol = {
        ax: bestX,
        ay: bestY,
        bx,
        by,
        speed: 1.8,
        dir: 1,
      };
    }
  }

  return {
    id: makeRuleBalloonId(state.tick, serial),
    kind: 'shoot_balloon' as const,
    x: bestX,
    y: bestY,
    radius,
    hp: 1,
    maxHp: 1,
    points: isGold ? 3 : 1,
    color: isGold ? '#facc15' : '#f43f5e',
    label: isGold ? '★3pt' : '1pt',
    ...(patrol ? { patrol } : {}),
  };
}

function getTerritoryGridDims(sizeId?: ArenaSizeId): { cols: number; rows: number } {
  switch (sizeId) {
    case 'tiny':
      return { cols: 5, rows: 4 };
    case 'small':
      return { cols: 6, rows: 5 };
    case 'medium':
      return { cols: 8, rows: 6 };
    default:
      return { cols: 10, rows: 8 };
  }
}

function syncDominationScores(state: BattleState): void {
  const grid = state.territoryGrid;
  if (!grid) return;
  const scores: Record<string, number> = {};
  for (const t of state.tanks) {
    const teamKey = t.teamId ?? t.id;
    if (scores[teamKey] === undefined) scores[teamKey] = 0;
  }
  for (let i = 0; i < grid.owners.length; i++) {
    if (grid.blocked[i]) continue;
    const owner = grid.owners[i];
    if (owner) {
      scores[owner] = (scores[owner] ?? 0) + 1;
    }
  }
  state.ruleTeamScores = scores;
}

function updateDominationGrid(state: BattleState): void {
  const grid = state.territoryGrid;
  if (!grid) return;
  const cellW = state.arena.width / grid.cols;
  const cellH = state.arena.height / grid.rows;

  const cellTeams = new Map<number, Set<string>>();
  const cellTanks = new Map<number, TankRuntime[]>();
  for (const tank of state.tanks) {
    if (tank.hp <= 0) continue;
    const col = Math.max(0, Math.min(grid.cols - 1, Math.floor(tank.x / cellW)));
    const row = Math.max(0, Math.min(grid.rows - 1, Math.floor(tank.y / cellH)));
    const idx = row * grid.cols + col;
    if (grid.blocked[idx]) continue;
    const teamKey = tank.teamId ?? tank.id;
    let tSet = cellTeams.get(idx);
    if (!tSet) {
      tSet = new Set<string>();
      cellTeams.set(idx, tSet);
    }
    tSet.add(teamKey);
    const list = cellTanks.get(idx);
    if (list) list.push(tank);
    else cellTanks.set(idx, [tank]);
  }

  let changed = false;
  for (const [idx, teams] of cellTeams.entries()) {
    const prev = grid.owners[idx];
    if (teams.size > 1) {
      if (prev !== null) {
        grid.owners[idx] = null;
        changed = true;
      }
    } else if (teams.size === 1) {
      const claimer = Array.from(teams)[0];
      if (prev !== claimer) {
        grid.owners[idx] = claimer;
        changed = true;
        const claimants = cellTanks.get(idx) ?? [];
        if (claimants[0]) {
          claimants[0].stats.ruleScore = (claimants[0].stats.ruleScore ?? 0) + 1;
        }
      }
    }
  }

  if (changed) {
    grid.version += 1;
  }
  syncDominationScores(state);
}

function buildFootballKickoffSpawns(
  state: BattleState,
  westTeamId: string,
  seed: number,
  kickoffIndex: number
): Record<string, { x: number; y: number; bodyAngle: number }> {
  const w = state.arena.width;
  const h = state.arena.height;
  const rng = createZoneRng((seed * 131 + kickoffIndex * 997 + 17) >>> 0);
  const westTanks = state.tanks.filter((t) => (t.teamId ?? t.id) === westTeamId);
  const eastTanks = state.tanks.filter((t) => (t.teamId ?? t.id) !== westTeamId);
  const spawns: Record<string, { x: number; y: number; bodyAngle: number }> = {};
  const placed: Array<{ x: number; y: number; r: number }> = [];

  const placeSide = (list: TankRuntime[], minRatio: number, maxRatio: number) => {
    for (const tank of list) {
      const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
      const minX = Math.max(r + 16, w * minRatio);
      const maxX = Math.min(w - r - 16, w * maxRatio);
      const yMargin = Math.max(48, r + 24);
      const minY = yMargin;
      const maxY = Math.max(yMargin + 10, h - yMargin);

      let chosenX = (minX + maxX) / 2;
      let chosenY = (minY + maxY) / 2;
      let foundClear = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const cx = minX + rng() * Math.max(10, maxX - minX);
        const cy = minY + rng() * Math.max(10, maxY - minY);
        const hitObs = state.arena.obstacles.some((o) =>
          circleIntersectsRect(cx, cy, r + 10, o)
        );
        if (hitObs) continue;
        const nearOther = placed.some(
          (p) => Math.hypot(cx - p.x, cy - p.y) < r + p.r + 36
        );
        if (nearOther) continue;
        chosenX = cx;
        chosenY = cy;
        foundClear = true;
        break;
      }

      const pos = { x: chosenX, y: chosenY };
      if (!foundClear && state.arena.obstacles.length > 0) {
        resolveObstaclePush(pos, r + 4, state.arena.obstacles);
        pos.x = Math.max(r + 12, Math.min(w - r - 12, pos.x));
        pos.y = Math.max(r + 12, Math.min(h - r - 12, pos.y));
      }

      placed.push({ x: pos.x, y: pos.y, r });
      const rawDeg = (Math.atan2(w / 2 - pos.x, -(h / 2 - pos.y)) * 180) / Math.PI;
      const bodyAngle = ((rawDeg % 360) + 360) % 360;
      spawns[tank.id] = { x: pos.x, y: pos.y, bodyAngle };
    }
  };

  placeSide(westTanks, 0.12, 0.38);
  placeSide(eastTanks, 0.62, 0.88);
  return spawns;
}

function resetFootballPositions(state: BattleState, freezeTicks: number): void {
  const fb = state.football;
  if (!fb) return;
  const w = state.arena.width;
  const h = state.arena.height;
  fb.kickoffCount += 1;
  fb.kickoffSpawns = buildFootballKickoffSpawns(
    state,
    fb.westTeamId,
    fb.kickoffSeed,
    fb.kickoffCount
  );

  const center = { x: w / 2, y: h / 2 };
  if (state.arena.obstacles.length > 0) {
    resolveObstaclePush(center, fb.radius + 4, state.arena.obstacles);
  }
  fb.x = center.x;
  fb.y = center.y;
  fb.vx = 0;
  fb.vy = 0;
  fb.lastTouchTankId = null;
  fb.lastTouchTeamId = null;
  fb.kickoffFreezeTicks = freezeTicks;
  fb.pendingKickoffReset = false;

  state.projectiles = [];
  state.mines = [];

  for (const t of state.tanks) {
    const sp = fb.kickoffSpawns[t.id];
    if (sp) {
      t.x = sp.x;
      t.y = sp.y;
      t.bodyAngle = sp.bodyAngle;
      t.turretAngle = sp.bodyAngle;
      t.radarAngle = sp.bodyAngle;
    }
    t.vx = 0;
    t.vy = 0;
    t.speed = 0;
    t.gunHeat = 0;
    t.recoil = 0;
    t.moveState = null;
    t.sleepState = null;
    t.turnState = null;
    t.fireState = null;
    t.detectedEnemy = null;
    t.radarLock = false;
    t.enemyDist = null;
  }
}

export const BOUNTY_TUNING = {
  baseValue: 100,
  stepValue: 100,
  maxValue: 500,
  respawnTicks: 50, // 2.5s at 20 TPS
  invulnerableTicks: 30, // 1.5s at 20 TPS
  killHealRatio: 0.2, // +20% maxHp per kill
  killSpRecover: 1, // +1 SP ammo per kill
  streakBuffs: [
    { damageMult: 1.0, coolingMult: 1.0 }, // 0 streak (100pt)
    { damageMult: 1.08, coolingMult: 1.05 }, // 1 streak (200pt)
    { damageMult: 1.15, coolingMult: 1.1 }, // 2 streak (300pt)
    { damageMult: 1.22, coolingMult: 1.15 }, // 3 streak (400pt)
    { damageMult: 1.28, coolingMult: 1.2 }, // 4+ streak (500pt)
  ],
} as const;

export function getBountyStreakBuff(streak: number): {
  damageMult: number;
  coolingMult: number;
} {
  const idx = clamp(Math.floor(streak), 0, BOUNTY_TUNING.streakBuffs.length - 1);
  return BOUNTY_TUNING.streakBuffs[idx];
}

function isBountyAllied(a: TankRuntime, b: TankRuntime, state: BattleState): boolean {
  if (a.id === b.id) return true;
  if (state.arena.multiTeamMode && a.teamId && b.teamId) {
    return a.teamId === b.teamId;
  }
  return Boolean(state.arena.teamBattle && a.team === b.team);
}

function isPointDetectedByEnemyRadar(
  pt: { x: number; y: number },
  enemy: TankRuntime,
  state: BattleState
): boolean {
  const radar = RADAR_SPECS[enemy.blueprint.assembly.radar];
  const radarRangeMult = clamp(state.arena.radarRangeMult ?? 1.0, 0.2, 1.0);
  const effectiveRange = radar.range * radarRangeMult;
  const dist = Math.hypot(pt.x - enemy.x, pt.y - enemy.y);
  if (dist > effectiveRange * 1.05) return false;
  const absBearing = vectorToAngle(pt.x - enemy.x, pt.y - enemy.y);
  const diff = Math.abs(normalizeAngle180(absBearing - enemy.radarAngle));
  if (diff > radar.fovDeg / 2 + 8) return false;
  return hasLineOfSight(
    enemy.x,
    enemy.y,
    pt.x,
    pt.y,
    state.arena.obstacles,
    state.smokes ?? []
  );
}

function isPointInEnemyTurretLine(
  pt: { x: number; y: number },
  enemy: TankRuntime,
  state: BattleState
): boolean {
  const dist = Math.hypot(pt.x - enemy.x, pt.y - enemy.y);
  if (dist > 900) return false;
  const absBearing = vectorToAngle(pt.x - enemy.x, pt.y - enemy.y);
  const diff = Math.abs(normalizeAngle180(absBearing - enemy.turretAngle));
  if (diff > 16) return false;
  return hasLineOfSight(
    enemy.x,
    enemy.y,
    pt.x,
    pt.y,
    state.arena.obstacles,
    state.smokes ?? []
  );
}

export function pickBountyRespawnPoint(
  tank: TankRuntime,
  state: BattleState,
  tankIndex: number
): { x: number; y: number; angle: number } {
  const w = state.arena.width;
  const h = state.arena.height;
  const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
  const wallMargin = Math.max(54, r + 28);
  const candidates: Array<{ x: number; y: number }> = [];

  for (const sp of getSpawnsForArena(w, h)) {
    candidates.push({
      x: clamp(sp.x, wallMargin, w - wallMargin),
      y: clamp(sp.y, wallMargin, h - wallMargin),
    });
  }

  const cols = 6;
  const rows = 5;
  const spanX = Math.max(40, w - wallMargin * 2);
  const spanY = Math.max(40, h - wallMargin * 2);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      candidates.push({
        x: Math.round(wallMargin + (spanX * col) / Math.max(1, cols - 1)),
        y: Math.round(wallMargin + (spanY * row) / Math.max(1, rows - 1)),
      });
    }
  }

  const unobstructed = candidates.filter((pt) => {
    const blockedByObs = state.arena.obstacles.some((obs) =>
      circleIntersectsRect(pt.x, pt.y, r + 14, obs)
    );
    if (blockedByObs) return false;
    const inDangerousTile = (state.arena.tiles ?? []).some(
      (tl) =>
        (tl.kind === 'hazard' || tl.kind === 'slow') &&
        circleIntersectsRect(pt.x, pt.y, r + 6, tl)
    );
    return !inDangerousTile;
  });

  const otherAlive = state.tanks.filter((other) => other.id !== tank.id && other.hp > 0);
  const nonOverlapping = unobstructed.filter(
    (pt) =>
      !otherAlive.some(
        (other) =>
          Math.hypot(pt.x - other.x, pt.y - other.y) <
          r + CHASSIS_SPECS[other.blueprint.assembly.chassis].radius + 24
      )
  );

  const pool =
    nonOverlapping.length > 0
      ? nonOverlapping
      : unobstructed.length > 0
        ? unobstructed
        : candidates;

  const enemiesAlive = otherAlive.filter((other) => !isBountyAllied(tank, other, state));
  const refTargets = enemiesAlive.length > 0 ? enemiesAlive : otherAlive;

  interface ScoredCandidate {
    pt: { x: number; y: number };
    radarHits: number;
    turretHits: number;
    projHazard: boolean;
    minEnemyDist: number;
    distFromDeath: number;
  }

  const scored: ScoredCandidate[] = pool.map((pt) => {
    let radarHits = 0;
    let turretHits = 0;
    for (const enemy of enemiesAlive) {
      if (isPointDetectedByEnemyRadar(pt, enemy, state)) radarHits += 1;
      if (isPointInEnemyTurretLine(pt, enemy, state)) turretHits += 1;
    }

    const projHazard = state.projectiles.some((p) => {
      if (p.ownerId === tank.id) return false;
      const owner = state.tanks.find((t) => t.id === p.ownerId);
      if (owner && isBountyAllied(tank, owner, state)) return false;
      const dx = pt.x - p.x;
      const dy = pt.y - p.y;
      const dist = Math.hypot(dx, dy);
      return dist <= 150 && dx * p.vx + dy * p.vy > 0;
    });

    let minEnemyDist = 9999;
    for (const target of refTargets) {
      const d = Math.hypot(pt.x - target.x, pt.y - target.y);
      if (d < minEnemyDist) minEnemyDist = d;
    }
    const distFromDeath = Math.hypot(pt.x - tank.x, pt.y - tank.y);

    return { pt, radarHits, turretHits, projHazard, minEnemyDist, distFromDeath };
  });

  const tier1 = scored.filter((c) => c.radarHits === 0 && c.turretHits === 0 && !c.projHazard);
  const tier2 = scored.filter((c) => c.radarHits === 0 && !c.projHazard);
  const tier3 = scored.filter((c) => c.radarHits === 0);

  let bestTier: ScoredCandidate[];
  if (tier1.length > 0) {
    bestTier = tier1;
  } else if (tier2.length > 0) {
    bestTier = tier2;
  } else if (tier3.length > 0) {
    bestTier = tier3;
  } else {
    const minPenalty = Math.min(
      ...scored.map((c) => c.radarHits * 4 + c.turretHits * 2 + (c.projHazard ? 2 : 0))
    );
    bestTier = scored.filter(
      (c) => c.radarHits * 4 + c.turretHits * 2 + (c.projHazard ? 2 : 0) === minPenalty
    );
  }

  const awayFromDeath = bestTier.filter((c) => c.distFromDeath >= 180);
  const stepA = awayFromDeath.length > 0 ? awayFromDeath : bestTier;

  const wellSpaced = stepA.filter((c) => c.minEnemyDist >= 200);
  const ranked = [...(wellSpaced.length > 0 ? wellSpaced : stepA)].sort((a, b) => {
    const scoreB = b.minEnemyDist + Math.min(260, b.distFromDeath * 0.6);
    const scoreA = a.minEnemyDist + Math.min(260, a.distFromDeath * 0.6);
    return scoreB - scoreA;
  });

  const topChoices = ranked.slice(0, Math.min(6, ranked.length));
  const rng = createZoneRng(
    ((state.tick + 1) * 97 + (tankIndex + 1) * 313 + (tank.stats.deaths ?? 0) * 1997) >>> 0
  );
  const chosen = topChoices[Math.floor(rng() * topChoices.length)] ?? ranked[0];
  const faceAngle = normalizeAngle360(
    vectorToAngle(w / 2 - chosen.pt.x, h / 2 - chosen.pt.y)
  );
  return { x: chosen.pt.x, y: chosen.pt.y, angle: faceAngle };
}

function handleBountyHuntTick(state: BattleState): void {
  const justDiedIds = new Set<string>();

  for (const victim of state.tanks) {
    if (victim.hp > 0 || (victim.respawnTicks ?? 0) > 0) continue;
    justDiedIds.add(victim.id);
    victim.respawnTicks = BOUNTY_TUNING.respawnTicks;

    const directKiller =
      victim.killedById &&
      victim.killedById !== 'environment' &&
      victim.killedById !== victim.id
        ? state.tanks.find((t) => t.id === victim.killedById)
        : undefined;
    const recentAttacker =
      !directKiller &&
      victim.lastAttackerId &&
      victim.lastAttackerId !== victim.id &&
      state.tick - (victim.lastAttackerTick ?? -999) <= 100
        ? state.tanks.find((t) => t.id === victim.lastAttackerId)
        : undefined;
    const killer = directKiller ?? recentAttacker;

    const claimedBounty = victim.bountyValue ?? BOUNTY_TUNING.baseValue;
    if (killer && !isBountyAllied(killer, victim, state)) {
      killer.stats.ruleScore = (killer.stats.ruleScore ?? 0) + claimedBounty;
      if (claimedBounty >= 200) {
        killer.stats.bountyClaimedCount = (killer.stats.bountyClaimedCount ?? 0) + 1;
      }
      killer.stats.maxBountyClaimed = Math.max(
        killer.stats.maxBountyClaimed ?? 0,
        claimedBounty
      );

      const nextStreak = (killer.bountyStreak ?? 0) + 1;
      killer.bountyStreak = nextStreak;
      killer.stats.maxBountyStreak = Math.max(
        killer.stats.maxBountyStreak ?? 0,
        nextStreak
      );
      killer.bountyValue = Math.min(
        BOUNTY_TUNING.maxValue,
        BOUNTY_TUNING.baseValue + nextStreak * BOUNTY_TUNING.stepValue
      );
      const buff = getBountyStreakBuff(nextStreak);
      killer.bountyDamageMult = buff.damageMult;
      killer.bountyCoolingMult = buff.coolingMult;

      if (killer.hp > 0) {
        const healAmount = Math.round(killer.maxHp * BOUNTY_TUNING.killHealRatio);
        killer.hp = Math.min(killer.maxHp, killer.hp + healAmount);
        const subMax =
          SUB_WEAPON_SPECS[killer.blueprint.assembly.subWeapon]?.maxAmmo ?? 0;
        if (subMax > 0) {
          killer.subAmmo = Math.min(subMax, killer.subAmmo + BOUNTY_TUNING.killSpRecover);
        }
        state.explosions.push({
          id: `bounty_heal_${state.tick}_${killer.id}`,
          x: killer.x,
          y: killer.y,
          radius: 46,
          color: '#fbbf24',
          age: 0,
          maxAge: 24,
        });
      }
    }

    victim.bountyValue = BOUNTY_TUNING.baseValue;
    victim.bountyStreak = 0;
    victim.bountyDamageMult = 1.0;
    victim.bountyCoolingMult = 1.0;
    victim.lastAttackerId = null;
  }

  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks[i];
    if (tank.hp > 0 || justDiedIds.has(tank.id)) continue;
    const rem = (tank.respawnTicks ?? 0) - 1;
    if (rem > 0) {
      tank.respawnTicks = rem;
      continue;
    }

    const pt = pickBountyRespawnPoint(tank, state, i);
    const subMax = SUB_WEAPON_SPECS[tank.blueprint.assembly.subWeapon]?.maxAmmo ?? 0;
    tank.x = pt.x;
    tank.y = pt.y;
    tank.vx = 0;
    tank.vy = 0;
    tank.speed = 0;
    tank.bodyAngle = pt.angle;
    tank.turretAngle = pt.angle;
    tank.radarAngle = pt.angle;
    tank.hp = tank.maxHp;
    tank.gunHeat = 0;
    tank.subAmmo = subMax;
    tank.subCooldown = 0;
    tank.shieldTicks = 0;
    tank.boostTicks = 0;
    tank.recoil = 0;
    tank.invulnerableTicks = BOUNTY_TUNING.invulnerableTicks;
    tank.respawnTicks = 0;
    tank.killedById = null;
    tank.lastAttackerId = null;
    tank.lastAttackerTick = undefined;
    tank.wallHitCooldown = 0;
    tank.outerWallBounceCooldown = 0;
    tank.detectedEnemy = null;
    tank.enemyDist = null;
    tank.radarLock = false;
    tank.underLock = false;
    tank.moveState = null;
    tank.sleepState = null;
    tank.turnState = null;
    tank.fireState = null;
    tank.halted = false;
    tank.loopStack = [];
    tank.counters = { A: 0, B: 0 };
    tank.loopCounters = {};
    tank.activePrintSpeech = null;

    state.explosions.push({
      id: `bounty_spawn_${state.tick}_${tank.id}`,
      x: tank.x,
      y: tank.y,
      radius: 44,
      color: '#38bdf8',
      age: 0,
      maxAge: 22,
    });
  }

  const nextScores: Record<string, number> = {};
  for (const tank of state.tanks) {
    const tid = tank.teamId ?? tank.id;
    nextScores[tid] = (nextScores[tid] ?? 0) + Math.round(tank.stats.ruleScore ?? 0);
  }
  state.ruleTeamScores = nextScores;
}

export const BATTLEFIELD_RULE_REGISTRY: Record<BattlefieldRuleId, BattlefieldRuleSpec> = {
  elimination: {
    id: 'elimination',
    name: '殲滅バトル（標準）',
    shortLabel: '殲滅戦',
    description: '相手を全滅させるか、制限時間終了時の生存数・基礎貢献度判定で勝敗を決めます。',
    ready: true,
    computeContributionLabel: (tank) => `与ダメ ${Math.round(tank.stats.damageDealt)}`,
  },
  ramming_derby: {
    id: 'ramming_derby',
    name: '体当たりバトル（射撃禁止向け）',
    shortLabel: '体当たり',
    description:
      '車体同士の衝突で「主砲最大火力×3 × 速度係数（0.3〜1.5倍）」の体当たりダメージを与え、撃破やポイントに加算します（全武装禁止との組み合わせ推奨）。',
    ready: true,
    recommendedDisableWeapons: true,
    onTick: (state) => {
      // Credit boosted collision damage and score between non-allied tanks that collided on this tick
      for (let i = 0; i < state.tanks.length; i++) {
        const a = state.tanks[i];
        if (a.hp <= 0 || a.lastTankCollisionTick !== state.tick) continue;
        for (let j = i + 1; j < state.tanks.length; j++) {
          const b = state.tanks[j];
          if (b.hp <= 0 || b.lastTankCollisionTick !== state.tick) continue;
          if (state.arena.multiTeamMode && a.teamId && b.teamId && a.teamId === b.teamId) continue;

          const ra = CHASSIS_SPECS[a.blueprint.assembly.chassis].radius;
          const rb = CHASSIS_SPECS[b.blueprint.assembly.chassis].radius;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > ra + rb + 48) continue;

          const dmgToB = computeRammingDamage(a);
          const dmgToA = computeRammingDamage(b);

          applyDamage(b, dmgToB, a, state.tick);
          applyDamage(a, dmgToA, b, state.tick);
          a.stats.ruleScore = (a.stats.ruleScore ?? 0) + Math.round(dmgToB);
          b.stats.ruleScore = (b.stats.ruleScore ?? 0) + Math.round(dmgToA);
        }
      }
    },
    computeContributionLabel: (tank) => `衝突pt ${Math.round(tank.stats.ruleScore ?? 0)}`,
  },
  domination: {
    id: 'domination',
    name: '陣取り（全面タイル塗り）',
    shortLabel: '陣取り',
    description:
      '全面タイルを乗って自チーム色に占領（他チーム同居で非占領）。リスポーンなしでタイムアップまで続行し、最終占領タイル数で勝敗を決めます。',
    ready: true,
    setupArena: (state) => {
      state.arena.continueUntilTimeout = true;
      state.arena.scoreOnlyVictory = true;
      const { cols, rows } = getTerritoryGridDims(state.arena.sizeId);
      const cellW = state.arena.width / cols;
      const cellH = state.arena.height / rows;
      const total = cols * rows;
      const blocked = new Array<boolean>(total).fill(false);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellW;
          const y = r * cellH;
          const cx = x + cellW / 2;
          const cy = y + cellH / 2;
          let overlapArea = 0;
          let centerInside = false;
          for (const obs of state.arena.obstacles) {
            if (
              cx >= obs.x &&
              cx <= obs.x + obs.width &&
              cy >= obs.y &&
              cy <= obs.y + obs.height
            ) {
              centerInside = true;
              break;
            }
            const ox = Math.max(0, Math.min(x + cellW, obs.x + obs.width) - Math.max(x, obs.x));
            const oy = Math.max(0, Math.min(y + cellH, obs.y + obs.height) - Math.max(y, obs.y));
            overlapArea += ox * oy;
          }
          if (centerInside || overlapArea >= cellW * cellH * 0.45) {
            blocked[r * cols + c] = true;
          }
        }
      }

      const teamColors: Record<string, string> = {};
      const teamLabels: Record<string, string> = {};
      for (const t of state.tanks) {
        const key = t.teamId ?? t.id;
        teamColors[key] = state.ruleTeamColors?.[key] ?? t.blueprint.color;
        teamLabels[key] = state.ruleTeamLabels?.[key] ?? (t.playerName || t.blueprint.name);
      }

      state.territoryGrid = {
        cols,
        rows,
        owners: new Array<string | null>(total).fill(null),
        blocked,
        teamColors,
        teamLabels,
        version: 1,
      };
      updateDominationGrid(state);
    },
    onTick: (state) => {
      updateDominationGrid(state);
    },
    computeContributionLabel: (tank) => `塗替 ${Math.round(tank.stats.ruleScore ?? 0)}回`,
  },
  balloon_hunt: {
    id: 'balloon_hunt',
    name: '風船割り（風船のみターゲット）',
    shortLabel: '風船割り',
    description:
      'レーダー・ミサイルは風船のみを捕捉し、戦車へのダメージは無効（衝突バウンド強）。砲弾・体当たりで割った風船ptを競います。',
    ready: true,
    setupArena: (state, config) => {
      state.arena.radarTargetMode = 'targets_only';
      state.arena.disableTankDamage = true;
      state.arena.tankBounceMult = 1.8;
      state.arena.allowBalloonRamPop = true;
      state.arena.continueUntilTimeout = true;
      state.arena.scoreOnlyVictory = true;
      state.arena.targets = [];

      const count = getDesiredBalloonCount(state.arena.sizeId);
      for (let i = 0; i < count; i++) {
        state.arena.targets.push(spawnRuleBalloon(state, config, i + 1));
      }

      const scores: Record<string, number> = {};
      for (const t of state.tanks) {
        scores[t.teamId ?? t.id] = 0;
      }
      state.ruleTeamScores = scores;
    },
    onTick: (state, config) => {
      const targets = (state.arena.targets ?? []).filter((t) => !t.popped);
      const desired = getDesiredBalloonCount(state.arena.sizeId);
      let serial = state.tick * 13;
      while (targets.length < desired) {
        serial += 1;
        state.arena.targets = targets;
        targets.push(spawnRuleBalloon(state, config, serial));
      }
      state.arena.targets = targets;

      const scores: Record<string, number> = {};
      for (const t of state.tanks) {
        const key = t.teamId ?? t.id;
        scores[key] = (scores[key] ?? 0) + Math.round(t.stats.ruleScore ?? 0);
      }
      state.ruleTeamScores = scores;
    },
    computeContributionLabel: (tank) => `風船 ${Math.round(tank.stats.ruleScore ?? 0)}pt`,
  },
  tank_soccer: {
    id: 'tank_soccer',
    name: 'コンバットフットボール',
    shortLabel: 'フットボール',
    description:
      'レーダー・ミサイルはボールのみ捕捉（自陣ゴール方向への発射禁止・毎回ランダム配置キックオフ）。砲弾・体当たりで運び相手エンドラインへ入れると1点です。',
    ready: true,
    setupArena: (state, config) => {
      state.arena.radarTargetMode = 'ball_only';
      state.arena.disableTankDamage = true;
      state.arena.tankBounceMult = 1.8;
      state.arena.continueUntilTimeout = true;
      state.arena.scoreOnlyVictory = true;

      const distinctTeams = Array.from(new Set(state.tanks.map((t) => t.teamId ?? t.id)));
      const westTeamId = distinctTeams[0] ?? 'team_0';
      const eastTeamId = distinctTeams[1] ?? westTeamId;

      if (distinctTeams.length > 2) {
        state.tanks.forEach((t, idx) => {
          t.teamId = idx % 2 === 0 ? westTeamId : eastTeamId;
        });
      }

      const westSample = state.tanks.find((t) => (t.teamId ?? t.id) === westTeamId);
      const eastSample = state.tanks.find((t) => (t.teamId ?? t.id) === eastTeamId);
      const westTeamLabel =
        state.ruleTeamLabels?.[westTeamId] ??
        westSample?.playerName ??
        westSample?.blueprint.name ??
        'Team A';
      const eastTeamLabel =
        state.ruleTeamLabels?.[eastTeamId] ??
        eastSample?.playerName ??
        eastSample?.blueprint.name ??
        'Team B';
      const westTeamColor =
        state.ruleTeamColors?.[westTeamId] ?? westSample?.blueprint.color ?? '#56b4e9';
      const eastTeamColor =
        state.ruleTeamColors?.[eastTeamId] ?? eastSample?.blueprint.color ?? '#e69f00';

      state.ruleTeamLabels = {
        ...(state.ruleTeamLabels ?? {}),
        [westTeamId]: westTeamLabel,
        [eastTeamId]: eastTeamLabel,
      };
      state.ruleTeamColors = {
        ...(state.ruleTeamColors ?? {}),
        [westTeamId]: westTeamColor,
        [eastTeamId]: eastTeamColor,
      };
      state.ruleTeamScores = {
        [westTeamId]: 0,
        [eastTeamId]: 0,
      };

      const kickoffSeed =
        config.obstacleSeed >= 0
          ? config.obstacleSeed
          : Math.floor(Math.random() * 1_000_000_000);
      state.football = {
        x: state.arena.width / 2,
        y: state.arena.height / 2,
        vx: 0,
        vy: 0,
        radius: 20,
        lastTouchTankId: null,
        lastTouchTeamId: null,
        westTeamId,
        eastTeamId,
        westTeamLabel,
        eastTeamLabel,
        westTeamColor,
        eastTeamColor,
        kickoffFreezeTicks: 0,
        kickoffSeed,
        kickoffCount: 0,
        kickoffSpawns: {},
        lastGoalBanner: null,
      };
      resetFootballPositions(state, 0);
    },
    onTick: (state) => {
      const fb = state.football;
      if (!fb) return;

      // 1. Tank-to-ball dribble / kick contact
      for (const tank of state.tanks) {
        if (tank.hp <= 0) continue;
        const r = CHASSIS_SPECS[tank.blueprint.assembly.chassis].radius;
        const dx = fb.x - tank.x;
        const dy = fb.y - tank.y;
        const dist = Math.hypot(dx, dy);
        const minDist = r + fb.radius;
        if (dist >= minDist) continue;

        let nx: number;
        let ny: number;
        if (dist < 1e-4) {
          const rad = (tank.bodyAngle * Math.PI) / 180;
          nx = Math.sin(rad);
          ny = -Math.cos(rad);
        } else {
          nx = dx / dist;
          ny = dy / dist;
        }

        fb.x = tank.x + nx * (minDist + 0.5);
        fb.y = tank.y + ny * (minDist + 0.5);

        const boostMult = tank.boostTicks > 0 ? 1.5 : 1.0;
        const kickSpeed = Math.max(2.2, (1.7 + Math.abs(tank.speed) * 1.15) * boostMult);
        const radialVel = fb.vx * nx + fb.vy * ny;
        if (radialVel < kickSpeed) {
          const dv = kickSpeed - radialVel;
          fb.vx += nx * dv + tank.vx * 0.2;
          fb.vy += ny * dv + tank.vy * 0.2;
        }
        fb.lastTouchTankId = tank.id;
        fb.lastTouchTeamId = tank.teamId ?? tank.id;
      }

      // 2. Armed mine blast vs ball
      if (state.mines.length > 0) {
        const remainingMines = [];
        for (const mine of state.mines) {
          if (
            mine.armTicks <= 0 &&
            Math.hypot(fb.x - mine.x, fb.y - mine.y) <= fb.radius + 14
          ) {
            const dx = fb.x - mine.x;
            const dy = fb.y - mine.y;
            const d = Math.hypot(dx, dy);
            const nx = d > 1e-4 ? dx / d : 0;
            const ny = d > 1e-4 ? dy / d : -1;
            fb.vx += nx * 7.5;
            fb.vy += ny * 7.5;
            const owner = state.tanks.find((t) => t.id === mine.ownerId);
            if (owner) {
              fb.lastTouchTankId = owner.id;
              fb.lastTouchTeamId = owner.teamId ?? owner.id;
            }
            state.explosions.push({
              id: `fb_mine_${state.tick}_${mine.id}`,
              x: mine.x,
              y: mine.y,
              radius: 42,
              color: '#ef4444',
              age: 0,
              maxAge: 26,
            });
          } else {
            remainingMines.push(mine);
          }
        }
        state.mines = remainingMines;
      }

      // Clamp max ball speed & advance ball with rolling friction
      const spd = Math.hypot(fb.vx, fb.vy);
      if (spd > 15.5) {
        fb.vx = (fb.vx / spd) * 15.5;
        fb.vy = (fb.vy / spd) * 15.5;
      }
      fb.x += fb.vx;
      fb.y += fb.vy;
      fb.vx *= 0.968;
      fb.vy *= 0.968;
      if (Math.hypot(fb.vx, fb.vy) < 0.03) {
        fb.vx = 0;
        fb.vy = 0;
      }

      // Bounce off North/South sidelines
      if (fb.y < fb.radius) {
        fb.y = fb.radius;
        fb.vy = Math.abs(fb.vy) * 0.82;
      } else if (fb.y > state.arena.height - fb.radius) {
        fb.y = state.arena.height - fb.radius;
        fb.vy = -Math.abs(fb.vy) * 0.82;
      }

      // Push & bounce off obstacles
      if (state.arena.obstacles.length > 0) {
        const obsPush = resolveObstaclePush(fb, fb.radius, state.arena.obstacles);
        if (obsPush.hit) {
          const nLen = Math.hypot(obsPush.nx, obsPush.ny);
          if (nLen > 1e-5) {
            const onx = obsPush.nx / nLen;
            const ony = obsPush.ny / nLen;
            const dot = fb.vx * onx + fb.vy * ony;
            if (dot < 0) {
              fb.vx -= 1.82 * dot * onx;
              fb.vy -= 1.82 * dot * ony;
            }
          }
        }
      }

      // Check East / West Endline Goals
      let scoringTeamId: string | null = null;
      let scoringLabel = '';
      let scoringColor = '#38bdf8';
      if (fb.x >= state.arena.width - fb.radius) {
        scoringTeamId = fb.westTeamId;
        scoringLabel = fb.westTeamLabel;
        scoringColor = fb.westTeamColor;
      } else if (fb.x <= fb.radius) {
        scoringTeamId = fb.eastTeamId;
        scoringLabel = fb.eastTeamLabel;
        scoringColor = fb.eastTeamColor;
      }

      if (scoringTeamId) {
        const scores = { ...(state.ruleTeamScores ?? {}) };
        scores[scoringTeamId] = (scores[scoringTeamId] ?? 0) + 1;
        state.ruleTeamScores = scores;

        if (fb.lastTouchTankId && fb.lastTouchTeamId === scoringTeamId) {
          const scorer = state.tanks.find((t) => t.id === fb.lastTouchTankId);
          if (scorer) {
            scorer.stats.ruleScore = (scorer.stats.ruleScore ?? 0) + 1;
          }
        }

        state.explosions.push({
          id: `fb_goal_${state.tick}`,
          x: fb.x >= state.arena.width / 2 ? state.arena.width - fb.radius : fb.radius,
          y: fb.y,
          radius: 75,
          color: scoringColor,
          age: 0,
          maxAge: 34,
        });
        fb.x = fb.x >= state.arena.width / 2 ? state.arena.width - fb.radius : fb.radius;
        fb.vx = 0;
        fb.vy = 0;
        state.projectiles = [];
        state.mines = [];
        fb.lastGoalBanner = {
          teamId: scoringTeamId,
          teamLabel: scoringLabel,
          color: scoringColor,
          tick: state.tick,
        };
        fb.pendingKickoffReset = true;
      }
    },
    computeContributionLabel: (tank) => `ゴール ${Math.round(tank.stats.ruleScore ?? 0)}pt`,
  },
  bounty_hunt: {
    id: 'bounty_hunt',
    name: 'バウンティハンター（リスポーン賞金首戦）',
    shortLabel: '賞金首戦',
    description:
      '通常バトロワ機体のまま参加できるリスポーン付きポイント戦。撃破で相手の懸賞金(100〜500pt)を奪いHP20%＋SP1回復＋連勝バフを獲得。撃破されても2.5秒後に無敵＆SP満タンで敵レーダー外の安全地点へ復帰します。',
    ready: true,
    setupArena: (state) => {
      state.arena.continueUntilTimeout = true;
      state.arena.scoreOnlyVictory = true;
      state.arena.respawnEnabled = true;
      const scores: Record<string, number> = {};
      for (const tank of state.tanks) {
        tank.bountyValue = BOUNTY_TUNING.baseValue;
        tank.bountyStreak = 0;
        tank.bountyDamageMult = 1.0;
        tank.bountyCoolingMult = 1.0;
        tank.respawnTicks = 0;
        tank.invulnerableTicks = 0;
        const tid = tank.teamId ?? tank.id;
        scores[tid] = scores[tid] ?? 0;
      }
      state.ruleTeamScores = scores;
    },
    onTick: (state) => {
      handleBountyHuntTick(state);
    },
    computeContributionLabel: (tank) =>
      `賞金 ${Math.round(tank.stats.ruleScore ?? 0)}pt (★${tank.bountyValue ?? 100})`,
  },
};

export const OUTER_WALL_MODE_SPECS: Record<
  OuterWallMode,
  { id: OuterWallMode; label: string; shortLabel: string; description: string }
> = {
  normal: {
    id: 'normal',
    label: '通常壁',
    shortLabel: '通常壁',
    description: '通常の壁判定（壁沿いスライド＋微小ダメージ）。',
  },
  bounce: {
    id: 'bounce',
    label: '強バウンド壁',
    shortLabel: '強バウンド',
    description: '外周に接触すると内側へ大きく跳ね返されます。',
  },
  damage: {
    id: 'damage',
    label: '電撃大ダメージ壁',
    shortLabel: '電撃壁',
    description: '外周に接触すると大ダメージ（24）を受け、HP0 で撃破されます。',
  },
  damage_bounce: {
    id: 'damage_bounce',
    label: '電撃＋強バウンド壁',
    shortLabel: '電撃バウンド',
    description: '外周接触時に大ダメージ（24）を与えつつ大きく跳ね返します。',
  },
};

export const ARENA_ZONE_MODE_SPECS: Record<
  ArenaZoneMode,
  { id: ArenaZoneMode; label: string; shortLabel: string; description: string }
> = {
  none: {
    id: 'none',
    label: 'なし',
    shortLabel: 'エリアなし',
    description: '特殊床エリアを配置しません。',
  },
  slow: {
    id: 'slow',
    label: '減速エリア（泥沼・砂地）',
    shortLabel: '減速エリア',
    description: 'エリア内では移動速度・加速・旋回速度が大きく低下します（砲弾は通過）。',
  },
  no_weapon: {
    id: 'no_weapon',
    label: '武器禁止エリア（ジャミング）',
    shortLabel: '武器禁止エリア',
    description: 'エリア内では主砲・副武装が発射不可になります（外からの射撃は有効）。',
  },
  ice: {
    id: 'ice',
    label: '氷床エリア（スリップ）',
    shortLabel: '氷床エリア',
    description: 'エリア内では車体が慣性で滑り、急制動や急旋回がドリフト気味になります。',
  },
  cooldown: {
    id: 'cooldown',
    label: '冷却エリア（急速放熱 ×2）',
    shortLabel: '冷却エリア',
    description: 'エリア内にいる間は主砲の放熱速度が2倍になり、連射戦が激化します。',
  },
  mixed: {
    id: 'mixed',
    label: '混合（減速＋武器禁止＋氷＋冷却）',
    shortLabel: '全種混合エリア',
    description: '減速・武器禁止・氷床・冷却の各エリアを戦場にバランスよく配置します。',
  },
};

export interface GravityPresetSpec {
  id: GravityPresetId;
  speedMult: number;
  turretMult: number;
  label: string;
  shortLabel: string;
}

export const GRAVITY_PRESET_SPECS: Record<GravityPresetId, GravityPresetSpec> = {
  high_2: {
    id: 'high_2',
    speedMult: 0.5,
    turretMult: 0.75,
    label: '超高重力（速度 ×0.5 / 砲塔 ×0.75）',
    shortLabel: '超高重力 ×0.5',
  },
  high_1: {
    id: 'high_1',
    speedMult: 0.75,
    turretMult: 0.875,
    label: '高重力（速度 ×0.75 / 砲塔 ×0.88）',
    shortLabel: '高重力 ×0.75',
  },
  normal: {
    id: 'normal',
    speedMult: 1.0,
    turretMult: 1.0,
    label: '標準重力（×1.0）',
    shortLabel: '標準重力',
  },
  low_1: {
    id: 'low_1',
    speedMult: 1.25,
    turretMult: 1.125,
    label: '低重力（速度 ×1.25 / 砲塔 ×1.13）',
    shortLabel: '低重力 ×1.25',
  },
  low_2: {
    id: 'low_2',
    speedMult: 1.5,
    turretMult: 1.25,
    label: '超低重力（速度 ×1.5 / 砲塔 ×1.25）',
    shortLabel: '超低重力 ×1.5',
  },
};

export interface SandstormPresetSpec {
  id: SandstormPresetId;
  radarMult: number;
  label: string;
  shortLabel: string;
}

export const SANDSTORM_PRESET_SPECS: Record<SandstormPresetId, SandstormPresetSpec> = {
  none: {
    id: 'none',
    radarMult: 1.0,
    label: 'なし（レーダー ×1.0）',
    shortLabel: '砂塵なし',
  },
  light: {
    id: 'light',
    radarMult: 0.8,
    label: '弱砂塵（レーダー ×0.8）',
    shortLabel: '弱砂塵 ×0.8',
  },
  medium: {
    id: 'medium',
    radarMult: 0.6,
    label: '中砂塵（レーダー ×0.6）',
    shortLabel: '中砂塵 ×0.6',
  },
  heavy: {
    id: 'heavy',
    radarMult: 0.4,
    label: '強砂塵（レーダー ×0.4）',
    shortLabel: '強砂塵 ×0.4',
  },
  extreme: {
    id: 'extreme',
    radarMult: 0.2,
    label: '濃砂嵐（レーダー ×0.2）',
    shortLabel: '濃砂嵐 ×0.2',
  },
};

export const TEAM_LABELS = ['Team A', 'Team B', 'Team C', 'Team D'] as const;
export const TEAM_COLORS = [
  getAutoTankColor(0),
  getAutoTankColor(1),
  getAutoTankColor(2),
  getAutoTankColor(3),
];

export const DEFAULT_BATTLEFIELD_CONFIG: BattlefieldConfig = {
  format: 'battle_royale',
  ruleId: 'elimination',
  cpuRegulation: 'any',
  disableWeapons: false,
  disableSubWeapons: false,
  outerWallMode: 'normal',
  zoneMode: 'none',
  gravityPreset: 'normal',
  sandstormPreset: 'none',
  arenaSize: 'large',
  obstacleMode: 'few',
  obstacleSeed: -1,
  maxSeconds: 180,
  teamUnitSize: 1,
  seriesFormat: 'bo1',
  randomizeSeedPerMatch: false,
};

export type BattlefieldTankTier = 4 | 8;

export interface BattlefieldMapPreset {
  arenaSize: ArenaSizeId;
  obstacleMode: ObstacleMode;
  outerWallMode: OuterWallMode;
  zoneMode: ArenaZoneMode;
  gravityPreset: GravityPresetId;
  sandstormPreset: SandstormPresetId;
  maxSeconds: number;
  disableWeapons: boolean;
  disableSubWeapons: boolean;
  obstacleSeed: number | 'random';
  summary: string;
}

export const BATTLEFIELD_RECOMMENDED_PRESETS: Record<
  BattlefieldRuleId,
  Record<BattlefieldTankTier, BattlefieldMapPreset>
> = {
  elimination: {
    4: {
      arenaSize: 'medium',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '中 / 障害物:少 / 通常壁 / 120秒 / シード:ランダム',
    },
    8: {
      arenaSize: 'large',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 180,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '大 / 障害物:少 / 通常壁 / 180秒 / シード:ランダム',
    },
  },
  ramming_derby: {
    4: {
      arenaSize: 'small',
      obstacleMode: 'none',
      outerWallMode: 'bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: true,
      disableSubWeapons: false,
      obstacleSeed: -1,
      summary: '小 / 障害物:なし / 強バウンド / 120秒 / 全武装禁止',
    },
    8: {
      arenaSize: 'small',
      obstacleMode: 'none',
      outerWallMode: 'damage_bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: true,
      disableSubWeapons: false,
      obstacleSeed: -1,
      summary: '小 / 障害物:なし / 電撃バウンド / 120秒 / 全武装禁止',
    },
  },
  balloon_hunt: {
    4: {
      arenaSize: 'medium',
      obstacleMode: 'few',
      outerWallMode: 'bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 60,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '中 / 障害物:少 / 強バウンド / 60秒 / シード:ランダム',
    },
    8: {
      arenaSize: 'large',
      obstacleMode: 'few',
      outerWallMode: 'bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 60,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '大 / 障害物:少 / 強バウンド / 60秒 / シード:ランダム',
    },
  },
  domination: {
    4: {
      arenaSize: 'small',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 60,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '小 / 障害物:少 / 通常壁 / 60秒 / シード:ランダム',
    },
    8: {
      arenaSize: 'large',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '大 / 障害物:少 / 通常壁 / 120秒 / シード:ランダム',
    },
  },
  tank_soccer: {
    4: {
      arenaSize: 'medium',
      obstacleMode: 'none',
      outerWallMode: 'bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 60,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: -1,
      summary: '中 / 障害物:なし / 強バウンド / 60秒 / 毎回ランダム配置(-1)',
    },
    8: {
      arenaSize: 'medium',
      obstacleMode: 'none',
      outerWallMode: 'bounce',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 60,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: -1,
      summary: '中 / 障害物:なし / 強バウンド / 60秒 / 毎回ランダム配置(-1)',
    },
  },
  bounty_hunt: {
    4: {
      arenaSize: 'medium',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '中 / 障害物:少 / 通常壁 / 120秒 / シード:ランダム',
    },
    8: {
      arenaSize: 'large',
      obstacleMode: 'few',
      outerWallMode: 'normal',
      zoneMode: 'none',
      gravityPreset: 'normal',
      sandstormPreset: 'none',
      maxSeconds: 120,
      disableWeapons: false,
      disableSubWeapons: false,
      obstacleSeed: 'random',
      summary: '大 / 障害物:少 / 通常壁 / 120秒 / シード:ランダム',
    },
  },
};

/** Return the curated recommended map preset for a rule and tank count tier. */
export function getRecommendedMapPreset(
  ruleId: BattlefieldRuleId,
  tier: BattlefieldTankTier
): BattlefieldMapPreset {
  return BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][tier];
}

/** Determine whether 4-tank or 8-tank preset fits the active format and enabled roster. */
export function resolveRecommendedTankTier(
  format: BattlefieldFormat,
  teamUnitSize: 1 | 2,
  enabledTankCount: number
): BattlefieldTankTier {
  if (format === 'tournament' || format === 'league') {
    return teamUnitSize * 2 >= 6 ? 8 : 4;
  }
  return enabledTankCount >= 6 ? 8 : 4;
}

/** Return a copy of config with the recommended map settings applied for the rule & tier. */
export function applyRecommendedMapPreset(
  config: BattlefieldConfig,
  tier: BattlefieldTankTier,
  rng: () => number = Math.random
): BattlefieldConfig {
  const preset = getRecommendedMapPreset(config.ruleId, tier);
  const resolvedSeed =
    preset.obstacleSeed === 'random'
      ? Math.floor(rng() * 9000) + 1
      : preset.obstacleSeed;
  return {
    ...config,
    arenaSize: preset.arenaSize,
    obstacleMode: preset.obstacleMode,
    outerWallMode: preset.outerWallMode,
    zoneMode: preset.zoneMode,
    gravityPreset: preset.gravityPreset,
    sandstormPreset: preset.sandstormPreset,
    maxSeconds: preset.maxSeconds,
    disableWeapons: preset.disableWeapons,
    disableSubWeapons: preset.disableSubWeapons,
    obstacleSeed: resolvedSeed,
  };
}

/** Check whether config currently matches all map fields of the recommended preset. */
export function isRecommendedMapPresetApplied(
  config: BattlefieldConfig,
  tier: BattlefieldTankTier
): boolean {
  const preset = getRecommendedMapPreset(config.ruleId, tier);
  const seedMatches =
    preset.obstacleSeed === 'random' || config.obstacleSeed === preset.obstacleSeed;
  return (
    config.arenaSize === preset.arenaSize &&
    config.obstacleMode === preset.obstacleMode &&
    config.outerWallMode === preset.outerWallMode &&
    config.zoneMode === preset.zoneMode &&
    config.gravityPreset === preset.gravityPreset &&
    config.sandstormPreset === preset.sandstormPreset &&
    config.maxSeconds === preset.maxSeconds &&
    config.disableWeapons === preset.disableWeapons &&
    config.disableSubWeapons === preset.disableSubWeapons &&
    seedMatches
  );
}

/**
 * Resolve the per-game BattlefieldConfig (optionally rolling a fresh obstacleSeed
 * per match or offsetting fixed positive seeds across Bo3 games 2 & 3).
 * Combat Football and obstacle-less modes keep config untouched so randomized kickoffs stay fresh.
 */
export function resolveMatchConfigForGame(
  config: BattlefieldConfig,
  gameIndex = 0,
  rng: () => number = Math.random
): BattlefieldConfig {
  if (config.ruleId === 'tank_soccer' || config.obstacleMode === 'none') {
    return config;
  }
  if (config.randomizeSeedPerMatch) {
    return {
      ...config,
      obstacleSeed: Math.floor(rng() * 9000) + 1,
    };
  }
  if (gameIndex > 0 && config.obstacleSeed >= 0) {
    return {
      ...config,
      obstacleSeed: ((config.obstacleSeed + gameIndex * 37) % 9000) + 1,
    };
  }
  return config;
}

export function validateEntryForRegulation(
  entry: BattlefieldRosterEntry,
  regulation: CpuRegulationId,
  slotIndexInTeam?: number
): { valid: boolean; reason?: string } {
  const gs: GridSize = entry.blueprint.program.gridSize;
  switch (regulation) {
    case 'any':
      return { valid: true };
    case 'only_4x4':
      return gs === 4
        ? { valid: true }
        : { valid: false, reason: `4×4限定（現在 ${gs}×${gs}）` };
    case 'max_6x6':
      return gs <= 6
        ? { valid: true }
        : { valid: false, reason: `6×6以下限定（現在 ${gs}×${gs}）` };
    case 'max_8x8':
      return gs <= 8
        ? { valid: true }
        : { valid: false, reason: `8×8以下限定（現在 ${gs}×${gs}）` };
    case 'only_6x6':
      return gs === 6
        ? { valid: true }
        : { valid: false, reason: `6×6限定（現在 ${gs}×${gs}）` };
    case 'only_8x8':
      return gs === 8
        ? { valid: true }
        : { valid: false, reason: `8×8限定（現在 ${gs}×${gs}）` };
    case 'pair_6x6_4x4': {
      if (slotIndexInTeam === undefined) {
        return gs <= 6
          ? { valid: true }
          : { valid: false, reason: `6×6+4×4ペア限定（${gs}×${gs}は不可）` };
      }
      if (slotIndexInTeam === 0) {
        return gs <= 6
          ? { valid: true }
          : { valid: false, reason: `1番機は6×6以下が必要（現在 ${gs}×${gs}）` };
      }
      return gs === 4
        ? { valid: true }
        : { valid: false, reason: `2番機は4×4が必要（現在 ${gs}×${gs}）` };
    }
  }
}

export function validateTeamForRegulation(
  entries: BattlefieldRosterEntry[],
  regulation: CpuRegulationId
): { valid: boolean; reason?: string } {
  if (entries.length === 0) {
    return { valid: false, reason: '機体が登録されていません' };
  }
  if (regulation === 'pair_6x6_4x4') {
    if (entries.length !== 2) {
      return { valid: false, reason: `ペア戦 (6×6 + 4×4) には2機必要です（現在 ${entries.length}機）` };
    }
    const sorted = [...entries].sort(
      (a, b) => b.blueprint.program.gridSize - a.blueprint.program.gridSize
    );
    const big = sorted[0].blueprint.program.gridSize;
    const small = sorted[1].blueprint.program.gridSize;
    if (big > 6 || small > 4) {
      return {
        valid: false,
        reason: `6×6以下 + 4×4 のペアが必要です（現在 ${big}×${big} & ${small}×${small}）`,
      };
    }
    return { valid: true };
  }
  for (let i = 0; i < entries.length; i++) {
    const check = validateEntryForRegulation(entries[i], regulation, i);
    if (!check.valid) return check;
  }
  return { valid: true };
}

let entrySeq = 1;
export function createRosterEntryFromBlueprint(
  rawBp: TankBlueprint,
  sourceLabel = '読込',
  isPreset = false
): BattlefieldRosterEntry {
  const repaired = validateAndRepairBlueprint(rawBp).blueprint;
  const gs = repaired.program.gridSize;
  const normalized: TankBlueprint = {
    ...repaired,
    assembly: {
      ...repaired.assembly,
      cpu: cpuIdForGridSize(gs),
    },
  };
  const playerName = isPreset
    ? 'CPU'
    : sanitizeAuthorName(normalized.author, 'Player');
  const machineName = sanitizeTankName(normalized.name, 'カスタム戦車');
  return {
    entryId: `bf_entry_${entrySeq++}_${Date.now().toString(36)}`,
    playerName,
    basePlayerName: playerName,
    machineName,
    blueprint: normalized,
    sourceLabel,
    teamSlot: 0,
    enabled: true,
    isPreset,
  };
}

function extractUuidTail2(uuid?: string): string | null {
  if (!uuid) return null;
  const cleaned = uuid.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  return cleaned.length >= 2 ? cleaned.slice(-2) : null;
}

function pickRandom2DigitSuffix(
  prefix: string,
  usedNames: Set<string>,
  rng: () => number
): string {
  for (let i = 0; i < 40; i++) {
    const cand = String(Math.floor(rng() * 100)).padStart(2, '0');
    if (!usedNames.has(`${prefix}-${cand}`)) {
      return cand;
    }
  }
  for (let n = 0; n < 100; n++) {
    const cand = String(n).padStart(2, '0');
    if (!usedNames.has(`${prefix}-${cand}`)) {
      return cand;
    }
  }
  for (let n = 100; n < 1000; n++) {
    const cand = String(n);
    if (!usedNames.has(`${prefix}-${cand}`)) {
      return cand;
    }
  }
  return '00';
}

/**
 * Ensure every roster entry has a distinct display playerName.
 * Colliding player names receive `-${UUID tail 2 chars}` when authorUuid is available,
 * otherwise a unique random 2-digit numeric suffix (`-00`..`-99`).
 */
export function disambiguateRosterPlayerNames(
  entries: BattlefieldRosterEntry[],
  rng: () => number = Math.random
): BattlefieldRosterEntry[] {
  const baseCounts = new Map<string, number>();
  const exactCounts = new Map<string, number>();

  const meta = entries.map((entry) => {
    const fallback = entry.isPreset ? 'CPU' : 'Player';
    const currentName = entry.playerName.trim() || fallback;
    const baseName = entry.basePlayerName?.trim() || currentName;
    baseCounts.set(baseName, (baseCounts.get(baseName) ?? 0) + 1);
    exactCounts.set(currentName, (exactCounts.get(currentName) ?? 0) + 1);
    return { entry, currentName, baseName };
  });

  const usedNames = new Set<string>();
  const keepIndices = new Set<number>();

  // Pass 1: preserve unique names and already-assigned unique suffixes
  meta.forEach(({ currentName, baseName }, idx) => {
    const isExactUnique = exactCounts.get(currentName) === 1;
    const isBaseUnique = baseCounts.get(baseName) === 1;
    const alreadySuffixed = currentName !== baseName;
    if (isExactUnique && (isBaseUnique || alreadySuffixed)) {
      keepIndices.add(idx);
      usedNames.add(currentName);
    }
  });

  // Pass 2: assign deterministic UUID-tail or random 2-digit suffixes to colliding entries
  return meta.map(({ entry, currentName, baseName }, idx) => {
    if (keepIndices.has(idx)) {
      return {
        ...entry,
        playerName: currentName,
        basePlayerName: baseName,
      };
    }

    const prefix = baseName.slice(0, 13);
    const uuidTail = entry.isPreset ? null : extractUuidTail2(entry.blueprint.authorUuid);
    const suffix =
      uuidTail && !usedNames.has(`${prefix}-${uuidTail}`)
        ? uuidTail
        : pickRandom2DigitSuffix(prefix, usedNames, rng);
    const finalName = `${prefix}-${suffix}`;
    usedNames.add(finalName);

    return {
      ...entry,
      playerName: finalName,
      basePlayerName: baseName,
    };
  });
}

export function sortRosterEntries(
  entries: BattlefieldRosterEntry[]
): BattlefieldRosterEntry[] {
  return [...entries].sort((a, b) => {
    const aPreset = a.isPreset ? 1 : 0;
    const bPreset = b.isPreset ? 1 : 0;
    if (aPreset !== bPreset) return aPreset - bPreset;
    const pCmp = a.playerName.localeCompare(b.playerName, 'ja');
    if (pCmp !== 0) return pCmp;
    const gsCmp = a.blueprint.program.gridSize - b.blueprint.program.gridSize;
    if (gsCmp !== 0) return gsCmp;
    return a.machineName.localeCompare(b.machineName, 'ja');
  });
}

export function shuffleArray<T>(
  items: readonly T[],
  rng: () => number = Math.random
): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Shuffle roster order randomly (enabled entries stay enabled) for randomized brackets/schedules. */
export function shuffleCompetitionRoster(
  roster: BattlefieldRosterEntry[],
  rng: () => number = Math.random
): BattlefieldRosterEntry[] {
  return shuffleArray(roster, rng);
}

/**
 * Draw up to `maxCount` regulation-eligible entries from a potentially large roster,
 * prioritizing entries not yet drawn in `recentPlayedIds` (fair rotation).
 * Unpicked entries remain in the roster with `enabled: false`.
 */
export function pickRandomBattleRoyaleEntries(
  roster: BattlefieldRosterEntry[],
  config: BattlefieldConfig,
  maxCount = 8,
  recentPlayedIds: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random
): {
  nextRoster: BattlefieldRosterEntry[];
  pickedIds: string[];
  resetCycle: boolean;
  eligibleCount: number;
} {
  const limit = Math.max(1, Math.trunc(maxCount));
  const eligible = roster.filter(
    (entry) => validateEntryForRegulation(entry, config.cpuRegulation).valid
  );
  if (eligible.length === 0) {
    return { nextRoster: [...roster], pickedIds: [], resetCycle: false, eligibleCount: 0 };
  }

  const unplayed = shuffleArray(
    eligible.filter((e) => !recentPlayedIds.has(e.entryId)),
    rng
  );
  const played = shuffleArray(
    eligible.filter((e) => recentPlayedIds.has(e.entryId)),
    rng
  );

  let picked: BattlefieldRosterEntry[] = [];
  let resetCycle = false;

  if (unplayed.length >= limit) {
    picked = unplayed.slice(0, limit);
  } else {
    resetCycle = played.length > 0 && eligible.length > limit;
    picked = [...unplayed, ...played.slice(0, Math.max(0, limit - unplayed.length))];
  }

  const pickedIdSet = new Set(picked.map((e) => e.entryId));
  const pickedOrdered = picked.map((e) => ({ ...e, enabled: true }));
  const remainder = roster
    .filter((e) => !pickedIdSet.has(e.entryId))
    .map((e) => ({
      ...e,
      enabled: false,
    }));

  return {
    nextRoster: [...pickedOrdered, ...remainder],
    pickedIds: picked.map((e) => e.entryId),
    resetCycle,
    eligibleCount: eligible.length,
  };
}

/**
 * Draw up to 8 eligible entries (using fair rotation) and shuffle-assign them cleanly
 * into balanced `teamCount` slots (0..teamCount-1) for team matches.
 */
export function assignRandomTeams(
  roster: BattlefieldRosterEntry[],
  config: BattlefieldConfig,
  teamCount: 2 | 4 = 2,
  recentPlayedIds: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random
): {
  nextRoster: BattlefieldRosterEntry[];
  pickedIds: string[];
  resetCycle: boolean;
  eligibleCount: number;
} {
  const { nextRoster, pickedIds, resetCycle, eligibleCount } = pickRandomBattleRoyaleEntries(
    roster,
    config,
    8,
    recentPlayedIds,
    rng
  );
  if (pickedIds.length === 0) {
    return { nextRoster, pickedIds, resetCycle, eligibleCount };
  }

  const pickedSet = new Set(pickedIds);
  const pickedEntries = shuffleArray(
    nextRoster.filter((e) => pickedSet.has(e.entryId)),
    rng
  );

  // Assign slots sequentially round-robin so teams are size-balanced;
  // for pair_6x6_4x4 regulation try to pair a 6x6 and 4x4 onto each team first.
  const orderedForSlots =
    config.cpuRegulation === 'pair_6x6_4x4'
      ? [
          ...pickedEntries.filter((e) => e.blueprint.program.gridSize === 6),
          ...pickedEntries.filter((e) => e.blueprint.program.gridSize === 4),
          ...pickedEntries.filter(
            (e) => e.blueprint.program.gridSize !== 6 && e.blueprint.program.gridSize !== 4
          ),
        ]
      : pickedEntries;

  const teamAssigned = orderedForSlots.map((entry, idx) => ({
    ...entry,
    enabled: true,
    teamSlot: idx % teamCount,
  }));
  const rest = nextRoster.filter((e) => !pickedSet.has(e.entryId));

  return {
    nextRoster: [...teamAssigned, ...rest],
    pickedIds,
    resetCycle,
    eligibleCount,
  };
}

export function formatTankListLabel(
  machineName: string,
  playerName: string,
  gridSize: GridSize
): string {
  return `${machineName}（${playerName}）（${gridSize}x${gridSize}）`;
}

export function parseImportedTankContent(
  text: string,
  fileName = 'import'
): { ok: true; entry: BattlefieldRosterEntry } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: `${fileName}: ファイル内容が空です` };
  }

  try {
    if (trimmed.startsWith('VST1-')) {
      const bp = decodeShareCode(trimmed);
      return { ok: true, entry: createRosterEntryFromBlueprint(bp, 'シェアコード') };
    }

    if (trimmed.startsWith('{') || fileName.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(trimmed);
      const bp = validateAndNormalizeBlueprint(parsed);
      return { ok: true, entry: createRosterEntryFromBlueprint(bp, fileName) };
    }

    if (looksLikePythonSource(trimmed) || fileName.toLowerCase().endsWith('.py')) {
      const parsed = parsePythonSourceWithAutoSize(trimmed, 6, 'relative', 12);
      if (!parsed.ok) {
        return { ok: false, error: `${fileName}: ${parsed.error}` };
      }
      const fallbackTankName = fileName.replace(/\.(py|txt)$/i, '') || 'Python戦車';
      const bp: TankBlueprint = {
        version: 1,
        id: `py_${Date.now().toString(36)}`,
        name: sanitizeTankName(parsed.tankName ?? fallbackTankName, fallbackTankName),
        author: sanitizeAuthorName(parsed.authorName, 'Player'),
        ...(parsed.authorUuid ? { authorUuid: parsed.authorUuid } : {}),
        ...(parsed.gameVersion ? { gameVersion: parsed.gameVersion } : {}),
        color: getAutoTankColor(0),
        assembly: {
          chassis: parsed.chassisId ?? 'standard',
          radar: parsed.radarId ?? 'balanced',
          mainGun: parsed.mainGunId ?? 'standard',
          cpu: cpuIdForGridSize(parsed.program.gridSize),
          subWeapon: parsed.subWeaponId ?? 'missile',
        },
        program: parsed.program,
      };
      return { ok: true, entry: createRosterEntryFromBlueprint(bp, fileName) };
    }

    const fallback = JSON.parse(trimmed);
    const bp = validateAndNormalizeBlueprint(fallback);
    return { ok: true, entry: createRosterEntryFromBlueprint(bp, fileName) };
  } catch (err) {
    return {
      ok: false,
      error: `${fileName}: ${err instanceof Error ? err.message : '解析に失敗しました'}`,
    };
  }
}

function createZoneRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rectsOverlapWithGap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap: number
): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export function generateBattlefieldZones(
  zoneMode: ArenaZoneMode,
  seed: number = -1,
  arenaSize: ArenaSizeId = 'large',
  obstacles: ArenaObstacle[] = []
): ArenaTile[] {
  if (zoneMode === 'none') return [];

  const sizeSpec = ARENA_SIZE_SPECS[arenaSize] ?? ARENA_SIZE_SPECS.large;
  const arenaW = sizeSpec.width;
  const arenaH = sizeSpec.height;
  const scale = Math.min(arenaW / 1400, arenaH / 1100);
  const targetCount =
    arenaSize === 'tiny' || arenaSize === 'small' ? 2 : arenaSize === 'medium' ? 3 : 4;

  const baseSeed = seed === -1 ? 4242 : seed;
  const modeSalt =
    zoneMode === 'slow'
      ? 11
      : zoneMode === 'no_weapon'
        ? 23
        : zoneMode === 'ice'
          ? 41
          : zoneMode === 'cooldown'
            ? 53
            : 37;
  const rng = createZoneRng(baseSeed * 131 + modeSalt);

  const spawns = getSpawnsForArena(arenaW, arenaH);
  const wallPad = Math.max(46, Math.round(90 * scale));
  const spawnPad = Math.max(58, Math.round(108 * scale));
  const obsGap = Math.max(16, Math.round(26 * scale));
  const zoneGap = Math.max(36, Math.round(68 * scale));

  const placed: ArenaTile[] = [];
  const maxAttempts = 600;
  for (let attempt = 0; attempt < maxAttempts && placed.length < targetCount; attempt++) {
    const compact = attempt >= maxAttempts / 2;
    const rawW = (compact ? 125 : 175) + Math.floor(rng() * 4) * 16;
    const rawH = (compact ? 115 : 155) + Math.floor(rng() * 4) * 16;
    const width = Math.max(compact ? 76 : 96, Math.round(rawW * scale));
    const height = Math.max(compact ? 76 : 96, Math.round(rawH * scale));

    const availW = arenaW - wallPad * 2 - width;
    const availH = arenaH - wallPad * 2 - height;
    if (availW <= 0 || availH <= 0) continue;

    const x = Math.round((wallPad + rng() * availW) / 10) * 10;
    const y = Math.round((wallPad + rng() * availH) / 10) * 10;
    const rect: ArenaObstacle = { id: 'probe', x, y, width, height };

    if (spawns.some((sp) => circleIntersectsRect(sp.x, sp.y, spawnPad, rect))) continue;
    if (obstacles.some((obs) => rectsOverlapWithGap(rect, obs, obsGap))) continue;
    if (placed.some((other) => rectsOverlapWithGap(rect, other, zoneGap))) continue;

    const mixedCycle: Array<'slow' | 'no_weapon' | 'ice' | 'cooldown'> = [
      'slow',
      'no_weapon',
      'ice',
      'cooldown',
    ];
    const kind =
      zoneMode === 'mixed'
        ? mixedCycle[placed.length % mixedCycle.length]
        : zoneMode;

    placed.push({
      id: `bf_zone_${kind}_${placed.length + 1}`,
      kind,
      x,
      y,
      width,
      height,
    });
  }

  return placed;
}

export function createBattlefieldMatchState(
  participants: BattlefieldParticipant[],
  config: BattlefieldConfig
): BattleState {
  const sizeSpec = ARENA_SIZE_SPECS[config.arenaSize] ?? ARENA_SIZE_SPECS.large;
  const maxTicks = Math.max(200, Math.round(config.maxSeconds * 20));
  const obstacles = generateArenaObstacles(
    config.obstacleMode,
    config.obstacleSeed,
    sizeSpec.id
  );
  const zones = generateBattlefieldZones(
    config.zoneMode ?? 'none',
    config.obstacleSeed,
    sizeSpec.id,
    obstacles
  );
  const gravitySpec =
    GRAVITY_PRESET_SPECS[config.gravityPreset ?? 'normal'] ?? GRAVITY_PRESET_SPECS.normal;
  const sandstormSpec =
    SANDSTORM_PRESET_SPECS[config.sandstormPreset ?? 'none'] ?? SANDSTORM_PRESET_SPECS.none;
  const arena: ArenaConfig = {
    sizeId: sizeSpec.id,
    width: sizeSpec.width,
    height: sizeSpec.height,
    maxTicks,
    obstacles,
    ...(zones.length > 0 ? { tiles: zones } : {}),
    teamBattle: true,
    multiTeamMode: true,
    disableWeapons: Boolean(config.disableWeapons),
    disableSubWeapons: Boolean(config.disableWeapons || config.disableSubWeapons),
    outerWallMode: config.outerWallMode ?? 'normal',
    gravitySpeedMult: gravitySpec.speedMult,
    radarRangeMult: sandstormSpec.radarMult,
    ruleId: config.ruleId,
  };

  const spawns = getSpawnsForArena(arena.width, arena.height);
  const tanks: TankRuntime[] = participants.slice(0, 8).map((p, idx) => {
    const spawn = spawns[idx % spawns.length];
    const bp: TankBlueprint = {
      ...validateAndRepairBlueprint(p.entry.blueprint).blueprint,
      name: p.entry.machineName,
      author: p.entry.playerName || p.entry.blueprint.author || 'Player',
      color: p.teamColor,
    };
    const runtime = createTankRuntime(
      `bf_tank_${idx}`,
      idx === 0 ? 'player' : 'enemy',
      bp,
      spawn
    );
    runtime.teamId = p.teamId;
    runtime.playerName = p.entry.playerName || bp.author || 'Player';
    return runtime;
  });

  const ruleTeamLabels: Record<string, string> = {};
  const ruleTeamColors: Record<string, string> = {};
  for (const p of participants.slice(0, 8)) {
    ruleTeamLabels[p.teamId] = p.teamLabel;
    ruleTeamColors[p.teamId] = p.teamColor;
  }

  const state: BattleState = {
    tick: 0,
    arena,
    tanks,
    projectiles: [],
    mines: [],
    smokes: [],
    decoys: [],
    explosions: [],
    ruleTeamLabels,
    ruleTeamColors,
    status: 'running',
    winnerId: null,
    winType: null,
    endReason: null,
  };

  const ruleSpec = BATTLEFIELD_RULE_REGISTRY[config.ruleId];
  ruleSpec?.setupArena?.(state, config);
  return state;
}

export function stepBattlefieldTick(
  state: BattleState,
  config: BattlefieldConfig
): BattleState {
  if (state.status !== 'finished' && state.football?.pendingKickoffReset) {
    resetFootballPositions(state, 0);
  }
  const ruleSpec = BATTLEFIELD_RULE_REGISTRY[config.ruleId];
  return stepBattleTick(
    state,
    ruleSpec?.onTick ? (s) => ruleSpec.onTick!(s, config) : undefined
  );
}

export interface TankMatchReportRow {
  rank: number;
  tankId: string;
  teamId: string;
  teamLabel: string;
  teamColor: string;
  playerName: string;
  machineName: string;
  gridSize: GridSize;
  chassisLabel: string;
  gunLabel: string;
  subWeaponLabel: string;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  hitRatePercent: number | null;
  survivedTicks: number;
  survivedSeconds: number;
  isAlive: boolean;
  hpRemaining: number;
  maxHp: number;
  killedByLabel: string;
  ruleScore: number;
  contributionScore: number;
  ruleMetricText: string;
  awards: string[];
  deaths?: number;
  maxBountyStreak?: number;
  bountyClaimedCount?: number;
  maxBountyClaimed?: number;
  firstKillTick?: number | null;
}

export interface TeamMatchReportRow {
  rank: number;
  teamId: string;
  teamLabel: string;
  teamColor: string;
  isWinner: boolean;
  aliveCount: number;
  memberCount: number;
  totalKills: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  avgSurvivedSeconds: number;
  totalContribution: number;
  teamRuleScore?: number;
}

export interface BattlefieldMatchReport {
  durationSeconds: number;
  totalTicks: number;
  winType: BattleState['winType'];
  winnerTankId: string | null;
  winnerTeamId: string | null;
  endReason: string;
  configSnapshot: BattlefieldConfig;
  tankRows: TankMatchReportRow[];
  teamRows: TeamMatchReportRow[];
}

export function buildMatchReport(
  state: BattleState,
  participants: BattlefieldParticipant[],
  config: BattlefieldConfig
): BattlefieldMatchReport {
  const metaByTankId = new Map<string, BattlefieldParticipant>();
  participants.slice(0, 8).forEach((p, idx) => {
    metaByTankId.set(`bf_tank_${idx}`, p);
  });

  const winnerTank =
    state.winnerId && state.winnerId !== 'draw'
      ? state.tanks.find((t) => t.id === state.winnerId)
      : undefined;
  const winnerTeamId = winnerTank ? (winnerTank.teamId ?? winnerTank.id) : null;

  const tankLabelById = new Map<string, string>();
  for (const t of state.tanks) {
    const pName = t.playerName || t.blueprint.author || 'Player';
    tankLabelById.set(t.id, `${t.blueprint.name} (${pName})`);
  }

  const ruleSpec = BATTLEFIELD_RULE_REGISTRY[config.ruleId];

  const rawRows: TankMatchReportRow[] = state.tanks.map((t) => {
    const meta = metaByTankId.get(t.id);
    const teamId = t.teamId ?? t.id;
    const teamLabel = meta?.teamLabel ?? teamId;
    const playerName = t.playerName || meta?.entry.playerName || t.blueprint.author || 'Player';
    const machineName = t.blueprint.name || meta?.entry.machineName || '戦車';
    const kills = t.stats.kills ?? 0;
    const damageDealt = Math.round(t.stats.damageDealt * 10) / 10;
    const damageTaken = Math.round(t.stats.damageTaken * 10) / 10;
    const shotsFired = t.stats.shotsFired;
    const shotsHit = t.stats.shotsHit;
    const hitRatePercent =
      shotsFired > 0 ? Math.round((shotsHit / shotsFired) * 1000) / 10 : null;
    const isAlive = t.hp > 0;
    const survivedTicks = isAlive
      ? state.tick
      : (t.stats.eliminatedAtTick ?? state.tick);
    const survivedSeconds = Math.round((survivedTicks / 20) * 10) / 10;
    const ruleScore = Math.round((t.stats.ruleScore ?? 0) * 10) / 10;

    const winBonus = winnerTeamId && teamId === winnerTeamId ? 120 : 0;
    const contributionScore = winBonus + computeTankBaseContribution(t, state.tick);

    let killedByLabel = isAlive ? '生存' : '場外・自滅';
    const deaths = t.stats.deaths ?? 0;
    if (config.ruleId === 'bounty_hunt') {
      killedByLabel = isAlive
        ? deaths > 0
          ? `生存 (被撃破${deaths}回)`
          : '無敗生存'
        : `復帰待機 (被撃破${deaths}回)`;
    } else if (!isAlive && t.killedById) {
      if (t.killedById === 'environment') {
        killedByLabel = '壁・環境';
      } else {
        killedByLabel = tankLabelById.get(t.killedById) ?? t.killedById;
      }
    }

    return {
      rank: 0,
      tankId: t.id,
      teamId,
      teamLabel,
      teamColor: meta?.teamColor ?? t.blueprint.color,
      playerName,
      machineName,
      gridSize: t.blueprint.program.gridSize,
      chassisLabel: CHASSIS_SPECS[t.blueprint.assembly.chassis].name,
      gunLabel: MAIN_GUN_SPECS[t.blueprint.assembly.mainGun].name,
      subWeaponLabel: SUB_WEAPON_SPECS[t.blueprint.assembly.subWeapon].name,
      kills,
      damageDealt,
      damageTaken,
      shotsFired,
      shotsHit,
      hitRatePercent,
      survivedTicks,
      survivedSeconds,
      isAlive,
      hpRemaining: Math.max(0, Math.round(t.hp)),
      maxHp: t.maxHp,
      killedByLabel,
      ruleScore,
      contributionScore,
      ruleMetricText: ruleSpec?.computeContributionLabel?.(t) ?? `与ダメ ${Math.round(damageDealt)}`,
      awards: [],
      deaths,
      maxBountyStreak: t.stats.maxBountyStreak ?? 0,
      bountyClaimedCount: t.stats.bountyClaimedCount ?? 0,
      maxBountyClaimed: t.stats.maxBountyClaimed ?? 0,
      firstKillTick: t.stats.firstKillTick ?? null,
    };
  });

  const teamRuleScores = state.ruleTeamScores ?? {};
  const isScoreVictory = Boolean(state.arena.scoreOnlyVictory);
  rawRows.sort((a, b) => {
    const aWin = winnerTeamId && a.teamId === winnerTeamId ? 1 : 0;
    const bWin = winnerTeamId && b.teamId === winnerTeamId ? 1 : 0;
    if (bWin !== aWin) return bWin - aWin;
    if (isScoreVictory) {
      const aTScore = teamRuleScores[a.teamId] ?? a.ruleScore;
      const bTScore = teamRuleScores[b.teamId] ?? b.ruleScore;
      if (bTScore !== aTScore) return bTScore - aTScore;
      if (b.ruleScore !== a.ruleScore) return b.ruleScore - a.ruleScore;
    } else if ((b.isAlive ? 1 : 0) !== (a.isAlive ? 1 : 0)) {
      return (b.isAlive ? 1 : 0) - (a.isAlive ? 1 : 0);
    }
    if (b.contributionScore !== a.contributionScore) {
      return b.contributionScore - a.contributionScore;
    }
    if (b.survivedTicks !== a.survivedTicks) return b.survivedTicks - a.survivedTicks;
    return b.damageDealt - a.damageDealt;
  });

  rawRows.forEach((r, idx) => {
    r.rank = idx + 1;
  });

  // Assign Awards
  if (rawRows.length > 0) {
    const bestContrib = [...rawRows].sort((a, b) => b.contributionScore - a.contributionScore)[0];
    if (bestContrib.contributionScore > 0) {
      bestContrib.awards.push('🏆 MVP');
    }

    if (config.ruleId === 'bounty_hunt') {
      const hunters = rawRows.filter((r) => (r.bountyClaimedCount ?? 0) >= 1);
      if (hunters.length > 0) {
        const topHunter = [...hunters].sort((a, b) => {
          const maxDiff = (b.maxBountyClaimed ?? 0) - (a.maxBountyClaimed ?? 0);
          if (maxDiff !== 0) return maxDiff;
          const cntDiff = (b.bountyClaimedCount ?? 0) - (a.bountyClaimedCount ?? 0);
          if (cntDiff !== 0) return cntDiff;
          return b.ruleScore - a.ruleScore;
        })[0];
        topHunter.awards.push('👑 賞金首ハンター');
      }
      const streakers = rawRows.filter((r) => (r.maxBountyStreak ?? 0) >= 2);
      if (streakers.length > 0) {
        const topStreak = [...streakers].sort((a, b) => {
          const sDiff = (b.maxBountyStreak ?? 0) - (a.maxBountyStreak ?? 0);
          return sDiff !== 0 ? sDiff : b.ruleScore - a.ruleScore;
        })[0];
        topStreak.awards.push('🔥 連勝の覇者');
      }
    } else {
      const multiKillers = rawRows.filter((r) => r.kills >= 2);
      if (multiKillers.length > 0) {
        const topKiller = [...multiKillers].sort((a, b) =>
          b.kills !== a.kills ? b.kills - a.kills : b.damageDealt - a.damageDealt
        )[0];
        topKiller.awards.push('🔥 連勝の覇者');
      }
    }

    const totalKills = rawRows.reduce((s, r) => s + r.kills, 0);
    const firstKillers = rawRows.filter((r) => r.firstKillTick != null);
    if (firstKillers.length > 0 && (totalKills >= 2 || rawRows.length >= 3)) {
      const fastestKiller = [...firstKillers].sort(
        (a, b) => (a.firstKillTick ?? Infinity) - (b.firstKillTick ?? Infinity)
      )[0];
      fastestKiller.awards.push('⚡ 電光石火');
    }

    const maxDmg = [...rawRows].sort((a, b) => b.damageDealt - a.damageDealt)[0];
    if (maxDmg.damageDealt > 0) {
      maxDmg.awards.push('💥 最多ダメージ');
    }

    const sharpshooters = rawRows.filter((r) => r.shotsFired >= 3 && (r.hitRatePercent ?? 0) > 0);
    if (sharpshooters.length > 0) {
      const topAcc = [...sharpshooters].sort((a, b) =>
        (b.hitRatePercent ?? 0) !== (a.hitRatePercent ?? 0)
          ? (b.hitRatePercent ?? 0) - (a.hitRatePercent ?? 0)
          : b.shotsHit - a.shotsHit
      )[0];
      topAcc.awards.push('🎯 スナイパー');
    }

    const survivors = rawRows.filter((r) => r.isAlive);
    const totalDamage = rawRows.reduce((s, r) => s + r.damageDealt + r.damageTaken, 0);
    if (survivors.length > 0) {
      const heavyTanks = survivors.filter((r) => r.damageTaken >= 60);
      if (heavyTanks.length > 0) {
        const ironWall = [...heavyTanks].sort((a, b) => b.damageTaken - a.damageTaken)[0];
        ironWall.awards.push('🛡️ 鉄壁');
      } else if (totalDamage > 0 && survivors.some((r) => r.damageTaken === 0)) {
        const untouched = [...survivors]
          .filter((r) => r.damageTaken === 0)
          .sort((a, b) => b.contributionScore - a.contributionScore)[0];
        untouched.awards.push('✨ 無傷');
      } else {
        const toughest = [...survivors].sort((a, b) => a.damageTaken - b.damageTaken)[0];
        toughest.awards.push('🛡️ 生存');
      }
    }

    const giantKillers = rawRows.filter((r) => {
      const hasBiggerFoeOutranked = rawRows.some(
        (other) =>
          other.teamId !== r.teamId &&
          other.gridSize > r.gridSize &&
          (other.rank > r.rank || !other.isAlive)
      );
      return hasBiggerFoeOutranked && (r.kills >= 1 || (winnerTeamId && r.teamId === winnerTeamId));
    });
    if (giantKillers.length > 0) {
      const smallestHero = [...giantKillers].sort((a, b) =>
        a.gridSize !== b.gridSize
          ? a.gridSize - b.gridSize
          : b.contributionScore - a.contributionScore
      )[0];
      smallestHero.awards.push('🌟 ジャイアントキリング');
    }

    const runnerUpCandidates = rawRows.filter(
      (r) =>
        (!winnerTeamId || r.teamId !== winnerTeamId) &&
        r.awards.length === 0 &&
        (r.damageDealt > 0 || r.ruleScore > 0)
    );
    if (runnerUpCandidates.length > 0) {
      const fightingSpirit = [...runnerUpCandidates].sort(
        (a, b) => b.contributionScore - a.contributionScore
      )[0];
      fightingSpirit.awards.push('💪 敢闘賞');
    }
  }

  // Team aggregates
  const teamIds = Array.from(new Set(rawRows.map((r) => r.teamId)));
  const teamRows: TeamMatchReportRow[] = teamIds
    .map((tid) => {
      const members = rawRows.filter((r) => r.teamId === tid);
      const first = members[0];
      return {
        rank: 0,
        teamId: tid,
        teamLabel: first.teamLabel,
        teamColor: first.teamColor,
        isWinner: winnerTeamId === tid,
        aliveCount: members.filter((m) => m.isAlive).length,
        memberCount: members.length,
        totalKills: members.reduce((s, m) => s + m.kills, 0),
        totalDamageDealt: Math.round(members.reduce((s, m) => s + m.damageDealt, 0) * 10) / 10,
        totalDamageTaken: Math.round(members.reduce((s, m) => s + m.damageTaken, 0) * 10) / 10,
        avgSurvivedSeconds:
          Math.round(
            (members.reduce((s, m) => s + m.survivedSeconds, 0) / Math.max(1, members.length)) * 10
          ) / 10,
        totalContribution: members.reduce((s, m) => s + m.contributionScore, 0),
        teamRuleScore:
          teamRuleScores[tid] ?? members.reduce((s, m) => s + m.ruleScore, 0),
      };
    })
    .sort((a, b) => {
      if (b.isWinner !== a.isWinner) return b.isWinner ? 1 : -1;
      if (isScoreVictory && (b.teamRuleScore ?? 0) !== (a.teamRuleScore ?? 0)) {
        return (b.teamRuleScore ?? 0) - (a.teamRuleScore ?? 0);
      }
      if (b.aliveCount !== a.aliveCount) return b.aliveCount - a.aliveCount;
      if (b.totalContribution !== a.totalContribution) {
        return b.totalContribution - a.totalContribution;
      }
      return b.totalDamageDealt - a.totalDamageDealt;
    });

  teamRows.forEach((tr, idx) => {
    tr.rank = idx + 1;
  });

  return {
    durationSeconds: Math.round((state.tick / 20) * 10) / 10,
    totalTicks: state.tick,
    winType: state.winType ?? null,
    winnerTankId: winnerTank?.id ?? null,
    winnerTeamId,
    endReason: state.endReason ?? '試合終了',
    configSnapshot: { ...config },
    tankRows: rawRows,
    teamRows,
  };
}

export function simulateMatchHeadless(
  participants: BattlefieldParticipant[],
  config: BattlefieldConfig
): { state: BattleState; report: BattlefieldMatchReport } {
  const state = createBattlefieldMatchState(participants, config);
  const limit = state.arena.maxTicks + 2;
  let guard = 0;
  while (state.status !== 'finished' && guard < limit) {
    stepBattlefieldTick(state, config);
    guard += 1;
  }
  return {
    state,
    report: buildMatchReport(state, participants, config),
  };
}

export interface HudTeamCluster {
  teamId: string;
  teamLabel: string;
  teamColor: string;
  tankIds: string[];
}

export interface HudRowLayout {
  columns: number;
  clusters: HudTeamCluster[];
}

export interface BattlefieldHudLayout {
  isTeamGrouped: boolean;
  rows: HudRowLayout[];
}

/**
 * Arrange active tanks into clean HP HUD rows (max 4 tanks per row; 6 tanks -> 3+3).
 * When any team has 2+ members, keeps all teammates contiguous inside team clusters
 * without mutating the underlying tank array order.
 */
export function computeBattlefieldHudLayout(
  tanks: TankRuntime[],
  teamLabels?: Record<string, string>,
  teamColors?: Record<string, string>
): BattlefieldHudLayout {
  if (tanks.length === 0) {
    return { isTeamGrouped: false, rows: [] };
  }

  const groups: HudTeamCluster[] = [];
  const groupById = new Map<string, HudTeamCluster>();
  for (const t of tanks) {
    const teamId = t.teamId ?? t.id;
    let group = groupById.get(teamId);
    if (!group) {
      group = {
        teamId,
        teamLabel: teamLabels?.[teamId] ?? (t.playerName || t.blueprint.name),
        teamColor: teamColors?.[teamId] ?? t.blueprint.color,
        tankIds: [],
      };
      groupById.set(teamId, group);
      groups.push(group);
    }
    group.tankIds.push(t.id);
  }

  const isTeamGrouped = groups.some((g) => g.tankIds.length >= 2);
  if (!isTeamGrouped) {
    const cols = tanks.length <= 4 ? Math.max(1, tanks.length) : Math.min(4, Math.ceil(tanks.length / 2));
    const rows: HudRowLayout[] = [];
    for (let i = 0; i < tanks.length; i += cols) {
      const slice = tanks.slice(i, i + cols);
      rows.push({
        columns: cols,
        clusters: slice.map((t) => {
          const teamId = t.teamId ?? t.id;
          return {
            teamId,
            teamLabel: teamLabels?.[teamId] ?? (t.playerName || t.blueprint.name),
            teamColor: teamColors?.[teamId] ?? t.blueprint.color,
            tankIds: [t.id],
          };
        }),
      });
    }
    return { isTeamGrouped: false, rows };
  }

  const rows: HudRowLayout[] = [];
  let currentClusters: HudTeamCluster[] = [];
  let currentSlots = 0;

  const flushRow = () => {
    if (currentClusters.length === 0) return;
    rows.push({
      columns: Math.max(1, currentSlots),
      clusters: currentClusters,
    });
    currentClusters = [];
    currentSlots = 0;
  };

  for (const cluster of groups) {
    const slots = Math.min(4, cluster.tankIds.length);
    if (currentClusters.length > 0 && currentSlots + slots > 4) {
      flushRow();
    }
    currentClusters.push(cluster);
    currentSlots += slots;
    if (cluster.tankIds.length >= 4) {
      flushRow();
    }
  }
  flushRow();

  return { isTeamGrouped: true, rows };
}

export interface CompetitionUnit {
  unitId: string;
  unitName: string;
  entries: BattlefieldRosterEntry[];
  color: string;
}

export interface TournamentMatch {
  matchId: string;
  roundIndex: number;
  roundLabel: string;
  matchIndexInRound: number;
  unitAId: string | null;
  unitBId: string | null;
  winnerUnitId: string | null;
  isDraw?: boolean;
  isBye?: boolean;
  report?: BattlefieldMatchReport;
  seriesBestOf?: 1 | 3;
  winsA?: number;
  winsB?: number;
  draws?: number;
  gameReports?: BattlefieldMatchReport[];
  nextMatchId?: string;
  nextMatchSlot?: 'A' | 'B';
}

export interface TournamentBracket {
  units: CompetitionUnit[];
  rounds: TournamentMatch[][];
  championUnitId: string | null;
}

function getRoundLabel(roundIdx: number, totalRounds: number): string {
  const remaining = totalRounds - roundIdx;
  if (remaining === 1) return '決勝';
  if (remaining === 2) return '準決勝';
  if (remaining === 3) return '準々決勝';
  return `${roundIdx + 1}回戦`;
}

export function createTournamentBracket(
  units: CompetitionUnit[],
  seriesBestOf: 1 | 3 = 1
): TournamentBracket {
  if (units.length < 2) {
    return { units, rounds: [], championUnitId: units[0]?.unitId ?? null };
  }

  let size = 2;
  let totalRounds = 1;
  while (size < units.length) {
    size *= 2;
    totalRounds += 1;
  }

  // Distribute seeded slots so BYEs pair cleanly with top seeds instead of each other
  let seedOrder = [0, 1];
  for (let s = 4; s <= size; s *= 2) {
    const nextOrder: number[] = [];
    for (const idx of seedOrder) {
      nextOrder.push(idx, s - 1 - idx);
    }
    seedOrder = nextOrder;
  }
  const seededSlots: (string | null)[] = seedOrder.map(
    (seedRank) => units[seedRank]?.unitId ?? null
  );

  const rounds: TournamentMatch[][] = [];
  for (let r = 0; r < totalRounds; r++) {
    const matchCount = size >> (r + 1);
    const label = getRoundLabel(r, totalRounds);
    const roundMatches: TournamentMatch[] = [];
    for (let m = 0; m < matchCount; m++) {
      roundMatches.push({
        matchId: `tour_r${r}_m${m}`,
        roundIndex: r,
        roundLabel: label,
        matchIndexInRound: m,
        unitAId: r === 0 ? seededSlots[m * 2] : null,
        unitBId: r === 0 ? seededSlots[m * 2 + 1] : null,
        winnerUnitId: null,
        seriesBestOf,
        winsA: 0,
        winsB: 0,
        draws: 0,
        gameReports: [],
        nextMatchId: r < totalRounds - 1 ? `tour_r${r + 1}_m${Math.floor(m / 2)}` : undefined,
        nextMatchSlot: r < totalRounds - 1 ? (m % 2 === 0 ? 'A' : 'B') : undefined,
      });
    }
    rounds.push(roundMatches);
  }

  let bracket: TournamentBracket = {
    units,
    rounds,
    championUnitId: null,
  };

  // Auto-advance first-round BYEs
  for (const m of rounds[0]) {
    if (m.unitAId && !m.unitBId) {
      bracket = applyTournamentMatchResult(bracket, m.matchId, m.unitAId, undefined, false, true);
    } else if (!m.unitAId && m.unitBId) {
      bracket = applyTournamentMatchResult(bracket, m.matchId, m.unitBId, undefined, false, true);
    }
  }

  return bracket;
}

export function applyTournamentMatchResult(
  bracket: TournamentBracket,
  matchId: string,
  winnerUnitId: string | null,
  report?: BattlefieldMatchReport,
  isDraw = false,
  isBye = false
): TournamentBracket {
  const nextRounds = bracket.rounds.map((round) => round.map((m) => ({ ...m })));
  const flatMap = new Map<string, TournamentMatch>();
  for (const round of nextRounds) {
    for (const m of round) {
      flatMap.set(m.matchId, m);
    }
  }

  const target = flatMap.get(matchId);
  if (!target) return bracket;

  let resolvedWinner = winnerUnitId;
  if (!resolvedWinner && target.unitAId && target.unitBId && report) {
    // Tie-break for elimination advancement: higher team contribution, else unit A
    const tA = report.teamRows.find((tr) => tr.teamId === 'unit_A');
    const tB = report.teamRows.find((tr) => tr.teamId === 'unit_B');
    resolvedWinner =
      (tB?.totalContribution ?? 0) > (tA?.totalContribution ?? 0)
        ? target.unitBId
        : target.unitAId;
  } else if (!resolvedWinner) {
    resolvedWinner = target.unitAId ?? target.unitBId;
  }

  target.winnerUnitId = resolvedWinner;
  target.isDraw = isDraw;
  target.isBye = isBye;
  if (report) {
    target.report = report;
  }

  if (target.nextMatchId && target.nextMatchSlot) {
    const nextM = flatMap.get(target.nextMatchId);
    if (nextM) {
      if (target.nextMatchSlot === 'A') {
        nextM.unitAId = resolvedWinner;
      } else {
        nextM.unitBId = resolvedWinner;
      }
      // Also auto-advance if the sibling slot is permanently empty (BYE cascade)
      const prevRound = nextRounds[target.roundIndex];
      const siblingIdx =
        target.matchIndexInRound % 2 === 0
          ? target.matchIndexInRound + 1
          : target.matchIndexInRound - 1;
      const sibling = prevRound?.[siblingIdx];
      if (sibling && !sibling.unitAId && !sibling.unitBId && resolvedWinner && !nextM.winnerUnitId) {
        nextM.winnerUnitId = resolvedWinner;
        nextM.isBye = true;
      }
    }
  }

  const finalMatch = nextRounds[nextRounds.length - 1]?.[0];
  return {
    units: bracket.units,
    rounds: nextRounds,
    championUnitId: finalMatch?.winnerUnitId ?? null,
  };
}

/**
 * Record one completed game toward a Bo1 or Bo3 (first-to-2) tournament match.
 * Keeps the match active until one side reaches 2 wins or 3 games have been played.
 */
export function applyTournamentGameResult(
  bracket: TournamentBracket,
  matchId: string,
  gameWinnerUnitId: string | null,
  report: BattlefieldMatchReport,
  isGameDraw: boolean,
  seriesBestOf: 1 | 3 = 1
): TournamentBracket {
  const effectiveBestOf: 1 | 3 =
    seriesBestOf === 3 ||
    bracket.rounds.flat().find((m) => m.matchId === matchId)?.seriesBestOf === 3
      ? 3
      : 1;

  if (effectiveBestOf === 1) {
    return applyTournamentMatchResult(
      bracket,
      matchId,
      gameWinnerUnitId,
      report,
      isGameDraw
    );
  }

  const nextRounds = bracket.rounds.map((round) => round.map((m) => ({ ...m })));
  const target = nextRounds.flat().find((m) => m.matchId === matchId);
  if (!target) return bracket;

  // Re-playing an already decided series restarts the Bo3 tally cleanly
  const restart = Boolean(target.winnerUnitId);
  let winsA = restart ? 0 : (target.winsA ?? 0);
  let winsB = restart ? 0 : (target.winsB ?? 0);
  let draws = restart ? 0 : (target.draws ?? 0);
  const gameReports = restart ? [] : [...(target.gameReports ?? [])];

  if (isGameDraw || !gameWinnerUnitId) {
    draws += 1;
  } else if (gameWinnerUnitId === target.unitAId) {
    winsA += 1;
  } else if (gameWinnerUnitId === target.unitBId) {
    winsB += 1;
  } else {
    draws += 1;
  }
  gameReports.push(report);

  target.seriesBestOf = 3;
  target.winsA = winsA;
  target.winsB = winsB;
  target.draws = draws;
  target.gameReports = gameReports;
  target.report = report;

  const seriesDone = winsA >= 2 || winsB >= 2 || gameReports.length >= 3;
  if (!seriesDone) {
    target.winnerUnitId = null;
    target.isDraw = false;
    return {
      units: bracket.units,
      rounds: nextRounds,
      championUnitId: bracket.championUnitId,
    };
  }

  let seriesWinnerId: string | null = null;
  if (winsA > winsB) {
    seriesWinnerId = target.unitAId;
  } else if (winsB > winsA) {
    seriesWinnerId = target.unitBId;
  } else {
    let contribA = 0;
    let contribB = 0;
    for (const rep of gameReports) {
      contribA += rep.teamRows.find((tr) => tr.teamId === 'unit_A')?.totalContribution ?? 0;
      contribB += rep.teamRows.find((tr) => tr.teamId === 'unit_B')?.totalContribution ?? 0;
    }
    seriesWinnerId = contribB > contribA ? target.unitBId : target.unitAId;
  }

  const updatedBracket: TournamentBracket = {
    units: bracket.units,
    rounds: nextRounds,
    championUnitId: bracket.championUnitId,
  };
  return applyTournamentMatchResult(
    updatedBracket,
    matchId,
    seriesWinnerId,
    report,
    winsA === winsB
  );
}

export interface LeagueMatch {
  matchId: string;
  roundNumber: number;
  unitAId: string;
  unitBId: string;
  winnerUnitId: string | null;
  isDraw: boolean;
  report?: BattlefieldMatchReport;
  seriesBestOf?: 1 | 3;
  winsA?: number;
  winsB?: number;
  draws?: number;
  gameReports?: BattlefieldMatchReport[];
}

export interface LeagueStandingRow {
  rank: number;
  unitId: string;
  unitName: string;
  playerSummary: string;
  machineSummary: string;
  cpuSummary: string;
  color: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  totalKills: number;
  totalDamageDealt: number;
  totalDamageTaken: number;
  totalShotsFired: number;
  totalShotsHit: number;
  hitRatePercent: number | null;
  avgSurvivedSeconds: number;
  totalContribution: number;
  teamRuleScore?: number;
}

export function createLeagueSchedule(
  units: CompetitionUnit[],
  seriesBestOf: 1 | 3 = 1
): LeagueMatch[] {
  if (units.length < 2) return [];
  const ids: (string | null)[] = units.map((u) => u.unitId);
  if (ids.length % 2 === 1) {
    ids.push(null);
  }
  const n = ids.length;
  const totalRounds = n - 1;
  const matches: LeagueMatch[] = [];
  let seq = 1;

  const rotating = ids.slice(1);
  for (let round = 0; round < totalRounds; round++) {
    const order = [ids[0], ...rotating];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a && b) {
        matches.push({
          matchId: `league_m${seq++}`,
          roundNumber: round + 1,
          unitAId: a,
          unitBId: b,
          winnerUnitId: null,
          isDraw: false,
          seriesBestOf,
          winsA: 0,
          winsB: 0,
          draws: 0,
          gameReports: [],
        });
      }
    }
    const last = rotating.pop();
    if (last !== undefined) {
      rotating.unshift(last);
    }
  }
  return matches;
}

/**
 * Record one completed game toward a Bo1 or Bo3 league match.
 * Leaves `report` unset until the Bo3 series reaches 2 wins or 3 games.
 */
export function applyLeagueGameResult(
  matches: LeagueMatch[],
  matchId: string,
  gameWinnerUnitId: string | null,
  report: BattlefieldMatchReport,
  isGameDraw: boolean,
  seriesBestOf: 1 | 3 = 1
): LeagueMatch[] {
  return matches.map((m) => {
    if (m.matchId !== matchId) return m;
    const effectiveBestOf: 1 | 3 = seriesBestOf === 3 || m.seriesBestOf === 3 ? 3 : 1;
    if (effectiveBestOf === 1) {
      return {
        ...m,
        seriesBestOf: 1,
        winnerUnitId: isGameDraw ? null : gameWinnerUnitId,
        isDraw: isGameDraw || !gameWinnerUnitId,
        winsA: !isGameDraw && gameWinnerUnitId === m.unitAId ? 1 : 0,
        winsB: !isGameDraw && gameWinnerUnitId === m.unitBId ? 1 : 0,
        draws: isGameDraw || !gameWinnerUnitId ? 1 : 0,
        gameReports: [report],
        report,
      };
    }

    const restart = Boolean(m.report);
    let winsA = restart ? 0 : (m.winsA ?? 0);
    let winsB = restart ? 0 : (m.winsB ?? 0);
    let draws = restart ? 0 : (m.draws ?? 0);
    const gameReports = restart ? [] : [...(m.gameReports ?? [])];

    if (isGameDraw || !gameWinnerUnitId) {
      draws += 1;
    } else if (gameWinnerUnitId === m.unitAId) {
      winsA += 1;
    } else if (gameWinnerUnitId === m.unitBId) {
      winsB += 1;
    } else {
      draws += 1;
    }
    gameReports.push(report);

    const seriesDone = winsA >= 2 || winsB >= 2 || gameReports.length >= 3;
    if (!seriesDone) {
      return {
        ...m,
        seriesBestOf: 3,
        winsA,
        winsB,
        draws,
        gameReports,
        winnerUnitId: null,
        isDraw: false,
        report: undefined,
      };
    }

    const seriesWinnerId = winsA > winsB ? m.unitAId : winsB > winsA ? m.unitBId : null;
    return {
      ...m,
      seriesBestOf: 3,
      winsA,
      winsB,
      draws,
      gameReports,
      winnerUnitId: seriesWinnerId,
      isDraw: winsA === winsB,
      report,
    };
  });
}

export function computeLeagueStandings(
  units: CompetitionUnit[],
  matches: LeagueMatch[]
): LeagueStandingRow[] {
  const rows: LeagueStandingRow[] = units.map((u) => {
    const playerSummary = Array.from(new Set(u.entries.map((e) => e.playerName))).join(' & ');
    const machineSummary = u.entries.map((e) => e.machineName).join(' + ');
    const cpuSummary = u.entries.map((e) => `${e.blueprint.program.gridSize}x${e.blueprint.program.gridSize}`).join('+');
    let played = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let totalKills = 0;
    let totalDamageDealt = 0;
    let totalDamageTaken = 0;
    let totalShotsFired = 0;
    let totalShotsHit = 0;
    let survivedSum = 0;
    let survivedDenom = 0;
    let totalContribution = 0;

    for (const m of matches) {
      if (!m.report) continue;
      const isA = m.unitAId === u.unitId;
      const isB = m.unitBId === u.unitId;
      if (!isA && !isB) continue;

      played += 1;
      if (m.isDraw || !m.winnerUnitId) {
        draws += 1;
      } else if (m.winnerUnitId === u.unitId) {
        wins += 1;
      } else {
        losses += 1;
      }

      const myTeamId = isA ? 'unit_A' : 'unit_B';
      const reports = m.gameReports && m.gameReports.length > 0 ? m.gameReports : [m.report];
      for (const rep of reports) {
        const myTanks = rep.tankRows.filter((tr) => tr.teamId === myTeamId);
        for (const tr of myTanks) {
          totalKills += tr.kills;
          totalDamageDealt += tr.damageDealt;
          totalDamageTaken += tr.damageTaken;
          totalShotsFired += tr.shotsFired;
          totalShotsHit += tr.shotsHit;
          totalContribution += tr.contributionScore;
        }
        if (myTanks.length > 0) {
          survivedSum +=
            myTanks.reduce((s, tr) => s + tr.survivedSeconds, 0) / myTanks.length;
          survivedDenom += 1;
        }
      }
    }

    return {
      rank: 0,
      unitId: u.unitId,
      unitName: u.unitName,
      playerSummary,
      machineSummary,
      cpuSummary,
      color: u.color,
      played,
      wins,
      draws,
      losses,
      points: wins * 3 + draws,
      totalKills,
      totalDamageDealt: Math.round(totalDamageDealt * 10) / 10,
      totalDamageTaken: Math.round(totalDamageTaken * 10) / 10,
      totalShotsFired,
      totalShotsHit,
      hitRatePercent:
        totalShotsFired > 0
          ? Math.round((totalShotsHit / totalShotsFired) * 1000) / 10
          : null,
      avgSurvivedSeconds:
        survivedDenom > 0 ? Math.round((survivedSum / survivedDenom) * 10) / 10 : 0,
      totalContribution,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    const aNet = a.totalDamageDealt - a.totalDamageTaken;
    const bNet = b.totalDamageDealt - b.totalDamageTaken;
    if (Math.abs(bNet - aNet) >= 0.1) return bNet - aNet;
    if (Math.abs(b.totalDamageDealt - a.totalDamageDealt) >= 0.1) {
      return b.totalDamageDealt - a.totalDamageDealt;
    }
    return b.totalContribution - a.totalContribution;
  });

  rows.forEach((r, idx) => {
    r.rank = idx + 1;
  });

  return rows;
}

export function buildParticipantsFromUnitPair(
  unitA: CompetitionUnit,
  unitB: CompetitionUnit
): BattlefieldParticipant[] {
  const maxPerSide = Math.max(unitA.entries.length, unitB.entries.length);
  const participants: BattlefieldParticipant[] = [];
  // Interleave spawns A0, B0, A1, B1... so teams start symmetrically across opposite arena sides
  for (let i = 0; i < maxPerSide; i++) {
    if (unitA.entries[i]) {
      participants.push({
        entry: unitA.entries[i],
        teamId: 'unit_A',
        teamLabel: unitA.unitName,
        teamColor: unitA.color,
        slotIndex: i,
      });
    }
    if (unitB.entries[i]) {
      participants.push({
        entry: unitB.entries[i],
        teamId: 'unit_B',
        teamLabel: unitB.unitName,
        teamColor: unitB.color,
        slotIndex: i,
      });
    }
  }
  return participants;
}

export function formatConfigConditionSuffix(cfg: BattlefieldConfig): string {
  const parts: string[] = [];
  if (cfg.outerWallMode && cfg.outerWallMode !== 'normal') {
    parts.push(OUTER_WALL_MODE_SPECS[cfg.outerWallMode]?.label ?? cfg.outerWallMode);
  }
  if (cfg.zoneMode && cfg.zoneMode !== 'none') {
    parts.push(ARENA_ZONE_MODE_SPECS[cfg.zoneMode]?.label ?? cfg.zoneMode);
  }
  if (cfg.gravityPreset && cfg.gravityPreset !== 'normal') {
    parts.push(GRAVITY_PRESET_SPECS[cfg.gravityPreset]?.shortLabel ?? cfg.gravityPreset);
  }
  if (cfg.sandstormPreset && cfg.sandstormPreset !== 'none') {
    parts.push(SANDSTORM_PRESET_SPECS[cfg.sandstormPreset]?.shortLabel ?? cfg.sandstormPreset);
  }
  return parts.length > 0 ? ` / ${parts.join(' / ')}` : '';
}

export function formatMatchReportText(
  report: BattlefieldMatchReport,
  summary?: { headline: string; highlights?: string[] } | null
): string {
  const cfg = report.configSnapshot;
  const ruleName = BATTLEFIELD_RULE_REGISTRY[cfg.ruleId]?.name ?? cfg.ruleId;
  const regLabel = CPU_REGULATION_SPECS[cfg.cpuRegulation]?.label ?? cfg.cpuRegulation;
  const weaponNote = cfg.disableWeapons
    ? '射撃禁止（主砲・副武装すべて禁止）'
    : cfg.disableSubWeapons
      ? '副武装 (SP) のみ禁止'
      : '武装制限なし';

  const lines: string[] = [
    '=== CodePanzer.py バトルフィールド 試合結果 ===',
    `[ルール] ${ruleName} / ${regLabel} / ${weaponNote}${formatConfigConditionSuffix(cfg)} / ${ARENA_SIZE_SPECS[cfg.arenaSize].shortLabel}アリーナ (${cfg.maxSeconds}秒上限)`,
    `[決着] ${report.endReason} (経過: ${report.durationSeconds.toFixed(1)}s)`,
  ];

  if (summary?.headline) {
    lines.push(`[総評] ${summary.headline}`);
    for (const h of summary.highlights ?? []) {
      lines.push(`  ・${h}`);
    }
  }

  lines.push(
    '',
    '順位 | チーム | Player名 | マシーン名 | CPU | 撃破 | 与ダメ | 被ダメ | 命中率 | 生存時間 | 貢献度 | 賞'
  );

  for (const r of report.tankRows) {
    const hitStr =
      r.hitRatePercent !== null
        ? `${r.hitRatePercent.toFixed(1)}% (${r.shotsHit}/${r.shotsFired})`
        : `- (0/0)`;
    const survStr =
      cfg.ruleId === 'bounty_hunt'
        ? `${r.killedByLabel} (残HP:${r.hpRemaining}/${r.maxHp})`
        : r.isAlive
          ? `${r.survivedSeconds.toFixed(1)}s (生存 HP:${r.hpRemaining}/${r.maxHp})`
          : `${r.survivedSeconds.toFixed(1)}s (${r.killedByLabel}に撃破)`;
    const awardStr = r.awards.length > 0 ? r.awards.join(' ') : '-';
    lines.push(
      `${r.rank}位 | ${r.teamLabel} | ${r.playerName} | ${r.machineName} | ${r.gridSize}x${r.gridSize} | ${r.kills} | ${r.damageDealt.toFixed(1)} | ${r.damageTaken.toFixed(1)} | ${hitStr} | ${survStr} | ${r.contributionScore} (${r.ruleMetricText}) | ${awardStr}`
    );
  }

  return lines.join('\n');
}

export function formatMatchReportTsv(report: BattlefieldMatchReport): string {
  const header = [
    '順位',
    'チーム',
    'Player名',
    'マシーン名',
    'CPU',
    '撃破数',
    '与ダメージ',
    '被ダメージ',
    '命中数',
    '発射数',
    '命中率(%)',
    '生存時間(秒)',
    '状態',
    '貢献スコア',
    'ルール貢献',
    '賞',
  ].join('\t');

  const rows = report.tankRows.map((r) =>
    [
      r.rank,
      r.teamLabel,
      r.playerName,
      r.machineName,
      `${r.gridSize}x${r.gridSize}`,
      r.kills,
      r.damageDealt.toFixed(1),
      r.damageTaken.toFixed(1),
      r.shotsHit,
      r.shotsFired,
      r.hitRatePercent !== null ? r.hitRatePercent.toFixed(1) : '',
      r.survivedSeconds.toFixed(1),
      r.isAlive ? '生存' : '撃破',
      r.contributionScore,
      r.ruleMetricText,
      r.awards.join(' '),
    ].join('\t')
  );

  return [header, ...rows].join('\n');
}

export function formatLeagueStandingsText(
  standings: LeagueStandingRow[],
  config: BattlefieldConfig
): string {
  const ruleName = BATTLEFIELD_RULE_REGISTRY[config.ruleId]?.name ?? config.ruleId;
  const regLabel = CPU_REGULATION_SPECS[config.cpuRegulation]?.label ?? config.cpuRegulation;
  const seriesNote = config.seriesFormat === 'bo3' ? ' / Bo3(2本先取)' : '';
  const lines: string[] = [
    '=== CodePanzer.py バトルフィールド リーグ戦順位表 ===',
    `[条件] ${ruleName} / ${regLabel} / ${config.disableWeapons ? '射撃禁止' : '通常武装'}${seriesNote}${formatConfigConditionSuffix(config)}`,
    '順位 | チーム/ユニット | Player名 | マシーン名 | CPU | 試合 | 勝 | 分 | 負 | 勝点 | 総撃破 | 総与ダメ | 総被ダメ | 命中率 | 平均生存 | 総貢献',
  ];

  for (const s of standings) {
    const hitStr =
      s.hitRatePercent !== null
        ? `${s.hitRatePercent.toFixed(1)}% (${s.totalShotsHit}/${s.totalShotsFired})`
        : '-';
    lines.push(
      `${s.rank}位 | ${s.unitName} | ${s.playerSummary} | ${s.machineSummary} | ${s.cpuSummary} | ${s.played} | ${s.wins} | ${s.draws} | ${s.losses} | ${s.points} | ${s.totalKills} | ${s.totalDamageDealt.toFixed(1)} | ${s.totalDamageTaken.toFixed(1)} | ${hitStr} | ${s.avgSurvivedSeconds.toFixed(1)}s | ${s.totalContribution}`
    );
  }
  return lines.join('\n');
}

export function formatTournamentSummaryText(
  bracket: TournamentBracket,
  config: BattlefieldConfig
): string {
  const unitById = new Map(bracket.units.map((u) => [u.unitId, u]));
  const champ = bracket.championUnitId ? unitById.get(bracket.championUnitId) : null;
  const ruleName = BATTLEFIELD_RULE_REGISTRY[config.ruleId]?.name ?? config.ruleId;
  const regLabel = CPU_REGULATION_SPECS[config.cpuRegulation]?.label ?? config.cpuRegulation;
  const seriesNote = config.seriesFormat === 'bo3' ? ' / Bo3(2本先取)' : '';

  const lines: string[] = [
    '=== CodePanzer.py バトルフィールド トーナメント結果 ===',
    `[条件] ${ruleName} / ${regLabel} / ${config.disableWeapons ? '射撃禁止' : '通常武装'}${seriesNote}${formatConfigConditionSuffix(config)}`,
    champ
      ? `[優勝] 🏆 ${champ.unitName} (Player: ${champ.entries.map((e) => e.playerName).join(' & ')} / マシーン: ${champ.entries.map((e) => e.machineName).join(' + ')})`
      : '[進行状況] トーナメント未決着',
    '',
  ];

  for (const round of bracket.rounds) {
    if (round.length === 0) continue;
    lines.push(`--- ${round[0].roundLabel} ---`);
    for (const m of round) {
      const a = m.unitAId ? unitById.get(m.unitAId)?.unitName ?? m.unitAId : '(BYE)';
      const b = m.unitBId ? unitById.get(m.unitBId)?.unitName ?? m.unitBId : '(BYE)';
      const scoreTag =
        m.seriesBestOf === 3 && (m.winsA !== undefined || m.winsB !== undefined)
          ? ` [${m.winsA ?? 0}-${m.winsB ?? 0}]`
          : '';
      if (m.isBye) {
        const w = m.winnerUnitId ? unitById.get(m.winnerUnitId)?.unitName ?? '-' : '-';
        lines.push(`  ${a} vs ${b} -> ${w} (シード勝ち抜け)`);
      } else if (m.winnerUnitId) {
        const w = unitById.get(m.winnerUnitId)?.unitName ?? m.winnerUnitId;
        const dur = m.report ? `${m.report.durationSeconds.toFixed(1)}s` : '-';
        lines.push(`  ${a} vs ${b}${scoreTag} -> 勝者: ${w} (${dur})`);
      } else {
        lines.push(`  ${a} vs ${b}${scoreTag} -> 未対戦`);
      }
    }
  }

  return lines.join('\n');
}

export const BATTLEFIELD_SESSION_STORAGE_KEY = 'codepanzer_bf_session_v1';

export interface BattlefieldSessionSnapshot {
  version: 1;
  savedAt: number;
  config: BattlefieldConfig;
  roster: BattlefieldRosterEntry[];
  tournamentBracket: TournamentBracket | null;
  leagueData: {
    units: CompetitionUnit[];
    matches: LeagueMatch[];
  } | null;
  activeMatchId: string | null;
  autoAdvance: boolean;
}

/** Save current Battlefield roster, config, and tournament/league progress to localStorage. */
export function saveBattlefieldSession(snapshot: BattlefieldSessionSnapshot): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(BATTLEFIELD_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

/** Load and repair the persisted Battlefield session if valid; otherwise return null. */
export function loadBattlefieldSession(): BattlefieldSessionSnapshot | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(BATTLEFIELD_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BattlefieldSessionSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.roster) || !parsed.config) {
      return null;
    }

    const repairedRoster: BattlefieldRosterEntry[] = [];
    for (const item of parsed.roster) {
      if (!item || typeof item !== 'object' || !item.blueprint || !item.entryId) continue;
      const repairedBp = validateAndRepairBlueprint(item.blueprint).blueprint;
      const gs = repairedBp.program.gridSize;
      repairedRoster.push({
        entryId: String(item.entryId),
        playerName: String(item.playerName ?? (item.isPreset ? 'CPU' : 'Player')),
        ...(item.basePlayerName ? { basePlayerName: String(item.basePlayerName) } : {}),
        machineName: sanitizeTankName(item.machineName ?? repairedBp.name, 'カスタム戦車'),
        blueprint: {
          ...repairedBp,
          assembly: {
            ...repairedBp.assembly,
            cpu: cpuIdForGridSize(gs),
          },
        },
        sourceLabel: String(item.sourceLabel ?? '復元'),
        teamSlot:
          typeof item.teamSlot === 'number'
            ? Math.max(0, Math.min(3, Math.trunc(item.teamSlot)))
            : 0,
        enabled: item.enabled !== false,
        isPreset: Boolean(item.isPreset),
      });
    }

    if (repairedRoster.length === 0) return null;
    entrySeq = Math.max(entrySeq, repairedRoster.length + 10);

    const cfg: BattlefieldConfig = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ...parsed.config,
      seriesFormat: parsed.config.seriesFormat === 'bo3' ? 'bo3' : 'bo1',
      randomizeSeedPerMatch: Boolean(parsed.config.randomizeSeedPerMatch),
    };

    const bracket =
      parsed.tournamentBracket &&
      Array.isArray(parsed.tournamentBracket.units) &&
      Array.isArray(parsed.tournamentBracket.rounds)
        ? parsed.tournamentBracket
        : null;

    const league =
      parsed.leagueData &&
      Array.isArray(parsed.leagueData.units) &&
      Array.isArray(parsed.leagueData.matches)
        ? parsed.leagueData
        : null;

    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      config: cfg,
      roster: repairedRoster,
      tournamentBracket: bracket,
      leagueData: league,
      activeMatchId: typeof parsed.activeMatchId === 'string' ? parsed.activeMatchId : null,
      autoAdvance: Boolean(parsed.autoAdvance),
    };
  } catch {
    return null;
  }
}

/** Remove any saved Battlefield session from localStorage cleanly. */
export function clearBattlefieldSession(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(BATTLEFIELD_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors cleanly
  }
}
