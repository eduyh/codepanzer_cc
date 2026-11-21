import { CHIP_DEFINITIONS } from '../data/chips';
import {
  CHASSIS_SPECS,
  MAIN_GUN_SPECS,
  RADAR_SPECS,
  SUB_WEAPON_SPECS,
  tryParseFirePowerInput,
} from '../data/parts';
import { createEmptyCells, makeCell } from '../data/presets';
import {
  ALLOWED_GRID_SIZES,
  ChassisId,
  ChipProgram,
  ChipType,
  CoordinateMode,
  GridCell,
  GridCoord,
  GridSize,
  MainGunId,
  RadarId,
  SubWeaponId,
} from '../types/game';

export const ALLOWED_CHASSIS_IDS: ChassisId[] = ['light', 'standard', 'heavy', 'destroyer'];
export const ALLOWED_RADAR_IDS: RadarId[] = ['wide', 'balanced', 'long'];
export const ALLOWED_MAIN_GUN_IDS: MainGunId[] = ['rapid', 'standard', 'cannon'];
export const CURRENT_GAME_VERSION = '1.7.5';
export const CURRENT_BLUEPRINT_VERSION = 1;
export const CURRENT_ENV_DUMP_VERSION = 1;
export const MAX_GAME_VERSION_LENGTH = 24;
export const MAX_TANK_NAME_LENGTH = 16;
export const MAX_AUTHOR_NAME_LENGTH = 8;
export const MAX_AUTHOR_UUID_LENGTH = 36;

export function truncateToMaxChars(raw: unknown, maxLen: number): string {
  const cleaned = String(raw ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, '');
  return Array.from(cleaned).slice(0, maxLen).join('');
}

function sanitizeBoundedText(raw: unknown, maxLen: number, fallback: string): string {
  const trimmed = truncateToMaxChars(raw, maxLen).trim();
  return trimmed || fallback;
}

export function sanitizeTankName(raw: unknown, fallback = 'カスタム戦車'): string {
  return sanitizeBoundedText(raw, MAX_TANK_NAME_LENGTH, fallback);
}

export function sanitizeAuthorName(raw: unknown, fallback = 'Player'): string {
  return sanitizeBoundedText(raw, MAX_AUTHOR_NAME_LENGTH, fallback);
}

export function sanitizeAuthorUuid(raw: unknown, fallback = ''): string {
  return sanitizeBoundedText(raw, MAX_AUTHOR_UUID_LENGTH, fallback);
}

export function sanitizeGameVersion(raw: unknown, fallback = CURRENT_GAME_VERSION): string {
  const trimmed = truncateToMaxChars(raw, MAX_GAME_VERSION_LENGTH)
    .trim()
    .replace(/^[vV]/, '');
  if (!trimmed) return fallback;
  return /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : fallback;
}

export function compareSemver(a: string, b: string): number {
  const parseParts = (v: string): [number, number, number] | null => {
    const m = v
      .trim()
      .replace(/^[vV]/, '')
      .match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  };
  const pa = parseParts(a);
  const pb = parseParts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isNewerGameVersion(
  targetVersion?: string,
  currentVersion = CURRENT_GAME_VERSION
): boolean {
  if (!targetVersion) return false;
  return compareSemver(targetVersion, currentVersion) > 0;
}
export const ALLOWED_SUB_WEAPON_IDS: SubWeaponId[] = [
  'none',
  'missile',
  'mine',
  'shield',
  'smoke',
  'boost',
  'decoy',
];

export const MAX_BATTLE_TANKS = 8;

// CVD-safe 8-color palette (based on Okabe-Ito + high-luminance white for dark backgrounds)
export const AUTO_TANK_COLORS: readonly string[] = [
  '#56b4e9', // 1: Sky Blue (Player / Slot 1)
  '#e69f00', // 2: Orange
  '#009e73', // 3: Bluish Green
  '#cc79a7', // 4: Reddish Purple
  '#f0e442', // 5: Bright Yellow
  '#d55e00', // 6: Vermilion
  '#0072b2', // 7: Deep Blue
  '#f8fafc', // 8: White Silver
];

export function getAutoTankColor(index: number): string {
  const len = AUTO_TANK_COLORS.length;
  return AUTO_TANK_COLORS[((index % len) + len) % len];
}

export const STANDARD_SETUP = {
  chassis: 'standard' as ChassisId,
  radar: 'balanced' as RadarId,
  mainGun: 'standard' as MainGunId,
  subWeapon: 'missile' as SubWeaponId,
  color: AUTO_TANK_COLORS[0],
};

export function isAllowedChassisId(val: unknown): val is ChassisId {
  return typeof val === 'string' && (ALLOWED_CHASSIS_IDS as string[]).includes(val);
}

export function isAllowedRadarId(val: unknown): val is RadarId {
  return typeof val === 'string' && (ALLOWED_RADAR_IDS as string[]).includes(val);
}

export function isAllowedMainGunId(val: unknown): val is MainGunId {
  return typeof val === 'string' && (ALLOWED_MAIN_GUN_IDS as string[]).includes(val);
}

export function isAllowedSubWeaponId(val: unknown): val is SubWeaponId {
  return typeof val === 'string' && (ALLOWED_SUB_WEAPON_IDS as string[]).includes(val);
}

interface HardwareParseOutcome<T extends string> {
  id: T;
  corrected: boolean;
  warning?: string;
}

function parseAndValidateHardwareLine<T extends string, S extends object>(
  lineText: string,
  varName: string,
  labelJa: string,
  standardId: T,
  isAllowed: (val: unknown) => val is T,
  specsMap: Record<T, S>,
  fieldMap: Record<string, keyof S>
): HardwareParseOutcome<T> {
  const m = lineText.trim().match(new RegExp(`^${varName}\\s*=\\s*(.+)$`));
  if (!m) {
    return {
      id: standardId,
      corrected: true,
      warning: `${labelJa}の記述形式が不正なため、標準セットアップ ("${standardId}") に自動補正しました。`,
    };
  }
  const rhs = m[1].trim();

  const strMatch = rhs.match(/^(?:"([^"]*)"|'([^']*)')$/);
  if (strMatch) {
    const val = (strMatch[1] ?? strMatch[2] ?? '').trim();
    if (isAllowed(val)) {
      return { id: val, corrected: false };
    }
    return {
      id: standardId,
      corrected: true,
      warning: `規定外の${labelJa} ("${val}") が指定されたため、標準セットアップ ("${standardId}") に自動補正しました。`,
    };
  }

  if (rhs.startsWith('{') && rhs.endsWith('}')) {
    try {
      const normalized = rhs.replace(/'/g, '"').replace(/,\s*}/g, '}');
      const parsed: unknown = JSON.parse(normalized);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          id: standardId,
          corrected: true,
          warning: `${labelJa}の値が不正なため、標準セットアップ ("${standardId}") に自動補正しました。`,
        };
      }
      const obj = parsed as Record<string, unknown>;
      const rawType = obj.type ?? obj.id;
      if (!isAllowed(rawType)) {
        return {
          id: standardId,
          corrected: true,
          warning: `規定外の${labelJa} ("${String(rawType ?? '')}") が指定されたため、標準セットアップ ("${standardId}") に自動補正しました。`,
        };
      }

      const spec = specsMap[rawType];
      for (const k of Object.keys(obj)) {
        if (k !== 'type' && k !== 'id' && !(k in fieldMap)) {
          return {
            id: rawType,
            corrected: true,
            warning: `${labelJa} "${rawType}" に異常項目 ("${k}") があったため、プリセット "${rawType}" の規定値に自動補正しました。`,
          };
        }
      }

      for (const [key, specProp] of Object.entries(fieldMap)) {
        if (key in obj) {
          const numVal = Number(obj[key]);
          const expected = Number(spec[specProp]);
          if (!Number.isFinite(numVal) || numVal !== expected) {
            return {
              id: rawType,
              corrected: true,
              warning: `${labelJa} "${rawType}" のスペック値 (${key}=${String(obj[key])}) に異常があったため、プリセット "${rawType}" の規定値に自動補正しました。`,
            };
          }
        }
      }

      return { id: rawType, corrected: false };
    } catch {
      return {
        id: standardId,
        corrected: true,
        warning: `${labelJa}の辞書構文が不正なため、標準セットアップ ("${standardId}") に自動補正しました。`,
      };
    }
  }

  return {
    id: standardId,
    corrected: true,
    warning: `${labelJa}の記述が不正なため、標準セットアップ ("${standardId}") に自動補正しました。`,
  };
}

export function parseAndValidateChassisLine(lineText: string): HardwareParseOutcome<ChassisId> {
  return parseAndValidateHardwareLine(
    lineText,
    'chassis',
    'シャシー',
    STANDARD_SETUP.chassis,
    isAllowedChassisId,
    CHASSIS_SPECS,
    { hp: 'maxHp', maxHp: 'maxHp', speed: 'maxSpeed', maxSpeed: 'maxSpeed', turn: 'turnRate', turnRate: 'turnRate' }
  );
}

export function parseAndValidateRadarLine(lineText: string): HardwareParseOutcome<RadarId> {
  return parseAndValidateHardwareLine(
    lineText,
    'radar',
    'レーダー',
    STANDARD_SETUP.radar,
    isAllowedRadarId,
    RADAR_SPECS,
    { fov: 'fovDeg', fovDeg: 'fovDeg', range: 'range', turn: 'turnRate', turnRate: 'turnRate' }
  );
}

export function parseAndValidateMainGunLine(lineText: string): HardwareParseOutcome<MainGunId> {
  return parseAndValidateHardwareLine(
    lineText,
    'main_gun',
    '主砲',
    STANDARD_SETUP.mainGun,
    isAllowedMainGunId,
    MAIN_GUN_SPECS,
    {
      damage: 'damageMultiplier',
      damageMultiplier: 'damageMultiplier',
      cooling: 'coolingRate',
      coolingRate: 'coolingRate',
      turn: 'turretTurnRate',
      turretTurnRate: 'turretTurnRate',
    }
  );
}

export function parseAndValidateSubWeaponLine(lineText: string): HardwareParseOutcome<SubWeaponId> {
  const normalizedLine = lineText.trim().replace(/^(?:special|sub_weapon)(\s*|_spec\s*)=/, 'special$1=');
  return parseAndValidateHardwareLine(
    normalizedLine,
    'special',
    'Special兵装',
    STANDARD_SETUP.subWeapon,
    isAllowedSubWeaponId,
    SUB_WEAPON_SPECS,
    { ammo: 'maxAmmo', maxAmmo: 'maxAmmo', cooldown: 'cooldownTicks', cooldownTicks: 'cooldownTicks' }
  );
}

export interface GridFitValidation {
  valid: boolean;
  blockCount: number;
  maxBlocks: number;
  outOfBoundsCount: number;
  suggestedSize: GridSize | null;
  message: string;
}

export function isAllowedGridSize(size: number): size is GridSize {
  return (ALLOWED_GRID_SIZES as number[]).includes(size);
}

export function suggestRequiredGridSize(blockCount: number): GridSize | null {
  for (const size of ALLOWED_GRID_SIZES) {
    if (blockCount <= size * size) {
      return size;
    }
  }
  return null;
}

export const MIN_FIRE_POWER = 0.5;
export const MAX_FIRE_POWER = 3.0;

export function validateFirePowerInCells(cells: (GridCell | null)[][]): string | null {
  for (let y = 0; y < cells.length; y++) {
    const row = cells[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (!cell || cell.type !== 'act_fire') continue;
      const rawPower = cell.params.power ?? 'normal';
      if (tryParseFirePowerInput(rawPower) === null) {
        return `不正なプログラムです: fire_main の火力 (power=${cell.params.power}) は "fast" / "normal" / "heavy"（または ${MIN_FIRE_POWER.toFixed(1)}〜${MAX_FIRE_POWER.toFixed(1)}）で指定する必要があります。`;
      }
    }
  }
  return null;
}

export function countGridBlocks(cells: (GridCell | null)[][]): number {
  let count = 0;
  for (let y = 0; y < cells.length; y++) {
    const row = cells[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== null) count += 1;
    }
  }
  return count;
}

export function validateGridBlockFit(
  cells: (GridCell | null)[][],
  targetSize: GridSize
): GridFitValidation {
  const maxBlocks = targetSize * targetSize;
  let blockCount = 0;
  let outOfBoundsCount = 0;

  for (let y = 0; y < cells.length; y++) {
    const row = cells[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === null) continue;
      blockCount += 1;
      if (x >= targetSize || y >= targetSize) {
        outOfBoundsCount += 1;
      }
    }
  }

  const suggestedSize = suggestRequiredGridSize(blockCount);

  if (blockCount > maxBlocks) {
    return {
      valid: false,
      blockCount,
      maxBlocks,
      outOfBoundsCount,
      suggestedSize,
      message: `ブロック数 (${blockCount}) が ${targetSize}×${targetSize} の上限 (${maxBlocks}) を超えています。${
        suggestedSize ? `${suggestedSize}×${suggestedSize} 以上を選択してください。` : '12×12 の上限を超えています。'
      }`,
    };
  }

  if (outOfBoundsCount > 0) {
    return {
      valid: false,
      blockCount,
      maxBlocks,
      outOfBoundsCount,
      suggestedSize,
      message: `${targetSize}×${targetSize} の範囲外にある ${outOfBoundsCount} 個のブロックが切り詰められます（合計 ${blockCount}/${maxBlocks} ブロック）。`,
    };
  }

  const powerError = validateFirePowerInCells(cells);
  if (powerError) {
    return {
      valid: false,
      blockCount,
      maxBlocks,
      outOfBoundsCount: 0,
      suggestedSize,
      message: powerError,
    };
  }

  return {
    valid: true,
    blockCount,
    maxBlocks,
    outOfBoundsCount: 0,
    suggestedSize,
    message: `適合: ${blockCount} / ${maxBlocks} ブロック (${targetSize}×${targetSize})`,
  };
}

interface ParsedStatement {
  id: number;
  type: ChipType;
  params: Record<string, string | number>;
  yesBody?: ParsedStatement[];
  noBody?: ParsedStatement[];
  nextId?: number | null;
  yesId?: number | null;
  noId?: number | null;
}

function parseKwOrPosArgs(rawArgs: string): {
  kw: Record<string, string | number>;
  pos: (string | number)[];
} {
  const kw: Record<string, string | number> = {};
  const pos: (string | number)[] = [];
  if (!rawArgs.trim()) return { kw, pos };

  const parts = rawArgs.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    const parseVal = (raw: string): string | number => {
      const s = raw.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
      }
      const n = Number(s);
      if (!Number.isNaN(n) && s !== '') return n;
      return s;
    };

    if (eqIdx > 0) {
      const k = part.slice(0, eqIdx).trim();
      const v = parseVal(part.slice(eqIdx + 1));
      kw[k] = v;
    } else {
      pos.push(parseVal(part));
    }
  }
  return { kw, pos };
}

function parseBoolFlag(val: string | number | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'number') return val !== 0 ? 1 : 0;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

function parseConditionLine(expr: string): {
  type: ChipType;
  params: Record<string, string | number>;
} | null {
  const e = expr.trim();
  if (/^enemy_detected\((.*)\)$/.test(e)) {
    const m = e.match(/^enemy_detected\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    return {
      type: 'cond_enemy_detected',
      params: { maxAgeTicks: Number(kw.max_age ?? pos[0] ?? 20) },
    };
  }
  if (/^enemy_in_sector\((.*)\)$/.test(e)) {
    const m = e.match(/^enemy_in_sector\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    return {
      type: 'cond_enemy_sector',
      params: {
        ref: String(kw.ref ?? pos[0] ?? 'turret'),
        centerAngle: Number(kw.center ?? kw.centerAngle ?? pos[1] ?? 0),
        halfWidth: Number(kw.width ?? kw.halfWidth ?? pos[2] ?? 20),
        maxDist: Number(kw.dist ?? kw.max_dist ?? pos[3] ?? 700),
      },
    };
  }
  // 旧壁センサー (wall_near) は近接センサー (proximity_near) へ移行のため無効化
  // if (/^wall_near\((.*)\)$/.test(e)) {
  //   const m = e.match(/^wall_near\((.*)\)$/);
  //   const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
  //   return {
  //     type: 'cond_wall_ahead',
  //     params: {
  //       direction: String(kw.dir ?? kw.direction ?? pos[0] ?? 'front'),
  //       angle: Number(kw.angle ?? 0),
  //       dist: Number(kw.dist ?? pos[1] ?? 110),
  //     },
  //   };
  // }
  if (/^proximity_near\((.*)\)$/.test(e)) {
    const m = e.match(/^proximity_near\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    return {
      type: 'cond_proximity',
      params: {
        mode: String(kw.mode ?? pos[0] ?? 'approaching'),
        target: String(kw.target ?? pos[1] ?? 'all'),
        dist: Number(kw.dist ?? pos[2] ?? 90),
      },
    };
  }
  if (/^hit_from\((.*)\)$/.test(e)) {
    const m = e.match(/^hit_from\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    return {
      type: 'cond_hit_from',
      params: {
        zone: String(kw.zone ?? pos[0] ?? 'any'),
        ticks: Number(kw.ticks ?? pos[1] ?? 20),
      },
    };
  }
  if (/^(main_cooldown|gun_heat)\s*==\s*0$/.test(e)) {
    return { type: 'cond_gun_ready', params: {} };
  }
  if (/^(sp_cooldown|sub_cooldown)\s*==\s*0$/.test(e)) {
    return { type: 'cond_sub_ready', params: {} };
  }
  if (/^hp_percent\s*<=\s*(-?\d+(?:\.\d+)?)$/.test(e)) {
    const m = e.match(/^hp_percent\s*<=\s*(-?\d+(?:\.\d+)?)$/);
    return { type: 'cond_hp_below', params: { percent: Number(m?.[1] ?? 45) } };
  }
  if (/^incoming_shell\((.*)\)$/.test(e)) {
    const m = e.match(/^incoming_shell\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    return {
      type: 'cond_incoming_shell',
      params: { maxDist: Number(kw.radius ?? kw.maxDist ?? pos[0] ?? 220) },
    };
  }
  if (/^under_lock\(\s*\)$/.test(e)) {
    return { type: 'cond_under_lock', params: {} };
  }
  if (/^mode\s*==\s*(\d+)$/.test(e)) {
    const m = e.match(/^mode\s*==\s*(\d+)$/);
    return { type: 'cond_mode', params: { mode: Number(m?.[1] ?? 1) } };
  }
  if (/^on_tile\((.*)\)$/.test(e)) {
    const m = e.match(/^on_tile\((.*)\)$/);
    const { kw, pos } = parseKwOrPosArgs(m?.[1] ?? '');
    const rawTarget = String(kw.target ?? kw.kind ?? kw.color ?? pos[0] ?? 'goal').trim();
    const target = rawTarget === 'color' ? 'any_color' : rawTarget;
    return {
      type: 'cond_floor_tile',
      params: { target, edge: parseBoolFlag(kw.edge ?? kw.once) },
    };
  }
  if (/^targets_left\(\s*\)\s*(==|<=|>|>=|!=)\s*(\d+)$/.test(e)) {
    const m = e.match(/^targets_left\(\s*\)\s*(==|<=|>|>=|!=)\s*(\d+)$/);
    const op = m?.[1];
    const num = Number(m?.[2] ?? 0);
    const check =
      (op === '==' || op === '<=') && num === 0 ? 'targets_cleared' : 'targets_remaining';
    return { type: 'cond_mission_state', params: { check } };
  }
  if (/^checkpoints_left\(\s*\)\s*(==|<=|>|>=|!=)\s*(\d+)$/.test(e)) {
    const m = e.match(/^checkpoints_left\(\s*\)\s*(==|<=|>|>=|!=)\s*(\d+)$/);
    const op = m?.[1];
    const num = Number(m?.[2] ?? 0);
    const check =
      (op === '==' || op === '<=') && num === 0
        ? 'checkpoints_cleared'
        : 'checkpoints_remaining';
    return { type: 'cond_mission_state', params: { check } };
  }
  if (/^checkpoints_done\(\s*\)$/.test(e)) {
    return { type: 'cond_mission_state', params: { check: 'checkpoints_cleared' } };
  }
  const distMatch = e.match(/^(?:enemy_dist|enemy_distance\(\))\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (distMatch) {
    return {
      type: 'cond_enemy_dist',
      params: {
        op: distMatch[1].startsWith('>') ? 'gte' : 'lte',
        dist: Number(distMatch[2]),
      },
    };
  }
  const modMatch = e.match(/^(enemy_dist|[abAB])\s*%\s*(\d+)\s*==\s*0$/);
  if (modMatch) {
    const reg = modMatch[1].toUpperCase() === 'ENEMY_DIST' ? 'ENEMY_DIST' : modMatch[1].toUpperCase();
    return {
      type: 'cond_counter',
      params: { reg, op: 'mod0', value: Number(modMatch[2]) },
    };
  }
  const cmpMatch = e.match(/^(enemy_dist|[abAB])\s*(>=|<=|==)\s*(-?\d+)$/);
  if (cmpMatch) {
    const reg = cmpMatch[1].toUpperCase() === 'ENEMY_DIST' ? 'ENEMY_DIST' : cmpMatch[1].toUpperCase();
    const op = cmpMatch[2] === '>=' ? 'gte' : cmpMatch[2] === '<=' ? 'lte' : 'eq';
    return {
      type: 'cond_counter',
      params: { reg, op, value: Number(cmpMatch[3]) },
    };
  }
  return null;
}

function parseWhileCondition(expr: string): Record<string, string | number> | null {
  const e = expr.trim();
  if (/^not\s+enemy_detected\(\)$/.test(e)) {
    return { cond: 'enemy_not_detected', value: 60 };
  }
  const wallMatch = e.match(/^wall_ahead\(\)\s*<=\s*(\d+)$/);
  if (wallMatch) {
    return { cond: 'wall_ahead', value: Number(wallMatch[1]) };
  }
  const errMatch = e.match(/^abs\(aim_error\(\)\)\s*>\s*(\d+)$/);
  if (errMatch) {
    return { cond: 'turret_not_aligned', value: Number(errMatch[1]) };
  }
  const varMatch = e.match(/^a\s*<\s*(\d+)$/i);
  if (varMatch) {
    return { cond: 'var_a_lt', value: Number(varMatch[1]) };
  }
  return null;
}

function parseActionLine(stmt: string): {
  type: ChipType;
  params: Record<string, string | number>;
} | null {
  const s = stmt.trim().replace(/;$/, '');
  if (s === 'pass') {
    return { type: 'wire', params: { seconds: 0 } };
  }
  const modeMatch = s.match(/^mode\s*=\s*(\d+)$/);
  if (modeMatch) {
    return { type: 'mode_set', params: { mode: Number(modeMatch[1]) } };
  }
  const randMatch = s.match(/^([abAB])\s*=\s*random\.randint\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/);
  if (randMatch) {
    return {
      type: 'random_op',
      params: {
        reg: randMatch[1].toUpperCase(),
        min: Number(randMatch[2]),
        max: Number(randMatch[3]),
      },
    };
  }
  const varMatch = s.match(/^([abAB])\s*(\+=|-=|=)\s*(-?\d+)$/);
  if (varMatch) {
    const op = varMatch[2] === '+=' ? 'inc' : varMatch[2] === '-=' ? 'dec' : 'set';
    return {
      type: 'counter_op',
      params: { reg: varMatch[1].toUpperCase(), op, value: Number(varMatch[3]) },
    };
  }

  const subCallMatch = s.match(/^sub_([a-dA-D])\s*\(\s*\)$/);
  if (subCallMatch) {
    return {
      type: 'sub_call',
      params: { sub: subCallMatch[1].toUpperCase() },
    };
  }

  const callMatch = s.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)\((.*)\)$/);
  if (!callMatch) return null;
  const fn = callMatch[1];
  const { kw, pos } = parseKwOrPosArgs(callMatch[2]);

  switch (fn) {
    case 'time.sleep':
    case 'sleep':
      return {
        type: 'wire',
        params: { seconds: Math.max(0, Number(kw.sec ?? kw.seconds ?? pos[0] ?? 0)) },
      };
    case 'move':
      return {
        type: 'act_move',
        params: {
          speedPercent: Number(kw.speed ?? kw.speedPercent ?? pos[0] ?? 80),
          duration: Math.max(0, Number(kw.duration ?? kw.sec ?? kw.seconds ?? pos[1] ?? 0)),
        },
      };
    case 'turn_body':
    case 'turnBody': {
      const modeVal = String(kw.mode ?? 'auto');
      const defaultAng = modeVal === 'turret_rel' || modeVal === 'enemy_rel' ? 0 : 4;
      return {
        type: 'act_turn_body',
        params: {
          mode: modeVal,
          angle: Number(kw.angle ?? kw.deg ?? pos[0] ?? defaultAng),
          wait: parseBoolFlag(kw.wait),
        },
      };
    }
    case 'turn_body_to_turret':
      return {
        type: 'act_turn_body',
        params: {
          mode: 'turret_rel',
          angle: Number(kw.offset ?? kw.angle ?? pos[0] ?? 0),
          wait: parseBoolFlag(kw.wait),
        },
      };
    case 'turn_body_to_enemy':
      return {
        type: 'act_turn_body',
        params: {
          mode: 'enemy_rel',
          angle: Number(kw.offset ?? kw.angle ?? pos[0] ?? 90),
          wait: parseBoolFlag(kw.wait),
        },
      };
    case 'turn_turret':
    case 'turnTurret': {
      const modeVal = String(kw.mode ?? 'auto');
      const defaultAng = modeVal === 'body_rel' ? 0 : 6;
      return {
        type: 'act_turn_turret',
        params: {
          mode: modeVal,
          angle: Number(kw.angle ?? kw.deg ?? pos[0] ?? defaultAng),
          wait: parseBoolFlag(kw.wait),
        },
      };
    }
    case 'turn_turret_to_body':
      return {
        type: 'act_turn_turret',
        params: {
          mode: 'body_rel',
          angle: Number(kw.offset ?? kw.angle ?? pos[0] ?? 0),
          wait: parseBoolFlag(kw.wait),
        },
      };
    case 'stop':
    case 'halt':
      return { type: 'act_halt', params: {} };
    case 'aim_enemy':
    case 'aimEnemy':
      return {
        type: 'act_aim_enemy',
        params: {
          lead: String(kw.lead ?? pos[0] ?? 'direct'),
          offset: Number(kw.offset ?? pos[1] ?? 0),
        },
      };
    case 'turn_radar':
    case 'radar': {
      const posMode =
        pos[0] === 'lock_enemy' ||
        pos[0] === 'sweep' ||
        pos[0] === 'delta' ||
        pos[0] === 'heading' ||
        pos[0] === 'auto'
          ? String(pos[0])
          : undefined;
      const modeArg = String(kw.mode ?? posMode ?? 'auto');
      const defaultAng = modeArg === 'sweep' ? 60 : 14;
      const numericPos =
        typeof pos[0] === 'number'
          ? pos[0]
          : typeof pos[1] === 'number'
            ? pos[1]
            : undefined;
      return {
        type: 'act_turn_radar',
        params: {
          mode: modeArg,
          angle: Number(kw.angle ?? kw.arc ?? numericPos ?? defaultAng),
        },
      };
    }
    case 'fire_main':
    case 'fire':
      return {
        type: 'act_fire',
        params: {
          power: kw.power ?? pos[0] ?? 'normal',
          wait: parseBoolFlag(kw.wait),
        },
      };
    case 'fire_sp':
    case 'use_sp':
    case 'fire_sub':
    case 'use_sub':
    case 'useSub':
      return { type: 'act_sub_weapon', params: {} };
    default:
      return null;
  }
}

export type ParsePythonResult =
  | {
      ok: true;
      program: ChipProgram;
      tankName?: string;
      authorName?: string;
      authorUuid?: string;
      gameVersion?: string;
      chassisId?: ChassisId;
      radarId?: RadarId;
      mainGunId?: MainGunId;
      subWeaponId?: SubWeaponId;
      warnings?: string[];
      blockCount: number;
      maxBlocks: number;
    }
  | {
      ok: false;
      error: string;
      blockCount: number;
      maxBlocks: number;
      suggestedSize: GridSize | null;
    };

export function looksLikePythonSource(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('VST1-') || t.startsWith('{')) return false;
  return /^(import\s+(time|random)|tank_name\s*=|author_name\s*=|author_uuid\s*=|game_version\s*=|chassis\s*=|radar\s*=|main_gun\s*=|special\s*=|sub_weapon\s*=|color\s*=|def\s+(on_tick|sub_[a-dA-D])|if\s+|while\s+|for\s+|print\(|time\.sleep\(|random\.randint|enemy_dist|under_lock\(|move\(|fire_main\(|fire_sp\(|fire_sub\(|fire\(|turn_|aim_enemy|sub_[a-dA-D]\(|use_sp|use_sub|main_cooldown|sp_cooldown|sub_cooldown|[ab]\s*[+\-]?=)/m.test(
    t
  );
}

function stripPythonComment(line: string): string {
  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuote) {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (inQuote === null) inQuote = ch;
      else if (inQuote === ch) inQuote = null;
      continue;
    }
    if (ch === '#' && inQuote === null) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parsePythonSourceToProgram(
  source: string,
  targetSize: GridSize,
  coordinateMode: CoordinateMode
): ParsePythonResult {
  const maxBlocks = targetSize * targetSize;
  const rawLines = source.split(/\r?\n/);

  interface TokenLine {
    lineNum: number;
    indent: number;
    text: string;
  }

  const lines: TokenLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const noComment = stripPythonComment(rawLines[i]);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ lineNum: i + 1, indent, text: noComment.trim() });
  }

  if (lines.length === 0) {
    return {
      ok: false,
      error: 'プログラムが空です。',
      blockCount: 0,
      maxBlocks,
      suggestedSize: 4,
    };
  }

  let cursor = 0;
  let parsedTankName: string | undefined;
  let parsedAuthorName: string | undefined;
  let parsedAuthorUuid: string | undefined;
  let parsedGameVersion: string | undefined;
  let parsedChassisId: ChassisId | undefined;
  let parsedRadarId: RadarId | undefined;
  let parsedMainGunId: MainGunId | undefined;
  let parsedSubWeaponId: SubWeaponId | undefined;
  const warnings: string[] = [];

  while (cursor < lines.length && lines[cursor].indent === 0) {
    const t = lines[cursor].text;
    if (/^import\s+(time|random)(\s*,\s*(time|random))*$/.test(t)) {
      cursor += 1;
      continue;
    }
    const nameMatch = t.match(/^tank_name\s*=\s*(?:"([^"]*)"|'([^']*)')$/);
    if (nameMatch) {
      const rawName = nameMatch[1] ?? nameMatch[2] ?? '';
      const cleanName = sanitizeTankName(rawName, '');
      if (cleanName) {
        parsedTankName = cleanName;
      }
      cursor += 1;
      continue;
    }
    const authorMatch = t.match(/^author_name\s*=\s*(?:"([^"]*)"|'([^']*)')$/);
    if (authorMatch) {
      const rawAuthor = authorMatch[1] ?? authorMatch[2] ?? '';
      const cleanAuthor = sanitizeAuthorName(rawAuthor, '');
      if (cleanAuthor) {
        parsedAuthorName = cleanAuthor;
      }
      cursor += 1;
      continue;
    }
    const uuidMatch = t.match(/^author_uuid\s*=\s*(?:"([^"]*)"|'([^']*)')$/);
    if (uuidMatch) {
      const rawUuid = uuidMatch[1] ?? uuidMatch[2] ?? '';
      const cleanUuid = sanitizeAuthorUuid(rawUuid, '');
      if (cleanUuid) {
        parsedAuthorUuid = cleanUuid;
      }
      cursor += 1;
      continue;
    }
    const gameVerMatch = t.match(/^game_version\s*=\s*(?:"([^"]*)"|'([^']*)')$/);
    if (gameVerMatch) {
      const rawVer = gameVerMatch[1] ?? gameVerMatch[2] ?? '';
      const cleanVer = sanitizeGameVersion(rawVer, '');
      if (cleanVer) {
        parsedGameVersion = cleanVer;
        if (isNewerGameVersion(cleanVer)) {
          warnings.push(
            `このコードは現在のバージョン (v${CURRENT_GAME_VERSION}) より新しいバージョン (v${cleanVer}) で作成されています。`
          );
        }
      }
      cursor += 1;
      continue;
    }
    if (/^chassis(?:\s*|_spec\s*)=/.test(t)) {
      const chRes = parseAndValidateChassisLine(t);
      parsedChassisId = chRes.id;
      if (chRes.warning) warnings.push(`${lines[cursor].lineNum}行目: ${chRes.warning}`);
      cursor += 1;
      continue;
    }
    if (/^radar(?:\s*|_spec\s*|_fov\s*|_range\s*)=/.test(t)) {
      const radarRes = parseAndValidateRadarLine(t);
      parsedRadarId = radarRes.id;
      if (radarRes.warning) warnings.push(`${lines[cursor].lineNum}行目: ${radarRes.warning}`);
      cursor += 1;
      continue;
    }
    if (/^main_gun(?:\s*|_spec\s*)=/.test(t)) {
      const gunRes = parseAndValidateMainGunLine(t);
      parsedMainGunId = gunRes.id;
      if (gunRes.warning) warnings.push(`${lines[cursor].lineNum}行目: ${gunRes.warning}`);
      cursor += 1;
      continue;
    }
    if (/^(?:special|sub_weapon)(?:\s*|_spec\s*)=/.test(t)) {
      const subRes = parseAndValidateSubWeaponLine(t);
      parsedSubWeaponId = subRes.id;
      if (subRes.warning) warnings.push(`${lines[cursor].lineNum}行目: ${subRes.warning}`);
      cursor += 1;
      continue;
    }
    if (/^color\s*=/.test(t)) {
      // Backward compatibility: colors are assigned automatically per battle participant
      cursor += 1;
      continue;
    }
    if (/^def\s+(?:on_tick|sub_[a-dA-D])\(\)\s*:$/i.test(t)) {
      break;
    }
    break;
  }

  let seqId = 1;
  const allNodes: ParsedStatement[] = [];
  const startNode: ParsedStatement = { id: seqId++, type: 'start', params: {} };
  allNodes.push(startNode);

  const parseBlock = (minIndent: number): { stmts: ParsedStatement[]; error?: string } => {
    const stmts: ParsedStatement[] = [];
    let pendingPrint = false;
    const attachPendingPrint = (node: ParsedStatement) => {
      if (pendingPrint) {
        node.params = { ...node.params, _print: 1 };
        pendingPrint = false;
      }
    };
    while (cursor < lines.length) {
      const cur = lines[cursor];
      if (cur.indent < minIndent) break;

      if (cur.text === 'continue') {
        cursor += 1;
        continue;
      }

      if (cur.text === 'else:') {
        break;
      }

      if (/^print\(.*\)$/.test(cur.text)) {
        pendingPrint = true;
        cursor += 1;
        continue;
      }

      if (/^while\s+(.+):$/.test(cur.text)) {
        const m = cur.text.match(/^while\s+(.+):$/);
        const condParams = parseWhileCondition(m?.[1] ?? '');
        if (!condParams) {
          return {
            stmts,
            error: `${cur.lineNum}行目: while 条件式 "${m?.[1]}" を解釈できませんでした。`,
          };
        }
        cursor += 1;
        const bodyRes = parseBlock(cur.indent + 1);
        if (bodyRes.error) return bodyRes;
        const node: ParsedStatement = {
          id: seqId++,
          type: 'loop_while',
          params: condParams,
          yesBody: bodyRes.stmts,
          noBody: [],
        };
        attachPendingPrint(node);
        allNodes.push(node);
        stmts.push(node);
        continue;
      }

      if (/^for\s+\w+\s+in\s+range\((\d+)\)\s*:$/.test(cur.text)) {
        const m = cur.text.match(/^for\s+\w+\s+in\s+range\((\d+)\)\s*:$/);
        const iterations = Math.max(1, Number(m?.[1] ?? 15));
        cursor += 1;
        const bodyRes = parseBlock(cur.indent + 1);
        if (bodyRes.error) return bodyRes;
        const node: ParsedStatement = {
          id: seqId++,
          type: 'loop_for',
          params: { iterations },
          yesBody: bodyRes.stmts,
          noBody: [],
        };
        attachPendingPrint(node);
        allNodes.push(node);
        stmts.push(node);
        continue;
      }

      if (/^if\s+(.+):$/.test(cur.text)) {
        const m = cur.text.match(/^if\s+(.+):$/);
        const condParsed = parseConditionLine(m?.[1] ?? '');
        if (!condParsed) {
          return {
            stmts,
            error: `${cur.lineNum}行目: if 条件式 "${m?.[1]}" を解釈できませんでした。`,
          };
        }
        cursor += 1;
        const yesRes = parseBlock(cur.indent + 1);
        if (yesRes.error) return yesRes;

        let noStmts: ParsedStatement[] = [];
        if (
          cursor < lines.length &&
          lines[cursor].indent === cur.indent &&
          lines[cursor].text === 'else:'
        ) {
          cursor += 1;
          const noRes = parseBlock(cur.indent + 1);
          if (noRes.error) return noRes;
          noStmts = noRes.stmts;
        }

        const node: ParsedStatement = {
          id: seqId++,
          type: condParsed.type,
          params: condParsed.params,
          yesBody: yesRes.stmts,
          noBody: noStmts,
        };
        attachPendingPrint(node);
        allNodes.push(node);
        stmts.push(node);
        continue;
      }

      const act = parseActionLine(cur.text);
      if (!act) {
        return {
          stmts,
          error: `${cur.lineNum}行目: 命令 "${cur.text}" を認識できませんでした。`,
        };
      }
      if (act.type === 'act_fire') {
        const parsedTier = tryParseFirePowerInput(
          act.params.power,
          parsedMainGunId ?? STANDARD_SETUP.mainGun
        );
        if (!parsedTier) {
          return {
            stmts,
            error: `${cur.lineNum}行目: 不正なプログラムです。fire_main の火力 (power=${act.params.power}) は "fast"（速弱）/ "normal"（標準）/ "heavy"（遅強）のいずれかで指定してください。`,
          };
        }
        act.params.power = parsedTier;
      }
      cursor += 1;
      const node: ParsedStatement = {
        id: seqId++,
        type: act.type,
        params: act.params,
      };
      attachPendingPrint(node);
      allNodes.push(node);
      stmts.push(node);
    }
    if (pendingPrint && stmts.length > 0) {
      const last = stmts[stmts.length - 1];
      last.params = { ...last.params, _print: 1 };
    }
    return { stmts };
  };

  const subFuncs: Array<{ defNode: ParsedStatement; body: ParsedStatement[] }> = [];
  let mainStmts: ParsedStatement[] = [];
  let parseError: string | undefined;

  while (cursor < lines.length && !parseError) {
    const cur = lines[cursor];
    const subDefMatch =
      cur.indent === 0 ? cur.text.match(/^def\s+sub_([a-dA-D])\(\)\s*:$/i) : null;
    if (subDefMatch) {
      const subKey = subDefMatch[1].toUpperCase();
      cursor += 1;
      const bodyIndent = cursor < lines.length ? lines[cursor].indent : 0;
      let bodyStmts: ParsedStatement[] = [];
      if (cursor < lines.length && bodyIndent > 0) {
        const res = parseBlock(bodyIndent);
        if (res.error) {
          parseError = res.error;
          break;
        }
        bodyStmts = res.stmts;
      }
      const defNode: ParsedStatement = {
        id: seqId++,
        type: 'sub_def',
        params: { sub: subKey },
      };
      allNodes.push(defNode);
      subFuncs.push({ defNode, body: bodyStmts });
      continue;
    }

    if (cur.indent === 0 && /^def\s+on_tick\(\)\s*:$/.test(cur.text)) {
      cursor += 1;
      const bodyIndent = cursor < lines.length ? lines[cursor].indent : 0;
      if (cursor < lines.length && bodyIndent > 0) {
        const res = parseBlock(bodyIndent);
        if (res.error) {
          parseError = res.error;
          break;
        }
        mainStmts = [...mainStmts, ...res.stmts];
      }
      continue;
    }

    const res = parseBlock(cur.indent);
    if (res.error) {
      parseError = res.error;
      break;
    }
    mainStmts = [...mainStmts, ...res.stmts];
    if (res.stmts.length === 0) break;
  }

  if (parseError) {
    return {
      ok: false,
      error: parseError,
      blockCount: allNodes.length,
      maxBlocks,
      suggestedSize: suggestRequiredGridSize(allNodes.length),
    };
  }

  const blockCount = allNodes.length;
  const suggestedSize = suggestRequiredGridSize(blockCount);

  if (blockCount > maxBlocks) {
    return {
      ok: false,
      blockCount,
      maxBlocks,
      suggestedSize,
      error: `ソースに必要なブロック数 (${blockCount}) が、現在の ${targetSize}×${targetSize} グリッドの上限 (${maxBlocks} ブロック) に適合しません。${
        suggestedSize
          ? `${suggestedSize}×${suggestedSize} に変更するか処理を簡略化してください。`
          : '最大 12×12 (144 ブロック) 以内に収めてください。'
      }`,
    };
  }

  // Wire AST nodes linearly / recursively
  const wireList = (list: ParsedStatement[], continuationId: number | null) => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const nextNodeId = i + 1 < list.length ? list[i + 1].id : continuationId;
      const def = CHIP_DEFINITIONS[node.type];
      if (def.isCondition) {
        if (node.type === 'loop_while' || node.type === 'loop_for') {
          if (node.yesBody && node.yesBody.length > 0) {
            node.yesId = node.yesBody[0].id;
            wireList(node.yesBody, null);
          }
          node.noId = nextNodeId;
        } else {
          if (node.yesBody && node.yesBody.length > 0) {
            node.yesId = node.yesBody[0].id;
            wireList(node.yesBody, nextNodeId);
          } else {
            node.yesId = nextNodeId;
          }
          if (node.noBody && node.noBody.length > 0) {
            node.noId = node.noBody[0].id;
            wireList(node.noBody, nextNodeId);
          } else {
            node.noId = nextNodeId;
          }
        }
      } else {
        node.nextId = node.type === 'act_halt' ? null : nextNodeId;
      }
    }
  };

  if (mainStmts.length > 0) {
    startNode.nextId = mainStmts[0].id;
    wireList(mainStmts, null);
  }
  for (const sf of subFuncs) {
    if (sf.body.length > 0) {
      sf.defNode.nextId = sf.body[0].id;
      wireList(sf.body, null);
    }
  }

  // Assign clean orthogonal (4-direction adjacent) coordinates on targetSize x targetSize grid
  const cells = createEmptyCells(targetSize);
  const coordMap = new Map<number, GridCoord>();
  const placedSet = new Set<number>();
  const nodeByCoord = new Map<string, ParsedStatement>();

  const ORTHO_DIRS: GridCoord[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];

  const inBounds = (x: number, y: number): boolean =>
    x >= 0 && x < targetSize && y >= 0 && y < targetSize;

  const isCellFree = (x: number, y: number): boolean =>
    inBounds(x, y) && cells[y][x] === null;

  const countFreeOrthoNeighbors = (x: number, y: number): number => {
    let count = 0;
    for (const d of ORTHO_DIRS) {
      if (isCellFree(x + d.x, y + d.y)) count++;
    }
    return count;
  };

  const countSubtree = (list?: ParsedStatement[]): number => {
    if (!list || list.length === 0) return 0;
    let total = 0;
    for (const st of list) {
      total += 1 + countSubtree(st.yesBody) + countSubtree(st.noBody);
    }
    return total;
  };

  const countUnplacedOutLinks = (st: ParsedStatement): number => {
    let need = 0;
    if (st.nextId && !placedSet.has(st.nextId)) need++;
    if (st.yesId && !placedSet.has(st.yesId)) need++;
    if (st.noId && !placedSet.has(st.noId)) need++;
    return need;
  };

  const countStarvedNeighbors = (cx: number, cy: number, ownerAnchor: GridCoord | null): number => {
    let starved = 0;
    for (const d of ORTHO_DIRS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (ownerAnchor && nx === ownerAnchor.x && ny === ownerAnchor.y) continue;
      const neighborNode = nodeByCoord.get(`${nx},${ny}`);
      if (!neighborNode) continue;
      const needed = countUnplacedOutLinks(neighborNode);
      if (needed > 0 && countFreeOrthoNeighbors(nx, ny) - 1 < needed) {
        starved += 1;
      }
    }
    return starved;
  };

  const placeSingle = (node: ParsedStatement, c: GridCoord) => {
    if (placedSet.has(node.id)) return;
    placedSet.add(node.id);
    coordMap.set(node.id, c);
    nodeByCoord.set(`${c.x},${c.y}`, node);
    cells[c.y][c.x] = makeCell(`src_${node.id}_${c.x}_${c.y}`, node.type, node.params);
  };

  const isDiamondCandidate = (
    node: ParsedStatement,
    continuationNode: ParsedStatement | null
  ): boolean => {
    const def = CHIP_DEFINITIONS[node.type];
    if (!def.isCondition || node.type === 'loop_while' || node.type === 'loop_for') {
      return false;
    }
    return Boolean(
      continuationNode &&
        !placedSet.has(continuationNode.id) &&
        node.yesBody?.length === 1 &&
        node.noBody?.length === 1 &&
        !(node.yesBody[0].yesBody?.length || node.yesBody[0].noBody?.length) &&
        !(node.noBody[0].yesBody?.length || node.noBody[0].noBody?.length)
    );
  };

  const findDiamondsAt = (
    cx: number,
    cy: number
  ): Array<{ yPos: GridCoord; nPos: GridCoord; jPos: GridCoord; score: number }> => {
    const perpPairs: Array<[GridCoord, GridCoord]> = [
      [{ x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: -1, y: 0 }, { x: 0, y: 1 }],
      [{ x: 1, y: 0 }, { x: 0, y: -1 }],
      [{ x: -1, y: 0 }, { x: 0, y: -1 }],
    ];
    const results: Array<{ yPos: GridCoord; nPos: GridCoord; jPos: GridCoord; score: number }> = [];
    for (const [d1, d2] of perpPairs) {
      for (const [dy, dn] of [
        [d1, d2],
        [d2, d1],
      ] as Array<[GridCoord, GridCoord]>) {
        const yPos = { x: cx + dy.x, y: cy + dy.y };
        const nPos = { x: cx + dn.x, y: cy + dn.y };
        const jPos = { x: cx + d1.x + d2.x, y: cy + d1.y + d2.y };
        if (isCellFree(yPos.x, yPos.y) && isCellFree(nPos.x, nPos.y) && isCellFree(jPos.x, jPos.y)) {
          // Boundary-hugging Warnsdorff score: lower remaining open neighbors on yPos/nPos is preferred
          const exitFree = countFreeOrthoNeighbors(jPos.x, jPos.y);
          const branchOpen =
            countFreeOrthoNeighbors(yPos.x, yPos.y) + countFreeOrthoNeighbors(nPos.x, nPos.y);
          const score = branchOpen - (exitFree > 0 ? 0.5 : -5);
          results.push({ yPos, nPos, jPos, score });
        }
      }
    }
    results.sort((a, b) => a.score - b.score);
    return results;
  };

  const claimBestFreeCoord = (
    anchor: GridCoord | null,
    needRemainingAfter: number,
    requireDiamond: boolean,
    minFreeNeighbors = 0
  ): GridCoord => {
    if (anchor) {
      const candidates = ORTHO_DIRS.map((d, dirIdx) => ({
        x: anchor.x + d.x,
        y: anchor.y + d.y,
        dirIdx,
      })).filter((c) => isCellFree(c.x, c.y));

      if (candidates.length > 0) {
        const minNeeded = Math.max(needRemainingAfter > 0 ? 1 : 0, minFreeNeighbors);
        const scored = candidates.map((c) => {
          const freeAfter = countFreeOrthoNeighbors(c.x, c.y);
          const hasDiamond = requireDiamond ? findDiamondsAt(c.x, c.y).length > 0 : true;
          const isDeadEnd = freeAfter < minNeeded;
          const starved = countStarvedNeighbors(c.x, c.y, anchor);
          return { ...c, freeAfter, hasDiamond, isDeadEnd, starved };
        });

        scored.sort((a, b) => {
          if (a.hasDiamond !== b.hasDiamond) return a.hasDiamond ? -1 : 1;
          if (a.isDeadEnd !== b.isDeadEnd) return a.isDeadEnd ? 1 : -1;
          if (a.starved !== b.starved) return a.starved - b.starved;
          if (a.freeAfter !== b.freeAfter) return a.freeAfter - b.freeAfter;
          return a.dirIdx - b.dirIdx;
        });

        return { x: scored[0].x, y: scored[0].y };
      }

      // Fallback to nearest free cell on grid if orthogonally pinched
      let best: GridCoord | null = null;
      let bestDist = Infinity;
      for (let y = 0; y < targetSize; y++) {
        for (let x = 0; x < targetSize; x++) {
          if (!isCellFree(x, y)) continue;
          const dist = Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
          if (dist < bestDist) {
            bestDist = dist;
            best = { x, y };
          }
        }
      }
      if (best) return best;
    }

    for (let y = 0; y < targetSize; y++) {
      for (let x = 0; x < targetSize; x++) {
        if (isCellFree(x, y)) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  };

  const layoutSeq = (list: ParsedStatement[], startAnchor: GridCoord | null) => {
    let anchor = startAnchor;
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const nextSibling = i + 1 < list.length ? list[i + 1] : null;
      const diamond = isDiamondCandidate(node, nextSibling);
      const remainingAfter = list.length - 1 - i + countSubtree(node.yesBody) + countSubtree(node.noBody);

      if (!placedSet.has(node.id)) {
        const c = claimBestFreeCoord(anchor, remainingAfter, diamond, countUnplacedOutLinks(node));
        placeSingle(node, c);
      }
      const c = coordMap.get(node.id)!;

      // Try 2x2 diamond layout if node has 1-block yes & no converging on nextSibling
      if (diamond && nextSibling && node.yesBody && node.noBody) {
        const diamonds = findDiamondsAt(c.x, c.y);
        if (diamonds.length > 0) {
          const d = diamonds[0];
          placeSingle(node.yesBody[0], d.yPos);
          placeSingle(node.noBody[0], d.nPos);
          placeSingle(nextSibling, d.jPos);
          anchor = d.jPos;
          continue;
        }
      }

      const def = CHIP_DEFINITIONS[node.type];
      if (def.isCondition) {
        const hasYes = Boolean(node.yesBody && node.yesBody.length > 0);
        const hasNo = Boolean(node.noBody && node.noBody.length > 0);

        if (hasYes && hasNo && node.yesBody && node.noBody) {
          // Pre-claim both branch heads orthogonally adjacent to condition cell when possible
          const yesHead = node.yesBody[0];
          const noHead = node.noBody[0];
          if (!placedSet.has(yesHead.id)) {
            const yc = claimBestFreeCoord(
              c,
              Math.max(0, countSubtree(node.yesBody) - 1),
              false,
              countUnplacedOutLinks(yesHead)
            );
            placeSingle(yesHead, yc);
          }
          if (!placedSet.has(noHead.id)) {
            const nc = claimBestFreeCoord(
              c,
              Math.max(0, countSubtree(node.noBody) - 1),
              false,
              countUnplacedOutLinks(noHead)
            );
            placeSingle(noHead, nc);
          }

          // Expand smaller branch first so it stays compact and leaves room for the larger branch
          const yesSize = countSubtree(node.yesBody);
          const noSize = countSubtree(node.noBody);
          if (noSize <= yesSize) {
            layoutSeq(node.noBody, coordMap.get(noHead.id) ?? c);
            layoutSeq(node.yesBody, coordMap.get(yesHead.id) ?? c);
          } else {
            layoutSeq(node.yesBody, coordMap.get(yesHead.id) ?? c);
            layoutSeq(node.noBody, coordMap.get(noHead.id) ?? c);
          }
        } else if (hasYes && node.yesBody) {
          layoutSeq(node.yesBody, c);
        } else if (hasNo && node.noBody) {
          layoutSeq(node.noBody, c);
        }
      }

      anchor = coordMap.get(node.id) ?? c;
    }
  };

  placeSingle(startNode, { x: 0, y: 0 });
  layoutSeq(mainStmts, { x: 0, y: 0 });

  const findSubDefStart = (needBody: boolean): GridCoord => {
    // Prefer lower rows (away from on_tick at row 0) where a clean row segment is open
    for (let y = targetSize - 1; y >= 0; y--) {
      for (let x = 0; x < targetSize; x++) {
        if (!isCellFree(x, y)) continue;
        if (!needBody || countFreeOrthoNeighbors(x, y) >= 1) {
          return { x, y };
        }
      }
    }
    return claimBestFreeCoord(null, 0, false);
  };

  for (const sf of subFuncs) {
    const startSubCoord = findSubDefStart(sf.body.length > 0);
    placeSingle(sf.defNode, startSubCoord);
    if (sf.body.length > 0) {
      layoutSeq(sf.body, startSubCoord);
    }
  }

  // Fill links from coordMap
  for (const node of allNodes) {
    const c = coordMap.get(node.id);
    if (!c) continue;
    const cell = cells[c.y][c.x];
    if (!cell) continue;
    if (node.nextId) cell.next = coordMap.get(node.nextId) ?? null;
    if (node.yesId) cell.yes = coordMap.get(node.yesId) ?? null;
    if (node.noId) cell.no = coordMap.get(node.noId) ?? null;
  }

  // Bridge any non-orthogonal (jump/diagonal) links using shortest free-cell BFS with wire cells
  const findFreeBridgePath = (from: GridCoord, to: GridCoord): GridCoord[] | null => {
    const queue: GridCoord[] = [];
    const parent = new Map<string, GridCoord | null>();
    for (const d of ORTHO_DIRS) {
      const nx = from.x + d.x;
      const ny = from.y + d.y;
      if (nx === to.x && ny === to.y) return [];
      if (!isCellFree(nx, ny)) continue;
      const key = `${nx},${ny}`;
      parent.set(key, null);
      queue.push({ x: nx, y: ny });
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (Math.abs(to.x - cur.x) + Math.abs(to.y - cur.y) === 1) {
        const path: GridCoord[] = [];
        let trace: GridCoord | null = cur;
        while (trace) {
          path.unshift(trace);
          trace = parent.get(`${trace.x},${trace.y}`) ?? null;
        }
        return path;
      }
      for (const d of ORTHO_DIRS) {
        const nx = cur.x + d.x;
        const ny = cur.y + d.y;
        if (!isCellFree(nx, ny)) continue;
        const key = `${nx},${ny}`;
        if (parent.has(key)) continue;
        parent.set(key, cur);
        queue.push({ x: nx, y: ny });
      }
    }
    return null;
  };

  let bridgedWireCount = 0;
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const cell = cells[y][x];
      if (!cell || cell.id.startsWith('wire_bridge_')) continue;
      for (const branchKey of ['next', 'yes', 'no'] as const) {
        const target = cell[branchKey];
        if (!target) continue;
        const manhattan = Math.abs(target.x - x) + Math.abs(target.y - y);
        if (manhattan <= 1) continue;
        const bridgePath = findFreeBridgePath({ x, y }, target);
        if (bridgePath && bridgePath.length > 0) {
          cell[branchKey] = { ...bridgePath[0] };
          for (let i = 0; i < bridgePath.length; i++) {
            const p = bridgePath[i];
            const nextPt = i + 1 < bridgePath.length ? { ...bridgePath[i + 1] } : { ...target };
            cells[p.y][p.x] = makeCell(
              `wire_bridge_${x}_${y}_${branchKey}_${i}`,
              'wire',
              { seconds: 0 },
              { next: nextPt }
            );
            bridgedWireCount++;
          }
        } else if (!bridgePath) {
          warnings.push(
            `座標 (${x},${y})→(${target.x},${target.y}) が隣接していないため破線接続になりました（実行時はスキップされます）。`
          );
        }
      }
    }
  }

  return {
    ok: true,
    program: {
      gridSize: targetSize,
      coordinateMode,
      cells,
    },
    tankName: parsedTankName,
    authorName: parsedAuthorName,
    authorUuid: parsedAuthorUuid,
    gameVersion: parsedGameVersion,
    chassisId: parsedChassisId,
    radarId: parsedRadarId,
    mainGunId: parsedMainGunId,
    subWeaponId: parsedSubWeaponId,
    warnings: warnings.length > 0 ? warnings : undefined,
    blockCount: blockCount + bridgedWireCount,
    maxBlocks,
  };
}

export function parsePythonSourceWithAutoSize(
  source: string,
  preferredSize: GridSize,
  coordinateMode: CoordinateMode,
  maxAllowedSize: GridSize = 12
): ParsePythonResult {
  const first = parsePythonSourceToProgram(source, preferredSize, coordinateMode);
  if (first.ok) return first;
  if (first.suggestedSize && first.suggestedSize > preferredSize) {
    for (const candidate of ALLOWED_GRID_SIZES) {
      if (candidate < first.suggestedSize || candidate <= preferredSize) continue;
      if (candidate > maxAllowedSize) break;
      const retry = parsePythonSourceToProgram(source, candidate, coordinateMode);
      if (retry.ok) {
        const sizeNote = `ブロック数 (${retry.blockCount}) に合わせて CPU を ${preferredSize}×${preferredSize} → ${candidate}×${candidate} に自動拡張しました。`;
        return {
          ...retry,
          warnings: retry.warnings ? [sizeNote, ...retry.warnings] : [sizeNote],
        };
      }
    }
  }
  return first;
}

