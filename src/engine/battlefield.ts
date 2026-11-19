import {
  CHASSIS_SPECS,
  computeShellMetrics,
  MAIN_GUN_SPECS,
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
import { circleIntersectsRect } from './math';
import {
  applyDamage,
  ARENA_SIZE_SPECS,
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
  | 'tank_soccer';

export type CpuRegulationId =
  | 'any'
  | 'only_4x4'
  | 'max_6x6'
  | 'max_8x8'
  | 'only_6x6'
  | 'only_8x8'
  | 'pair_6x6_4x4';

export type ArenaZoneMode = 'none' | 'slow' | 'no_weapon' | 'mixed';

export type GravityPresetId = 'high_2' | 'high_1' | 'normal' | 'low_1' | 'low_2';

export type SandstormPresetId = 'none' | 'light' | 'medium' | 'heavy' | 'extreme';

export interface BattlefieldRosterEntry {
  entryId: string;
  playerName: string;
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

export const BATTLEFIELD_RULE_REGISTRY: Record<BattlefieldRuleId, BattlefieldRuleSpec> = {
  elimination: {
    id: 'elimination',
    name: '殲滅バトル（標準）',
    shortLabel: '殲滅戦',
    description: '相手を全滅させるか、制限時間終了時の残存HP率・ダメージ判定で勝敗を決めます。',
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
  mixed: {
    id: 'mixed',
    label: '混合（減速＋武器禁止）',
    shortLabel: '減速+武器禁止',
    description: '減速エリアと武器禁止エリアの両方を戦場に配置します。',
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
};

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
    machineName,
    blueprint: normalized,
    sourceLabel,
    teamSlot: 0,
    enabled: true,
    isPreset,
  };
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
  const modeSalt = zoneMode === 'slow' ? 11 : zoneMode === 'no_weapon' ? 23 : 37;
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

    const kind =
      zoneMode === 'mixed'
        ? placed.length % 2 === 0
          ? 'slow'
          : 'no_weapon'
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

    const survivalBonus = Math.round(
      (survivedTicks / Math.max(1, state.tick)) * 60
    );
    const accuracyBonus =
      shotsFired >= 3 && hitRatePercent !== null ? Math.round(hitRatePercent * 0.4) : 0;
    const winBonus = winnerTeamId && teamId === winnerTeamId ? 120 : 0;
    const aliveBonus = isAlive ? 40 : 0;
    const contributionScore =
      winBonus +
      aliveBonus +
      survivalBonus +
      kills * 100 +
      Math.round(damageDealt * 1.2) +
      accuracyBonus +
      Math.round(ruleScore * 10);

    let killedByLabel = isAlive ? '生存' : '場外・自滅';
    if (!isAlive && t.killedById) {
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
    const maxDmg = [...rawRows].sort((a, b) => b.damageDealt - a.damageDealt)[0];
    if (maxDmg.damageDealt > 0) {
      maxDmg.awards.push('💥 最多ダメージ');
    }
    const sharpshooters = rawRows.filter((r) => r.shotsFired >= 3 && (r.hitRatePercent ?? 0) > 0);
    if (sharpshooters.length > 0) {
      const topAcc = [...sharpshooters].sort(
        (a, b) => (b.hitRatePercent ?? 0) - (a.hitRatePercent ?? 0)
      )[0];
      topAcc.awards.push('🎯 高命中');
    }
    const survivors = rawRows.filter((r) => r.isAlive);
    if (survivors.length > 0) {
      const toughest = [...survivors].sort((a, b) => a.damageTaken - b.damageTaken)[0];
      toughest.awards.push('🛡️ 生存');
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

export function createTournamentBracket(units: CompetitionUnit[]): TournamentBracket {
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

export interface LeagueMatch {
  matchId: string;
  roundNumber: number;
  unitAId: string;
  unitBId: string;
  winnerUnitId: string | null;
  isDraw: boolean;
  report?: BattlefieldMatchReport;
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

export function createLeagueSchedule(units: CompetitionUnit[]): LeagueMatch[] {
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
      const myTanks = m.report.tankRows.filter((tr) => tr.teamId === myTeamId);
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
        played > 0 ? Math.round((survivedSum / played) * 10) / 10 : 0,
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

export function formatMatchReportText(report: BattlefieldMatchReport): string {
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
    '',
    '順位 | チーム | Player名 | マシーン名 | CPU | 撃破 | 与ダメ | 被ダメ | 命中率 | 生存時間 | 貢献度 | 賞',
  ];

  for (const r of report.tankRows) {
    const hitStr =
      r.hitRatePercent !== null
        ? `${r.hitRatePercent.toFixed(1)}% (${r.shotsHit}/${r.shotsFired})`
        : `- (0/0)`;
    const survStr = r.isAlive
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
  const lines: string[] = [
    '=== CodePanzer.py バトルフィールド リーグ戦順位表 ===',
    `[条件] ${ruleName} / ${regLabel} / ${config.disableWeapons ? '射撃禁止' : '通常武装'}${formatConfigConditionSuffix(config)}`,
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

  const lines: string[] = [
    '=== CodePanzer.py バトルフィールド トーナメント結果 ===',
    `[条件] ${ruleName} / ${regLabel} / ${config.disableWeapons ? '射撃禁止' : '通常武装'}${formatConfigConditionSuffix(config)}`,
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
      if (m.isBye) {
        const w = m.winnerUnitId ? unitById.get(m.winnerUnitId)?.unitName ?? '-' : '-';
        lines.push(`  ${a} vs ${b} -> ${w} (シード勝ち抜け)`);
      } else if (m.winnerUnitId) {
        const w = unitById.get(m.winnerUnitId)?.unitName ?? m.winnerUnitId;
        const dur = m.report ? `${m.report.durationSeconds.toFixed(1)}s` : '-';
        lines.push(`  ${a} vs ${b} -> 勝者: ${w} (${dur})`);
      } else {
        lines.push(`  ${a} vs ${b} -> 未対戦`);
      }
    }
  }

  return lines.join('\n');
}
