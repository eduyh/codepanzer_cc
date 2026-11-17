import { CPU_SPECS, cpuIdForGridSize } from '../data/parts';
import { createEmptyCells } from '../data/presets';
import { ALLOWED_GRID_SIZES, GridSize, TankBlueprint } from '../types/game';
import {
  AUTO_TANK_COLORS,
  isAllowedChassisId,
  isAllowedGridSize,
  isAllowedMainGunId,
  isAllowedRadarId,
  isAllowedSubWeaponId,
  STANDARD_SETUP,
  validateGridBlockFit,
} from './codeParser';

const SHARE_PREFIX = 'VST1-';
const STORAGE_KEY_SAVED_TANKS = 'vstank_saved_blueprints_v1';
const STORAGE_KEY_TUTORIAL_CLEARS = 'vstank_tutorial_clears_v1';

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Compact JSON representation to keep share codes short:
 * strips null cells and restores the grid matrix on decode.
 */
interface CompactBlueprintPayload {
  v: 1;
  id: string;
  n: string;
  a?: string;
  c: string;
  asm: TankBlueprint['assembly'];
  cm: TankBlueprint['program']['coordinateMode'];
  gs: GridSize;
  cells: Array<{
    x: number;
    y: number;
    t: string;
    p: Record<string, string | number>;
    nx?: [number, number];
    ys?: [number, number];
    no?: [number, number];
  }>;
}

export function validateAndNormalizeBlueprint(raw: unknown): TankBlueprint {
  if (!raw || typeof raw !== 'object') {
    throw new Error('無効なデータ形式です');
  }
  const obj = raw as Partial<TankBlueprint>;
  if (!obj.assembly || !obj.program || !obj.name) {
    throw new Error('機体データに必要なフィールドが不足しています');
  }

  const rawGs = obj.program.gridSize;
  if (rawGs !== undefined && !isAllowedGridSize(Number(rawGs))) {
    throw new Error(
      `未対応のグリッドサイズ (${rawGs}) です。${ALLOWED_GRID_SIZES.map((s) => `${s}×${s}`).join(' / ')} のみ対応しています。`
    );
  }

  const cpuSpec = CPU_SPECS[obj.assembly.cpu];
  const gridSize: GridSize =
    rawGs !== undefined && isAllowedGridSize(Number(rawGs))
      ? (Number(rawGs) as GridSize)
      : cpuSpec
        ? cpuSpec.gridSize
        : 8;

  if (Array.isArray(obj.program.cells)) {
    const fit = validateGridBlockFit(obj.program.cells, gridSize);
    if (!fit.valid) {
      throw new Error(fit.message);
    }
  }

  const normalizedChassis = isAllowedChassisId(obj.assembly.chassis)
    ? obj.assembly.chassis
    : STANDARD_SETUP.chassis;
  const normalizedRadar = isAllowedRadarId(obj.assembly.radar)
    ? obj.assembly.radar
    : STANDARD_SETUP.radar;
  const normalizedGun = isAllowedMainGunId(obj.assembly.mainGun)
    ? obj.assembly.mainGun
    : STANDARD_SETUP.mainGun;
  const normalizedSub = isAllowedSubWeaponId(obj.assembly.subWeapon)
    ? obj.assembly.subWeapon
    : STANDARD_SETUP.subWeapon;
  const rawColor = typeof obj.color === 'string' ? obj.color.trim().toLowerCase() : '';
  const normalizedColor = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : AUTO_TANK_COLORS[0];

  const cells = createEmptyCells(gridSize);
  if (Array.isArray(obj.program.cells)) {
    for (let y = 0; y < Math.min(gridSize, obj.program.cells.length); y++) {
      const row = obj.program.cells[y];
      if (!Array.isArray(row)) continue;
      for (let x = 0; x < Math.min(gridSize, row.length); x++) {
        cells[y][x] = row[x] ?? null;
      }
    }
  }
  return {
    version: 1,
    id: obj.id || `imported_${Date.now()}`,
    name: String(obj.name).slice(0, 40),
    author: obj.author ? String(obj.author).slice(0, 40) : undefined,
    color: normalizedColor,
    assembly: {
      chassis: normalizedChassis,
      radar: normalizedRadar,
      mainGun: normalizedGun,
      subWeapon: normalizedSub,
      cpu: cpuIdForGridSize(gridSize),
    },
    program: {
      gridSize,
      coordinateMode: obj.program.coordinateMode === 'absolute' ? 'absolute' : 'relative',
      cells,
    },
  };
}

export function encodeShareCode(blueprint: TankBlueprint): string {
  const compactCells: CompactBlueprintPayload['cells'] = [];
  for (let y = 0; y < blueprint.program.cells.length; y++) {
    for (let x = 0; x < blueprint.program.cells[y].length; x++) {
      const cell = blueprint.program.cells[y][x];
      if (!cell) continue;
      const entry: CompactBlueprintPayload['cells'][number] = {
        x,
        y,
        t: cell.type,
        p: cell.params,
      };
      if (cell.next) entry.nx = [cell.next.x, cell.next.y];
      if (cell.yes) entry.ys = [cell.yes.x, cell.yes.y];
      if (cell.no) entry.no = [cell.no.x, cell.no.y];
      compactCells.push(entry);
    }
  }

  const payload: CompactBlueprintPayload = {
    v: 1,
    id: blueprint.id,
    n: blueprint.name,
    a: blueprint.author,
    c: blueprint.color,
    asm: blueprint.assembly,
    cm: blueprint.program.coordinateMode,
    gs: blueprint.program.gridSize,
    cells: compactCells,
  };

  return SHARE_PREFIX + toBase64Url(JSON.stringify(payload));
}

export function decodeShareCode(rawCode: string): TankBlueprint {
  const trimmed = rawCode.trim();
  if (!trimmed.startsWith(SHARE_PREFIX)) {
    // Also allow raw JSON paste
    if (trimmed.startsWith('{')) {
      return validateAndNormalizeBlueprint(JSON.parse(trimmed));
    }
    throw new Error('シェアコードは "VST1-" で始まる必要があります');
  }

  const encoded = trimmed.slice(SHARE_PREFIX.length);
  const jsonStr = fromBase64Url(encoded);
  const payload = JSON.parse(jsonStr) as CompactBlueprintPayload;
  if (payload.v !== 1 || !payload.asm || !Array.isArray(payload.cells)) {
    throw new Error('シェアコードのフォーマットが不正です');
  }

  const gsNum = Number(payload.gs);
  if (!isAllowedGridSize(gsNum)) {
    throw new Error(
      `未対応のグリッドサイズ (${payload.gs}) です。4×4 / 6×6 / 8×8 / 12×12 のみ対応しています。`
    );
  }
  const gridSize: GridSize = gsNum;
  if (payload.cells.length > gridSize * gridSize) {
    throw new Error(
      `ブロック数 (${payload.cells.length}) が ${gridSize}×${gridSize} の上限 (${gridSize * gridSize}) を超えています。`
    );
  }
  const cells = createEmptyCells(gridSize);
  for (let idx = 0; idx < payload.cells.length; idx++) {
    const c = payload.cells[idx];
    if (c.y < 0 || c.y >= gridSize || c.x < 0 || c.x >= gridSize) {
      throw new Error(
        `座標 (${c.x}, ${c.y}) が ${gridSize}×${gridSize} グリッドの範囲外です。`
      );
    }
    cells[c.y][c.x] = {
      id: `imp_${idx}_${c.x}_${c.y}`,
      type: c.t as TankBlueprint['program']['cells'][0][0] extends infer R
        ? R extends { type: infer T }
          ? T
          : never
        : never,
      params: c.p ?? {},
      next: c.nx ? { x: c.nx[0], y: c.nx[1] } : null,
      yes: c.ys ? { x: c.ys[0], y: c.ys[1] } : null,
      no: c.no ? { x: c.no[0], y: c.no[1] } : null,
    };
  }

  return validateAndNormalizeBlueprint({
    version: 1,
    id: payload.id || `imported_${Date.now()}`,
    name: payload.n,
    author: payload.a,
    color: payload.c,
    assembly: payload.asm,
    program: {
      gridSize,
      coordinateMode: payload.cm,
      cells,
    },
  });
}

export function exportTankJsonFile(blueprint: TankBlueprint): void {
  const json = JSON.stringify(blueprint, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = blueprint.name.replace(/[^\w\u3040-\u30ff\u4e00-\u9faf-]+/g, '_');
  a.href = url;
  a.download = `${safeName || 'tank'}.vstank.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildShareUrl(blueprint: TankBlueprint): string {
  const code = encodeShareCode(blueprint);
  const url = new URL(window.location.href);
  url.searchParams.set('enemy', code);
  return url.toString();
}

export function extractEnemyFromUrl(): TankBlueprint | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('enemy');
    if (!code) return null;
    return decodeShareCode(code);
  } catch {
    return null;
  }
}

export function loadSavedBlueprints(): TankBlueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SAVED_TANKS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => validateAndNormalizeBlueprint(item));
  } catch {
    return [];
  }
}

export function saveBlueprintToStorage(blueprint: TankBlueprint): TankBlueprint[] {
  const existing = loadSavedBlueprints();
  const idx = existing.findIndex((b) => b.id === blueprint.id);
  const updated =
    idx >= 0
      ? existing.map((b, i) => (i === idx ? blueprint : b))
      : [blueprint, ...existing];
  try {
    localStorage.setItem(STORAGE_KEY_SAVED_TANKS, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

export function deleteBlueprintFromStorage(id: string): TankBlueprint[] {
  const updated = loadSavedBlueprints().filter((b) => b.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY_SAVED_TANKS, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

export function loadTutorialClears(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TUTORIAL_CLEARS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function markTutorialCleared(stageId: string): string[] {
  const existing = loadTutorialClears();
  if (existing.includes(stageId)) return existing;
  const updated = [...existing, stageId];
  try {
    localStorage.setItem(STORAGE_KEY_TUTORIAL_CLEARS, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

