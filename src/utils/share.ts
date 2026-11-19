import { CPU_SPECS, cpuIdForGridSize } from '../data/parts';
import { createEmptyCells } from '../data/presets';
import {
  ALLOWED_GRID_SIZES,
  ChipProgram,
  ClearUnitId,
  DecodedClearCode,
  GridSize,
  LearningAttemptRecord,
  StageClearTelemetry,
  TankBlueprint,
  UiFontScale,
  UserEnvironmentDump,
  UserProfile,
} from '../types/game';
import { validateAndRepairBlueprint } from './blueprintGatekeeper';
import {
  AUTO_TANK_COLORS,
  countGridBlocks,
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
export const CLEAR_CODE_PREFIX = 'CP1-';
export const REQUIRED_DISTINCT_FAILURES_FOR_MODEL_ANSWER = 5;
export const MIN_BLOCKS_FOR_FAILURE_ATTEMPT = 3;
const STORAGE_KEY_SAVED_TANKS = 'vstank_saved_blueprints_v1';
const STORAGE_KEY_TUTORIAL_CLEARS = 'vstank_tutorial_clears_v1';
const STORAGE_KEY_LEARNING_CLEARS = 'vstank_learning_clears_v1';
const STORAGE_KEY_CLEAR_TELEMETRY = 'vstank_clear_telemetry_v1';
const STORAGE_KEY_LEARNING_ATTEMPTS = 'vstank_learning_attempts_v1';
const STORAGE_KEY_USER_PROFILE = 'vstank_user_profile_v1';
export const STORAGE_KEY_UI_FONT_SCALE = 'vstank_ui_font_scale';

const CLEAR_XOR_KEY_A = 608472915341n;
const CLEAR_XOR_KEY_B = 839164720519n;
const CLEAR_SIG_SALT = 948271635n;
const CLEAR_SIG_MOD = 1679609n; // largest prime < 36^4 (1,679,616)

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

function serializeProgramStructure(program: ChipProgram): string {
  const parts: string[] = [String(program.gridSize), program.coordinateMode];
  for (let y = 0; y < program.cells.length; y++) {
    const row = program.cells[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (!cell) continue;
      const paramEntries = Object.entries(cell.params ?? {})
        .filter(([k]) => k !== '_print')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      const nx = cell.next ? `${cell.next.x},${cell.next.y}` : '-';
      const ys = cell.yes ? `${cell.yes.x},${cell.yes.y}` : '-';
      const no = cell.no ? `${cell.no.x},${cell.no.y}` : '-';
      parts.push(`${x},${y}:${cell.type}[${paramEntries}]>${nx}|${ys}|${no}`);
    }
  }
  return parts.join(';');
}

function computeProgramHash32(program: ChipProgram): number {
  const serialized = serializeProgramStructure(program);
  let hash = 2166136261;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Computes a deterministic 0..999 structural fingerprint of a ChipProgram.
 */
export function computeProgramFingerprint(program: ChipProgram): number {
  const hash = computeProgramHash32(program);
  return ((hash % 1000) + 1000) % 1000;
}

/**
 * Returns true if the student's solution exactly matches the built-in starter program
 * (excluding ultra-simple < 4 block starter programs such as mission 1-1).
 */
export function isProgramIdenticalToStarter(
  program: ChipProgram,
  starterProgram: ChipProgram,
  missionId?: string
): boolean {
  if (missionId === 'learn_1_1' || countGridBlocks(starterProgram.cells) < 4) {
    return false;
  }
  return serializeProgramStructure(program) === serializeProgramStructure(starterProgram);
}

function normalizeLearningAttemptsMap(raw: unknown): Record<string, LearningAttemptRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, LearningAttemptRecord> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const missionId = key.trim();
    if (!missionId || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const obj = val as Partial<LearningAttemptRecord>;
    const seen = new Set<number>();
    const failedFingerprints: number[] = [];
    if (Array.isArray(obj.failedFingerprints)) {
      for (const fp of obj.failedFingerprints) {
        if (typeof fp !== 'number' || !Number.isFinite(fp)) continue;
        const n = Math.trunc(fp);
        if (seen.has(n)) continue;
        seen.add(n);
        failedFingerprints.push(n);
        if (failedFingerprints.length >= 20) break;
      }
    }
    result[missionId] = {
      missionId,
      failedFingerprints,
      openedModelAnswer: Boolean(obj.openedModelAnswer),
    };
  }
  return result;
}

function saveLearningAttemptsMap(map: Record<string, LearningAttemptRecord>): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_LEARNING_ATTEMPTS, JSON.stringify(map));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function loadLearningAttempts(): Record<string, LearningAttemptRecord> {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY_LEARNING_ATTEMPTS)
        : null;
    if (!raw) return {};
    return normalizeLearningAttemptsMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function recordLearningFailedAttempt(params: {
  missionId: string;
  program: ChipProgram;
  hintsOpen: boolean;
}): Record<string, LearningAttemptRecord> {
  const existingMap = loadLearningAttempts();
  if (!params.hintsOpen || countGridBlocks(params.program.cells) < MIN_BLOCKS_FOR_FAILURE_ATTEMPT) {
    return existingMap;
  }
  const prev = existingMap[params.missionId] ?? {
    missionId: params.missionId,
    failedFingerprints: [],
    openedModelAnswer: false,
  };
  const fp = computeProgramHash32(params.program);
  if (prev.failedFingerprints.includes(fp) || prev.failedFingerprints.length >= 20) {
    return existingMap;
  }
  const updated: Record<string, LearningAttemptRecord> = {
    ...existingMap,
    [params.missionId]: {
      ...prev,
      failedFingerprints: [...prev.failedFingerprints, fp],
    },
  };
  saveLearningAttemptsMap(updated);
  return updated;
}

export function markLearningModelAnswerOpened(
  missionId: string
): Record<string, LearningAttemptRecord> {
  const existingMap = loadLearningAttempts();
  const prev = existingMap[missionId];
  if (prev?.openedModelAnswer) {
    return existingMap;
  }
  // If already self-cleared earlier, keep review mode without revoking self-cleared credit
  if (
    (loadLearningClears().includes(missionId) || loadTutorialClears().includes(missionId)) &&
    loadClearTelemetry()[missionId]?.usedModelAnswer === false
  ) {
    return existingMap;
  }
  const updated: Record<string, LearningAttemptRecord> = {
    ...existingMap,
    [missionId]: {
      missionId,
      failedFingerprints: prev?.failedFingerprints ?? [],
      openedModelAnswer: true,
    },
  };
  saveLearningAttemptsMap(updated);
  return updated;
}

function normalizeClearTelemetryMap(raw: unknown): Record<string, StageClearTelemetry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, StageClearTelemetry> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const stageId = key.trim();
    if (!stageId || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const obj = val as Partial<StageClearTelemetry>;
    const clearTicks =
      typeof obj.clearTicks === 'number' && Number.isFinite(obj.clearTicks)
        ? Math.max(1, Math.round(obj.clearTicks))
        : 100;
    const blockCount =
      typeof obj.blockCount === 'number' && Number.isFinite(obj.blockCount)
        ? Math.max(0, Math.round(obj.blockCount))
        : 1;
    const fpRaw =
      typeof obj.programFingerprint === 'number' && Number.isFinite(obj.programFingerprint)
        ? Math.round(obj.programFingerprint)
        : 0;
    const programFingerprint = ((fpRaw % 1000) + 1000) % 1000;
    const clearedAt =
      typeof obj.clearedAt === 'string' && obj.clearedAt.trim()
        ? obj.clearedAt.trim()
        : new Date().toISOString();
    result[stageId] = {
      stageId,
      clearedAt,
      clearTicks,
      blockCount,
      usedModelAnswer: Boolean(obj.usedModelAnswer),
      programFingerprint,
    };
  }
  return result;
}

export function loadClearTelemetry(): Record<string, StageClearTelemetry> {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_CLEAR_TELEMETRY) : null;
    if (!raw) return {};
    return normalizeClearTelemetryMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function recordStageClearTelemetry(entry: {
  stageId: string;
  clearTicks: number;
  program: ChipProgram;
  usedModelAnswer: boolean;
  starterProgram?: ChipProgram;
  clearedAt?: string;
}): Record<string, StageClearTelemetry> {
  const existingMap = loadClearTelemetry();
  const prev = existingMap[entry.stageId];
  const attemptRec = loadLearningAttempts()[entry.stageId];
  const matchedStarter = entry.starterProgram
    ? isProgramIdenticalToStarter(entry.program, entry.starterProgram, entry.stageId)
    : false;
  const rawUsed = Boolean(entry.usedModelAnswer || attemptRec?.openedModelAnswer || matchedStarter);
  // Once model answer was opened in this learning mission, it irreversibly counts as assisted.
  // Otherwise, preserve an earlier self-cleared credit if reviewed later.
  const usedModelAnswer = attemptRec?.openedModelAnswer
    ? true
    : prev && !prev.usedModelAnswer
      ? false
      : rawUsed;
  const nextEntry: StageClearTelemetry = {
    stageId: entry.stageId,
    clearedAt: entry.clearedAt ?? new Date().toISOString(),
    clearTicks: Math.max(1, Math.round(entry.clearTicks)),
    blockCount: countGridBlocks(entry.program.cells),
    usedModelAnswer,
    programFingerprint: computeProgramFingerprint(entry.program),
  };
  const updated: Record<string, StageClearTelemetry> = {
    ...existingMap,
    [entry.stageId]: nextEntry,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_CLEAR_TELEMETRY, JSON.stringify(updated));
    }
  } catch {
    // Ignore storage quota errors
  }
  return updated;
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
  const clearTelemetry = loadClearTelemetry();
  const learningAttempts = loadLearningAttempts();
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
    clearTelemetry,
    learningAttempts,
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
  const clearTelemetry = normalizeClearTelemetryMap(obj.clearTelemetry);
  const learningAttempts = normalizeLearningAttemptsMap(obj.learningAttempts);
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
    ...(Object.keys(clearTelemetry).length > 0 ? { clearTelemetry } : {}),
    ...(Object.keys(learningAttempts).length > 0 ? { learningAttempts } : {}),
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
      [STORAGE_KEY_CLEAR_TELEMETRY, JSON.stringify(dump.clearTelemetry ?? {})],
      [STORAGE_KEY_LEARNING_ATTEMPTS, JSON.stringify(dump.learningAttempts ?? {})],
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

const UNIT_ID_TO_CODE: Record<ClearUnitId, number> = {
  L1: 11,
  L2: 12,
  L3: 13,
  L4: 14,
  T1: 21,
  T2: 22,
  T3: 23,
  T4: 24,
};

const CODE_TO_UNIT_META: Record<number, { unitId: ClearUnitId; label: string }> = {
  11: { unitId: 'L1', label: '課題学習 第1回' },
  12: { unitId: 'L2', label: '課題学習 第2回' },
  13: { unitId: 'L3', label: '課題学習 第3回' },
  14: { unitId: 'L4', label: '課題学習 第4回' },
  21: { unitId: 'T1', label: '開発訓練 第1部' },
  22: { unitId: 'T2', label: '開発訓練 第2部' },
  23: { unitId: 'T3', label: '開発訓練 第3部' },
  24: { unitId: 'T4', label: '開発訓練 第4部' },
};

function normalizeUuidTo32Hex(userId: string): string {
  const hexOnly = userId.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hexOnly.length === 32) return hexOnly;
  if (hexOnly.length > 32) return hexOnly.slice(0, 32);
  let padded = hexOnly;
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  while (padded.length < 32) {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
    padded += hash.toString(16).toUpperCase().padStart(8, '0');
  }
  return padded.slice(0, 32);
}

function clampInt(val: number, min: number, max: number): number {
  const rounded = Number.isFinite(val) ? Math.round(val) : min;
  return Math.max(min, Math.min(max, rounded));
}

function parseBase36BigInt(str: string): bigint {
  const upper = str.toUpperCase();
  let acc = 0n;
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    let d: number;
    if (code >= 48 && code <= 57) d = code - 48;
    else if (code >= 65 && code <= 90) d = code - 55;
    else throw new Error('Invalid base36 char');
    acc = acc * 36n + BigInt(d);
  }
  return acc;
}

/**
 * Generates an Excel-verifiable 59-char Clear Code (CP1-<32hex>-<8b36>-<8b36>-<4b36>).
 */
export function encodeClearCode(params: {
  userId: string;
  unitId: ClearUnitId;
  totalStages: number;
  selfClearedStages: number;
  clearedAt?: Date;
  gameVersion?: string;
  totalClearSeconds: number;
  programFingerprint: number;
}): string {
  const uuidHex = normalizeUuidTo32Hex(params.userId);
  const u1 = BigInt(`0x${uuidHex.slice(0, 8)}`);
  const u3 = BigInt(`0x${uuidHex.slice(8, 16)}`);
  const u4 = BigInt(`0x${uuidHex.slice(16, 24)}`);
  const u2 = BigInt(`0x${uuidHex.slice(24, 32)}`);

  const unitCode = UNIT_ID_TO_CODE[params.unitId];
  const total = clampInt(params.totalStages, 1, 9);
  const self = clampInt(params.selfClearedStages, 0, total);
  const dt = params.clearedAt ?? new Date();
  const month = clampInt(dt.getMonth() + 1, 1, 12);
  const day = clampInt(dt.getDate(), 1, 31);
  const hour = clampInt(dt.getHours(), 0, 23);
  const minute = clampInt(dt.getMinutes(), 0, 59);

  const d1Str =
    String(unitCode).padStart(2, '0') +
    String(total) +
    String(self) +
    String(month).padStart(2, '0') +
    String(day).padStart(2, '0') +
    String(hour).padStart(2, '0') +
    String(minute).padStart(2, '0');
  const d1 = BigInt(d1Str);

  const verStr = sanitizeGameVersion(params.gameVersion, CURRENT_GAME_VERSION);
  const verMatch = verStr.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const major = clampInt(verMatch ? Number(verMatch[1]) : 1, 0, 9);
  const minor = clampInt(verMatch ? Number(verMatch[2]) : 0, 0, 99);
  const patch = clampInt(verMatch && verMatch[3] !== undefined ? Number(verMatch[3]) : 0, 0, 99);
  const sec = clampInt(params.totalClearSeconds, 1, 9999);
  const fp = ((clampInt(params.programFingerprint, -999999, 999999) % 1000) + 1000) % 1000;

  const d2Str =
    String(major) +
    String(minor).padStart(2, '0') +
    String(patch).padStart(2, '0') +
    String(sec).padStart(4, '0') +
    String(fp).padStart(3, '0');
  const d2 = BigInt(d2Str);

  const maskA = (u1 * 193n + u2) ^ CLEAR_XOR_KEY_A;
  const maskB = (u3 * 197n + u4) ^ CLEAR_XOR_KEY_B;
  const c1 = d1 ^ maskA;
  const c2 = d2 ^ maskB;

  const blockA = c1.toString(36).toUpperCase().padStart(8, '0');
  const blockB = c2.toString(36).toUpperCase().padStart(8, '0');

  const sigNum =
    (u1 * 3n + u2 * 5n + u3 * 7n + u4 * 11n + d1 * 17n + d2 * 29n + CLEAR_SIG_SALT) %
    CLEAR_SIG_MOD;
  const sigBlock = sigNum.toString(36).toUpperCase().padStart(4, '0');

  return `${CLEAR_CODE_PREFIX}${uuidHex}-${blockA}-${blockB}-${sigBlock}`;
}

/**
 * Decodes and verifies a Clear Code using the exact same arithmetic as the Excel sheet formulas.
 */
export function decodeClearCode(rawCode: string): DecodedClearCode {
  const trimmed = rawCode.trim().toUpperCase();
  const invalidFallback: DecodedClearCode = {
    valid: false,
    rawCode: trimmed,
    uuidHex: '',
    formattedUuid: '',
    unitCode: 0,
    unitId: null,
    unitLabel: '不正なコード',
    totalStages: 0,
    selfClearedStages: 0,
    month: 0,
    day: 0,
    hour: 0,
    minute: 0,
    gameVersion: '',
    totalClearSeconds: 0,
    programFingerprint: 0,
  };

  const m = trimmed.match(/^CP1-([0-9A-F]{32})-([0-9A-Z]{8})-([0-9A-Z]{8})-([0-9A-Z]{4})$/);
  if (!m) return invalidFallback;

  const [, uuidHex, blockA, blockB, sigBlock] = m;
  const formattedUuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`.toLowerCase();

  const u1 = BigInt(`0x${uuidHex.slice(0, 8)}`);
  const u3 = BigInt(`0x${uuidHex.slice(8, 16)}`);
  const u4 = BigInt(`0x${uuidHex.slice(16, 24)}`);
  const u2 = BigInt(`0x${uuidHex.slice(24, 32)}`);

  const c1 = parseBase36BigInt(blockA);
  const c2 = parseBase36BigInt(blockB);

  const maskA = (u1 * 193n + u2) ^ CLEAR_XOR_KEY_A;
  const maskB = (u3 * 197n + u4) ^ CLEAR_XOR_KEY_B;
  const d1 = c1 ^ maskA;
  const d2 = c2 ^ maskB;

  const expectedSigNum =
    (u1 * 3n + u2 * 5n + u3 * 7n + u4 * 11n + d1 * 17n + d2 * 29n + CLEAR_SIG_SALT) %
    CLEAR_SIG_MOD;
  const expectedSig = expectedSigNum.toString(36).toUpperCase().padStart(4, '0');
  const sigMatches = expectedSig === sigBlock;

  const d1Str = d1.toString(10);
  const d2Str = d2.toString(10);
  if (d1Str.length !== 12 || d2Str.length > 12) {
    return { ...invalidFallback, uuidHex, formattedUuid };
  }

  const d2Padded = d2Str.padStart(12, '0');
  const unitCode = Number(d1Str.slice(0, 2));
  const totalStages = Number(d1Str.slice(2, 3));
  const selfClearedStages = Number(d1Str.slice(3, 4));
  const month = Number(d1Str.slice(4, 6));
  const day = Number(d1Str.slice(6, 8));
  const hour = Number(d1Str.slice(8, 10));
  const minute = Number(d1Str.slice(10, 12));

  const major = Number(d2Padded.slice(0, 1));
  const minor = Number(d2Padded.slice(1, 3));
  const patch = Number(d2Padded.slice(3, 5));
  const totalClearSeconds = Number(d2Padded.slice(5, 9));
  const programFingerprint = Number(d2Padded.slice(9, 12));

  const unitMeta = CODE_TO_UNIT_META[unitCode] ?? null;
  const fieldsValid =
    unitMeta !== null &&
    totalStages >= 1 &&
    totalStages <= 9 &&
    selfClearedStages >= 0 &&
    selfClearedStages <= totalStages &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59;

  return {
    valid: sigMatches && fieldsValid,
    rawCode: trimmed,
    uuidHex,
    formattedUuid,
    unitCode,
    unitId: unitMeta ? unitMeta.unitId : null,
    unitLabel: unitMeta ? unitMeta.label : '不明な単元',
    totalStages,
    selfClearedStages,
    month,
    day,
    hour,
    minute,
    gameVersion: `${major}.${minor}.${patch}`,
    totalClearSeconds,
    programFingerprint,
  };
}

/**
 * Builds the completion Clear Code for a unit if all stages in the unit are cleared.
 * Returns null if any stage in the unit has not been cleared yet.
 */
export function buildUnitClearCode(params: {
  unitId: ClearUnitId;
  stageIds: string[];
  clearedIds: string[];
  telemetry: Record<string, StageClearTelemetry>;
  userId: string;
  gameVersion?: string;
}): string | null {
  if (
    params.stageIds.length === 0 ||
    !params.stageIds.every((id) => params.clearedIds.includes(id))
  ) {
    return null;
  }

  let selfClearedStages = 0;
  let totalTicks = 0;
  let fpAcc = 0;
  let latestClearedMs = 0;

  params.stageIds.forEach((stageId, idx) => {
    const rec = params.telemetry[stageId];
    if (!rec || !rec.usedModelAnswer) {
      selfClearedStages += 1;
    }
    totalTicks += rec ? rec.clearTicks : 100;
    const fpVal = rec ? rec.programFingerprint : ((idx + 1) * 101) % 1000;
    fpAcc = (fpAcc * 31 + fpVal + idx * 17) % 1000;
    if (rec?.clearedAt) {
      const parsedMs = Date.parse(rec.clearedAt);
      if (Number.isFinite(parsedMs) && parsedMs > latestClearedMs) {
        latestClearedMs = parsedMs;
      }
    }
  });

  const clearedAt = latestClearedMs > 0 ? new Date(latestClearedMs) : new Date(2026, 0, 1, 0, 0);
  const totalClearSeconds = clampInt(Math.round(totalTicks / 20), 1, 9999);

  return encodeClearCode({
    userId: params.userId,
    unitId: params.unitId,
    totalStages: params.stageIds.length,
    selfClearedStages,
    clearedAt,
    gameVersion: params.gameVersion ?? CURRENT_GAME_VERSION,
    totalClearSeconds,
    programFingerprint: fpAcc,
  });
}

/**
 * Returns the 4-digit daily unlock code (MMDD in local time, e.g. "1119" for Nov 19).
 */
export function getExpectedDailyUnlockCode(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

/**
 * Verifies whether the user input matches today's 4-digit MMDD unlock code.
 */
export function verifyDailyUnlockCode(input: string, now: Date = new Date()): boolean {
  const cleaned = input.trim();
  if (!/^\d{4}$/.test(cleaned)) return false;
  return cleaned === getExpectedDailyUnlockCode(now);
}

