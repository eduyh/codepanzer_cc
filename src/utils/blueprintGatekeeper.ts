import { CHIP_DEFINITIONS } from '../data/chips';
import {
  CHASSIS_SPECS,
  CPU_SPECS,
  cpuIdForGridSize,
  FIRE_POWER_TIERS,
  MAIN_GUN_SPECS,
  RADAR_SPECS,
  SUB_WEAPON_SPECS,
  tryParseFirePowerInput,
} from '../data/parts';
import { clamp } from '../engine/math';
import {
  ChassisId,
  ChipType,
  CpuId,
  GridCell,
  GridSize,
  MainGunId,
  RadarId,
  SubWeaponId,
  TankBlueprint,
} from '../types/game';
import {
  CURRENT_BLUEPRINT_VERSION,
  CURRENT_GAME_VERSION,
  isNewerGameVersion,
  sanitizeGameVersion,
} from './codeParser';

export interface GatekeeperResult {
  blueprint: TankBlueprint;
  fixes: string[];
  isValid: boolean;
}

const VALID_GRID_SIZES: GridSize[] = [4, 6, 8, 12];

function normalizeGridSize(raw: unknown): GridSize {
  const n = Number(raw);
  if (VALID_GRID_SIZES.includes(n as GridSize)) return n as GridSize;
  return 6;
}

function migrateDeprecatedCell(cell: GridCell, x: number, y: number, fixes: string[]): GridCell {
  if (cell.type === 'cond_wall_ahead') {
    const dir = String(cell.params?.direction ?? 'front');
    const rawDist = Number(cell.params?.dist ?? 90);
    const dist = clamp(Number.isFinite(rawDist) ? rawDist : 90, 20, 300);
    const mode = dir === 'left_closer' ? 'left_closer' : 'approaching';
    const nextParams: Record<string, string | number> = {
      mode,
      target: 'all',
      dist,
    };
    if (cell.params?._print !== undefined) {
      nextParams._print = cell.params._print;
    }
    fixes.push(`(${x},${y}) cond_wall_ahead -> cond_proximity`);
    return {
      ...cell,
      type: 'cond_proximity',
      params: nextParams,
    };
  }
  return cell;
}

/**
 * Validates a TankBlueprint against current part and chip specifications,
 * automatically repairing out-of-range parameters, invalid options,
 * assembly mismatches, and deprecated chips.
 */
export function validateAndRepairBlueprint(input: TankBlueprint): GatekeeperResult {
  const bp: TankBlueprint = JSON.parse(JSON.stringify(input)) as TankBlueprint;
  const fixes: string[] = [];

  // 0. Schema & game version check / migration
  const rawSchemaVersion = Number(bp.version ?? CURRENT_BLUEPRINT_VERSION);
  if (!Number.isFinite(rawSchemaVersion) || rawSchemaVersion < 1) {
    fixes.push(`schema version "${String(bp.version)}" -> v${CURRENT_BLUEPRINT_VERSION}`);
  } else if (rawSchemaVersion > CURRENT_BLUEPRINT_VERSION) {
    fixes.push(
      `データ形式バージョン (v${rawSchemaVersion}) が現在のバージョン (v${CURRENT_BLUEPRINT_VERSION}) より新しいため互換モードで読み込みました`
    );
  }
  bp.version = CURRENT_BLUEPRINT_VERSION;

  if (bp.gameVersion !== undefined) {
    const cleanGv = sanitizeGameVersion(bp.gameVersion, '');
    if (!cleanGv) {
      fixes.push(`gameVersion "${String(bp.gameVersion)}" -> "${CURRENT_GAME_VERSION}"`);
      bp.gameVersion = CURRENT_GAME_VERSION;
    } else {
      if (isNewerGameVersion(cleanGv, CURRENT_GAME_VERSION)) {
        fixes.push(
          `現在のバージョン (v${CURRENT_GAME_VERSION}) より新しいバージョン (v${cleanGv}) で作成された機体データです`
        );
      }
      bp.gameVersion = cleanGv;
    }
  }

  // 1. Assembly validation & repair
  const assembly = bp.assembly ?? {
    chassis: 'standard',
    mainGun: 'standard',
    radar: 'balanced',
    cpu: 'compact_6x6',
    subWeapon: 'none',
  };

  if (!CHASSIS_SPECS[assembly.chassis as ChassisId]) {
    fixes.push(`chassis "${String(assembly.chassis)}" -> "standard"`);
    assembly.chassis = 'standard';
  }
  if (!MAIN_GUN_SPECS[assembly.mainGun as MainGunId]) {
    fixes.push(`mainGun "${String(assembly.mainGun)}" -> "standard"`);
    assembly.mainGun = 'standard';
  }
  if (!RADAR_SPECS[assembly.radar as RadarId]) {
    fixes.push(`radar "${String(assembly.radar)}" -> "balanced"`);
    assembly.radar = 'balanced';
  }
  if (!SUB_WEAPON_SPECS[assembly.subWeapon as SubWeaponId]) {
    fixes.push(`subWeapon "${String(assembly.subWeapon)}" -> "none"`);
    assembly.subWeapon = 'none';
  }

  const gridSize = normalizeGridSize(bp.program?.gridSize);
  const expectedCpu = cpuIdForGridSize(gridSize);
  if (!CPU_SPECS[assembly.cpu as CpuId] || assembly.cpu !== expectedCpu) {
    fixes.push(`cpu "${String(assembly.cpu)}" -> "${expectedCpu}"`);
    assembly.cpu = expectedCpu;
  }
  bp.assembly = assembly;

  if (!/^#[0-9a-f]{6}$/i.test(String(bp.color ?? ''))) {
    fixes.push(`color "${String(bp.color)}" -> "#06b6d4"`);
    bp.color = '#06b6d4';
  }

  const isFixedTurret = Boolean(CHASSIS_SPECS[assembly.chassis]?.fixedTurret);

  // 2. Program & chip parameter validation & repair
  if (bp.program && Array.isArray(bp.program.cells)) {
    bp.program.gridSize = gridSize;
    if (bp.program.coordinateMode !== 'relative' && bp.program.coordinateMode !== 'absolute') {
      fixes.push(`coordinateMode "${String(bp.program.coordinateMode)}" -> "relative"`);
      bp.program.coordinateMode = 'relative';
    }

    for (let y = 0; y < bp.program.cells.length; y++) {
      const row = bp.program.cells[y];
      if (!Array.isArray(row)) continue;
      for (let x = 0; x < row.length; x++) {
        const rawCell = row[x];
        if (!rawCell) continue;

        let cell = migrateDeprecatedCell(rawCell, x, y, fixes);
        if (isFixedTurret && (cell.type === 'act_turn_turret' || cell.type === 'act_aim_enemy')) {
          fixes.push(`(${x},${y}) ${cell.type} disabled on fixedTurret chassis -> "wire"`);
          cell = {
            ...cell,
            type: 'wire',
            params: {},
          };
          row[x] = cell;
          continue;
        }
        const def = CHIP_DEFINITIONS[cell.type as ChipType];
        if (!def) {
          fixes.push(`(${x},${y}) unknown chip "${String(cell.type)}" -> "wire"`);
          cell = {
            ...cell,
            type: 'wire',
            params: {},
          };
          row[x] = cell;
          continue;
        }

        const repairedParams: Record<string, string | number> = {};
        const srcParams = cell.params ?? {};

        for (const schema of def.paramSchema) {
          const fallback = def.defaultParams[schema.key];
          const rawVal = srcParams[schema.key];

          if (schema.type === 'number') {
            const num = rawVal === undefined ? Number(fallback ?? 0) : Number(rawVal);
            let nextNum = Number.isFinite(num) ? num : Number(fallback ?? 0);
            if (!Number.isFinite(num)) {
              fixes.push(`(${x},${y}) ${cell.type}.${schema.key} invalid -> ${nextNum}`);
            }

            const minBound = schema.min;
            const maxBound = schema.max;

            if (minBound !== undefined && nextNum < minBound) {
              fixes.push(`(${x},${y}) ${cell.type}.${schema.key} ${nextNum} -> ${minBound}`);
              nextNum = minBound;
            } else if (maxBound !== undefined && nextNum > maxBound) {
              fixes.push(`(${x},${y}) ${cell.type}.${schema.key} ${nextNum} -> ${maxBound}`);
              nextNum = maxBound;
            }
            repairedParams[schema.key] = nextNum;
          } else if (schema.type === 'select') {
            if (cell.type === 'act_fire' && schema.key === 'power') {
              const rawTier = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
              if (
                typeof rawTier === 'string' &&
                (FIRE_POWER_TIERS as readonly string[]).includes(rawTier)
              ) {
                repairedParams[schema.key] = rawTier;
              } else if (rawVal === undefined) {
                const fbTier = String(fallback ?? 'normal');
                fixes.push(`(${x},${y}) ${cell.type}.${schema.key} missing -> "${fbTier}"`);
                repairedParams[schema.key] = fbTier;
              } else {
                const mappedTier = tryParseFirePowerInput(rawVal, assembly.mainGun);
                const nextTier = mappedTier ?? 'normal';
                fixes.push(
                  `(${x},${y}) ${cell.type}.${schema.key} "${String(rawVal)}" -> "${nextTier}"`
                );
                repairedParams[schema.key] = nextTier;
              }
              continue;
            }
            const options = schema.options ?? [];
            const validValues = options.map((opt) => opt.value);
            const isNumericSelect =
              validValues.length > 0 && validValues.every((v) => typeof v === 'number');
            if (isNumericSelect) {
              const numVal =
                rawVal === undefined ? Number(fallback ?? validValues[0]) : Number(rawVal);
              if (Number.isFinite(numVal) && validValues.includes(numVal)) {
                repairedParams[schema.key] = numVal;
              } else {
                const fbNum = Number(fallback ?? validValues[0]);
                fixes.push(
                  `(${x},${y}) ${cell.type}.${schema.key} "${String(rawVal)}" -> ${fbNum}`
                );
                repairedParams[schema.key] = fbNum;
              }
            } else {
              const str = rawVal === undefined ? String(fallback ?? '') : String(rawVal);
              if (validValues.length > 0 && !validValues.includes(str)) {
                const fbStr = String(fallback ?? validValues[0]);
                fixes.push(`(${x},${y}) ${cell.type}.${schema.key} "${str}" -> "${fbStr}"`);
                repairedParams[schema.key] = fbStr;
              } else {
                repairedParams[schema.key] = str;
              }
            }
          } else if (schema.type === 'boolean') {
            const fbBool = Number(fallback ?? 0) === 1 ? 1 : 0;
            if (rawVal === undefined) {
              repairedParams[schema.key] = fbBool;
            } else if (typeof rawVal === 'boolean') {
              repairedParams[schema.key] = rawVal ? 1 : 0;
            } else if (typeof rawVal === 'number') {
              if (rawVal === 0 || rawVal === 1) {
                repairedParams[schema.key] = rawVal;
              } else {
                fixes.push(
                  `(${x},${y}) ${cell.type}.${schema.key} ${String(rawVal)} -> ${fbBool}`
                );
                repairedParams[schema.key] = fbBool;
              }
            } else {
              const lower = String(rawVal).trim().toLowerCase();
              if (lower === 'true' || lower === '1') {
                repairedParams[schema.key] = 1;
              } else if (lower === 'false' || lower === '0') {
                repairedParams[schema.key] = 0;
              } else {
                fixes.push(
                  `(${x},${y}) ${cell.type}.${schema.key} "${String(rawVal)}" -> ${fbBool}`
                );
                repairedParams[schema.key] = fbBool;
              }
            }
          }
        }

        if (srcParams._print !== undefined && Number(srcParams._print) === 1) {
          repairedParams._print = 1;
        }

        cell.params = repairedParams;
        row[x] = cell;
      }
    }
  }

  return {
    blueprint: bp,
    fixes,
    isValid: fixes.length === 0,
  };
}
