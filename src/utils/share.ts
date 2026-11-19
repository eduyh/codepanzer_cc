import { CPU_SPECS, cpuIdForGridSize } from '../data/parts';
import { createEmptyCells } from '../data/presets';
import {
  ALLOWED_GRID_SIZES,
  GridSize,
  TankBlueprint,
  UiFontScale,
  UserEnvironmentDump,
  UserProfile,
} from '../types/game';
import { validateAndRepairBlueprint } from './blueprintGatekeeper';
import {
  AUTO_TANK_COLORS,
  CURRENT_BLUEPRINT_VERSION,
  CURRENT_ENV_DUMP_VERSION,
  CURRENT_GAME_VERSION,
  isAllowedChassisId,
  isAllowedGridSize,
  isAllowedMainGunId,
  isAllowedRadarId,
  isAllowedSubWeaponId,
  sanitizeAuthorName,
  sanitizeAuthorUuid,
  sanitizeGameVersion,
  sanitizeTankName,
  STANDARD_SETUP,
  validateGridBlockFit,
} from './codeParser';

const SHARE_PREFIX = 'VST1-';
export const ENV_DUMP_PREFIX = 'VSE1-';
const STORAGE_KEY_SAVED_TANKS = 'vstank_saved_blueprints_v1';
const STORAGE_KEY_TUTORIAL_CLEARS = 'vstank_tutorial_clears_v1';
const STORAGE_KEY_LEARNING_CLEARS = 'vstank_learning_clears_v1';
const STORAGE_KEY_USER_PROFILE = 'vstank_user_profile_v1';
export const STORAGE_KEY_UI_FONT_SCALE = 'vstank_ui_font_scale';

export function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function loadUserProfile(): UserProfile {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_USER_PROFILE) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      const userId = sanitizeAuthorUuid(parsed.userId, '') || generateUuidV4();
      const userName = sanitizeAuthorName(parsed.userName, 'Player');
      const profile: UserProfile = { userName, userId };
      if (!parsed.userId || parsed.userName !== userName) {
        try {
          localStorage.setItem(STORAGE_KEY_USER_PROFILE, JSON.stringify(profile));
        } catch {
          // Ignore storage quota errors
        }
      }
      return profile;
    }
  } catch {
    // Fallback to generating a fresh profile
  }
  const initial: UserProfile = {
    userName: 'Player',
    userId: generateUuidV4(),
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_USER_PROFILE, JSON.stringify(initial));
    }
  } catch {
    // Ignore storage quota errors
  }
  return initial;
}

export function saveUserName(rawUserName: string): UserProfile {
  const current = loadUserProfile();
  const updated: UserProfile = {
    userName: sanitizeAuthorName(rawUserName, 'Player'),
    userId: current.userId,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_USER_PROFILE, JSON.stringify(updated));
    }
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

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
  v: number;
  gv?: string;
  id: string;
  n: string;
  a?: string;
  au?: string;
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
  const cleanAuthor = obj.author ? sanitizeAuthorName(obj.author, '') : '';
  const cleanUuid = obj.authorUuid ? sanitizeAuthorUuid(obj.authorUuid, '') : '';
  const constructed: TankBlueprint = {
    version: typeof obj.version === 'number' ? obj.version : CURRENT_BLUEPRINT_VERSION,
    gameVersion:
      obj.gameVersion !== undefined
        ? sanitizeGameVersion(obj.gameVersion, CURRENT_GAME_VERSION)
        : CURRENT_GAME_VERSION,
    id: obj.id || `imported_${Date.now()}`,
    name: sanitizeTankName(obj.name),
    ...(cleanAuthor ? { author: cleanAuthor } : {}),
    ...(cleanUuid ? { authorUuid: cleanUuid } : {}),
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
  return validateAndRepairBlueprint(constructed).blueprint;
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
    v: CURRENT_BLUEPRINT_VERSION,
    gv: sanitizeGameVersion(blueprint.gameVersion, CURRENT_GAME_VERSION),
    id: blueprint.id,
    n: sanitizeTankName(blueprint.name),
    a: blueprint.author ? sanitizeAuthorName(blueprint.author, '') || undefined : undefined,
    au: blueprint.authorUuid ? sanitizeAuthorUuid(blueprint.authorUuid, '') || undefined : undefined,
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
  if (
    typeof payload.v !== 'number' ||
    !Number.isFinite(payload.v) ||
    payload.v < 1 ||
    !payload.asm ||
    !Array.isArray(payload.cells)
  ) {
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
    version: payload.v,
    ...(payload.gv ? { gameVersion: payload.gv } : {}),
    id: payload.id || `imported_${Date.now()}`,
    name: payload.n,
    author: payload.a,
    authorUuid: payload.au,
    color: payload.c,
    assembly: payload.asm,
    program: {
      gridSize,
      coordinateMode: payload.cm,
      cells,
    },
  });
}

function sanitizeFileNameSegment(name: string, fallback: string): string {
  const safe = name
    .replace(/[^\w\u3040-\u30ff\u4e00-\u9faf\uff10-\uff19-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return safe || fallback;
}

function triggerJsonDownload(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportTankJsonFile(blueprint: TankBlueprint): void {
  const stamped: TankBlueprint = {
    ...blueprint,
    version: CURRENT_BLUEPRINT_VERSION,
    gameVersion: sanitizeGameVersion(blueprint.gameVersion, CURRENT_GAME_VERSION),
  };
  const safeName = sanitizeFileNameSegment(stamped.name, 'tank');
  triggerJsonDownload(`${safeName}.vstank.json`, stamped);
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

function loadClearedIdList(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function markClearedIdInList(storageKey: string, id: string): string[] {
  const existing = loadClearedIdList(storageKey);
  if (existing.includes(id)) return existing;
  const updated = [...existing, id];
  try {
    localStorage.setItem(storageKey, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

export function loadTutorialClears(): string[] {
  return loadClearedIdList(STORAGE_KEY_TUTORIAL_CLEARS);
}

export function markTutorialCleared(stageId: string): string[] {
  return markClearedIdInList(STORAGE_KEY_TUTORIAL_CLEARS, stageId);
}

export function loadLearningClears(): string[] {
  return loadClearedIdList(STORAGE_KEY_LEARNING_CLEARS);
}

export function markLearningCleared(missionId: string): string[] {
  return markClearedIdInList(STORAGE_KEY_LEARNING_CLEARS, missionId);
}

function normalizeUiFontScale(raw: unknown): UiFontScale {
  return raw === 'large' || raw === 'xlarge' ? raw : 'normal';
}

export function loadUiFontScaleFromStorage(): UiFontScale {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_UI_FONT_SCALE) : null;
    return normalizeUiFontScale(raw);
  } catch {
    return 'normal';
  }
}

function normalizeClearIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) unique.add(trimmed);
  }
  return Array.from(unique);
}

/**
 * Builds a complete backup snapshot of the current browser environment.
 */
export function buildUserEnvironmentDump(options?: {
  currentBlueprint?: TankBlueprint;
  fontScale?: UiFontScale;
  exportedAt?: string;
}): UserEnvironmentDump {
  const userProfile = loadUserProfile();
  const savedBlueprints = loadSavedBlueprints();
  const learningClears = loadLearningClears();
  const tutorialClears = loadTutorialClears();
  const fontScale = options?.fontScale ?? loadUiFontScaleFromStorage();

  let normalizedCurrent: TankBlueprint | undefined;
  if (options?.currentBlueprint) {
    const base = validateAndNormalizeBlueprint(options.currentBlueprint);
    normalizedCurrent = {
      ...base,
      author: base.author ?? userProfile.userName,
      authorUuid: base.authorUuid ?? userProfile.userId,
    };
  }

  return {
    version: CURRENT_ENV_DUMP_VERSION,
    gameVersion: CURRENT_GAME_VERSION,
    exportedAt: options?.exportedAt ?? new Date().toISOString(),
    userProfile,
    ...(normalizedCurrent ? { currentBlueprint: normalizedCurrent } : {}),
    savedBlueprints,
    learningClears,
    tutorialClears,
    uiSettings: {
      fontScale,
    },
  };
}

/**
 * Validates and sanitizes an imported environment dump object.
 */
export function validateAndNormalizeEnvironmentDump(raw: unknown): UserEnvironmentDump {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('環境ダンプデータの形式が不正です');
  }
  const obj = raw as Record<string, unknown>;
  if (
    obj.version !== undefined &&
    (typeof obj.version !== 'number' || obj.version < 1 || !Number.isFinite(obj.version))
  ) {
    throw new Error('環境ダンプデータの形式が不正です');
  }
  const hasEnvField =
    'userProfile' in obj ||
    'savedBlueprints' in obj ||
    'learningClears' in obj ||
    'tutorialClears' in obj ||
    'uiSettings' in obj;
  if (!hasEnvField) {
    throw new Error('環境ダンプデータの形式が不正です');
  }

  const rawProfile =
    obj.userProfile && typeof obj.userProfile === 'object' && !Array.isArray(obj.userProfile)
      ? (obj.userProfile as Partial<UserProfile>)
      : {};
  const userProfile: UserProfile = {
    userName: sanitizeAuthorName(rawProfile.userName, 'Player'),
    userId: sanitizeAuthorUuid(rawProfile.userId, '') || generateUuidV4(),
  };

  let currentBlueprint: TankBlueprint | undefined;
  if (obj.currentBlueprint !== undefined && obj.currentBlueprint !== null) {
    currentBlueprint = validateAndNormalizeBlueprint(obj.currentBlueprint);
  }

  const savedBlueprints: TankBlueprint[] = [];
  if (Array.isArray(obj.savedBlueprints)) {
    const seenIds = new Set<string>();
    for (const item of obj.savedBlueprints) {
      const normalized = validateAndNormalizeBlueprint(item);
      if (seenIds.has(normalized.id)) continue;
      seenIds.add(normalized.id);
      savedBlueprints.push(normalized);
    }
  }

  const learningClears = normalizeClearIdList(obj.learningClears);
  const tutorialClears = normalizeClearIdList(obj.tutorialClears);
  const rawUi =
    obj.uiSettings && typeof obj.uiSettings === 'object' && !Array.isArray(obj.uiSettings)
      ? (obj.uiSettings as { fontScale?: unknown })
      : {};
  const fontScale = normalizeUiFontScale(rawUi.fontScale);

  const exportedAt =
    typeof obj.exportedAt === 'string' && obj.exportedAt.trim()
      ? obj.exportedAt.trim()
      : new Date().toISOString();

  return {
    version: CURRENT_ENV_DUMP_VERSION,
    gameVersion: sanitizeGameVersion(obj.gameVersion, CURRENT_GAME_VERSION),
    exportedAt,
    userProfile,
    ...(currentBlueprint ? { currentBlueprint } : {}),
    savedBlueprints,
    learningClears,
    tutorialClears,
    uiSettings: {
      fontScale,
    },
  };
}

/**
 * Encodes a validated environment dump into a copy-pasteable VSE1- string.
 */
export function encodeUserEnvironmentDump(dump: UserEnvironmentDump): string {
  const normalized = validateAndNormalizeEnvironmentDump(dump);
  return ENV_DUMP_PREFIX + toBase64Url(JSON.stringify(normalized));
}

/**
 * Decodes either a VSE1- backup code or raw JSON string into a validated dump.
 */
export function decodeUserEnvironmentDump(rawText: string): UserEnvironmentDump {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('復元するダンプコードまたはJSONを入力してください');
  }
  if (trimmed.startsWith(SHARE_PREFIX)) {
    throw new Error(
      'これは単機シェアコード (VST1-) です。機体の読み込みは「共有・読込」から行ってください'
    );
  }
  if (trimmed.startsWith(ENV_DUMP_PREFIX)) {
    try {
      const encoded = trimmed.slice(ENV_DUMP_PREFIX.length);
      const jsonStr = fromBase64Url(encoded);
      return validateAndNormalizeEnvironmentDump(JSON.parse(jsonStr));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('環境ダンプ')) {
        throw err;
      }
      throw new Error('環境ダンプコードのデコードに失敗しました');
    }
  }
  if (trimmed.startsWith('{')) {
    try {
      return validateAndNormalizeEnvironmentDump(JSON.parse(trimmed));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('環境ダンプ')) {
        throw err;
      }
      throw new Error('環境ダンプJSONの解析に失敗しました');
    }
  }
  throw new Error('環境ダンプコードは "VSE1-" で始まるか、JSON形式である必要があります');
}

/**
 * Applies a validated dump (or encoded text) to localStorage, overwriting stored environment keys.
 */
export function applyUserEnvironmentDump(
  input: UserEnvironmentDump | string
): UserEnvironmentDump {
  const dump =
    typeof input === 'string'
      ? decodeUserEnvironmentDump(input)
      : validateAndNormalizeEnvironmentDump(input);

  if (typeof localStorage !== 'undefined') {
    const entries: Array<[string, string]> = [
      [STORAGE_KEY_USER_PROFILE, JSON.stringify(dump.userProfile)],
      [STORAGE_KEY_SAVED_TANKS, JSON.stringify(dump.savedBlueprints)],
      [STORAGE_KEY_LEARNING_CLEARS, JSON.stringify(dump.learningClears)],
      [STORAGE_KEY_TUTORIAL_CLEARS, JSON.stringify(dump.tutorialClears)],
    ];
    if (dump.uiSettings?.fontScale) {
      entries.push([STORAGE_KEY_UI_FONT_SCALE, dump.uiSettings.fontScale]);
    }
    for (const [key, val] of entries) {
      try {
        localStorage.setItem(key, val);
      } catch {
        // Ignore storage quota errors
      }
    }
  }
  return dump;
}

/**
 * Downloads the environment dump as a portable .json file.
 */
export function exportUserEnvironmentFile(dump: UserEnvironmentDump): void {
  const normalized = validateAndNormalizeEnvironmentDump(dump);
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const safeUser = sanitizeFileNameSegment(normalized.userProfile.userName, 'player');
  triggerJsonDownload(`codepanzer_env_${safeUser}_${yyyy}${mm}${dd}.json`, normalized);
}

