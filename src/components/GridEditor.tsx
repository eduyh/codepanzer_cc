import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Download,
  GraduationCap,
  Grid3X3,
  MousePointer,
  Move,
  Trash2,
  Unlink,
  Upload,
} from 'lucide-react';
import { CHIP_CATEGORY_LABELS, CHIP_DEFINITIONS, CHIP_LIST } from '../data/chips';
import {
  calculateAssemblyWeight,
  CHASSIS_SPECS,
  computeShellMetrics,
  CPU_SPECS,
  cpuIdForGridSize,
  FIRE_POWER_TIER_LABELS,
  MAIN_GUN_SPECS,
  normalizeFirePowerTier,
  RADAR_SPECS,
  resolveFirePower,
  SUB_WEAPON_SPECS,
  tryParseFirePowerInput,
} from '../data/parts';
import { createEmptyCells, makeCell } from '../data/presets';
import { findStartCell } from '../engine/chipRunner';
import {
  ALLOWED_GRID_SIZES,
  ChassisId,
  ChipCategory,
  ChipProgram,
  ChipType,
  CoordinateMode,
  CpuId,
  DisplayLang,
  ExecutionTrace,
  GridCell,
  GridCoord,
  GridSize,
  MainGunId,
  RadarId,
  SubWeaponId,
  TankBlueprint,
} from '../types/game';
import {
  ALLOWED_CHASSIS_IDS,
  ALLOWED_MAIN_GUN_IDS,
  ALLOWED_RADAR_IDS,
  ALLOWED_SUB_WEAPON_IDS,
  countGridBlocks,
  isAllowedChassisId,
  isAllowedMainGunId,
  isAllowedRadarId,
  isAllowedSubWeaponId,
  looksLikePythonSource,
  parsePythonSourceToProgram,
  parsePythonSourceWithAutoSize,
  STANDARD_SETUP,
  validateFirePowerInCells,
  validateGridBlockFit,
} from '../utils/codeParser';
import {
  decodeShareCode,
  exportTankJsonFile,
  validateAndNormalizeBlueprint,
} from '../utils/share';

interface GridEditorProps {
  program: ChipProgram;
  cpuId: CpuId;
  chassisId?: ChassisId;
  radarId?: RadarId;
  mainGunId?: MainGunId;
  subWeaponId?: SubWeaponId;
  tankName: string;
  trace?: ExecutionTrace;
  isPlaying: boolean;
  allowedChips?: ChipType[];
  allowLearningChips?: boolean;
  mobileMode?: boolean;
  requestedSidebarTab?: { mode: 'palette' | 'code'; nonce: number } | null;
  onChangeProgram: (
    next: ChipProgram,
    nextTankName?: string,
    nextRadarId?: RadarId,
    nextChassisId?: ChassisId,
    nextMainGunId?: MainGunId,
    nextSubWeaponId?: SubWeaponId
  ) => void;
  onChangeTankName?: (name: string) => void;
  onChangeChassis?: (chassis: ChassisId) => void;
  onChangeRadar?: (radar: RadarId) => void;
  onChangeMainGun?: (gun: MainGunId) => void;
  onChangeSubWeapon?: (sub: SubWeaponId) => void;
  onImportBlueprint?: (bp: TankBlueprint) => void;
}

const ORTHO_PAD_SLOTS: Array<
  | { kind: 'empty'; key: string }
  | { kind: 'center'; key: string }
  | { kind: 'dir'; key: string; dx: number; dy: number; label: string }
> = [
  { kind: 'empty', key: 'tl' },
  { kind: 'dir', key: 'up', dx: 0, dy: -1, label: '↑' },
  { kind: 'empty', key: 'tr' },
  { kind: 'dir', key: 'left', dx: -1, dy: 0, label: '←' },
  { kind: 'center', key: 'mid' },
  { kind: 'dir', key: 'right', dx: 1, dy: 0, label: '→' },
  { kind: 'empty', key: 'bl' },
  { kind: 'dir', key: 'down', dx: 0, dy: 1, label: '↓' },
  { kind: 'empty', key: 'br' },
];

function summarizeChipParams(cell: GridCell, lang: DisplayLang): string {
  const p = cell.params;
  switch (cell.type) {
    case 'wire': {
      const sec = Number(p.seconds ?? 0);
      return sec > 0 ? `${sec}s` : '0s';
    }
    case 'sub_def': {
      const subKey = String(p.sub ?? 'A').toUpperCase();
      return lang === 'en' ? `sub_${subKey.toLowerCase()}` : `SUB ${subKey}`;
    }
    case 'sub_call': {
      const subKey = String(p.sub ?? 'A').toUpperCase();
      return lang === 'en' ? `sub_${subKey.toLowerCase()}()` : `→SUB ${subKey}`;
    }
    case 'loop_while':
      if (lang === 'en') {
        return p.cond === 'enemy_not_detected'
          ? '!det'
          : p.cond === 'wall_ahead'
            ? `wall<=${p.value}`
            : p.cond === 'turret_not_aligned'
              ? `err>${p.value}°`
              : `a<${p.value}`;
      }
      return p.cond === 'enemy_not_detected'
        ? '!検知'
        : p.cond === 'wall_ahead'
          ? `壁<=${p.value}`
          : p.cond === 'turret_not_aligned'
            ? `角>${p.value}°`
            : `a<${p.value}`;
    case 'loop_for':
      return lang === 'en' ? `n=${p.iterations}` : `${p.iterations}回`;
    case 'act_move':
      return Number(p.duration ?? 0) > 0
        ? `${p.speedPercent}% (${p.duration}s)`
        : `${p.speedPercent}%`;
    case 'act_turn_body': {
      const ang = Number(p.angle ?? 0);
      const sign = ang >= 0 ? '+' : '';
      const waitTag = Number(p.wait ?? 0) === 1 ? (lang === 'en' ? ' [w]' : ' [待]') : '';
      if (p.mode === 'wall_away') {
        return `${lang === 'en' ? `away ${Math.abs(ang)}°` : `壁回避${Math.abs(ang)}°`}${waitTag}`;
      }
      if (p.mode === 'enemy_rel') {
        return `${lang === 'en' ? `e${sign}${ang}°` : `敵${sign}${ang}°`}${waitTag}`;
      }
      if (p.mode === 'turret_rel') {
        return `${lang === 'en' ? `t${sign}${ang}°` : `砲塔${sign}${ang}°`}${waitTag}`;
      }
      return `${ang}°${waitTag}`;
    }
    case 'act_turn_turret': {
      const ang = Number(p.angle ?? 0);
      const waitTag = Number(p.wait ?? 0) === 1 ? (lang === 'en' ? ' [w]' : ' [待]') : '';
      if (p.mode === 'body_rel') {
        const sign = ang >= 0 ? '+' : '';
        return `${lang === 'en' ? `b${sign}${ang}°` : `車体${sign}${ang}°`}${waitTag}`;
      }
      return `${p.angle}°${waitTag}`;
    }
    case 'act_turn_radar':
      if (p.mode === 'lock_enemy') return lang === 'en' ? 'lock' : '追尾';
      if (p.mode === 'sweep') return lang === 'en' ? `±${p.angle ?? 60}°` : `首振±${p.angle ?? 60}°`;
      return `${p.angle}°`;
    case 'act_aim_enemy':
      return p.lead === 'lead'
        ? lang === 'en'
          ? 'lead'
          : '偏差'
        : lang === 'en'
          ? 'direct'
          : '直接';
    case 'act_fire': {
      const tier = normalizeFirePowerTier(p.power);
      const waitTag = Number(p.wait ?? 0) === 1 ? (lang === 'en' ? ' [w]' : ' [待]') : '';
      return `${FIRE_POWER_TIER_LABELS[tier][lang]}${waitTag}`;
    }
    case 'cond_enemy_sector':
      return `±${p.halfWidth}°`;
    case 'cond_enemy_dist':
      return `${p.op === 'gte' ? '>=' : '<='}${p.dist ?? 300}px`;
    case 'cond_wall_ahead':
      if (p.direction === 'left_closer') return lang === 'en' ? 'L<R' : '左<右';
      if (p.direction === 'front_left') return lang === 'en' ? `FL${p.dist}` : `左前${p.dist}px`;
      if (p.direction === 'front_right') return lang === 'en' ? `FR${p.dist}` : `右前${p.dist}px`;
      return `${p.dist}px`;
    case 'cond_proximity':
      if (p.mode === 'front') return lang === 'en' ? `F<=${p.dist ?? 90}` : `前${p.dist ?? 90}px`;
      if (p.mode === 'left_closer') return lang === 'en' ? 'L<R' : '左<右';
      if (p.mode === 'left_open') return lang === 'en' ? `LO>${p.dist ?? 90}` : `左空>${p.dist ?? 90}`;
      if (p.mode === 'right_open') return lang === 'en' ? `RO>${p.dist ?? 90}` : `右空>${p.dist ?? 90}`;
      return `${p.dist ?? 90}px`;
    case 'cond_hit_from':
      return `${p.zone ?? 'any'}`;
    case 'cond_hp_below':
      return `<=${p.percent}%`;
    case 'cond_counter': {
      const reg = String(p.reg ?? 'A') === 'ENEMY_DIST' ? 'ed' : String(p.reg ?? 'A').toLowerCase();
      return `${reg}${p.op === 'gte' ? '>=' : p.op === 'lte' ? '<=' : p.op === 'eq' ? '==' : '%'}${p.value}`;
    }
    case 'counter_op': {
      const reg = String(p.reg ?? 'A').toLowerCase();
      return `${reg}${p.op === 'inc' ? '+=' : p.op === 'dec' ? '-=' : '='}${p.value}`;
    }
    case 'random_op': {
      const reg = String(p.reg ?? 'A').toLowerCase();
      return `${reg}=rand(${p.min ?? 0},${p.max ?? 1})`;
    }
    case 'mode_set':
    case 'cond_mode':
      return `m=${p.mode}`;
    case 'cond_floor_tile': {
      const t = String(p.target ?? 'goal');
      const edgeTag = Number(p.edge ?? 0) === 1 ? (lang === 'en' ? ' [1x]' : ' [踏]') : '';
      const base =
        t === 'goal'
          ? lang === 'en'
            ? 'goal'
            : 'ゴール'
          : t === 'checkpoint'
            ? lang === 'en'
              ? 'cp'
              : 'CP'
            : t === 'any_color'
              ? lang === 'en'
                ? 'color'
                : '色床'
              : t === 'hazard'
                ? lang === 'en'
                  ? 'hazard'
                  : '危険'
                : t;
      return `${base}${edgeTag}`;
    }
    case 'cond_mission_state': {
      const chk = String(p.check ?? 'targets_remaining');
      if (chk === 'targets_cleared') return lang === 'en' ? 'tgt=0' : '的=0';
      if (chk === 'checkpoints_remaining') return lang === 'en' ? 'cp>0' : 'CP>0';
      if (chk === 'checkpoints_cleared') return lang === 'en' ? 'cp=0' : 'CP済';
      return lang === 'en' ? 'tgt>0' : '的>0';
    }
    case 'act_halt':
      return '';
    default:
      return '';
  }
}

interface SyntaxHelpInfo {
  conceptTag: string;
  signatureInfo: string;
  pythonSyntax: string;
  learningTip: string;
}

interface CodeLine {
  text: string;
  coord?: GridCoord;
  indent?: number;
  syntaxHelp?: SyntaxHelpInfo;
}

function formatPythonConditionExpr(type: ChipType, params: Record<string, string | number>): string {
  const p = params;
  switch (type) {
    case 'loop_while':
      if (p.cond === 'enemy_not_detected') return 'not enemy_detected()';
      if (p.cond === 'wall_ahead') return `wall_ahead() <= ${p.value}`;
      if (p.cond === 'turret_not_aligned') return `abs(aim_error()) > ${p.value}`;
      return `a < ${p.value}`;
    case 'cond_enemy_detected':
      return `enemy_detected(max_age=${p.maxAgeTicks ?? 12})`;
    case 'cond_enemy_dist':
      return `enemy_dist ${p.op === 'gte' ? '>=' : '<='} ${p.dist ?? 300}`;
    case 'cond_enemy_sector':
      return `enemy_in_sector(ref="${p.ref ?? 'turret'}", center=${p.centerAngle ?? 0}, width=${p.halfWidth ?? 20}, dist=${p.maxDist ?? 700})`;
    case 'cond_wall_ahead':
      return `wall_near(dir="${p.direction ?? 'front'}", dist=${p.dist ?? 110})`;
    case 'cond_proximity':
      return `proximity_near(mode="${p.mode ?? 'approaching'}", target="${p.target ?? 'all'}", dist=${p.dist ?? 90})`;
    case 'cond_hit_from':
      return `hit_from(zone="${p.zone ?? 'any'}", ticks=${p.ticks ?? 20})`;
    case 'cond_gun_ready':
      return 'main_cooldown == 0';
    case 'cond_sub_ready':
      return 'sp_cooldown == 0';
    case 'cond_hp_below':
      return `hp_percent <= ${p.percent ?? 45}`;
    case 'cond_counter': {
      const reg = String(p.reg ?? 'A') === 'ENEMY_DIST' ? 'enemy_dist' : String(p.reg ?? 'A').toLowerCase();
      const op = p.op === 'gte' ? '>=' : p.op === 'lte' ? '<=' : p.op === 'eq' ? '==' : '%';
      return p.op === 'mod0' ? `${reg} % ${p.value} == 0` : `${reg} ${op} ${p.value}`;
    }
    case 'cond_incoming_shell':
      return `incoming_shell(radius=${p.maxDist ?? 220})`;
    case 'cond_under_lock':
      return 'under_lock()';
    case 'cond_mode':
      return `mode == ${p.mode ?? 1}`;
    case 'cond_floor_tile': {
      const edgeSuffix = Number(p.edge ?? 0) === 1 ? ', edge=True' : '';
      return `on_tile("${p.target ?? 'goal'}"${edgeSuffix})`;
    }
    case 'cond_mission_state': {
      const check = String(p.check ?? 'targets_remaining');
      if (check === 'targets_cleared') return 'targets_left() == 0';
      if (check === 'checkpoints_remaining') return 'checkpoints_left() > 0';
      if (check === 'checkpoints_cleared') return 'checkpoints_done()';
      return 'targets_left() > 0';
    }
    default:
      return 'True';
  }
}

function formatPythonActionStmt(type: ChipType, params: Record<string, string | number>): string {
  const p = params;
  switch (type) {
    case 'start':
      return 'def on_tick():';
    case 'wire':
      return `time.sleep(${Number(p.seconds ?? 0)})`;
    case 'sub_def':
      return `def sub_${String(p.sub ?? 'A').toLowerCase()}():`;
    case 'sub_call':
      return `sub_${String(p.sub ?? 'A').toLowerCase()}()`;
    case 'counter_op': {
      const reg = String(p.reg ?? 'A').toLowerCase();
      const op = p.op === 'inc' ? '+=' : p.op === 'dec' ? '-=' : '=';
      return `${reg} ${op} ${p.value}`;
    }
    case 'random_op': {
      const reg = String(p.reg ?? 'A').toLowerCase();
      return `${reg} = random.randint(${p.min ?? 0}, ${p.max ?? 1})`;
    }
    case 'mode_set':
      return `mode = ${p.mode ?? 1}`;
    case 'act_halt':
      return 'stop()';
    case 'act_move':
      return Number(p.duration ?? 0) > 0
        ? `move(speed=${p.speedPercent ?? 80}, duration=${p.duration})`
        : `move(speed=${p.speedPercent ?? 80})`;
    case 'act_turn_body': {
      const waitSuffix = Number(p.wait ?? 0) === 1 ? ', wait=True' : '';
      return `turn_body(mode="${p.mode ?? 'auto'}", angle=${p.angle ?? 4}${waitSuffix})`;
    }
    case 'act_turn_turret': {
      const waitSuffix = Number(p.wait ?? 0) === 1 ? ', wait=True' : '';
      return `turn_turret(mode="${p.mode ?? 'auto'}", angle=${p.angle ?? 6}${waitSuffix})`;
    }
    case 'act_aim_enemy':
      return `aim_enemy(lead="${p.lead ?? 'direct'}", offset=${p.offset ?? 0})`;
    case 'act_turn_radar':
      return p.mode === 'lock_enemy'
        ? 'turn_radar(mode="lock_enemy")'
        : `turn_radar(mode="${p.mode ?? 'sweep'}", angle=${p.angle ?? 60})`;
    case 'act_fire': {
      const waitSuffix = Number(p.wait ?? 0) === 1 ? ', wait=True' : '';
      return `fire_main(power="${normalizeFirePowerTier(p.power)}"${waitSuffix})`;
    }
    case 'act_sub_weapon':
      return 'fire_sp()';
    default:
      return `${type}()`;
  }
}

function formatPythonPrintStmt(type: ChipType, params: Record<string, string | number>): string {
  switch (type) {
    case 'cond_enemy_detected':
      return 'print(f"detected={enemy_detected()}")';
    case 'cond_enemy_dist':
      return 'print(f"enemy_dist={enemy_dist}")';
    case 'cond_gun_ready':
      return 'print(f"main_cd={main_cooldown}")';
    case 'cond_sub_ready':
      return 'print(f"sp_cd={sp_cooldown}")';
    case 'cond_hp_below':
      return 'print(f"hp={hp_percent}%")';
    case 'cond_under_lock':
      return 'print(f"under_lock={under_lock()}")';
    case 'cond_counter': {
      const v =
        String(params.reg ?? 'A') === 'ENEMY_DIST'
          ? 'enemy_dist'
          : String(params.reg ?? 'A').toLowerCase();
      return `print(f"${v}={${v}}")`;
    }
    case 'counter_op':
    case 'random_op': {
      const v = String(params.reg ?? 'A').toLowerCase();
      return `print(f"${v}={${v}}")`;
    }
    case 'mode_set':
    case 'cond_mode':
      return 'print(f"mode={mode}")';
    default: {
      const def = CHIP_DEFINITIONS[type];
      const expr = def.isCondition
        ? formatPythonConditionExpr(type, params)
        : formatPythonActionStmt(type, params);
      return `print("${expr.replace(/"/g, "'")}")`;
    }
  }
}

function buildLivePythonSyntax(
  type: ChipType,
  params?: Record<string, string | number>
): string {
  const def = CHIP_DEFINITIONS[type];
  if (!params) return def.pythonSyntax;
  if (type === 'loop_while') return `while ${formatPythonConditionExpr(type, params)}:`;
  if (type === 'loop_for') return `for i in range(${params.iterations ?? 15}):`;
  if (def.isCondition) return `if ${formatPythonConditionExpr(type, params)}:`;
  return formatPythonActionStmt(type, params);
}

export function transpileProgramToLines(
  program: ChipProgram,
  tankName: string,
  withJaComments: boolean,
  radarId: RadarId = 'balanced',
  chassisId: ChassisId = 'standard',
  mainGunId: MainGunId = 'standard',
  subWeaponId: SubWeaponId = 'missile',
  _color?: string
): CodeLine[] {
  const start = findStartCell(program.cells);
  const safeName = tankName.replace(/"/g, '\\"');
  const usesRandom = program.cells.some((row) => row.some((c) => c?.type === 'random_op'));
  const cSpec = CHASSIS_SPECS[chassisId] ?? CHASSIS_SPECS.standard;
  const rSpec = RADAR_SPECS[radarId] ?? RADAR_SPECS.balanced;
  const gSpec = MAIN_GUN_SPECS[mainGunId] ?? MAIN_GUN_SPECS.standard;
  const sSpec = SUB_WEAPON_SPECS[subWeaponId] ?? SUB_WEAPON_SPECS.missile;

  const importTimeHelp: SyntaxHelpInfo = {
    conceptTag: '標準モジュール読み込み (import)',
    signatureInfo: 'モジュール: time (待機・時間制御)',
    pythonSyntax: 'import time',
    learningTip:
      'Pythonに最初から用意されている「標準ライブラリ」の time モジュールを読み込みます。これにより time.sleep() が使えるようになります。',
  };
  const importRandomHelp: SyntaxHelpInfo = {
    conceptTag: '標準モジュール読み込み (import)',
    signatureInfo: 'モジュール: random (乱数生成)',
    pythonSyntax: 'import random',
    learningTip:
      'ランダムな整数や選択肢を作る標準モジュール random を読み込みます。random.randint(a, b) でa以上b以下の整数を生成できます。',
  };
  const tankNameHelp: SyntaxHelpInfo = {
    conceptTag: '変数代入 (文字列リテラル str)',
    signatureInfo: '代入: tank_name: str → 自機名称の設定',
    pythonSyntax: `tank_name = "${safeName}"`,
    learningTip:
      'ダブルクォーテーション "..." で囲むと「文字列（テキストデータ）」になります。変数 tank_name に自戦車の名前を代入しています。',
  };
  const chassisCodeText = `chassis = {"type": "${cSpec.id}", "hp": ${cSpec.maxHp}, "speed": ${cSpec.maxSpeed}, "turn": ${cSpec.turnRate}}`;
  const chassisHelp: SyntaxHelpInfo = {
    conceptTag: '辞書リテラルとハードウェア設定 (dict)',
    signatureInfo: `規定シャシー: ${cSpec.id} (HP${cSpec.maxHp} / 速度${cSpec.maxSpeed} / 旋回${cSpec.turnRate}°)`,
    pythonSyntax: chassisCodeText,
    learningTip:
      '搭載シャシーの種類・最大HP・最高速度・旋回性能を表す辞書データです。異常値や規定外名の場合は自動でプリセット／標準構成へ補正されます。',
  };
  const radarCodeText = `radar = {"type": "${rSpec.id}", "fov": ${rSpec.fovDeg}, "range": ${rSpec.range}, "turn": ${rSpec.turnRate}}`;
  const radarHelp: SyntaxHelpInfo = {
    conceptTag: '辞書リテラルとハードウェア設定 (dict)',
    signatureInfo: `規定レーダー: ${rSpec.id} (視野${rSpec.fovDeg}° / 射程${rSpec.range}px / 旋回${rSpec.turnRate}°)`,
    pythonSyntax: radarCodeText,
    learningTip:
      '{} は Python の辞書(dict)です。搭載レーダーの種類と視野角・射程・旋回速度を保持します。異常値や規定外名の場合は自動でプリセット／標準構成へ補正されます。',
  };
  const mainGunCodeText = `main_gun = {"type": "${gSpec.id}", "damage": ${gSpec.damageMultiplier}, "cooling": ${gSpec.coolingRate}, "turn": ${gSpec.turretTurnRate}}`;
  const mainGunHelp: SyntaxHelpInfo = {
    conceptTag: '辞書リテラルとハードウェア設定 (dict)',
    signatureInfo: `規定主砲: ${gSpec.id} (威力x${gSpec.damageMultiplier} / 冷却${gSpec.coolingRate} / 旋回${gSpec.turretTurnRate}°)`,
    pythonSyntax: mainGunCodeText,
    learningTip:
      '搭載主砲の種類・ダメージ倍率・冷却速度・砲塔旋回速度を表す辞書データです。異常値や規定外名の場合は自動でプリセット／標準構成へ補正されます。',
  };
  const subWeaponCodeText = `special = {"type": "${sSpec.id}", "ammo": ${sSpec.maxAmmo}, "cooldown": ${sSpec.cooldownTicks}}`;
  const subWeaponHelp: SyntaxHelpInfo = {
    conceptTag: '辞書リテラルとハードウェア設定 (dict)',
    signatureInfo: `規定Special兵装: ${sSpec.id} (回数${sSpec.maxAmmo} / クールダウン${sSpec.cooldownTicks}t)`,
    pythonSyntax: subWeaponCodeText,
    learningTip:
      '搭載Special (SP) 兵装の種類・最大回数・クールダウンTick数を表す辞書データです。異常値や規定外名の場合は自動でプリセット／標準構成へ補正されます。',
  };
  const elseHelp: SyntaxHelpInfo = {
    conceptTag: '条件分岐の反対側 (else節)',
    signatureInfo: '直前の if 条件が False のときだけ実行',
    pythonSyntax: 'else:',
    learningTip:
      'if の条件が成り立たなかった（False）側の処理をインデントして書きます。2Dグリッドの赤い矢印がこの else: に対応します。',
  };

  if (!start) {
    return [
      { text: 'import time', syntaxHelp: importTimeHelp },
      ...(usesRandom ? [{ text: 'import random', syntaxHelp: importRandomHelp }] : []),
      { text: `tank_name = "${safeName}"`, syntaxHelp: tankNameHelp },
      { text: chassisCodeText, syntaxHelp: chassisHelp },
      {
        text: withJaComments
          ? `${radarCodeText}  # ${rSpec.name}`
          : radarCodeText,
        syntaxHelp: radarHelp,
      },
      { text: mainGunCodeText, syntaxHelp: mainGunHelp },
      { text: subWeaponCodeText, syntaxHelp: subWeaponHelp },
      { text: '# START チップが見つかりません' },
    ];
  }
  const lines: CodeLine[] = [
    { text: 'import time', syntaxHelp: importTimeHelp },
    ...(usesRandom ? [{ text: 'import random', syntaxHelp: importRandomHelp }] : []),
    {
      text: withJaComments
        ? `tank_name = "${safeName}"  # 自戦車の名前`
        : `tank_name = "${safeName}"`,
      syntaxHelp: tankNameHelp,
    },
    {
      text: withJaComments
        ? `${chassisCodeText}  # ${cSpec.name} (HP${cSpec.maxHp} / 速度${cSpec.maxSpeed} / 旋回${cSpec.turnRate}°)`
        : chassisCodeText,
      syntaxHelp: chassisHelp,
    },
    {
      text: withJaComments
        ? `${radarCodeText}  # ${rSpec.name} (視野${rSpec.fovDeg}° / 射程${rSpec.range}px / 旋回${rSpec.turnRate}°)`
        : radarCodeText,
      syntaxHelp: radarHelp,
    },
    {
      text: withJaComments
        ? `${mainGunCodeText}  # ${gSpec.name} (威力x${gSpec.damageMultiplier} / 冷却${gSpec.coolingRate} / 旋回${gSpec.turretTurnRate}°)`
        : mainGunCodeText,
      syntaxHelp: mainGunHelp,
    },
    {
      text: withJaComments
        ? `${subWeaponCodeText}  # ${sSpec.name} (回数${sSpec.maxAmmo} / クールダウン${sSpec.cooldownTicks}t)`
        : subWeaponCodeText,
      syntaxHelp: subWeaponHelp,
    },
  ];

  const collectReachable = (
    origin: GridCoord | null | undefined,
    blocked: Set<string>,
    stopKey: string | null
  ): GridCoord[] => {
    if (!origin) return [];
    const seen = new Set<string>();
    const order: GridCoord[] = [];
    const queue: GridCoord[] = [origin];
    while (queue.length > 0) {
      const c = queue.shift()!;
      const k = `${c.x},${c.y}`;
      if (seen.has(k) || blocked.has(k) || (stopKey && k === stopKey)) continue;
      const cell = program.cells[c.y]?.[c.x];
      if (!cell) continue;
      seen.add(k);
      order.push(c);
      const def = CHIP_DEFINITIONS[cell.type];
      if (def.isCondition) {
        if (cell.yes) queue.push(cell.yes);
        if (cell.no) queue.push(cell.no);
      } else if (cell.next) {
        queue.push(cell.next);
      }
    }
    return order;
  };

  const findReconvergenceJoin = (
    yesCoord: GridCoord | null | undefined,
    noCoord: GridCoord | null | undefined,
    blocked: Set<string>,
    stopKey: string | null
  ): GridCoord | null => {
    if (!yesCoord || !noCoord) return null;
    const yesOrder = collectReachable(yesCoord, blocked, stopKey);
    const noOrder = collectReachable(noCoord, blocked, stopKey);
    const noSet = new Set(noOrder.map((c) => `${c.x},${c.y}`));
    const yesKey = `${yesCoord.x},${yesCoord.y}`;
    const noKey = `${noCoord.x},${noCoord.y}`;
    for (const cand of yesOrder) {
      const ck = `${cand.x},${cand.y}`;
      if (ck === yesKey) continue;
      if (ck === noKey || noSet.has(ck)) {
        return cand;
      }
    }
    return null;
  };

  const walk = (
    coord: GridCoord | null | undefined,
    indent: number,
    ancestors: Set<string>,
    depth: number,
    stopKey: string | null
  ) => {
    if (!coord) return;
    if (depth > 28) {
      lines.push({ text: `${'  '.repeat(indent)}# ...` });
      return;
    }
    const key = `${coord.x},${coord.y}`;
    if (stopKey && key === stopKey) {
      return;
    }
    const cell = program.cells[coord.y]?.[coord.x];
    if (!cell) return;

    if (ancestors.has(key)) {
      lines.push({
        text: `${'  '.repeat(indent)}continue  # (${coord.x},${coord.y}) へ戻る`,
        coord,
        indent,
        syntaxHelp: {
          conceptTag: 'ループ先頭への復帰 (continue / 循環)',
          signatureInfo: '矢印が上位ブロックに戻っている循環配線',
          pythonSyntax: 'continue',
          learningTip:
            '2Dグリッド上で矢印が前のブロックへ戻っている循環を表します。Pythonのループ内で continue を使うと先頭に戻って次の反復へ移ります。',
        },
      });
      return;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(key);
    const pad = '  '.repeat(indent);
    const def = CHIP_DEFINITIONS[cell.type];
    const jaSuffix = withJaComments ? `  # ${def.name}` : '';

    if (cell.type === 'start' || cell.type === 'sub_def') {
      walk(cell.next, indent, nextAncestors, depth + 1, stopKey);
      return;
    }

    if (Number(cell.params._print ?? 0) === 1) {
      const printText = formatPythonPrintStmt(cell.type, cell.params);
      lines.push({
        text: `${pad}${printText}`,
        coord,
        indent,
        syntaxHelp: {
          conceptTag: 'デバッグ出力 (print / f-string)',
          signatureInfo: '引数: str → 戦車の頭上に吹き出し表示 (0ブロック)',
          pythonSyntax: printText,
          learningTip:
            'print() は実行中の値や通った処理を確認するデバッグ出力です。f"..." (f文字列) を使うと {変数名} にその瞬間の数値が埋め込まれ、戦車の上の吹き出しで動きを観察できます（ブロック数は消費しません）。',
        },
      });
    }

    if (cell.type === 'wire') {
      lines.push({
        text: `${pad}${formatPythonActionStmt(cell.type, cell.params)}${jaSuffix}`,
        coord,
        indent,
      });
      if (cell.next) {
        walk(cell.next, indent, nextAncestors, depth + 1, stopKey);
      }
      return;
    }

    if (cell.type === 'loop_while') {
      lines.push({
        text: `${pad}while ${formatPythonConditionExpr(cell.type, cell.params)}:${jaSuffix}`,
        coord,
        indent,
      });
      if (cell.yes) {
        walk(cell.yes, indent + 1, nextAncestors, depth + 1, stopKey);
      } else {
        lines.push({ text: `${pad}  time.sleep(0)  # 反復処理未接続`, indent: indent + 1 });
      }
      if (cell.no) {
        walk(cell.no, indent, nextAncestors, depth + 1, stopKey);
      }
      return;
    }

    if (cell.type === 'loop_for') {
      lines.push({
        text: `${pad}for i in range(${cell.params.iterations ?? 15}):${jaSuffix}`,
        coord,
        indent,
      });
      if (cell.yes) {
        walk(cell.yes, indent + 1, nextAncestors, depth + 1, stopKey);
      } else {
        lines.push({ text: `${pad}  time.sleep(0)  # 反復処理未接続`, indent: indent + 1 });
      }
      if (cell.no) {
        walk(cell.no, indent, nextAncestors, depth + 1, stopKey);
      }
      return;
    }

    if (def.isCondition) {
      const joinCoord = findReconvergenceJoin(cell.yes, cell.no, nextAncestors, stopKey);
      const branchStopKey = joinCoord ? `${joinCoord.x},${joinCoord.y}` : stopKey;
      const noIsJoin = Boolean(
        joinCoord && cell.no && cell.no.x === joinCoord.x && cell.no.y === joinCoord.y
      );

      lines.push({
        text: `${pad}if ${formatPythonConditionExpr(cell.type, cell.params)}:${jaSuffix}`,
        coord,
        indent,
      });
      if (cell.yes) {
        walk(cell.yes, indent + 1, nextAncestors, depth + 1, branchStopKey);
      } else {
        lines.push({ text: `${pad}  time.sleep(0)  # True側未接続`, indent: indent + 1 });
      }
      if (cell.no && !noIsJoin) {
        lines.push({ text: `${pad}else:`, coord, indent, syntaxHelp: elseHelp });
        walk(cell.no, indent + 1, nextAncestors, depth + 1, branchStopKey);
      }
      if (joinCoord) {
        walk(joinCoord, indent, nextAncestors, depth + 1, stopKey);
      }
      return;
    }

    lines.push({
      text: `${pad}${formatPythonActionStmt(cell.type, cell.params)}${jaSuffix}`,
      coord,
      indent,
    });
    if (cell.type !== 'act_halt') {
      walk(cell.next, indent, nextAncestors, depth + 1, stopKey);
    }
  };

  // Emit defined subroutines (def sub_a(): .. def sub_d():) before def on_tick():
  const subOrder = ['A', 'B', 'C', 'D'] as const;
  const subEntries: Array<{ key: string; coord: GridCoord; cell: GridCell }> = [];
  for (let y = 0; y < program.cells.length; y++) {
    for (let x = 0; x < (program.cells[y]?.length ?? 0); x++) {
      const c = program.cells[y]?.[x];
      if (c?.type === 'sub_def') {
        const subKey = String(c.params.sub ?? 'A').toUpperCase();
        subEntries.push({ key: subKey, coord: { x, y }, cell: c });
      }
    }
  }
  subEntries.sort(
    (a, b) =>
      subOrder.indexOf(a.key as (typeof subOrder)[number]) -
      subOrder.indexOf(b.key as (typeof subOrder)[number])
  );
  for (const entry of subEntries) {
    lines.push({
      text: withJaComments
        ? `def sub_${entry.key.toLowerCase()}():  # サブルーチン ${entry.key}`
        : `def sub_${entry.key.toLowerCase()}():`,
      coord: entry.coord,
      indent: 0,
    });
    const subBodyStart = lines.length;
    walk(entry.coord, 1, new Set(), 0, null);
    if (lines.length === subBodyStart) {
      lines.push({ text: '  time.sleep(0)', indent: 1 });
    }
  }

  lines.push({
    text: withJaComments ? 'def on_tick():  # 毎Tick (1/20秒) 実行' : 'def on_tick():',
    coord: start,
    indent: 0,
  });
  const onTickStart = lines.length;
  walk(start, 1, new Set(), 0, null);
  if (lines.length === onTickStart) {
    lines.push({ text: '  time.sleep(0)', indent: 1 });
  }
  return lines;
}

function getCategoryClass(category: ChipCategory): string {
  switch (category) {
    case 'flow':
      return 'chip-flow';
    case 'condition':
      return 'chip-cond';
    case 'action':
      return 'chip-act';
    case 'sub':
      return 'chip-sub';
  }
}

export const GridEditor: React.FC<GridEditorProps> = ({
  program,
  cpuId,
  chassisId = 'standard',
  radarId = 'balanced',
  mainGunId = 'standard',
  subWeaponId = 'missile',
  tankName,
  trace,
  isPlaying,
  allowedChips,
  allowLearningChips = false,
  mobileMode = false,
  requestedSidebarTab = null,
  onChangeProgram,
  onChangeTankName,
  onChangeChassis,
  onChangeRadar,
  onChangeMainGun,
  onChangeSubWeapon,
  onImportBlueprint,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedCoord, setSelectedCoord] = useState<GridCoord | null>({ x: 0, y: 0 });
  const [placingChip, setPlacingChip] = useState<ChipType | null>(null);
  const [movingFromCoord, setMovingFromCoord] = useState<GridCoord | null>(null);
  const [activePaletteCategory, setActivePaletteCategory] = useState<ChipCategory | 'all'>('all');
  const [showAllTutorialChips, setShowAllTutorialChips] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<'palette' | 'code'>('palette');
  const [mobilePartsExpanded, setMobilePartsExpanded] = useState(false);
  const [mobileGuideExpanded, setMobileGuideExpanded] = useState(false);
  const [codeWrap, setCodeWrap] = useState(false);

  useEffect(() => {
    setShowAllTutorialChips(false);
  }, [allowedChips]);

  useEffect(() => {
    if (requestedSidebarTab) {
      setSidebarMode(requestedSidebarTab.mode);
    }
  }, [requestedSidebarTab]);
  const [displayLang, setDisplayLang] = useState<DisplayLang>('ja');
  const [codeJaComments, setCodeJaComments] = useState<boolean>(true);
  const [hoveredChipType, setHoveredChipType] = useState<ChipType | null>(null);
  const [hoveredCell, setHoveredCell] = useState<GridCell | null>(null);
  const [hoveredCoord, setHoveredCoord] = useState<GridCoord | null>(null);
  const [hoveredCodeLine, setHoveredCodeLine] = useState<CodeLine | null>(null);
  const [tooltipSize, setTooltipSize] = useState<'md' | 'lg' | 'xl'>('lg');
  const [tooltipPosition, setTooltipPosition] = useState<'bottom' | 'top'>('bottom');
  const [gridSizeNotice, setGridSizeNotice] = useState<{
    type: 'error' | 'info';
    text: string;
  } | null>(null);
  const [codeEditMode, setCodeEditMode] = useState<boolean>(false);
  const [sourceDraft, setSourceDraft] = useState<string>('');

  const safeChassisId = isAllowedChassisId(chassisId) ? chassisId : STANDARD_SETUP.chassis;
  const safeRadarId = isAllowedRadarId(radarId) ? radarId : STANDARD_SETUP.radar;
  const safeMainGunId = isAllowedMainGunId(mainGunId) ? mainGunId : STANDARD_SETUP.mainGun;
  const safeSubWeaponId = isAllowedSubWeaponId(subWeaponId)
    ? subWeaponId
    : STANDARD_SETUP.subWeapon;

  useEffect(() => {
    const corrected: string[] = [];
    if (!isAllowedChassisId(chassisId)) {
      corrected.push(`シャシー "${String(chassisId)}" → "${STANDARD_SETUP.chassis}"`);
      onChangeChassis?.(STANDARD_SETUP.chassis);
    }
    if (!isAllowedRadarId(radarId)) {
      corrected.push(`レーダー "${String(radarId)}" → "${STANDARD_SETUP.radar}"`);
      onChangeRadar?.(STANDARD_SETUP.radar);
    }
    if (!isAllowedMainGunId(mainGunId)) {
      corrected.push(`主砲 "${String(mainGunId)}" → "${STANDARD_SETUP.mainGun}"`);
      onChangeMainGun?.(STANDARD_SETUP.mainGun);
    }
    if (!isAllowedSubWeaponId(subWeaponId)) {
      corrected.push(`サブ兵装 "${String(subWeaponId)}" → "${STANDARD_SETUP.subWeapon}"`);
      onChangeSubWeapon?.(STANDARD_SETUP.subWeapon);
    }
    if (corrected.length > 0) {
      setGridSizeNotice({
        type: 'info',
        text: `異常値・規定外設定を標準セットアップへ自動補正しました: ${corrected.join(', ')}`,
      });
    }
  }, [
    chassisId,
    radarId,
    mainGunId,
    subWeaponId,
    onChangeChassis,
    onChangeRadar,
    onChangeMainGun,
    onChangeSubWeapon,
  ]);

  const codeLines = useMemo(
    () =>
      transpileProgramToLines(
        program,
        tankName,
        codeJaComments,
        safeRadarId,
        safeChassisId,
        safeMainGunId,
        safeSubWeaponId
      ),
    [
      program,
      tankName,
      codeJaComments,
      safeRadarId,
      safeChassisId,
      safeMainGunId,
      safeSubWeaponId,
    ]
  );
  const usedBlockCount = useMemo(() => countGridBlocks(program.cells), [program.cells]);
  const programPowerError = useMemo(() => validateFirePowerInCells(program.cells), [program.cells]);
  const hardwareError: string | null = null;
  const liveParseResult = useMemo(
    () =>
      codeEditMode
        ? parsePythonSourceToProgram(sourceDraft, program.gridSize, program.coordinateMode)
        : null,
    [codeEditMode, sourceDraft, program.gridSize, program.coordinateMode]
  );

  const cpuSpec = CPU_SPECS[cpuId];
  const size = program.gridSize;

  const selectedCell = useMemo(() => {
    if (!selectedCoord) return null;
    return program.cells[selectedCoord.y]?.[selectedCoord.x] ?? null;
  }, [program.cells, selectedCoord]);

  const { activeVisitedSet, activeStepMap, lastVisitedKey, hasActiveTrace } = useMemo(() => {
    const s = new Set<string>();
    const stepMap = new Map<string, number>();
    let lastKey: string | null = null;
    if (trace && trace.visited.length > 0) {
      trace.visited.forEach((c, idx) => {
        const key = `${c.x},${c.y}`;
        s.add(key);
        if (!stepMap.has(key)) {
          stepMap.set(key, idx + 1);
        }
        lastKey = key;
      });
    }
    return {
      activeVisitedSet: s,
      activeStepMap: stepMap,
      lastVisitedKey: lastKey,
      hasActiveTrace: Boolean(trace && trace.visited.length > 0),
    };
  }, [trace]);

  const activeEdgeSet = useMemo(() => {
    const s = new Set<string>();
    if (trace) {
      for (const e of trace.edges) {
        s.add(`${e.from.x},${e.from.y}->${e.to.x},${e.to.y}:${e.branch}`);
      }
    }
    return s;
  }, [trace]);

  const cloneCells = (cells: (GridCell | null)[][]): (GridCell | null)[][] =>
    cells.map((row) =>
      row.map((cell) =>
        cell
          ? {
              ...cell,
              params: { ...cell.params },
              next: cell.next ? { ...cell.next } : null,
              yes: cell.yes ? { ...cell.yes } : null,
              no: cell.no ? { ...cell.no } : null,
            }
          : null
      )
    );

  const handleCoordinateModeChange = (mode: CoordinateMode) => {
    onChangeProgram({
      ...program,
      coordinateMode: mode,
    });
  };

  const handleSelectGridSize = (nextSize: GridSize) => {
    if (nextSize === size) return;
    const fit = validateGridBlockFit(program.cells, nextSize);
    if (!fit.valid) {
      setGridSizeNotice({ type: 'error', text: fit.message });
      return;
    }

    const nextCells = createEmptyCells(nextSize);
    const coordMap = new Map<string, GridCoord>();

    // First pass: place cells that already fit inside nextSize
    for (let y = 0; y < program.cells.length; y++) {
      for (let x = 0; x < (program.cells[y]?.length ?? 0); x++) {
        const cell = program.cells[y][x];
        if (!cell) continue;
        if (x < nextSize && y < nextSize) {
          nextCells[y][x] = {
            ...cell,
            params: { ...cell.params },
          };
          coordMap.set(`${x},${y}`, { x, y });
        }
      }
    }

    // Second pass: relocate any out-of-bounds cells into free slots if compacting
    for (let y = 0; y < program.cells.length; y++) {
      for (let x = 0; x < (program.cells[y]?.length ?? 0); x++) {
        const cell = program.cells[y][x];
        if (!cell) continue;
        if (x >= nextSize || y >= nextSize) {
          let placed: GridCoord | null = null;
          for (let ny = 0; ny < nextSize && !placed; ny++) {
            for (let nx = 0; nx < nextSize && !placed; nx++) {
              if (nextCells[ny][nx] === null) {
                placed = { x: nx, y: ny };
              }
            }
          }
          if (placed) {
            nextCells[placed.y][placed.x] = {
              ...cell,
              params: { ...cell.params },
            };
            coordMap.set(`${x},${y}`, placed);
          }
        }
      }
    }

    // Remap outgoing links within compact bounds and drop non-orthogonal (jump) links
    const remapLink = (
      rx: number,
      ry: number,
      link: GridCoord | null | undefined
    ): GridCoord | null => {
      if (!link) return null;
      const mapped = coordMap.get(`${link.x},${link.y}`) ?? null;
      if (!mapped) return null;
      return Math.abs(mapped.x - rx) + Math.abs(mapped.y - ry) === 1 ? mapped : null;
    };
    for (let ny = 0; ny < nextSize; ny++) {
      for (let nx = 0; nx < nextSize; nx++) {
        const c = nextCells[ny][nx];
        if (!c) continue;
        c.next = remapLink(nx, ny, c.next);
        c.yes = remapLink(nx, ny, c.yes);
        c.no = remapLink(nx, ny, c.no);
      }
    }

    if (fit.outOfBoundsCount > 0) {
      setGridSizeNotice({
        type: 'info',
        text: `範囲外の ${fit.outOfBoundsCount} ブロックを ${nextSize}×${nextSize} 内に自動再配置しました。`,
      });
    } else {
      setGridSizeNotice(null);
    }

    if (selectedCoord && (selectedCoord.x >= nextSize || selectedCoord.y >= nextSize)) {
      setSelectedCoord({ x: 0, y: 0 });
    }

    onChangeProgram({
      ...program,
      gridSize: nextSize,
      cells: nextCells,
    });
  };

  const handleEnterCodeEdit = () => {
    setSourceDraft(codeLines.map((l) => l.text).join('\n'));
    setCodeEditMode(true);
  };

  const handleApplySourceToGrid = () => {
    if (!liveParseResult || !liveParseResult.ok) return;
    const warningMsg =
      liveParseResult.warnings && liveParseResult.warnings.length > 0
        ? `（自動補正: ${liveParseResult.warnings.join(' / ')}）`
        : '';
    setGridSizeNotice({
      type: 'info',
      text: `ソースを ${size}×${size} グリッドへ反映しました (${liveParseResult.blockCount}/${liveParseResult.maxBlocks} ブロック)。${warningMsg}`,
    });
    onChangeProgram(
      liveParseResult.program,
      liveParseResult.tankName,
      liveParseResult.radarId,
      liveParseResult.chassisId,
      liveParseResult.mainGunId,
      liveParseResult.subWeaponId
    );
    setCodeEditMode(false);
    setSelectedCoord({ x: 0, y: 0 });
  };

  const handleSaveTankFile = () => {
    const bpSnapshot: TankBlueprint = {
      version: 1,
      id: `saved_${Date.now()}`,
      name: tankName.trim() || 'カスタム戦車',
      color: STANDARD_SETUP.color,
      assembly: {
        chassis: safeChassisId,
        radar: safeRadarId,
        mainGun: safeMainGunId,
        subWeapon: safeSubWeaponId,
        cpu: cpuId,
      },
      program,
    };
    exportTankJsonFile(bpSnapshot);
    setGridSizeNotice({
      type: 'info',
      text: `自機「${bpSnapshot.name}」を .vstank.json ファイルに保存しました。`,
    });
  };

  const handleLoadTankFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        const trimmed = text.trim();
        if (!trimmed) {
          setGridSizeNotice({ type: 'error', text: '読み込んだファイルが空です。' });
          return;
        }
        if (looksLikePythonSource(trimmed)) {
          const parsed = parsePythonSourceWithAutoSize(
            trimmed,
            size,
            program.coordinateMode,
            mobileMode ? 8 : 12
          );
          if (!parsed.ok) {
            setGridSizeNotice({ type: 'error', text: parsed.error });
            return;
          }
          const warnText =
            parsed.warnings && parsed.warnings.length > 0
              ? `（自動補正: ${parsed.warnings.join(' / ')}）`
              : '';
          onChangeProgram(
            parsed.program,
            parsed.tankName,
            parsed.radarId,
            parsed.chassisId,
            parsed.mainGunId,
            parsed.subWeaponId
          );
          setGridSizeNotice({
            type: 'info',
            text: `ファイル「${file.name}」のPythonソースを自機へ読み込みました。${warnText}`,
          });
          setSelectedCoord({ x: 0, y: 0 });
          return;
        }

        const bp = trimmed.startsWith('{')
          ? validateAndNormalizeBlueprint(JSON.parse(trimmed))
          : decodeShareCode(trimmed);
        if (onImportBlueprint) {
          onImportBlueprint(bp);
        } else {
          onChangeProgram(
            bp.program,
            bp.name,
            bp.assembly.radar,
            bp.assembly.chassis,
            bp.assembly.mainGun,
            bp.assembly.subWeapon
          );
        }
        setGridSizeNotice({
          type: 'info',
          text: `ファイル「${bp.name}」を自機として読み込みました。`,
        });
        setSelectedCoord({ x: 0, y: 0 });
      } catch (err) {
        setGridSizeNotice({
          type: 'error',
          text: err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました。',
        });
      }
    };
    reader.readAsText(file);
  };

  const placeChipAt = (x: number, y: number, type: ChipType) => {
    const nextCells = cloneCells(program.cells);
    // Only allow one START chip on the board
    if (type === 'start') {
      for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
          if (nextCells[ry][rx]?.type === 'start') {
            nextCells[ry][rx] = null;
          }
        }
      }
    }

    let initialParams: Record<string, string | number> | undefined;
    if (type === 'sub_def') {
      const usedKeys = new Set<string>();
      for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
          const c = nextCells[ry][rx];
          if (c?.type === 'sub_def') {
            usedKeys.add(String(c.params.sub ?? 'A').toUpperCase());
          }
        }
      }
      const nextSubKey = (['A', 'B', 'C', 'D'] as const).find((k) => !usedKeys.has(k)) ?? 'A';
      initialParams = { sub: nextSubKey };
      // Ensure only one sub_def per identifier A..D
      for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
          const c = nextCells[ry][rx];
          if (c?.type === 'sub_def' && String(c.params.sub ?? 'A').toUpperCase() === nextSubKey) {
            nextCells[ry][rx] = null;
          }
        }
      }
    } else if (type === 'sub_call') {
      const existingDefKeys: string[] = [];
      for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
          const c = nextCells[ry][rx];
          if (c?.type === 'sub_def') {
            existingDefKeys.push(String(c.params.sub ?? 'A').toUpperCase());
          }
        }
      }
      if (existingDefKeys.length > 0) {
        initialParams = { sub: existingDefKeys[0] };
      }
    }

    const existing = nextCells[y][x];
    const newCell = makeCell(
      `chip_${Date.now()}_${x}_${y}`,
      type,
      initialParams,
      existing
        ? {
            next: existing.next,
            yes: existing.yes,
            no: existing.no,
          }
        : undefined
    );
    nextCells[y][x] = newCell;
    onChangeProgram({ ...program, cells: nextCells });
    setSelectedCoord({ x, y });
    setPlacingChip(null);
    setMovingFromCoord(null);
  };

  const moveOrSwapCell = (from: GridCoord, tx: number, ty: number) => {
    if (from.x === tx && from.y === ty) return;
    const nextCells = cloneCells(program.cells);
    const moving = nextCells[from.y]?.[from.x];
    if (!moving) return;
    const displaced = nextCells[ty][tx];
    nextCells[ty][tx] = moving;
    nextCells[from.y][from.x] = displaced;
    // Clear outgoing links on moved/displaced chips and incoming links to either coordinate
    moving.next = null;
    moving.yes = null;
    moving.no = null;
    if (displaced) {
      displaced.next = null;
      displaced.yes = null;
      displaced.no = null;
    }
    for (let ry = 0; ry < size; ry++) {
      for (let rx = 0; rx < size; rx++) {
        const c = nextCells[ry][rx];
        if (!c) continue;
        const filterLink = (link: GridCoord | null | undefined) => {
          if (!link) return null;
          if (link.x === from.x && link.y === from.y) return null;
          if (link.x === tx && link.y === ty) return null;
          return Math.abs(link.x - rx) + Math.abs(link.y - ry) === 1 ? link : null;
        };
        c.next = filterLink(c.next);
        c.yes = filterLink(c.yes);
        c.no = filterLink(c.no);
      }
    }
    onChangeProgram({ ...program, cells: nextCells });
    setSelectedCoord({ x: tx, y: ty });
  };

  const handleCellClick = (x: number, y: number) => {
    // 1. If a cell move/swap operation is armed
    if (movingFromCoord) {
      moveOrSwapCell(movingFromCoord, x, y);
      setMovingFromCoord(null);
      return;
    }

    // 2. If a palette chip tool is armed
    if (placingChip) {
      placeChipAt(x, y, placingChip);
      return;
    }

    // 3. Otherwise select this cell
    setSelectedCoord({ x, y });
  };

  const handleClearCell = (coord: GridCoord) => {
    if (movingFromCoord?.x === coord.x && movingFromCoord?.y === coord.y) {
      setMovingFromCoord(null);
    }
    const nextCells = cloneCells(program.cells);
    nextCells[coord.y][coord.x] = null;
    // Remove dangling references pointing to deleted cell
    for (let ry = 0; ry < size; ry++) {
      for (let rx = 0; rx < size; rx++) {
        const c = nextCells[ry][rx];
        if (!c) continue;
        if (c.next?.x === coord.x && c.next?.y === coord.y) c.next = null;
        if (c.yes?.x === coord.x && c.yes?.y === coord.y) c.yes = null;
        if (c.no?.x === coord.x && c.no?.y === coord.y) c.no = null;
      }
    }
    onChangeProgram({ ...program, cells: nextCells });
  };

  const handleClearAll = () => {
    const nextCells = createEmptyCells(size);
    nextCells[0][0] = makeCell(`start_${Date.now()}`, 'start');
    onChangeProgram({ ...program, cells: nextCells });
    setSelectedCoord({ x: 0, y: 0 });
    setPlacingChip(null);
    setMovingFromCoord(null);
  };

  const handleUpdateParam = (key: string, value: string | number) => {
    if (!selectedCoord || !selectedCell) return;
    let nextValue: string | number = value;
    if (selectedCell.type === 'act_fire' && key === 'power') {
      const parsedTier = tryParseFirePowerInput(value, safeMainGunId);
      if (!parsedTier) {
        setGridSizeNotice({
          type: 'error',
          text: `不正なプログラムです: fire_main の火力 (power=${value}) は "fast" / "normal" / "heavy" のいずれかで指定してください。`,
        });
      } else {
        setGridSizeNotice(null);
        nextValue = parsedTier;
      }
    }
    const nextCells = cloneCells(program.cells);
    const cell = nextCells[selectedCoord.y][selectedCoord.x];
    if (!cell) return;
    if (cell.type === 'sub_def' && key === 'sub') {
      const chosen = String(value).toUpperCase();
      for (let ry = 0; ry < size; ry++) {
        for (let rx = 0; rx < size; rx++) {
          if (rx === selectedCoord.x && ry === selectedCoord.y) continue;
          const other = nextCells[ry][rx];
          if (other?.type === 'sub_def' && String(other.params.sub ?? 'A').toUpperCase() === chosen) {
            nextCells[ry][rx] = null;
          }
        }
      }
      cell.params[key] = chosen;
    } else {
      cell.params[key] = nextValue;
      if (
        cell.type === 'act_turn_body' &&
        key === 'mode' &&
        (value === 'turret_rel' || value === 'enemy_rel') &&
        Number(cell.params.angle) === 4
      ) {
        cell.params.angle = 0;
      }
      if (
        cell.type === 'act_turn_turret' &&
        key === 'mode' &&
        value === 'body_rel' &&
        Number(cell.params.angle) === 6
      ) {
        cell.params.angle = 0;
      }
    }
    onChangeProgram({ ...program, cells: nextCells });
  };

  const handleTogglePrint = (enabled: boolean) => {
    if (!selectedCoord || !selectedCell) return;
    const nextCells = cloneCells(program.cells);
    const cell = nextCells[selectedCoord.y][selectedCoord.x];
    if (!cell) return;
    if (enabled) {
      cell.params._print = 1;
    } else {
      delete cell.params._print;
    }
    onChangeProgram({ ...program, cells: nextCells });
  };

  const handleDirectionWire = (branch: 'next' | 'yes' | 'no', dx: number, dy: number) => {
    if (!selectedCoord || !selectedCell) return;
    // Enforce strictly orthogonal 4-direction adjacent links (|dx| + |dy| === 1)
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    const tx = selectedCoord.x + dx;
    const ty = selectedCoord.y + dy;
    if (tx < 0 || tx >= size || ty < 0 || ty >= size) return;
    const nextCells = cloneCells(program.cells);
    const cell = nextCells[selectedCoord.y][selectedCoord.x];
    if (!cell) return;
    const cur = cell[branch];
    cell[branch] = cur && cur.x === tx && cur.y === ty ? null : { x: tx, y: ty };
    onChangeProgram({ ...program, cells: nextCells });
  };

  const handleUnlink = (branch: 'next' | 'yes' | 'no') => {
    if (!selectedCoord || !selectedCell) return;
    const nextCells = cloneCells(program.cells);
    const cell = nextCells[selectedCoord.y][selectedCoord.x];
    if (!cell) return;
    cell[branch] = null;
    onChangeProgram({ ...program, cells: nextCells });
  };

  // Drag & Drop handlers
  const handleDragStartPalette = (e: React.DragEvent, type: ChipType) => {
    e.dataTransfer.setData('application/vstank-chip', type);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragStartCell = (e: React.DragEvent, x: number, y: number) => {
    e.dataTransfer.setData('application/vstank-move', JSON.stringify({ x, y }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDropOnCell = (e: React.DragEvent, tx: number, ty: number) => {
    e.preventDefault();
    const chipType = e.dataTransfer.getData('application/vstank-chip') as ChipType;
    if (chipType && CHIP_DEFINITIONS[chipType]) {
      placeChipAt(tx, ty, chipType);
      return;
    }

    const moveData = e.dataTransfer.getData('application/vstank-move');
    if (moveData) {
      try {
        const from = JSON.parse(moveData) as GridCoord;
        moveOrSwapCell(from, tx, ty);
      } catch {
        // ignore invalid drag payload
      }
    }
  };

  const inspectFocusCoord = hoveredCoord ?? hoveredCodeLine?.coord ?? selectedCoord;
  const focusedTargetMap = useMemo(() => {
    const map = new Map<string, 'next' | 'yes' | 'no'>();
    if (!inspectFocusCoord) return map;
    const cell = program.cells[inspectFocusCoord.y]?.[inspectFocusCoord.x];
    if (!cell) return map;
    const def = CHIP_DEFINITIONS[cell.type];
    if (def.isCondition) {
      if (cell.yes) map.set(`${cell.yes.x},${cell.yes.y}`, 'yes');
      if (cell.no) map.set(`${cell.no.x},${cell.no.y}`, 'no');
    } else if (cell.next) {
      map.set(`${cell.next.x},${cell.next.y}`, 'next');
    }
    return map;
  }, [inspectFocusCoord, program.cells]);

  const subroutinePeerSet = useMemo(() => {
    const set = new Set<string>();
    if (!inspectFocusCoord) return set;
    const focusCell = program.cells[inspectFocusCoord.y]?.[inspectFocusCoord.x];
    if (!focusCell || (focusCell.type !== 'sub_call' && focusCell.type !== 'sub_def')) {
      return set;
    }
    const targetSub = String(focusCell.params.sub ?? 'A').toUpperCase();
    for (let ry = 0; ry < size; ry++) {
      for (let rx = 0; rx < size; rx++) {
        if (rx === inspectFocusCoord.x && ry === inspectFocusCoord.y) continue;
        const c = program.cells[ry]?.[rx];
        if (
          c &&
          (c.type === 'sub_call' || c.type === 'sub_def') &&
          String(c.params.sub ?? 'A').toUpperCase() === targetSub
        ) {
          set.add(`${rx},${ry}`);
        }
      }
    }
    return set;
  }, [inspectFocusCoord, program.cells, size]);

  // Build SVG arrow connectors
  const connectors = useMemo(() => {
    const raw: Array<{
      key: string;
      from: GridCoord;
      to: GridCoord;
      branch: 'next' | 'yes' | 'no';
      active: boolean;
      focused: boolean;
    }> = [];

    const edgePairSet = new Set<string>();
    const samePairCounts = new Map<string, number>();

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cell = program.cells[y]?.[x];
        if (!cell) continue;
        const def = CHIP_DEFINITIONS[cell.type];
        const isFocusedSource =
          Boolean(inspectFocusCoord && inspectFocusCoord.x === x && inspectFocusCoord.y === y);
        const pushEdge = (target: GridCoord, branch: 'next' | 'yes' | 'no') => {
          const pairKey = `${x},${y}->${target.x},${target.y}`;
          edgePairSet.add(pairKey);
          samePairCounts.set(pairKey, (samePairCounts.get(pairKey) ?? 0) + 1);
          raw.push({
            key: `${x},${y}-${branch}-${target.x},${target.y}`,
            from: { x, y },
            to: target,
            branch,
            active: activeEdgeSet.has(`${x},${y}->${target.x},${target.y}:${branch}`),
            focused: isFocusedSource,
          });
        };
        if (def.isCondition) {
          if (cell.yes) pushEdge(cell.yes, 'yes');
          if (cell.no) pushEdge(cell.no, 'no');
        } else if (cell.next) {
          pushEdge(cell.next, 'next');
        }
      }
    }

    const pairSeen = new Map<string, number>();
    return raw.map((item) => {
      const pairKey = `${item.from.x},${item.from.y}->${item.to.x},${item.to.y}`;
      const revKey = `${item.to.x},${item.to.y}->${item.from.x},${item.from.y}`;
      const hasOpposite = edgePairSet.has(revKey);
      const dupTotal = samePairCounts.get(pairKey) ?? 1;
      const dupIdx = pairSeen.get(pairKey) ?? 0;
      pairSeen.set(pairKey, dupIdx + 1);

      let perpOffset = 0;
      if (dupTotal > 1) {
        perpOffset = dupIdx === 0 ? -12 : 12;
      } else if (hasOpposite) {
        perpOffset = 11;
      }

      return { ...item, perpOffset };
    });
  }, [program.cells, size, activeEdgeSet, inspectFocusCoord]);

  const hasNonOrthoLinks = useMemo(
    () =>
      connectors.some(
        (c) => Math.abs(c.to.x - c.from.x) + Math.abs(c.to.y - c.from.y) !== 1
      ),
    [connectors]
  );

  const isFixedTurret = Boolean(CHASSIS_SPECS[safeChassisId]?.fixedTurret);
  const hasChipLimit = Boolean(allowedChips && allowedChips.length > 0);
  const filteredPaletteChips = CHIP_LIST.filter((c) => {
    if (isFixedTurret && (c.type === 'act_turn_turret' || c.type === 'act_aim_enemy')) {
      return false;
    }
    if (
      c.learningOnly &&
      !allowLearningChips &&
      !(hasChipLimit && allowedChips!.includes(c.type))
    ) {
      return false;
    }
    if (hasChipLimit && !showAllTutorialChips && !allowedChips!.includes(c.type)) {
      return false;
    }
    return activePaletteCategory === 'all' || c.category === activePaletteCategory;
  });

  const selectedDef = selectedCell ? CHIP_DEFINITIONS[selectedCell.type] : null;
  const codeLineCell =
    hoveredCodeLine?.coord
      ? program.cells[hoveredCodeLine.coord.y]?.[hoveredCodeLine.coord.x] ?? null
      : null;
  const codeLineSyntaxHelp = hoveredCodeLine?.syntaxHelp ?? null;

  const tooltipTargetType: ChipType | null = codeLineSyntaxHelp
    ? null
    : codeLineCell
      ? codeLineCell.type
      : hoveredChipType ?? hoveredCell?.type ?? selectedCell?.type ?? null;
  const tooltipTargetParams = codeLineCell
    ? codeLineCell.params
    : hoveredChipType
      ? undefined
      : hoveredCell
        ? hoveredCell.params
        : selectedCell?.params;
  const tooltipDef = tooltipTargetType ? CHIP_DEFINITIONS[tooltipTargetType] : null;
  const tooltipIndent = hoveredCodeLine?.indent ?? 0;

  const equippedGunSpec = MAIN_GUN_SPECS[safeMainGunId] ?? MAIN_GUN_SPECS.standard;
  const activeFireTierInfo =
    tooltipTargetType === 'act_fire'
      ? (() => {
          const { tier, power } = resolveFirePower(tooltipTargetParams?.power, safeMainGunId);
          const m = computeShellMetrics(safeMainGunId, power, safeChassisId);
          return `[装備中: ${equippedGunSpec.name} — ${FIRE_POWER_TIER_LABELS[tier].ja}(P=${power}): 威力${m.damage.toFixed(1)} / 弾速${m.bulletSpeed.toFixed(1)} / 冷却${m.cooldownTicks}t]`;
        })()
      : null;

  const tooltipDisplayData: SyntaxHelpInfo | null = codeLineSyntaxHelp
    ? codeLineSyntaxHelp
    : tooltipDef && tooltipTargetType
      ? {
          conceptTag: tooltipDef.conceptTag,
          signatureInfo: tooltipDef.signatureInfo,
          pythonSyntax: buildLivePythonSyntax(tooltipTargetType, tooltipTargetParams),
          learningTip: [
            tooltipDef.learningTip,
            activeFireTierInfo,
            tooltipIndent > 0
              ? `[インデント Lv.${tooltipIndent} (${tooltipIndent * 2}スペース): Pythonでは行頭の空白で関数・if・ループの中身を表します]`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        }
      : null;

  const renderTooltipCard = () => (
    <div className={`edu-tooltip-card edu-size-${tooltipSize}`}>
      <div className="edu-tooltip-toolbar">
        <span className="edu-toolbar-title">
          <GraduationCap size={14} /> Python 学習ガイド
        </span>
        <div className="edu-toolbar-controls">
          {(['md', 'lg', 'xl'] as const).map((sz) => (
            <button
              key={sz}
              type="button"
              className={`mini-btn ${tooltipSize === sz ? 'active' : ''}`}
              onClick={() => setTooltipSize(sz)}
            >
              {sz === 'md' ? '標準' : sz === 'lg' ? '拡大' : '特大'}
            </button>
          ))}
          <button
            type="button"
            className="mini-btn"
            onClick={() => setTooltipPosition((p) => (p === 'bottom' ? 'top' : 'bottom'))}
            title="ツールチップの表示位置を切り替え"
          >
            {tooltipPosition === 'bottom' ? '▲ 上部へ移動' : '▼ 盤面下へ移動'}
          </button>
        </div>
      </div>
      {tooltipDisplayData ? (
        <>
          <div className="edu-tooltip-head">
            <span className="edu-badge-concept">{tooltipDisplayData.conceptTag}</span>
            <span className="edu-badge-sig">{tooltipDisplayData.signatureInfo}</span>
          </div>
          <pre className="edu-syntax-code">{tooltipDisplayData.pythonSyntax}</pre>
          <p className="edu-tip-text">{tooltipDisplayData.learningTip}</p>
        </>
      ) : (
        <div className="edu-tip-empty">
          盤面・パレットのチップ、またはコード変換の各行にカーソルを合わせると、対応するPython構文と解説が大きく表示されます。
        </div>
      )}
    </div>
  );

  const visibleGridSizes = mobileMode
    ? ALLOWED_GRID_SIZES.filter((gs) => gs <= 8 || gs === size)
    : ALLOWED_GRID_SIZES;

  return (
    <div className="grid-editor-panel">
      {/* Header Controls: Grid Size (4/6/8/12) + Coordinate Mode + JA/EN + CPU Steps */}
      <div className="editor-topbar">
        <div className="grid-size-switch" title="CPU（グリッドサイズ）切替 (4×4 / 6×6 / 8×8 / 12×12)">
          <span className="coord-label">CPU</span>
          {visibleGridSizes.map((gs) => (
            <button
              key={gs}
              type="button"
              className={`seg-btn ${size === gs ? 'active' : ''}`}
              onClick={() => handleSelectGridSize(gs)}
            >
              {gs}×{gs}
            </button>
          ))}
        </div>

        <div className="coord-mode-switch" title="座標系モードの切り替え">
          <button
            type="button"
            className={`seg-btn ${program.coordinateMode === 'relative' ? 'active' : ''}`}
            onClick={() => handleCoordinateModeChange('relative')}
          >
            相対
          </button>
          <button
            type="button"
            className={`seg-btn ${program.coordinateMode === 'absolute' ? 'active' : ''}`}
            onClick={() => handleCoordinateModeChange('absolute')}
          >
            絶対
          </button>
        </div>

        <button
          type="button"
          className={`lang-switch ${displayLang === 'en' ? 'lang-en' : 'lang-ja'}`}
          onClick={() => setDisplayLang((l) => (l === 'en' ? 'ja' : 'en'))}
          title="チップの英文(Python)表記と日本語表記を切り替えます"
        >
          <span>
            <strong>{displayLang === 'en' ? 'EN' : 'JP'}</strong> ⇄{' '}
            {displayLang === 'en' ? 'JP' : 'EN'}
          </span>
        </button>

        <div className="editor-topbar-right">
          <div className="cpu-meter" title="使用ブロック数 / 上限 と 1Tickの実行ステップ">
            <span className={trace?.truncated ? 'text-amber' : undefined}>
              {usedBlockCount}/{size * size}blk · {trace?.stepsUsed ?? 0}/{cpuSpec.maxStepsPerTick}st
            </span>
            {trace?.truncated && <span className="badge-warn">上限</span>}
          </div>
          <button
            type="button"
            className="mini-btn danger-ghost"
            onClick={handleClearAll}
            disabled={isPlaying}
            title="グリッドを初期化"
          >
            全消去
          </button>
        </div>
      </div>

      {hardwareError && (
        <div className="status-banner banner-error">
          <span>{hardwareError}</span>
        </div>
      )}

      {programPowerError && gridSizeNotice?.type !== 'error' && (
        <div className="status-banner banner-error">
          <span>{programPowerError}</span>
        </div>
      )}

      {gridSizeNotice && (
        <div
          className={`status-banner ${
            gridSizeNotice.type === 'error' ? 'banner-error' : 'banner-placing'
          }`}
        >
          <span>{gridSizeNotice.text}</span>
          <button type="button" className="mini-btn" onClick={() => setGridSizeNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      {hasNonOrthoLinks && (
        <div className="status-banner banner-error">
          <span>
            ⚠ 斜めまたは離れたマスへの破線矢印があります（実行時は4方向隣接のみ有効なためスキップされます。中継チップや移動で隣接させてください）。
          </span>
        </div>
      )}

      {!mobileMode && tooltipPosition === 'top' && renderTooltipCard()}

      {/* Mode Banner / Placement Helper (only shown when placing or moving a chip) */}
      {(movingFromCoord || placingChip) && (
        <div className="editor-subbar">
          {movingFromCoord ? (
            <div className="status-banner banner-placing">
              <Move size={14} />
              <span>
                移動モード: <strong>({movingFromCoord.x},{movingFromCoord.y})</strong> の移動先マスをタップ
              </span>
              <button type="button" className="mini-btn" onClick={() => setMovingFromCoord(null)}>
                解除
              </button>
            </div>
          ) : placingChip ? (
            <div className="status-banner banner-placing">
              <MousePointer size={14} />
              <span>
                配置モード: <strong>{CHIP_DEFINITIONS[placingChip].name}</strong> (盤面をタップ)
              </span>
              <button type="button" className="mini-btn" onClick={() => setPlacingChip(null)}>
                解除
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Main Split: Grid Matrix + Palette / Inspector */}
      <div className="editor-body">
        {/* 2D Grid Board */}
        <div className="grid-board-wrapper">
          <div className="tank-name-row">
            <label
              className="editor-tank-name-box"
              title="自戦車の名前（Pythonソース内の tank_name にも反映されます）"
            >
              <span className="tank-name-prefix">自機名</span>
              <input
                type="text"
                className="editor-tank-name-input"
                value={tankName}
                maxLength={32}
                placeholder="自戦車の名前を入力"
                onChange={(e) => onChangeTankName?.(e.target.value)}
              />
            </label>

            <button
              type="button"
              className="file-io-btn"
              onClick={handleSaveTankFile}
              title="現在の自機設定とプログラムを .vstank.json ファイルに保存"
            >
              <Download size={13} />
              保存
            </button>
            <button
              type="button"
              className="file-io-btn"
              onClick={() => fileInputRef.current?.click()}
              title="保存した .vstank.json / .json / .py / 共有コードファイルを自機に読み込み"
            >
              <Upload size={13} />
              読込
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.vstank.json,.py,.txt"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleLoadTankFile(file);
                }
                e.target.value = '';
              }}
            />
          </div>

          {(() => {
            const cpuId = cpuIdForGridSize(size);
            const cpuSpec = CPU_SPECS[cpuId];
            const w = calculateAssemblyWeight({
              chassis: safeChassisId,
              mainGun: safeMainGunId,
              radar: safeRadarId,
              cpu: cpuId,
              subWeapon: safeSubWeaponId,
            });
            const pct = Math.min(100, Math.round((w.totalWeight / Math.max(1, w.weightLimit)) * 100));
            const penaltyPct = Math.round((1 - w.mobilityMultiplier) * 100);
            return (
              <>
                {mobileMode && (
                  <button
                    type="button"
                    className={`mobile-accordion-btn ${w.overweight ? 'is-warn' : ''}`}
                    onClick={() => setMobilePartsExpanded((v) => !v)}
                  >
                    <span>
                      機体パーツ・積載重量 ({w.totalWeight}/{w.weightLimit}t
                      {w.overweight ? ` 超過+${w.overweightAmount}t` : ''})
                    </span>
                    {mobilePartsExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                )}

                {(!mobileMode || mobilePartsExpanded) && (
                  <>
                    <div className="editor-config-grid">
                      {(
                        [
                          {
                            key: 'chassis',
                            label: 'シャシー',
                            code: 'chassis =',
                            title: '搭載シャシーの選択（Pythonソース内の chassis スペックにも反映されます）',
                            value: safeChassisId,
                            options: ALLOWED_CHASSIS_IDS.map((cid) => {
                              const sp = CHASSIS_SPECS[cid];
                              return {
                                value: cid,
                                label: `${sp.name} (HP${sp.maxHp} / 速${sp.maxSpeed} / 旋回${sp.turnRate}° / 重${sp.baseWeight}t / 積載${sp.weightLimit}t)`,
                              };
                            }),
                            onChange: (val: string) => {
                              const resolved = isAllowedChassisId(val) ? val : STANDARD_SETUP.chassis;
                              onChangeChassis?.(resolved);
                            },
                          },
                          {
                            key: 'radar',
                            label: 'レーダー',
                            code: 'radar =',
                            title: '搭載レーダーの選択（Pythonソース内の radar スペックにも反映されます）',
                            value: safeRadarId,
                            options: ALLOWED_RADAR_IDS.map((rid) => {
                              const sp = RADAR_SPECS[rid];
                              return {
                                value: rid,
                                label: `${sp.name} (角${sp.fovDeg}° / 射程${sp.range}px / 旋回${sp.turnRate}° / ${sp.weight}t)`,
                              };
                            }),
                            onChange: (val: string) => {
                              const resolved = isAllowedRadarId(val) ? val : STANDARD_SETUP.radar;
                              onChangeRadar?.(resolved);
                            },
                          },
                          {
                            key: 'mainGun',
                            label: '主砲',
                            code: 'main_gun =',
                            title: '搭載主砲の選択（Pythonソース内の main_gun スペックにも反映されます）',
                            value: safeMainGunId,
                            options: ALLOWED_MAIN_GUN_IDS.map((gid) => {
                              const sp = MAIN_GUN_SPECS[gid];
                              return {
                                value: gid,
                                label: `${sp.name} (威力x${sp.damageMultiplier} / 冷却${sp.coolingRate} / 旋回${sp.turretTurnRate}° / ${sp.weight}t)`,
                              };
                            }),
                            onChange: (val: string) => {
                              const resolved = isAllowedMainGunId(val) ? val : STANDARD_SETUP.mainGun;
                              onChangeMainGun?.(resolved);
                            },
                          },
                          {
                            key: 'subWeapon',
                            label: 'Special',
                            code: 'special =',
                            title: '搭載Special兵装の選択（Pythonソース内の special スペックにも反映されます）',
                            value: safeSubWeaponId,
                            options: ALLOWED_SUB_WEAPON_IDS.map((sid) => {
                              const sp = SUB_WEAPON_SPECS[sid];
                              if (sid === 'none') {
                                return { value: sid, label: `${sp.name} (${sp.weight}t)` };
                              }
                              const unit = sid === 'mine' || sid === 'missile' ? '発' : '回';
                              return {
                                value: sid,
                                label: `${sp.name} (${sp.maxAmmo}${unit} / CD${sp.cooldownTicks}t / ${sp.weight}t)`,
                              };
                            }),
                            onChange: (val: string) => {
                              const resolved = isAllowedSubWeaponId(val) ? val : STANDARD_SETUP.subWeapon;
                              onChangeSubWeapon?.(resolved);
                            },
                          },
                        ] as Array<{
                          key: string;
                          label: string;
                          code: string;
                          title: string;
                          value: string;
                          options: Array<{ value: string; label: string }>;
                          onChange: (val: string) => void;
                        }>
                      ).map((cfg) => (
                        <label
                          key={cfg.key}
                          className="editor-tank-name-box editor-radar-box"
                          title={cfg.title}
                        >
                          <span className="tank-name-prefix">{cfg.label}</span>
                          <select
                            className="editor-radar-select"
                            value={cfg.value}
                            onChange={(e) => {
                              setGridSizeNotice(null);
                              cfg.onChange(e.target.value);
                            }}
                          >
                            {cfg.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>

                    <div className={`weight-status-bar ${w.overweight ? 'overweight' : ''}`}>
                      <span className="weight-status-label">
                        積載重量 (CPU {cpuSpec.weight}t含む)
                      </span>
                      <div className="weight-bar-track">
                        <div
                          className="weight-bar-fill"
                          style={{
                            width: `${pct}%`,
                            background: w.overweight ? '#f43f5e' : '#06b6d4',
                          }}
                        />
                      </div>
                      <strong className="weight-status-value">
                        {w.totalWeight} / {w.weightLimit} t
                      </strong>
                      {w.overweight && (
                        <span className="weight-status-warn">
                          超過 +{w.overweightAmount}t（移動・旋回 -{penaltyPct}%）
                        </span>
                      )}
                    </div>
                  </>
                )}
              </>
            );
          })()}

          <div
            id="mobile-board-section"
            className={`chip-grid grid-size-${size}`}
            style={{
              gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: size }).map((_, y) =>
              Array.from({ length: size }).map((__, x) => {
                const cell = program.cells[y]?.[x] ?? null;
                const cellKey = `${x},${y}`;
                const isSelected = selectedCoord?.x === x && selectedCoord?.y === y;
                const isActiveTrace = activeVisitedSet.has(cellKey);
                const stepOrder = activeStepMap.get(cellKey);
                const isLastTrace = lastVisitedKey === cellKey;
                const isDimmedByTrace = hasActiveTrace && Boolean(cell) && !isActiveTrace;
                const targetBranch = focusedTargetMap.get(cellKey);
                const isSubPeer = subroutinePeerSet.has(cellKey);
                const def = cell ? CHIP_DEFINITIONS[cell.type] : null;
                const paramSummary = cell ? summarizeChipParams(cell, displayLang) : '';

                return (
                  <div
                    key={`${x}-${y}`}
                    className={[
                      'grid-cell',
                      cell ? 'has-chip' : 'empty-cell',
                      def ? getCategoryClass(def.category) : '',
                      isSelected ? 'selected' : '',
                      movingFromCoord?.x === x && movingFromCoord?.y === y ? 'moving-source' : '',
                      isActiveTrace ? 'trace-active' : '',
                      isLastTrace ? 'trace-last' : '',
                      isDimmedByTrace ? 'trace-dimmed' : '',
                      targetBranch ? `connected-target-${targetBranch}` : '',
                      isSubPeer ? 'connected-subroutine-peer' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    draggable={Boolean(cell)}
                    onDragStart={(e) => cell && handleDragStartCell(e, x, y)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleDropOnCell(e, x, y)}
                    onClick={() => handleCellClick(x, y)}
                    onMouseEnter={() => {
                      setHoveredChipType(null);
                      setHoveredCell(cell);
                      setHoveredCoord({ x, y });
                    }}
                    onMouseLeave={() => {
                      setHoveredCell(null);
                      setHoveredCoord(null);
                    }}
                    title={
                      def
                        ? `${def.pythonSyntax}\n${def.conceptTag} | ${def.signatureInfo}\n${def.learningTip}`
                        : `空きグリッド (${x},${y})`
                    }
                  >
                    <span className="cell-coord">
                      {x},{y}
                    </span>
                    {cell && Number(cell.params._print ?? 0) === 1 && (
                      <span className="cell-print-badge" title="print() デバッグ出力ON">
                        P
                      </span>
                    )}
                    {isActiveTrace && stepOrder !== undefined && (
                      <span
                        className={`cell-step-badge ${isLastTrace ? 'step-last' : ''}`}
                        title={`このTick内の実行順: #${stepOrder}`}
                      >
                        #{stepOrder}
                      </span>
                    )}
                    {cell && def ? (
                      <div className="cell-content">
                        <span className="cell-title">
                          {displayLang === 'en' ? def.shortLabelEn : def.shortLabel}
                        </span>
                        {paramSummary && <span className="cell-param">{paramSummary}</span>}
                      </div>
                    ) : (
                      <span className="cell-plus">+</span>
                    )}
                  </div>
                );
              })
            )}

            {/* SVG Arrow Overlay */}
            <svg
              className="grid-arrows-svg"
              viewBox={`0 0 ${size * 100} ${size * 100}`}
              preserveAspectRatio="none"
            >
              <defs>
                {(['next', 'yes', 'no'] as const).map((branch) => {
                  const color =
                    branch === 'yes' ? '#38bdf8' : branch === 'no' ? '#f43f5e' : '#10b981';
                  return (
                    <marker
                      key={branch}
                      id={`arrow-${branch}`}
                      markerWidth="22"
                      markerHeight="22"
                      refX="14"
                      refY="11"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <path
                        d="M1,1 L1,21 L20,11 z"
                        fill={color}
                        stroke="#020617"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                    </marker>
                  );
                })}
              </defs>

              {connectors.map((c) => {
                const x1 = c.from.x * 100 + 50;
                const y1 = c.from.y * 100 + 50;
                const x2 = c.to.x * 100 + 50;
                const y2 = c.to.y * 100 + 50;
                const dx = x2 - x1;
                const dy = y2 - y1;
                const dist = Math.hypot(dx, dy) || 1;
                const ux = dx / dist;
                const uy = dy / dist;
                const perpX = -uy;
                const perpY = ux;

                const manhattan = Math.abs(c.to.x - c.from.x) + Math.abs(c.to.y - c.from.y);
                const isNonOrtho = manhattan !== 1;
                const offsetX = perpX * c.perpOffset;
                const offsetY = perpY * c.perpOffset;

                // Edge-port anchors keep center chip text legible while making arrows large and unmistakable
                const hasPortBadge = c.branch === 'yes' || c.branch === 'no';
                const portDist = 31;
                const shaftStartDist = hasPortBadge ? 38 : 30;
                const sx = x1 + ux * shaftStartDist + offsetX;
                const sy = y1 + uy * shaftStartDist + offsetY;
                const ex = x2 - ux * 31 + offsetX;
                const ey = y2 - uy * 31 + offsetY;
                const bx = x1 + ux * portDist + offsetX;
                const by = y1 + uy * portDist + offsetY;

                const strokeColor =
                  c.branch === 'yes' ? '#38bdf8' : c.branch === 'no' ? '#f43f5e' : '#10b981';
                const strokeWidth = c.active ? 10 : c.focused ? 8 : 6.5;
                const opacity = c.active
                  ? 1
                  : hasActiveTrace
                    ? c.focused
                      ? 0.72
                      : 0.26
                    : c.focused
                      ? 1
                      : 0.9;

                const pathD = isNonOrtho
                  ? `M ${x1 + ux * 30} ${y1 + uy * 30} Q ${(x1 + x2) / 2 + perpX * 26} ${(y1 + y2) / 2 + perpY * 26} ${ex} ${ey}`
                  : `M ${sx} ${sy} L ${ex} ${ey}`;

                return (
                  <g
                    key={c.key}
                    style={{ opacity }}
                    className={c.active ? 'arrow-active-pulse' : undefined}
                  >
                    <path
                      d={pathD}
                      fill="none"
                      stroke="#020617"
                      strokeWidth={strokeWidth + 4.5}
                      strokeLinecap="round"
                      strokeOpacity={0.8}
                    />
                    <path
                      d={pathD}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      strokeDasharray={isNonOrtho ? '7 5' : undefined}
                      markerEnd={`url(#arrow-${c.branch})`}
                    />
                    {hasPortBadge && (
                      <g className="arrow-port-badge">
                        <circle
                          cx={bx}
                          cy={by}
                          r={11}
                          fill={c.branch === 'yes' ? '#0284c7' : '#e11d48'}
                          stroke="#020617"
                          strokeWidth={2}
                        />
                        <text
                          x={bx}
                          y={by}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="#ffffff"
                          fontSize="13"
                          fontWeight="800"
                        >
                          {c.branch === 'yes' ? 'T' : 'F'}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="arrow-legend">
            <span className="legend-item">
              <i className="dot dot-next" /> 次へ (next)
            </span>
            <span className="legend-item">
              <i className="dot dot-yes" /> T: True (then)
            </span>
            <span className="legend-item">
              <i className="dot dot-no" /> F: False (else)
            </span>
            <span className="legend-item">
              <i className="dot dot-trace" /> #1.. 実行順
            </span>
            <span className="legend-hint">上下左右4方向の隣接グリッド接続</span>
          </div>

          {!mobileMode && tooltipPosition === 'bottom' && renderTooltipCard()}
        </div>

        {/* Right Side: Chip Palette & Selected Cell Inspector */}
        <div className="editor-sidebar">
          {/* Selected Cell Inspector */}
          <div id="mobile-inspector-section" className="inspector-card">
            <div className="inspector-header">
              <h4>
                {selectedCoord ? `グリッド (${selectedCoord.x}, ${selectedCoord.y})` : 'グリッド未選択'}
                {selectedDef
                  ? ` : ${displayLang === 'en' ? selectedDef.nameEn : selectedDef.name}`
                  : ' : 空きグリッド'}
              </h4>
              {selectedCoord && selectedCell && (
                <div className="inspector-header-actions">
                  <button
                    type="button"
                    className={`mini-btn ${
                      movingFromCoord?.x === selectedCoord.x && movingFromCoord?.y === selectedCoord.y
                        ? 'active'
                        : ''
                    }`}
                    onClick={() => {
                      setPlacingChip(null);
                      const isSame =
                        movingFromCoord?.x === selectedCoord.x &&
                        movingFromCoord?.y === selectedCoord.y;
                      const nextMove = isSame ? null : selectedCoord;
                      setMovingFromCoord(nextMove);
                      if (nextMove && mobileMode) {
                        document
                          .getElementById('mobile-board-section')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }}
                    title="このチップを別のグリッドへ移動・入替"
                  >
                    <Move size={13} /> 移動
                  </button>
                  <button
                    type="button"
                    className="icon-btn-danger"
                    onClick={() => handleClearCell(selectedCoord)}
                    title="このチップを削除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>

            {selectedCell && selectedDef ? (
              <div className="inspector-body">
                <p className="chip-desc">{selectedDef.description}</p>

                {/* Parameters */}
                {selectedDef.paramSchema.length > 0 && (
                  <div className="param-list">
                    {selectedDef.paramSchema.map((field) => (
                      <label
                        key={field.key}
                        className={
                          field.type === 'boolean' ? 'param-row param-checkbox-row' : 'param-row'
                        }
                      >
                        <span>
                          {displayLang === 'en'
                            ? `${field.labelEn} (${field.label})`
                            : field.label}
                        </span>
                        {field.type === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={Number(selectedCell.params[field.key] ?? 0) === 1}
                            onChange={(e) => handleUpdateParam(field.key, e.target.checked ? 1 : 0)}
                          />
                        ) : field.type === 'select' ? (
                          <select
                            value={
                              selectedCell.type === 'act_fire' && field.key === 'power'
                                ? normalizeFirePowerTier(
                                    selectedCell.params[field.key],
                                    safeMainGunId
                                  )
                                : String(selectedCell.params[field.key] ?? '')
                            }
                            onChange={(e) => {
                              const raw = e.target.value;
                              const isNumeric = field.options?.every(
                                (o) => typeof o.value === 'number'
                              );
                              handleUpdateParam(field.key, isNumeric ? Number(raw) : raw);
                            }}
                          >
                            {field.options?.map((opt) => {
                              if (selectedCell.type === 'act_fire' && field.key === 'power') {
                                const tier = normalizeFirePowerTier(opt.value, safeMainGunId);
                                const tierPower = equippedGunSpec.powerTiers[tier];
                                const m = computeShellMetrics(
                                  safeMainGunId,
                                  tierPower,
                                  safeChassisId
                                );
                                const baseLabel =
                                  displayLang === 'en' ? opt.labelEn ?? opt.label : opt.label;
                                return (
                                  <option key={String(opt.value)} value={String(opt.value)}>
                                    {baseLabel} (P={tierPower} / 威力{m.damage.toFixed(1)} / 弾速
                                    {m.bulletSpeed.toFixed(1)} / {m.cooldownTicks}t)
                                  </option>
                                );
                              }
                              return (
                                <option key={String(opt.value)} value={String(opt.value)}>
                                  {displayLang === 'en' ? opt.labelEn ?? opt.label : opt.label}
                                </option>
                              );
                            })}
                          </select>
                        ) : (
                          <div className="num-input-wrap">
                            <input
                              type="number"
                              min={field.min}
                              max={field.max}
                              step={field.step ?? 1}
                              value={Number(selectedCell.params[field.key] ?? 0)}
                              onChange={(e) => handleUpdateParam(field.key, Number(e.target.value))}
                            />
                            {field.unit && <span className="unit">{field.unit}</span>}
                          </div>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                {selectedCell.type !== 'start' && (
                  <label
                    className="print-debug-toggle"
                    title="実行時に戦車の頭上に吹き出しで状態を表示します（ブロック数は消費しません）"
                  >
                    <input
                      type="checkbox"
                      checked={Number(selectedCell.params._print ?? 0) === 1}
                      onChange={(e) => handleTogglePrint(e.target.checked)}
                    />
                    <span>print() デバッグ出力（頭上に吹き出し表示）</span>
                  </label>
                )}

                {/* Wiring Controls (4-Direction Orthogonal Only) */}
                <div className="wiring-section">
                  <div className="wiring-title">
                    矢印（出力先）の設定 <span className="wiring-rule-tag">4方向隣接のみ</span>
                  </div>
                  {(() => {
                    const renderCrossPad = (
                      branch: 'next' | 'yes' | 'no',
                      target: GridCoord | null | undefined
                    ) => (
                      <div className="dir-pad">
                        {ORTHO_PAD_SLOTS.map((slot) => {
                          if (slot.kind === 'empty') {
                            return <span key={slot.key} className="dir-pad-spacer" />;
                          }
                          if (slot.kind === 'center') {
                            return (
                              <span
                                key={slot.key}
                                className="dir-pad-center"
                                title="現在のブロック（上下左右の隣接1グリッドにのみ接続できます）"
                              >
                                ●
                              </span>
                            );
                          }
                          const nx = (selectedCoord?.x ?? 0) + slot.dx;
                          const ny = (selectedCoord?.y ?? 0) + slot.dy;
                          const oob = nx < 0 || nx >= size || ny < 0 || ny >= size;
                          const isCurrent = target?.x === nx && target?.y === ny;
                          return (
                            <button
                              key={slot.key}
                              type="button"
                              disabled={oob}
                              title={
                                oob
                                  ? '盤面外'
                                  : isCurrent
                                    ? `(${nx},${ny}) への接続を解除`
                                    : `隣接グリッド (${nx},${ny}) へ接続`
                              }
                              className={`dir-btn ${isCurrent ? `current current-${branch}` : ''}`}
                              onClick={() => handleDirectionWire(branch, slot.dx, slot.dy)}
                            >
                              {slot.label}
                            </button>
                          );
                        })}
                      </div>
                    );

                    return selectedDef.isCondition ? (
                      <div className="branch-controls-dual">
                        {(['yes', 'no'] as const).map((branch) => {
                          const target = selectedCell[branch];
                          const isLoop =
                            selectedCell.type === 'loop_while' ||
                            selectedCell.type === 'loop_for';
                          const branchLabel =
                            branch === 'yes'
                              ? isLoop
                                ? 'T: 反復処理 (青)'
                                : 'T: True / then (青)'
                              : isLoop
                                ? 'F: ループ終了 (赤)'
                                : 'F: False / else (赤)';
                          return (
                            <div key={branch} className={`branch-box branch-${branch}`}>
                              <div className="branch-head">
                                <span>{branchLabel}</span>
                                <span className="branch-target">
                                  {target ? `→ (${target.x},${target.y})` : '未接続'}
                                </span>
                              </div>
                              {renderCrossPad(branch, target)}
                              {target && (
                                <button
                                  type="button"
                                  className="unlink-btn"
                                  onClick={() => handleUnlink(branch)}
                                >
                                  <Unlink size={11} /> 解除
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : selectedCell.type === 'act_halt' ? (
                      <div className="branch-box branch-next">
                        <div className="branch-head">
                          <span>終端チップ（ここで停止）</span>
                        </div>
                        <div className="dir-pad-row">
                          <span className="dir-pad-hint">
                            実行すると移動・旋回・発砲を停止し、以降のTickでも実行を終了します（出力先の配線は不要です）
                          </span>
                          {selectedCell.next && (
                            <button
                              type="button"
                              className="mini-btn"
                              onClick={() => handleUnlink('next')}
                            >
                              <Unlink size={12} /> 接続解除
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="branch-box branch-next">
                        <div className="branch-head">
                          <span>次のチップ (NEXT 緑)</span>
                          <span className="branch-target">
                            {selectedCell.next
                              ? `→ (${selectedCell.next.x},${selectedCell.next.y})`
                              : '未接続'}
                          </span>
                        </div>
                        <div className="dir-pad-row">
                          {renderCrossPad('next', selectedCell.next)}
                          <div className="jump-actions">
                            <span className="dir-pad-hint">
                              上下左右の隣接1グリッドをクリックして接続（再クリックで解除）
                            </span>
                            {selectedCell.next && (
                              <button
                                type="button"
                                className="mini-btn"
                                onClick={() => handleUnlink('next')}
                              >
                                <Unlink size={12} /> 接続解除
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <div className="inspector-empty">
                {mobileMode
                  ? '下のパレットからチップをタップして、このグリッドに配置できます。'
                  : '下のパレットからチップをクリックまたはドラッグして、このグリッドに配置できます。'}
              </div>
            )}
          </div>

          {/* Chip Palette / Code Preview Switcher */}
          <div id="mobile-code-section" className="palette-card">
            <div className="sidebar-mode-tabs">
              <button
                type="button"
                className={`sidebar-mode-btn ${sidebarMode === 'palette' ? 'active' : ''}`}
                onClick={() => setSidebarMode('palette')}
              >
                <Grid3X3 size={13} /> チップパレット
              </button>
              <button
                type="button"
                className={`sidebar-mode-btn ${sidebarMode === 'code' ? 'active' : ''}`}
                onClick={() => setSidebarMode('code')}
              >
                <Code2 size={13} /> コード変換 (Code)
              </button>
            </div>

            {sidebarMode === 'palette' ? (
              <>
                <div className="palette-tabs">
                  <button
                    type="button"
                    className={`pal-tab ${activePaletteCategory === 'all' ? 'active' : ''}`}
                    onClick={() => setActivePaletteCategory('all')}
                  >
                    すべて
                  </button>
                  {(['flow', 'condition', 'action', 'sub'] as ChipCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`pal-tab ${activePaletteCategory === cat ? 'active' : ''}`}
                      onClick={() => setActivePaletteCategory(cat)}
                    >
                      {CHIP_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </div>

                {hasChipLimit && (
                  <div className="palette-filter-bar">
                    <span>
                      {showAllTutorialChips
                        ? `全チップ表示中 (${CHIP_LIST.length}種)`
                        : `ステージ学習チップのみ (${allowedChips!.length}種)`}
                    </span>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setShowAllTutorialChips((v) => !v)}
                    >
                      {showAllTutorialChips ? '学習チップのみに戻す' : '全チップを表示'}
                    </button>
                  </div>
                )}

                <div className="palette-grid">
                  {filteredPaletteChips.length === 0 ? (
                    <div className="palette-empty-hint">
                      このカテゴリにはステージ対象チップがありません。「すべて」または「全チップを表示」を選択できます。
                    </div>
                  ) : (
                    filteredPaletteChips.map((def) => (
                      <button
                        key={def.type}
                        type="button"
                        draggable
                        onDragStart={(e) => handleDragStartPalette(e, def.type)}
                        onMouseEnter={() => setHoveredChipType(def.type)}
                        onMouseLeave={() => setHoveredChipType(null)}
                        onClick={() => {
                          setMovingFromCoord(null);
                          if (selectedCoord && !program.cells[selectedCoord.y]?.[selectedCoord.x]) {
                            placeChipAt(selectedCoord.x, selectedCoord.y, def.type);
                            if (mobileMode) {
                              document
                                .getElementById('mobile-board-section')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                          } else {
                            const nextArmed = placingChip === def.type ? null : def.type;
                            setPlacingChip(nextArmed);
                            if (nextArmed && mobileMode) {
                              document
                                .getElementById('mobile-board-section')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                          }
                        }}
                        className={`palette-chip ${getCategoryClass(def.category)} ${
                          placingChip === def.type ? 'armed' : ''
                        }`}
                        title={`${def.pythonSyntax}\n${def.conceptTag} | ${def.signatureInfo}\n${def.learningTip}`}
                      >
                        <span className="pal-short">
                          {displayLang === 'en' ? def.shortLabelEn : def.shortLabel}
                        </span>
                        <span className="pal-name">
                          {displayLang === 'en' ? def.nameEn : def.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="code-preview-box">
                <div className="code-preview-header">
                  <div className="code-lang-toggle">
                    <button
                      type="button"
                      className={`mini-btn ${!codeEditMode ? 'active' : ''}`}
                      onClick={() => setCodeEditMode(false)}
                    >
                      閲覧 (Live)
                    </button>
                    <button
                      type="button"
                      className={`mini-btn ${codeEditMode ? 'active' : ''}`}
                      onClick={handleEnterCodeEdit}
                    >
                      直接編集・貼付
                    </button>
                  </div>

                  {!codeEditMode && (
                    <div className="code-lang-toggle">
                      <button
                        type="button"
                        className={`mini-btn ${!codeJaComments ? 'active' : ''}`}
                        onClick={() => setCodeJaComments(false)}
                      >
                        Python (EN)
                      </button>
                      <button
                        type="button"
                        className={`mini-btn ${codeJaComments ? 'active' : ''}`}
                        onClick={() => setCodeJaComments(true)}
                      >
                        和訳コメント
                      </button>
                      <button
                        type="button"
                        className={`mini-btn ${codeWrap ? 'active' : ''}`}
                        onClick={() => setCodeWrap((v) => !v)}
                        title="長い行の折り返し表示を切り替え"
                      >
                        折返
                      </button>
                    </div>
                  )}
                </div>

                {codeEditMode ? (
                  <div className="code-edit-area">
                    <textarea
                      className="code-textarea"
                      rows={12}
                      spellCheck={false}
                      value={sourceDraft}
                      onChange={(e) => setSourceDraft(e.target.value)}
                      placeholder='def on_tick():&#10;  if main_cooldown == 0:&#10;    fire_main(power="normal")'
                    />
                    {liveParseResult && (
                      <div
                        className={`code-fit-badge ${
                          liveParseResult.ok ? 'fit-ok' : 'fit-ng'
                        }`}
                      >
                        {liveParseResult.ok ? (
                          <div>
                            <span>
                              適合OK: 必要ブロック数{' '}
                              <strong>
                                {liveParseResult.blockCount} / {liveParseResult.maxBlocks}
                              </strong>{' '}
                              ({size}×{size})
                            </span>
                            {liveParseResult.warnings && liveParseResult.warnings.length > 0 && (
                              <div style={{ color: '#fcd34d', marginTop: 4, fontSize: 11 }}>
                                ⚠ 自動補正: {liveParseResult.warnings.join(' / ')}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span>{liveParseResult.error}</span>
                        )}
                      </div>
                    )}
                    <div className="code-edit-actions">
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setSourceDraft(codeLines.map((l) => l.text).join('\n'))}
                      >
                        現在の盤面から読込
                      </button>
                      {liveParseResult &&
                        !liveParseResult.ok &&
                        liveParseResult.suggestedSize &&
                        liveParseResult.suggestedSize !== size && (
                          <button
                            type="button"
                            className="mini-btn active"
                            onClick={() => handleSelectGridSize(liveParseResult.suggestedSize!)}
                          >
                            {liveParseResult.suggestedSize}×{liveParseResult.suggestedSize} に拡張
                          </button>
                        )}
                      <button
                        type="button"
                        className="btn-primary code-apply-btn"
                        disabled={!liveParseResult?.ok}
                        onClick={handleApplySourceToGrid}
                      >
                        グリッドへ反映
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`code-lines ${codeWrap ? 'wrap-lines' : ''}`}
                    onMouseLeave={() => setHoveredCodeLine(null)}
                  >
                    {codeLines.map((line, idx) => {
                      const isActive = line.coord
                        ? activeVisitedSet.has(`${line.coord.x},${line.coord.y}`)
                        : false;
                      const isSelectedLine =
                        line.coord &&
                        selectedCoord &&
                        line.coord.x === selectedCoord.x &&
                        line.coord.y === selectedCoord.y;
                      return (
                        <div
                          key={idx}
                          className={[
                            'code-line',
                            isActive ? 'active' : '',
                            isSelectedLine ? 'selected' : '',
                            line.coord ? 'clickable' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onMouseEnter={() => setHoveredCodeLine(line)}
                          onMouseLeave={() =>
                            setHoveredCodeLine((cur) => (cur === line ? null : cur))
                          }
                          onClick={() => {
                            if (line.coord) setSelectedCoord(line.coord);
                          }}
                        >
                          <span className="code-ln">{idx + 1}</span>
                          <pre className="code-text">{line.text}</pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {mobileMode && (
            <div className="mobile-guide-wrap">
              <button
                type="button"
                className="mobile-accordion-btn"
                onClick={() => setMobileGuideExpanded((v) => !v)}
              >
                <span>
                  <GraduationCap size={14} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
                  Python 学習ガイド（選択チップ解説）
                </span>
                {mobileGuideExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              {mobileGuideExpanded && renderTooltipCard()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

