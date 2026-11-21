import { SUB_WEAPON_SPECS } from '../data/parts';
import { BattleState, TankRuntime } from '../types/game';
import type {
  BattlefieldConfig,
  BattlefieldMatchReport,
  BattlefieldRuleId,
  TankMatchReportRow,
} from './battlefield';

export type CommentaryStyle = 'standard' | 'hype' | 'analyst';
export type CommentaryPriority = 'S' | 'A' | 'B' | 'C';
export type CommentaryCategory =
  | 'opening'
  | 'ko'
  | 'goal'
  | 'finish'
  | 'duel'
  | 'lead_change'
  | 'critical'
  | 'low_hp'
  | 'ramming'
  | 'sub_weapon'
  | 'countdown'
  | 'status';

export interface CommentarySettings {
  enabled: boolean;
  style: CommentaryStyle;
  speechEnabled: boolean;
  speechRate: number;
}

export const DEFAULT_COMMENTARY_SETTINGS: CommentarySettings = {
  enabled: true,
  style: 'standard',
  speechEnabled: false,
  speechRate: 1.15,
};

export const COMMENTARY_STYLE_SPECS: Record<
  CommentaryStyle,
  { id: CommentaryStyle; label: string; description: string }
> = {
  standard: {
    id: 'standard',
    label: '標準実況',
    description: '聞き取りやすいスポーツ中継風',
  },
  hype: {
    id: 'hype',
    label: '熱血実況',
    description: 'テンション高め・eスポーツ風',
  },
  analyst: {
    id: 'analyst',
    label: 'データ解説',
    description: 'HP・スコア数値重視の冷静解説',
  },
};

export interface CommentaryEntry {
  id: string;
  tick: number;
  timeSec: number;
  priority: CommentaryPriority;
  category: CommentaryCategory;
  badge: string;
  text: string;
  accentColor?: string;
  speechText: string;
}

interface TankSnapshot {
  hp: number;
  maxHp: number;
  damageDealt: number;
  kills: number;
  subAmmo: number;
  ruleScore: number;
  lastTankCollisionTick: number;
  lastAttackHitTick: number;
}

export interface BattleCommentaryTracker {
  ruleId: BattlefieldRuleId;
  lastTick: number;
  tanks: Record<string, TankSnapshot>;
  lastFootballGoals: number;
  openingEmitted: boolean;
  finishEmitted: boolean;
  duelEmitted: boolean;
  firstHitEmitted: boolean;
  announced30s: boolean;
  announced10s: boolean;
  announcedMajorityDomination: boolean;
  lastLeaderTeamId: string | null;
  announcedLowHpIds: Set<string>;
  lastEmittedAtMs: number;
  lastEmittedTick: number;
  lastEmittedPriority: CommentaryPriority | null;
  lastEmittedCategory: CommentaryCategory | null;
  lastCritTick: number;
  lastRamTick: number;
  lastSubTick: number;
  lastDangerTick: number;
  lastGoldBalloonTick: number;
  seq: number;
  variantCounter: number;
}

const STORAGE_KEY_COMMENTARY = 'codepanzer_bf_commentary_v1';

const RULE_DISPLAY_NAMES: Record<BattlefieldRuleId, string> = {
  elimination: '殲滅バトル',
  ramming_derby: '体当たりバトル',
  domination: '陣取り',
  balloon_hunt: '風船割り',
  tank_soccer: 'コンバットフットボール',
};

const VALID_STYLES: CommentaryStyle[] = ['standard', 'hype', 'analyst'];

/** Load persisted commentary UI settings, keeping Web Speech disabled by default. */
export function loadCommentarySettings(): CommentarySettings {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY_COMMENTARY)
        : null;
    if (!raw) return { ...DEFAULT_COMMENTARY_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<CommentarySettings>;
    const style = VALID_STYLES.includes(parsed.style as CommentaryStyle)
      ? (parsed.style as CommentaryStyle)
      : DEFAULT_COMMENTARY_SETTINGS.style;
    const rate = Number(parsed.speechRate);
    return {
      enabled:
        typeof parsed.enabled === 'boolean'
          ? parsed.enabled
          : DEFAULT_COMMENTARY_SETTINGS.enabled,
      style,
      speechEnabled:
        typeof parsed.speechEnabled === 'boolean' ? parsed.speechEnabled : false,
      speechRate: Number.isFinite(rate)
        ? Math.max(0.8, Math.min(1.6, Math.round(rate * 100) / 100))
        : DEFAULT_COMMENTARY_SETTINGS.speechRate,
    };
  } catch {
    return { ...DEFAULT_COMMENTARY_SETTINGS };
  }
}

/** Persist commentary UI settings cleanly in localStorage. */
export function saveCommentarySettings(settings: CommentarySettings): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_COMMENTARY, JSON.stringify(settings));
    }
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

function captureTankSnapshots(tanks: TankRuntime[]): Record<string, TankSnapshot> {
  const map: Record<string, TankSnapshot> = {};
  for (const t of tanks) {
    map[t.id] = {
      hp: t.hp,
      maxHp: t.maxHp,
      damageDealt: t.stats.damageDealt,
      kills: t.stats.kills ?? 0,
      subAmmo: t.subAmmo,
      ruleScore: t.stats.ruleScore ?? 0,
      lastTankCollisionTick: t.lastTankCollisionTick ?? -999,
      lastAttackHitTick: t.lastAttackHitTick ?? -999,
    };
  }
  return map;
}

function getTeamScoresTotal(state: BattleState): number {
  return Object.values(state.ruleTeamScores ?? {}).reduce((a, b) => a + b, 0);
}

/** Initialize commentary tracking state for a freshly loaded match. */
export function createCommentaryTracker(
  state: BattleState,
  config: BattlefieldConfig
): BattleCommentaryTracker {
  return {
    ruleId: config.ruleId,
    lastTick: state.tick,
    tanks: captureTankSnapshots(state.tanks),
    lastFootballGoals: state.football ? getTeamScoresTotal(state) : 0,
    openingEmitted: state.tick > 0,
    finishEmitted: state.status === 'finished',
    duelEmitted: false,
    firstHitEmitted: state.tanks.some((t) => t.stats.damageDealt > 0),
    announced30s: false,
    announced10s: false,
    announcedMajorityDomination: false,
    lastLeaderTeamId: null,
    announcedLowHpIds: new Set(
      state.tanks.filter((t) => t.hp > 0 && t.hp / Math.max(1, t.maxHp) < 0.25).map((t) => t.id)
    ),
    lastEmittedAtMs: 0,
    lastEmittedTick: state.tick,
    lastEmittedPriority: null,
    lastEmittedCategory: null,
    lastCritTick: -999,
    lastRamTick: -999,
    lastSubTick: -999,
    lastDangerTick: -999,
    lastGoldBalloonTick: -999,
    seq: 0,
    variantCounter: 0,
  };
}

/** Build a clean pre-match standby line shown before playback starts. */
export function createStandbyCommentaryText(
  state: BattleState,
  config: BattlefieldConfig
): string {
  const ruleName = RULE_DISPLAY_NAMES[config.ruleId] ?? config.ruleId;
  if (state.tanks.length < 2) {
    return `待機中 — ${ruleName}（適合機体を2機以上エントリーしてください）`;
  }
  return `待機中 — ${ruleName}（${state.tanks.length}機出場 / ▶ 再生で実況スタート）`;
}

/** Format tank name cleanly for commentary, disambiguating duplicate CPU model names. */
export function formatCallName(tank: TankRuntime, allTanks: TankRuntime[]): string {
  const pName = tank.playerName?.trim() || '';
  const mName = tank.blueprint.name;
  if (!pName) return mName;
  if (!pName.startsWith('CPU')) {
    return `${mName}（${pName}）`;
  }
  const sameMachineCount = allTanks.filter((t) => t.blueprint.name === mName).length;
  return sameMachineCount > 1 ? `${mName}（${pName}）` : mName;
}

/** Strip pictographic emojis so Web Speech reads clean Japanese text. */
export function stripEmojiForSpeech(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0E\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type StyledTemplates = Record<CommentaryStyle, string[]>;

function pickVariant(
  templates: StyledTemplates,
  style: CommentaryStyle,
  counter: number
): string {
  const list = templates[style] ?? templates.standard;
  return list[Math.abs(counter) % list.length];
}

function findStrictLeader(
  scores: Record<string, number> | undefined
): { teamId: string; score: number; runnerUp: number } | null {
  if (!scores) return null;
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0 || sorted[0][1] <= 0) return null;
  if (sorted.length >= 2 && sorted[0][1] === sorted[1][1]) return null;
  return {
    teamId: sorted[0][0],
    score: Math.round(sorted[0][1]),
    runnerUp: Math.round(sorted[1]?.[1] ?? 0),
  };
}

function getTeamDisplayLabel(state: BattleState, teamId: string): string {
  if (state.ruleTeamLabels?.[teamId]) return state.ruleTeamLabels[teamId];
  const member = state.tanks.find((t) => (t.teamId ?? t.id) === teamId);
  return member ? formatCallName(member, state.tanks) : teamId;
}

function getTeamDisplayColor(state: BattleState, teamId: string): string | undefined {
  if (state.ruleTeamColors?.[teamId]) return state.ruleTeamColors[teamId];
  return state.tanks.find((t) => (t.teamId ?? t.id) === teamId)?.blueprint.color;
}

function buildRuleSituationTail(
  state: BattleState,
  config: BattlefieldConfig
): string {
  if (state.football) {
    const fb = state.football;
    const ws = Math.round(state.ruleTeamScores?.[fb.westTeamId] ?? 0);
    const es = Math.round(state.ruleTeamScores?.[fb.eastTeamId] ?? 0);
    return `現在 ${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}`;
  }
  if (config.ruleId === 'balloon_hunt' || config.ruleId === 'domination') {
    const unit = config.ruleId === 'balloon_hunt' ? 'pt' : 'マス';
    const top = findStrictLeader(state.ruleTeamScores);
    if (top) {
      return `現在首位は ${getTeamDisplayLabel(state, top.teamId)}（${top.score}${unit}）`;
    }
    return '現在は首位タイの接戦';
  }
  const alive = state.tanks.filter((t) => t.hp > 0).length;
  return `現在 ${alive}機が生存中`;
}

interface CandidateEvent {
  priority: CommentaryPriority;
  category: CommentaryCategory;
  badge: string;
  text: string;
  accentColor?: string;
  onEmit?: () => void;
}

function evaluateCandidateEvent(
  tracker: BattleCommentaryTracker,
  state: BattleState,
  config: BattlefieldConfig,
  style: CommentaryStyle
): CandidateEvent | null {
  const cIdx = tracker.variantCounter;
  const allTanks = state.tanks;

  // 1. Finish (Priority S)
  if (state.status === 'finished' && !tracker.finishEmitted) {
    tracker.finishEmitted = true;
    const isDraw = state.winType === 'draw' || !state.winnerId || state.winnerId === 'draw';
    if (isDraw) {
      return {
        priority: 'S',
        category: 'finish',
        badge: '決着',
        text: pickVariant(
          {
            standard: [`🏁 試合終了！ ${state.endReason || '大接戦の末に引き分けとなりました！'}`],
            hype: [`💥 決着！なんと ${state.endReason || '一歩も譲らぬ引き分け決着だ！！'}`],
            analyst: [`🏁 試合終了（${(state.tick / 20).toFixed(1)}秒）。結果は引き分け（${state.endReason || '同点'}）です。`],
          },
          style,
          cIdx
        ),
      };
    }

    const winnerTank = allTanks.find((t) => t.id === state.winnerId);
    const winTeamId = winnerTank ? winnerTank.teamId ?? winnerTank.id : null;
    const winLabel =
      (winTeamId && state.ruleTeamLabels?.[winTeamId]) ||
      (winnerTank ? formatCallName(winnerTank, allTanks) : state.winnerId);
    const winColor = (winTeamId && getTeamDisplayColor(state, winTeamId)) || winnerTank?.blueprint.color;

    if (config.ruleId === 'tank_soccer' && state.football) {
      const fb = state.football;
      const ws = Math.round(state.ruleTeamScores?.[fb.westTeamId] ?? 0);
      const es = Math.round(state.ruleTeamScores?.[fb.eastTeamId] ?? 0);
      return {
        priority: 'S',
        category: 'finish',
        badge: '試合終了',
        accentColor: winColor,
        text: pickVariant(
          {
            standard: [`🏆 試合終了！${winLabel} が ${ws} - ${es} でフットボールを制しました！`],
            hype: [`🏆 ホイッスル！！${ws} - ${es} で ${winLabel} が劇的勝利！！`],
            analyst: [`🏁 試合終了（${ws} - ${es}）。${winLabel} の勝利です。`],
          },
          style,
          cIdx
        ),
      };
    }

    if (config.ruleId === 'domination') {
      const topScore = winTeamId ? Math.round(state.ruleTeamScores?.[winTeamId] ?? 0) : 0;
      const winnerAlive = winTeamId
        ? allTanks.filter((t) => (t.teamId ?? t.id) === winTeamId && t.hp > 0).length
        : 0;
      if (winnerAlive === 0) {
        return {
          priority: 'S',
          category: 'finish',
          badge: '決着',
          accentColor: winColor,
          text: pickVariant(
            {
              standard: [`🏁 決着！全滅しながらも占領リードを守り切った ${winLabel} の陣取り勝利！（${topScore}マス）`],
              hype: [`🔥 執念の陣取り決着！機体が全滅しても領地を譲らなかった ${winLabel}（${topScore}マス）が逃げ切り勝利！！`],
              analyst: [`🏁 試合終了。全機撃破されたものの、保有タイル ${topScore}マスで ${winLabel} の勝利です。`],
            },
            style,
            cIdx
          ),
        };
      }
      return {
        priority: 'S',
        category: 'finish',
        badge: '試合終了',
        accentColor: winColor,
        text: pickVariant(
          {
            standard: [`🎨 試合終了！${winLabel} が ${topScore}マスを制圧して勝利しました！`],
            hype: [`🏆 タイムアップ！フィールドを塗り替えた ${winLabel}（${topScore}マス）の圧勝だ！！`],
            analyst: [`🏁 試合終了。最終占領 ${topScore}マスで ${winLabel} が勝利しました。`],
          },
          style,
          cIdx
        ),
      };
    }

    if (config.ruleId === 'balloon_hunt') {
      const topScore = winTeamId ? Math.round(state.ruleTeamScores?.[winTeamId] ?? 0) : 0;
      return {
        priority: 'S',
        category: 'finish',
        badge: '試合終了',
        accentColor: winColor,
        text: pickVariant(
          {
            standard: [`🎈 試合終了！${winLabel} が ${topScore}pt を獲得して優勝です！`],
            hype: [`🎈 フィニッシュ！！風船を割りまくった ${winLabel} が ${topScore}pt で頂点へ！！`],
            analyst: [`🏁 試合終了。合計 ${topScore}pt を記録した ${winLabel} の勝利です。`],
          },
          style,
          cIdx
        ),
      };
    }

    const lowWinner = winnerTank && winnerTank.hp / Math.max(1, winnerTank.maxHp) < 0.25;
    if (lowWinner && winnerTank) {
      const remHp = Math.max(1, Math.round(winnerTank.hp));
      return {
        priority: 'S',
        category: 'finish',
        badge: '決着',
        accentColor: winColor,
        text: pickVariant(
          {
            standard: [`🏆 劇的決着！残りHP ${remHp} の紙一重で ${winLabel} が生き残りました！`],
            hype: [`🔥 奇跡のサバイバル！！HPわずか ${remHp} で ${winLabel} が勝利をもぎ取った！！`],
            analyst: [`🏁 決着（${(state.tick / 20).toFixed(1)}秒）。${winLabel} が残HP ${remHp} で辛勝です。`],
          },
          style,
          cIdx
        ),
      };
    }

    return {
      priority: 'S',
      category: 'finish',
      badge: '決着',
      accentColor: winColor,
      text: pickVariant(
        {
          standard: [`🏆 決着！${winLabel} が激戦を制しました！`],
          hype: [`👑 バトル終了！！${winLabel} が堂々のチャンピオンだ！！`],
          analyst: [`🏁 決着（${(state.tick / 20).toFixed(1)}秒）。勝者は ${winLabel} です。`],
        },
        style,
        cIdx
      ),
    };
  }

  // 2. Football Goal (Priority S)
  if (config.ruleId === 'tank_soccer' && state.football) {
    const fb = state.football;
    const totalGoals = getTeamScoresTotal(state);
    if (totalGoals > tracker.lastFootballGoals) {
      const ws = Math.round(state.ruleTeamScores?.[fb.westTeamId] ?? 0);
      const es = Math.round(state.ruleTeamScores?.[fb.eastTeamId] ?? 0);
      const banner = fb.lastGoalBanner;
      const scoreTeamId = banner?.teamId ?? fb.westTeamId;
      const scoreLabel = banner?.teamLabel ?? getTeamDisplayLabel(state, scoreTeamId);
      const scorerTank =
        fb.lastTouchTankId && fb.lastTouchTeamId === scoreTeamId
          ? allTanks.find((t) => t.id === fb.lastTouchTankId)
          : undefined;
      const scorerCall = scorerTank ? formatCallName(scorerTank, allTanks) : null;
      const isWest = scoreTeamId === fb.westTeamId;
      const diffBefore = Math.abs((isWest ? ws - 1 : ws) - (isWest ? es : es - 1));
      const situationTag =
        ws === es
          ? '起死回生の同点弾'
          : (isWest ? ws > es : es > ws) && diffBefore === 0
            ? '試合を動かす勝ち越し弾'
            : '追加点';

      return {
        priority: 'S',
        category: 'goal',
        badge: 'GOAL!',
        accentColor: banner?.color,
        text: pickVariant(
          {
            standard: [
              scorerCall
                ? `⚽ GOAL! ${scorerCall} の${situationTag}！ ${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}`
                : `⚽ GOAL! ${scoreLabel} が${situationTag}！ ${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}`,
            ],
            hype: [
              scorerCall
                ? `⚽ ゴォォール！！${scorerCall} が押し込んだぁ！ ${ws} - ${es}！！`
                : `⚽ ゴール炸裂！！${scoreLabel} がぶち抜いた！ ${ws} - ${es}！！`,
            ],
            analyst: [
              scorerCall
                ? `⚽ 得点（${scoreLabel} / ${scorerCall}）。スコア ${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}。`
                : `⚽ 得点（${scoreLabel}）。スコア ${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}。`,
            ],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 3. Tank Elimination / KO (Priority S)
  const newlyDead = allTanks.filter((t) => {
    const prev = tracker.tanks[t.id];
    return prev && prev.hp > 0 && t.hp <= 0;
  });

  if (newlyDead.length > 0 && state.status === 'running') {
    const aliveTeams = new Set(
      allTanks.filter((t) => t.hp > 0).map((t) => t.teamId ?? t.id)
    );
    const totalTeams = new Set(allTanks.map((t) => t.teamId ?? t.id));
    const enteredDuel =
      totalTeams.size >= 3 &&
      aliveTeams.size === 2 &&
      !tracker.duelEmitted &&
      !state.arena.disableTankDamage;
    if (enteredDuel) {
      tracker.duelEmitted = true;
    }
    const duelSuffix = enteredDuel ? ' 残るは2組、一騎打ち突入！' : '';

    if (newlyDead.length >= 2) {
      const names = newlyDead.slice(0, 2).map((t) => formatCallName(t, allTanks)).join(' と ');
      return {
        priority: 'S',
        category: 'ko',
        badge: '連続撃破',
        accentColor: '#f43f5e',
        text: pickVariant(
          {
            standard: [`💥 相打ち・同時撃破！${names} が同時に戦線離脱！${duelSuffix}`],
            hype: [`💥 ダブルKO！！${names} がまとめて吹っ飛んだぁ！！${duelSuffix}`],
            analyst: [`💥 ${newlyDead.length}機が同時撃破（${names}）。残り生存 ${allTanks.filter((t) => t.hp > 0).length}機。${duelSuffix}`],
          },
          style,
          cIdx
        ),
      };
    }

    const victim = newlyDead[0];
    const victimName = formatCallName(victim, allTanks);
    const killer =
      victim.killedById && victim.killedById !== 'environment'
        ? allTanks.find((t) => t.id === victim.killedById)
        : undefined;

    if (victim.killedById === 'environment') {
      return {
        priority: 'S',
        category: 'ko',
        badge: 'KO!',
        accentColor: victim.blueprint.color,
        text: pickVariant(
          {
            standard: [`⚡ ${victimName} が外周壁の電撃ダメージで撃破！${duelSuffix}`],
            hype: [`⚡ バチバチッ！${victimName} が電撃ウォールに焼かれて撃沈！！${duelSuffix}`],
            analyst: [`⚡ ${victimName} が場外壁ダメージにより戦線離脱（残り${allTanks.filter((t) => t.hp > 0).length}機）。${duelSuffix}`],
          },
          style,
          cIdx
        ),
      };
    }

    if (killer) {
      const killerName = formatCallName(killer, allTanks);
      const kills = killer.stats.kills ?? 0;
      const streakNote = kills >= 3 ? `（${kills}連続無双！）` : kills === 2 ? '（2機目撃破）' : '';
      if (config.ruleId === 'ramming_derby') {
        return {
          priority: 'S',
          category: 'ko',
          badge: 'KO!',
          accentColor: killer.blueprint.color,
          text: pickVariant(
            {
              standard: [`💥 ${killerName} が強烈な体当たりで ${victimName} を撃破！${streakNote}${duelSuffix}`],
              hype: [`💥 激突KO！！${killerName} が ${victimName} を粉砕したぁ！${streakNote}${duelSuffix}`],
              analyst: [`💥 ${killerName} が体当たりで ${victimName} を撃破（累計${kills}KO）。${duelSuffix}`],
            },
            style,
            cIdx
          ),
        };
      }
      return {
        priority: 'S',
        category: 'ko',
        badge: enteredDuel ? '一騎打ち' : 'KO!',
        accentColor: killer.blueprint.color,
        text: pickVariant(
          {
            standard: [`💥 撃破！${killerName} が ${victimName} を仕留めた！${streakNote}${duelSuffix}`],
            hype: [`💥 轟沈！！${killerName} が ${victimName} を叩き潰したぁ！${streakNote}${duelSuffix}`],
            analyst: [`💥 ${killerName} が ${victimName} を撃破（累計${kills}KO / 残生存${allTanks.filter((t) => t.hp > 0).length}機）。${duelSuffix}`],
          },
          style,
          cIdx
        ),
      };
    }

    return {
      priority: 'S',
      category: 'ko',
      badge: '撃破',
      accentColor: victim.blueprint.color,
      text: pickVariant(
        {
          standard: [`💥 ${victimName} がここで戦線離脱！${duelSuffix}`],
          hype: [`💥 あぁっと！${victimName} がここで大破！！${duelSuffix}`],
          analyst: [`💥 ${victimName} 撃破（残り${allTanks.filter((t) => t.hp > 0).length}機）。${duelSuffix}`],
        },
        style,
        cIdx
      ),
    };
  }

  // 4. Final 10-second Countdown (Priority A)
  const remainingSec = Math.max(0, (state.arena.maxTicks - state.tick) / 20);
  if (
    state.status === 'running' &&
    state.tick > 120 &&
    remainingSec <= 10 &&
    remainingSec > 0.5 &&
    !tracker.announced10s
  ) {
    const tail = buildRuleSituationTail(state, config);
    return {
      priority: 'A',
      category: 'countdown',
      badge: '終盤',
      accentColor: '#f59e0b',
      onEmit: () => {
        tracker.announced10s = true;
      },
      text: pickVariant(
        {
          standard: [`⏱ 残り10秒！${tail}！`],
          hype: [`⏱ ラスト10秒！！泣いても笑ってもあと少し、${tail}！！`],
          analyst: [`⏱ 残り10秒。${tail} となっています。`],
        },
        style,
        cIdx
      ),
    };
  }

  // 5. Score Lead Change & Domination Majority (Priority A)
  if (
    (config.ruleId === 'balloon_hunt' || config.ruleId === 'domination') &&
    state.tick >= 100 &&
    state.status === 'running'
  ) {
    const strictLeader = findStrictLeader(state.ruleTeamScores);
    if (strictLeader) {
      const prevLeader = tracker.lastLeaderTeamId;
      tracker.lastLeaderTeamId = strictLeader.teamId;
      if (prevLeader && prevLeader !== strictLeader.teamId) {
        const unit = config.ruleId === 'balloon_hunt' ? 'pt' : 'マス';
        const leaderName = getTeamDisplayLabel(state, strictLeader.teamId);
        return {
          priority: 'A',
          category: 'lead_change',
          badge: '逆転',
          accentColor: getTeamDisplayColor(state, strictLeader.teamId),
          text: pickVariant(
            {
              standard: [`📈 首位交代！${leaderName} が ${strictLeader.score}${unit} でトップに立ちました！`],
              hype: [`🔥 ここで逆転！！${leaderName} が ${strictLeader.score}${unit} でトップ奪取！！`],
              analyst: [`📈 首位入れ替わり：${leaderName}（${strictLeader.score}${unit}）が2位に ${strictLeader.score - strictLeader.runnerUp}${unit} 差。`],
            },
            style,
            cIdx
          ),
        };
      }
    }
  }

  if (
    config.ruleId === 'domination' &&
    state.territoryGrid &&
    !tracker.announcedMajorityDomination &&
    state.status === 'running'
  ) {
    const tg = state.territoryGrid;
    let playable = 0;
    for (let i = 0; i < tg.blocked.length; i++) {
      if (!tg.blocked[i]) playable++;
    }
    const leader = findStrictLeader(state.ruleTeamScores);
    if (leader && playable > 0 && leader.score >= Math.ceil(playable * 0.5)) {
      const leaderName = getTeamDisplayLabel(state, leader.teamId);
      const pct = Math.round((leader.score / playable) * 100);
      return {
        priority: 'A',
        category: 'lead_change',
        badge: '過半数',
        accentColor: getTeamDisplayColor(state, leader.teamId),
        onEmit: () => {
          tracker.announcedMajorityDomination = true;
        },
        text: pickVariant(
          {
            standard: [`🎨 ${leaderName} が戦場の過半数（${pct}% / ${leader.score}マス）を制圧！`],
            hype: [`🎨 フィールドが染まっていく！${leaderName} が過半数 ${pct}% を支配！！`],
            analyst: [`🎨 ${leaderName} の占領率が ${pct}%（${leader.score}/${playable}マス）に到達。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 6. Gold Balloon (+3pt) Capture (Priority A)
  if (
    config.ruleId === 'balloon_hunt' &&
    state.tick - tracker.lastGoldBalloonTick >= 40 &&
    state.status === 'running'
  ) {
    const goldPopper = allTanks.find((t) => {
      const prev = tracker.tanks[t.id];
      return prev && (t.stats.ruleScore ?? 0) - prev.ruleScore >= 3;
    });
    if (goldPopper) {
      const name = formatCallName(goldPopper, allTanks);
      const total = Math.round(goldPopper.stats.ruleScore ?? 0);
      return {
        priority: 'A',
        category: 'lead_change',
        badge: '金風船',
        accentColor: '#fbbf24',
        onEmit: () => {
          tracker.lastGoldBalloonTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [`✨ ${name} が移動金風船（+3pt）を撃ち抜いた！合計 ${total}pt！`],
            hype: [`✨ ナイスショット！！${name} が高得点の金風船 +3pt を強奪（計 ${total}pt）！！`],
            analyst: [`✨ ${name} が金風船 +3pt を獲得し、個人スコア ${total}pt に伸ばしました。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 7. Rear Critical & Heavy Damage Hit (Priority A)
  if (
    !state.arena.disableTankDamage &&
    config.ruleId !== 'ramming_derby' &&
    state.tick - tracker.lastCritTick >= 45 &&
    state.status === 'running'
  ) {
    let worstVictim: TankRuntime | null = null;
    let worstLoss = 0;
    for (const t of allTanks) {
      const prev = tracker.tanks[t.id];
      if (!prev || t.hp <= 0) continue;
      const loss = prev.hp - t.hp;
      if (loss > worstLoss) {
        worstLoss = loss;
        worstVictim = t;
      }
    }

    if (worstVictim && worstLoss >= 18 && worstVictim.lastHitZone === 'rear') {
      const vName = formatCallName(worstVictim, allTanks);
      const attacker = allTanks.find(
        (t) =>
          t.id !== worstVictim!.id &&
          (t.lastAttackHitTick ?? -999) > (tracker.tanks[t.id]?.lastAttackHitTick ?? -999)
      );
      const aName = attacker ? formatCallName(attacker, allTanks) : null;
      return {
        priority: 'A',
        category: 'critical',
        badge: '背面直撃',
        accentColor: '#fb7185',
        onEmit: () => {
          tracker.lastCritTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [
              aName
                ? `🎯 ${aName} が ${vName} の背面装甲を撃ち抜いた！手痛い一撃！`
                : `🎯 ${vName} の背面にクリティカル直撃！`,
            ],
            hype: [
              aName
                ? `🎯 完璧な裏取り！！${aName} が ${vName} の背面をぶち抜いたぁ！！`
                : `🎯 バックショット直撃！！${vName} に大ダメージ！！`,
            ],
            analyst: [
              `🎯 ${vName} 背面被弾（-${Math.round(worstLoss)} / 残HP ${Math.round(worstVictim.hp)}）。`,
            ],
          },
          style,
          cIdx
        ),
      };
    }

    if (worstVictim && worstLoss >= 34) {
      const vName = formatCallName(worstVictim, allTanks);
      return {
        priority: 'A',
        category: 'critical',
        badge: '大打撃',
        accentColor: '#fb923c',
        onEmit: () => {
          tracker.lastCritTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [`🔥 大ダメージ！${vName} が一気に ${Math.round(worstLoss)} ダメージを受けた！`],
            hype: [`💥 ドカンと直撃！！${vName} の装甲が大きく吹き飛んだ！！`],
            analyst: [`🔥 ${vName} が -${Math.round(worstLoss)} の大ダメージ（残HP ${Math.round(worstVictim.hp)}/${worstVictim.maxHp}）。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 8. Low HP Pinch (<25% HP once per tank, Priority A)
  if (!state.arena.disableTankDamage && state.status === 'running') {
    const pinchTank = allTanks.find((t) => {
      if (t.hp <= 0 || tracker.announcedLowHpIds.has(t.id)) return false;
      const ratio = t.hp / Math.max(1, t.maxHp);
      return ratio < 0.25;
    });
    if (pinchTank) {
      const name = formatCallName(pinchTank, allTanks);
      const remHp = Math.max(1, Math.round(pinchTank.hp));
      return {
        priority: 'A',
        category: 'low_hp',
        badge: 'ピンチ',
        accentColor: '#ef4444',
        onEmit: () => {
          tracker.announcedLowHpIds.add(pinchTank.id);
        },
        text: pickVariant(
          {
            standard: [`🚨 ${name} 残りHP ${remHp}、ギリギリのピンチです！`],
            hype: [`⚠️ 崖っぷち！！${name} は残りHPわずか ${remHp} で踏ん張っている！`],
            analyst: [`⚠️ ${name} のHPが25%未満（残 ${remHp}/${pinchTank.maxHp}）に低下。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 9. Match Opening (Priority B)
  if (state.tick > 0 && !tracker.openingEmitted) {
    const ruleName = RULE_DISPLAY_NAMES[config.ruleId] ?? config.ruleId;
    return {
      priority: 'B',
      category: 'opening',
      badge: '開始',
      accentColor: '#38bdf8',
      onEmit: () => {
        tracker.openingEmitted = true;
      },
      text: pickVariant(
        {
          standard: [
            `🎙 ${ruleName} スタート！全 ${allTanks.length}機が一斉に動き出しました！`,
            `🚩 試合開始！${allTanks.length}機による ${ruleName}、勝利を掴むのはどの機体か！`,
          ],
          hype: [
            `🔥 バトルスタート！！${allTanks.length}機の激突、${ruleName} 開幕だぁ！！`,
            `⚡ レディ・ゴー！！${allTanks.length}機が一斉発進！！`,
          ],
          analyst: [
            `🎙 ${ruleName} 開始（参加 ${allTanks.length}機 / 制限 ${config.maxSeconds}秒）。各機展開します。`,
          ],
        },
        style,
        cIdx
      ),
    };
  }

  // 10. 30-second Countdown (Priority B)
  if (
    state.status === 'running' &&
    config.maxSeconds >= 60 &&
    state.tick > 120 &&
    remainingSec <= 30 &&
    remainingSec > 10 &&
    !tracker.announced30s
  ) {
    const tail = buildRuleSituationTail(state, config);
    return {
      priority: 'B',
      category: 'countdown',
      badge: '残り30秒',
      accentColor: '#eab308',
      onEmit: () => {
        tracker.announced30s = true;
      },
      text: pickVariant(
        {
          standard: [`⏳ 残り30秒、${tail}！`],
          hype: [`⏳ 終盤戦突入！残り30秒で ${tail}！！`],
          analyst: [`⏳ 残り30秒地点。${tail} です。`],
        },
        style,
        cIdx
      ),
    };
  }

  // 11. First Hit (Priority B)
  if (!tracker.firstHitEmitted && !state.arena.disableTankDamage && state.status === 'running') {
    const firstHitter = allTanks.find((t) => {
      const prev = tracker.tanks[t.id];
      return prev && t.stats.damageDealt > prev.damageDealt;
    });
    if (firstHitter) {
      const name = formatCallName(firstHitter, allTanks);
      return {
        priority: 'B',
        category: 'critical',
        badge: '先制',
        accentColor: firstHitter.blueprint.color,
        onEmit: () => {
          tracker.firstHitEmitted = true;
        },
        text: pickVariant(
          {
            standard: [`🎯 先制ヒット！${name} が試合最初の有効弾を決めました！`],
            hype: [`💥 ファーストヒット！！${name} が先陣を切ったぁ！`],
            analyst: [`🎯 最初の有効打は ${name}（与ダメ ${Math.round(firstHitter.stats.damageDealt)}）。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 12. High-Speed Ramming Impact (Priority B)
  if (state.tick - tracker.lastRamTick >= 55 && state.status === 'running') {
    const rammer = allTanks.find((t) => {
      const prev = tracker.tanks[t.id];
      return (
        t.hp > 0 &&
        prev &&
        (t.lastTankCollisionTick ?? -999) > prev.lastTankCollisionTick &&
        (t.lastCollisionImpactSpeed ?? 0) >= 2.1
      );
    });
    if (rammer) {
      const target = allTanks.find((t) => t.id === rammer.lastCollidedTankId);
      const rName = formatCallName(rammer, allTanks);
      const tName = target ? formatCallName(target, allTanks) : '相手戦車';
      return {
        priority: 'B',
        category: 'ramming',
        badge: '激突',
        accentColor: rammer.blueprint.color,
        onEmit: () => {
          tracker.lastRamTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [`💢 激突！${rName} が ${tName} に猛スピードで体当たり！`],
            hype: [`💢 フルスピード衝突！！${rName} が ${tName} を吹き飛ばした！`],
            analyst: [`💢 高速衝突発生（${rName} ⇄ ${tName} / 速度係数反映）。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 13. Combat Football Endline Danger (Priority B)
  if (
    config.ruleId === 'tank_soccer' &&
    state.football &&
    !state.football.pendingKickoffReset &&
    state.tick - tracker.lastDangerTick >= 60 &&
    state.status === 'running'
  ) {
    const fb = state.football;
    const w = state.arena.width;
    const nearEastGoal = fb.x >= w * 0.84 && fb.vx >= 2.2;
    const nearWestGoal = fb.x <= w * 0.16 && fb.vx <= -2.2;
    if (nearEastGoal || nearWestGoal) {
      const attackerLabel = nearEastGoal ? fb.westTeamLabel : fb.eastTeamLabel;
      const defenderLabel = nearEastGoal ? fb.eastTeamLabel : fb.westTeamLabel;
      return {
        priority: 'B',
        category: 'status',
        badge: '好機',
        accentColor: nearEastGoal ? fb.westTeamColor : fb.eastTeamColor,
        onEmit: () => {
          tracker.lastDangerTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [`⚡ ゴール前の攻防！${attackerLabel} が ${defenderLabel} 陣へ猛攻！`],
            hype: [`⚡ 決まるか！？ボールは ${defenderLabel} ゴールライン目前！！`],
            analyst: [`⚡ ${attackerLabel} のシュートが ${defenderLabel} エンドライン付近へ迫っています。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 14. Sub-Weapon Activation (Priority B)
  if (state.tick - tracker.lastSubTick >= 65 && state.status === 'running') {
    const userTank = allTanks.find((t) => {
      const prev = tracker.tanks[t.id];
      return t.hp > 0 && prev && t.subAmmo < prev.subAmmo && t.blueprint.assembly.subWeapon !== 'none';
    });
    if (userTank) {
      const subId = userTank.blueprint.assembly.subWeapon;
      const subName = SUB_WEAPON_SPECS[subId]?.name ?? subId;
      const name = formatCallName(userTank, allTanks);
      return {
        priority: 'B',
        category: 'sub_weapon',
        badge: 'SP発動',
        accentColor: userTank.blueprint.color,
        onEmit: () => {
          tracker.lastSubTick = state.tick;
        },
        text: pickVariant(
          {
            standard: [`🛰 ${name} が特殊兵装「${subName}」を発動！`],
            hype: [`🔥 ここで「${subName}」！！${name} が勝負に出た！`],
            analyst: [`🛰 ${name} が ${subName} を使用（残弾 ${userTank.subAmmo}）。`],
          },
          style,
          cIdx
        ),
      };
    }
  }

  // 15. Quiet Status Recap (Priority C)
  if (state.status === 'running' && state.tick - tracker.lastEmittedTick >= 100) {
    if (config.ruleId === 'tank_soccer' && state.football) {
      const fb = state.football;
      const ws = Math.round(state.ruleTeamScores?.[fb.westTeamId] ?? 0);
      const es = Math.round(state.ruleTeamScores?.[fb.eastTeamId] ?? 0);
      const zone =
        fb.x < state.arena.width * 0.38
          ? `${fb.westTeamLabel} 陣内`
          : fb.x > state.arena.width * 0.62
            ? `${fb.eastTeamLabel} 陣内`
            : 'センター付近';
      return {
        priority: 'C',
        category: 'status',
        badge: '展開',
        text: `⚽ ボールは${zone}で激しい奪い合い（${fb.westTeamLabel} ${ws} - ${es} ${fb.eastTeamLabel}）`,
      };
    }

    if (config.ruleId === 'balloon_hunt' || config.ruleId === 'domination') {
      const unit = config.ruleId === 'balloon_hunt' ? 'pt' : 'マス';
      const sorted = Object.entries(state.ruleTeamScores ?? {}).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        const l1 = getTeamDisplayLabel(state, sorted[0][0]);
        const l2 = getTeamDisplayLabel(state, sorted[1][0]);
        return {
          priority: 'C',
          category: 'status',
          badge: '経過',
          text: `📊 1位 ${l1}（${Math.round(sorted[0][1])}${unit}）を ${l2}（${Math.round(sorted[1][1])}${unit}）が追う展開`,
        };
      }
    }

    const alive = allTanks.filter((t) => t.hp > 0);
    if (alive.length >= 2) {
      const topHp = [...alive].sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp)[0];
      const topName = formatCallName(topHp, allTanks);
      return {
        priority: 'C',
        category: 'status',
        badge: '状況',
        text: `📊 残り${alive.length}機が交戦中！現在 ${topName} が HP ${Math.round(topHp.hp)} で優勢`,
      };
    }
  }

  return null;
}

function canEmitNow(
  tracker: BattleCommentaryTracker,
  candidate: CandidateEvent,
  state: BattleState,
  nowMs: number
): boolean {
  if (candidate.priority === 'S') {
    // Prevent duplicate same-tick same-category emission
    return !(
      tracker.lastEmittedTick === state.tick &&
      tracker.lastEmittedCategory === candidate.category
    );
  }
  const elapsedMs = tracker.lastEmittedAtMs === 0 ? 10000 : nowMs - tracker.lastEmittedAtMs;
  if (candidate.category === 'opening') {
    return true;
  }
  if (candidate.priority === 'A') {
    const prevLow = tracker.lastEmittedPriority === 'B' || tracker.lastEmittedPriority === 'C';
    return elapsedMs >= 1700 || (elapsedMs >= 800 && prevLow);
  }
  if (candidate.priority === 'B') {
    return elapsedMs >= 1700;
  }
  // C
  return elapsedMs >= 3200;
}

/**
 * Compare current BattleState against tracker snapshots and optionally emit
 * a prioritized live commentary line. Always updates tracker snapshots so
 * disabled/throttled windows never leak stale historical events later.
 */
export function evaluateCommentaryStep(
  tracker: BattleCommentaryTracker,
  state: BattleState,
  config: BattlefieldConfig,
  settings: CommentarySettings,
  nowMs: number = Date.now()
): CommentaryEntry | null {
  let emitted: CommentaryEntry | null = null;

  if (settings.enabled) {
    const candidate = evaluateCandidateEvent(tracker, state, config, settings.style);
    if (candidate && canEmitNow(tracker, candidate, state, nowMs)) {
      candidate.onEmit?.();
      tracker.seq += 1;
      tracker.variantCounter += 1;
      tracker.lastEmittedAtMs = nowMs;
      tracker.lastEmittedTick = state.tick;
      tracker.lastEmittedPriority = candidate.priority;
      tracker.lastEmittedCategory = candidate.category;
      emitted = {
        id: `cm_${state.tick}_${tracker.seq}`,
        tick: state.tick,
        timeSec: Math.round((state.tick / 20) * 10) / 10,
        priority: candidate.priority,
        category: candidate.category,
        badge: candidate.badge,
        text: candidate.text,
        accentColor: candidate.accentColor,
        speechText: stripEmojiForSpeech(candidate.text),
      };
    }
  } else {
    if (state.tick > 0) tracker.openingEmitted = true;
    if (state.status === 'finished') tracker.finishEmitted = true;
    for (const t of state.tanks) {
      if (t.hp > 0 && t.hp / Math.max(1, t.maxHp) < 0.25) {
        tracker.announcedLowHpIds.add(t.id);
      }
    }
  }

  // Sync tracker snapshots cleanly every step
  tracker.lastTick = state.tick;
  tracker.tanks = captureTankSnapshots(state.tanks);
  if (state.tanks.some((t) => t.stats.damageDealt > 0)) {
    tracker.firstHitEmitted = true;
  }
  if (state.football) {
    tracker.lastFootballGoals = getTeamScoresTotal(state);
  }
  if (config.ruleId === 'balloon_hunt' || config.ruleId === 'domination') {
    const leader = findStrictLeader(state.ruleTeamScores);
    if (leader) {
      tracker.lastLeaderTeamId = leader.teamId;
    }
  }
  return emitted;
}

/** Check whether the browser supports offline Web Speech synthesis. */
export function isSpeechSynthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  );
}

/** Cancel any queued or in-progress Web Speech commentary utterance. */
export function stopCommentarySpeech(): void {
  try {
    if (isSpeechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
  } catch {
    // Ignore browser speech errors cleanly
  }
}

/** Speak a commentary entry aloud when Web Speech is explicitly enabled. */
export function speakCommentary(
  entry: CommentaryEntry,
  settings: CommentarySettings,
  speedMultiplier = 1,
  force = false
): void {
  if (!settings.enabled || !settings.speechEnabled || !isSpeechSynthesisSupported()) {
    return;
  }
  if (!force) {
    if (speedMultiplier >= 4) return;
    if (speedMultiplier > 2 && entry.priority !== 'S' && entry.priority !== 'A') return;
  }
  try {
    const synth = window.speechSynthesis;
    if (force || entry.priority === 'S') {
      synth.cancel();
    } else if (synth.speaking || synth.pending) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(entry.speechText);
    utterance.lang = 'ja-JP';
    utterance.rate = Math.max(0.8, Math.min(1.6, settings.speechRate));
    utterance.pitch = settings.style === 'hype' ? 1.12 : settings.style === 'analyst' ? 0.96 : 1.03;
    synth.speak(utterance);
  } catch {
    // Ignore speech synthesis errors cleanly
  }
}

export interface MatchSummaryComment {
  headline: string;
  highlights: string[];
  style: CommentaryStyle;
}

function pickStyleText(
  style: CommentaryStyle,
  variants: Record<CommentaryStyle, string>
): string {
  return variants[style] ?? variants.standard;
}

function formatRowCallName(
  row: TankMatchReportRow,
  allRows: TankMatchReportRow[]
): string {
  const pName = row.playerName.trim();
  const mName = row.machineName;
  if (!pName) return mName;
  if (!pName.startsWith('CPU')) {
    return `${mName}（${pName}）`;
  }
  const sameModelCount = allRows.filter((r) => r.machineName === mName).length;
  return sameModelCount > 1 ? `${mName}（${pName}）` : mName;
}

function buildSummaryHeadline(
  report: BattlefieldMatchReport,
  style: CommentaryStyle
): string {
  const ruleId = report.configSnapshot.ruleId;
  const rows = report.tankRows;
  const teams = report.teamRows;
  const isDraw = report.winType === 'draw' || !report.winnerTeamId;

  if (isDraw) {
    const anyDamage = rows.some((r) => r.damageDealt > 0 || r.ruleScore > 0);
    if (!anyDamage) {
      return pickStyleText(style, {
        standard: `決定打を欠いた静かな立ち上がりのまま、${report.durationSeconds.toFixed(1)}秒で時間切れ引き分けとなりました。`,
        hype: `互いに様子を見合ったままタイムアップ！決着は次戦へ持ち越しだ！`,
        analyst: `総与ダメ・ルールポイントともに有効打がなく、${report.durationSeconds.toFixed(1)}秒で引き分け判定となりました。`,
      });
    }
    return pickStyleText(style, {
      standard: `最後まで一進一退の攻防が続き、決着のつかない熱戦の引き分けとなりました。`,
      hype: `一歩も譲らぬ大激闘！！${report.durationSeconds.toFixed(1)}秒を戦い抜いてドロー決着！！`,
      analyst: `双方のスコア・貢献度が拮抗し、${report.durationSeconds.toFixed(1)}秒経過時点で引き分けとなりました。`,
    });
  }

  const winTeam =
    teams.find((t) => t.teamId === report.winnerTeamId) ?? teams[0];
  const secondTeam = teams.find((t) => t.teamId !== winTeam?.teamId);
  const winRow =
    rows.find((r) => r.tankId === report.winnerTankId) ??
    rows.find((r) => r.teamId === report.winnerTeamId) ??
    rows[0];

  const isMultiMemberTeam = (winTeam?.memberCount ?? 1) > 1;
  const winDisplay =
    isMultiMemberTeam || ruleId === 'tank_soccer' || ruleId === 'domination'
      ? winTeam?.teamLabel ?? (winRow ? formatRowCallName(winRow, rows) : '勝者')
      : winRow
        ? formatRowCallName(winRow, rows)
        : winTeam?.teamLabel ?? '勝者';

  if (ruleId === 'tank_soccer') {
    const s1 = Math.round(winTeam?.teamRuleScore ?? 0);
    const s2 = Math.round(secondTeam?.teamRuleScore ?? 0);
    if (s2 === 0 && s1 >= 2) {
      return pickStyleText(style, {
        standard: `${winDisplay} が鉄壁の守備でゴールを許さず、${s1} - 0 の完封勝利を収めました。`,
        hype: `完全シャットアウト！！${winDisplay} が ${s1} - 0 で相手を圧倒したぁ！！`,
        analyst: `${winDisplay} が無失点（${s1} - 0）で試合をコントロールし完封勝ちです。`,
      });
    }
    if (s1 - s2 === 1) {
      return pickStyleText(style, {
        standard: `${winDisplay} が ${s1} - ${s2} の1点差ゲームを制し、緊迫のフットボールを勝ち切りました。`,
        hype: `息詰まる1点差バトル！！最後は ${winDisplay} が ${s1} - ${s2} で競り勝ったぁ！！`,
        analyst: `得点差 1点（${s1} - ${s2}）の接戦を ${winDisplay} が制しました。`,
      });
    }
    if (s1 >= 4) {
      return pickStyleText(style, {
        standard: `得点が飛び交う乱打戦を ${winDisplay} が ${s1} - ${s2} で押し切りました。`,
        hype: `ゴールラッシュ爆発！！${winDisplay} が ${s1}得点を叩き込んで勝利！！`,
        analyst: `計 ${s1 + s2}ゴールのオープンな展開を ${winDisplay}（${s1} - ${s2}）が制しています。`,
      });
    }
    return pickStyleText(style, {
      standard: `${winDisplay} が ${s1} - ${s2} で相手ゴールを脅かし続け、手堅く勝利しました。`,
      hype: `${winDisplay} が ${s1} - ${s2} でピッチを制圧！！見事な勝利だ！！`,
      analyst: `最終スコア ${s1} - ${s2} で ${winDisplay} の勝利となりました。`,
    });
  }

  if (ruleId === 'domination') {
    const s1 = Math.round(winTeam?.teamRuleScore ?? 0);
    const s2 = Math.round(secondTeam?.teamRuleScore ?? 0);
    const gap = s1 - s2;
    if ((winTeam?.aliveCount ?? 0) === 0) {
      return pickStyleText(style, {
        standard: `機体は全滅したものの、築き上げた占領リード（${s1}マス）を守り切った ${winDisplay} の見事なルール勝利です。`,
        hype: `全滅上等・領地で勝つ！！${winDisplay} が ${s1}マスを抱えて逃げ切り勝利だぁ！！`,
        analyst: `勝者側残存機数は 0 ですが、保有タイル数 ${s1}マス（2位 ${s2}マス）で ${winDisplay} が勝利条件を満たしました。`,
      });
    }
    if (gap >= 10) {
      return pickStyleText(style, {
        standard: `${winDisplay} が終始フィールドを支配し、2位に${gap}マス差をつける圧巻の制圧勝利でした。`,
        hype: `マップが完全制圧された！！${winDisplay} が${s1}マス（+${gap}マス差）で独走優勝だ！！`,
        analyst: `${winDisplay} が ${s1}マス（2位と +${gap}マス差）を確保し、安定した陣地展開で快勝しました。`,
      });
    }
    if (gap <= 3) {
      return pickStyleText(style, {
        standard: `最後まで塗り合いが続いた僅差の陣取りを、${winDisplay} がわずか ${gap}マス差（${s1} vs ${s2}）で制しました。`,
        hype: `紙一重の領地争奪戦！！${winDisplay} がラストに ${gap}マス上回って大勝利！！`,
        analyst: `最終タイル差 ${gap}マス（${s1}対${s2}）の接戦を ${winDisplay} が制しています。`,
      });
    }
    return pickStyleText(style, {
      standard: `${winDisplay} が要所のタイルを着実に確保し、${s1}マス占領で勝利しました。`,
      hype: `${winDisplay} が陣地争いを制覇！${s1}マスを染め上げて堂々の勝利！！`,
      analyst: `${winDisplay} が最終 ${s1}マス（2位 ${s2}マス）を占領して勝利しました。`,
    });
  }

  if (ruleId === 'balloon_hunt') {
    const s1 = Math.round(winTeam?.teamRuleScore ?? 0);
    const s2 = Math.round(secondTeam?.teamRuleScore ?? 0);
    const gap = s1 - s2;
    if (gap <= 4) {
      return pickStyleText(style, {
        standard: `${winDisplay} が ${s1}pt を積み上げ、2位とわずか ${gap}pt差のデッドヒートを制しました。`,
        hype: `超接戦の風船レース！！${winDisplay} が ${gap}pt差（${s1}pt）で競り勝ったぁ！！`,
        analyst: `上位差 ${gap}pt（1位 ${s1}pt / 2位 ${s2}pt）の僅差を ${winDisplay} が制しました。`,
      });
    }
    if (gap >= 15) {
      return pickStyleText(style, {
        standard: `${winDisplay} が正確な狙撃で ${s1}pt を荒稼ぎし、後続に ${gap}pt差の快勝です。`,
        hype: `風船ハンター無双！！${winDisplay} が ${s1}pt（+${gap}pt差）でぶっちぎり優勝！！`,
        analyst: `${winDisplay} が合計 ${s1}pt を記録し、2位（${s2}pt）に大きなリードを築いて勝利しました。`,
      });
    }
    return pickStyleText(style, {
      standard: `${winDisplay} が手際よく風船を割り続け、${s1}pt でトップを守り切りました。`,
      hype: `ナイスハンティング！${winDisplay} が ${s1}pt を奪取して風船バトル優勝！！`,
      analyst: `${winDisplay} が計 ${s1}pt を獲得し、安定してポイントを重ねました。`,
    });
  }

  // Elimination / Ramming Derby
  const defeatedMaxGrid = rows
    .filter(
      (r) =>
        r.teamId !== report.winnerTeamId &&
        (!r.isAlive || r.damageTaken > 0)
    )
    .reduce((mx, r) => Math.max(mx, r.gridSize), 0);
  const isGiantKilling =
    winRow &&
    !isMultiMemberTeam &&
    defeatedMaxGrid > winRow.gridSize &&
    (winRow.kills >= 1 || report.winType === 'elimination');

  if (isGiantKilling && winRow) {
    return pickStyleText(style, {
      standard: `${winRow.gridSize}×${winRow.gridSize} CPUの ${winDisplay} が上位規格（${defeatedMaxGrid}×${defeatedMaxGrid}）を下すジャイアントキリングを達成しました！`,
      hype: `大番狂わせ・下克上！！小型CPU（${winRow.gridSize}×${winRow.gridSize}）の ${winDisplay} が格上を撃破したぁ！！`,
      analyst: `${winRow.gridSize}×${winRow.gridSize} 機の ${winDisplay} が最大 ${defeatedMaxGrid}×${defeatedMaxGrid} 機を含む相手陣営を破る高効率勝利です。`,
    });
  }

  if (ruleId === 'ramming_derby' && winRow) {
    return pickStyleText(style, {
      standard: `${winDisplay} が体当たり ${Math.round(winRow.ruleScore)}pt（${winRow.kills}撃破）を記録し、肉弾戦を制しました。`,
      hype: `凄まじいパワー勝負！！${winDisplay} が衝突pt ${Math.round(winRow.ruleScore)} の破壊力で頂点に立った！！`,
      analyst: `${winDisplay} が体当たりスコア ${Math.round(winRow.ruleScore)}pt・撃破 ${winRow.kills} でトップ評価を獲得しました。`,
    });
  }

  if (winRow && winRow.kills >= 3 && report.winType === 'elimination') {
    return pickStyleText(style, {
      standard: `${winDisplay} が ${winRow.kills}撃破・与ダメ ${Math.round(winRow.damageDealt)} の大車輪の活躍で戦場を制圧しました。`,
      hype: `完全無双！！${winDisplay} が ${winRow.kills}機をなぎ倒して圧倒的チャンピオンだぁ！！`,
      analyst: `${winDisplay} が全撃破のうち ${winRow.kills}撃破・与ダメ ${Math.round(winRow.damageDealt)} を記録し、主導権を握り続けました。`,
    });
  }

  if (
    winRow &&
    winRow.isAlive &&
    winRow.hpRemaining / Math.max(1, winRow.maxHp) < 0.25
  ) {
    return pickStyleText(style, {
      standard: `残りHP ${winRow.hpRemaining} という紙一重の消耗戦を耐え抜き、${winDisplay} が勝利を掴み取りました。`,
      hype: `まさに首の皮一枚！！HPわずか ${winRow.hpRemaining} で生き残った ${winDisplay} の執念が実ったぁ！！`,
      analyst: `勝者 ${winDisplay} の残存HPは ${winRow.hpRemaining}/${winRow.maxHp}。極めて拮抗した消耗戦でした。`,
    });
  }

  if (report.winType === 'decision' && winRow) {
    return pickStyleText(style, {
      standard: `${report.durationSeconds.toFixed(1)}秒のフルタイムを戦い抜き、総合貢献度で上回った ${winDisplay} が判定勝利を収めました。`,
      hype: `フルタイムの総力戦！！戦場を最も動かした ${winDisplay} が堂々の判定勝利だ！！`,
      analyst: `タイムアップ（${report.durationSeconds.toFixed(1)}秒）により、生存・貢献度評価で ${winDisplay}（スコア ${winRow.contributionScore}）が勝利しました。`,
    });
  }

  if (
    winRow &&
    winRow.isAlive &&
    winRow.hpRemaining / Math.max(1, winRow.maxHp) >= 0.75 &&
    report.durationSeconds <= report.configSnapshot.maxSeconds * 0.5
  ) {
    return pickStyleText(style, {
      standard: `${winDisplay} が盤石の立ち回りでHPを多く残したまま、${report.durationSeconds.toFixed(1)}秒で速やかに決着をつけました。`,
      hype: `圧巻のスピード決着！！${winDisplay} がほとんど傷を負わず ${report.durationSeconds.toFixed(1)}秒で勝負を決めた！！`,
      analyst: `${winDisplay} は残HP率 ${Math.round((winRow.hpRemaining / Math.max(1, winRow.maxHp)) * 100)}%・試合時間 ${report.durationSeconds.toFixed(1)}秒で完勝しています。`,
    });
  }

  return pickStyleText(style, {
    standard: `${winDisplay} が着実に戦果を重ね、${report.durationSeconds.toFixed(1)}秒で激戦を勝ち抜きました。`,
    hype: `${winDisplay} が混戦を制覇！！見事な勝利を手にしたぁ！！`,
    analyst: `${winDisplay} が総合力で上回り、${report.durationSeconds.toFixed(1)}秒で決着しました。`,
  });
}

function pickKeyTurningPoint(
  commentaryLog: CommentaryEntry[]
): CommentaryEntry | null {
  const candidates = commentaryLog.filter(
    (e) => e.category !== 'opening' && e.category !== 'finish'
  );
  if (candidates.length === 0) return null;
  const rankOrder: Record<CommentaryCategory, number> = {
    lead_change: 5,
    goal: 4,
    duel: 4,
    ko: 3,
    critical: 2,
    low_hp: 2,
    ramming: 1,
    sub_weapon: 1,
    countdown: 0,
    status: 0,
    opening: 0,
    finish: 0,
  };
  return [...candidates].sort((a, b) => {
    const rDiff = (rankOrder[b.category] ?? 0) - (rankOrder[a.category] ?? 0);
    if (rDiff !== 0) return rDiff;
    return b.tick - a.tick;
  })[0];
}

/**
 * Generate a post-match system summary (headline + highlights) synced with the
 * selected commentary style and optional live commentary history.
 */
export function buildMatchSummaryComment(
  report: BattlefieldMatchReport,
  style: CommentaryStyle = 'standard',
  commentaryLog: CommentaryEntry[] = []
): MatchSummaryComment {
  const headline = buildSummaryHeadline(report, style);
  const highlights: string[] = [];
  const rows = report.tankRows;
  const winRow =
    rows.find((r) => r.tankId === report.winnerTankId) ??
    rows.find((r) => r.teamId === report.winnerTeamId) ??
    rows[0];

  // 1. Non-winner standout performance
  const nonWinners = rows.filter((r) => r.teamId !== report.winnerTeamId);
  if (nonWinners.length > 0) {
    const mvpOther = nonWinners.find((r) => r.awards.includes('🏆 MVP'));
    const maxDmgOther = nonWinners.find((r) => r.awards.includes('💥 最多ダメージ'));
    const sharpOther = [...nonWinners]
      .filter((r) => r.shotsFired >= 8 && (r.hitRatePercent ?? 0) >= 25)
      .sort((a, b) => (b.hitRatePercent ?? 0) - (a.hitRatePercent ?? 0))[0];
    const runnerUp = [...nonWinners].sort((a, b) => a.rank - b.rank)[0];

    if (mvpOther) {
      const name = formatRowCallName(mvpOther, rows);
      highlights.push(
        pickStyleText(style, {
          standard: `健闘賞: 敗れはしたものの、${name} が ${mvpOther.kills}撃破・与ダメ ${mvpOther.damageDealt.toFixed(1)} でMVP級の暴れぶりを見せました。`,
          hype: `敗れてなお最強！？${name} が ${mvpOther.kills}撃破・与ダメ ${mvpOther.damageDealt.toFixed(1)} で会場を沸かせた！`,
          analyst: `非勝利側最多貢献: ${name}（貢献度 ${mvpOther.contributionScore} / 撃破 ${mvpOther.kills} / 与ダメ ${mvpOther.damageDealt.toFixed(1)}）。`,
        })
      );
    } else if (sharpOther && (sharpOther.hitRatePercent ?? 0) >= 28) {
      const name = formatRowCallName(sharpOther, rows);
      const rate = (sharpOther.hitRatePercent ?? 0).toFixed(1);
      highlights.push(
        pickStyleText(style, {
          standard: `精密射撃: ${sharpOther.rank}位・${name} は命中率 ${rate}%（${sharpOther.shotsHit}/${sharpOther.shotsFired}）の高精度で食い下がりました。`,
          hype: `スナイパーの輝き！${sharpOther.rank}位の ${name} が命中率 ${rate}% の神業ショットで爪痕を残した！`,
          analyst: `高命中ピック: ${name}（${sharpOther.rank}位 / 命中率 ${rate}% / 与ダメ ${sharpOther.damageDealt.toFixed(1)}）。`,
        })
      );
    } else if (maxDmgOther) {
      const name = formatRowCallName(maxDmgOther, rows);
      highlights.push(
        pickStyleText(style, {
          standard: `火力の主役: ${maxDmgOther.rank}位・${name} が試合最多の与ダメージ ${maxDmgOther.damageDealt.toFixed(1)} を叩き出しました。`,
          hype: `大砲炸裂！！${name} が全機トップの与ダメ ${maxDmgOther.damageDealt.toFixed(1)} で戦場を揺らした！`,
          analyst: `最多与ダメージ: ${name}（${maxDmgOther.damageDealt.toFixed(1)} / 貢献度 ${maxDmgOther.contributionScore}）。`,
        })
      );
    } else if (runnerUp && winRow && runnerUp.damageDealt >= winRow.damageDealt * 0.75 && runnerUp.damageDealt >= 40) {
      const name = formatRowCallName(runnerUp, rows);
      highlights.push(
        pickStyleText(style, {
          standard: `惜敗の次点: ${runnerUp.rank}位・${name} も与ダメ ${runnerUp.damageDealt.toFixed(1)} で一歩も引かない戦いぶりでした。`,
          hype: `あと一歩だった！${runnerUp.rank}位の ${name} も最後まで勝者を脅かす好ファイト！`,
          analyst: `次点評価: ${name}（${runnerUp.rank}位 / 与ダメ ${runnerUp.damageDealt.toFixed(1)}）。`,
        })
      );
    }
  }

  // 2. Match-wide notable stat (wall KOs / toughness / winner sniper accuracy)
  const wallKoCount = rows.filter((r) => r.killedByLabel === '壁・環境').length;
  const tankySurvivor = [...rows]
    .filter((r) => r.isAlive && r.damageTaken >= 140)
    .sort((a, b) => b.damageTaken - a.damageTaken)[0];
  if (wallKoCount > 0) {
    highlights.push(
      pickStyleText(style, {
        standard: `戦場ギミック: 外周壁の電撃ダメージで ${wallKoCount}機が戦線離脱するスリリングな展開になりました。`,
        hype: `電撃ウォールが牙を剥いた！！外周壁で計 ${wallKoCount}機が吹き飛ぶ大波乱！`,
        analyst: `環境KO発生: 外周壁ギミックにより ${wallKoCount}機が撃破されました。`,
      })
    );
  } else if (tankySurvivor) {
    const name = formatRowCallName(tankySurvivor, rows);
    highlights.push(
      pickStyleText(style, {
        standard: `タフネス: ${name} が合計 ${tankySurvivor.damageTaken.toFixed(1)} ダメージを受けながらも最後まで生き残りました。`,
        hype: `なんという重装甲！！${name} は ${tankySurvivor.damageTaken.toFixed(1)} ダメージを耐え抜いて完走だ！`,
        analyst: `耐久記録: ${name} が被ダメージ ${tankySurvivor.damageTaken.toFixed(1)} で完走（残HP ${tankySurvivor.hpRemaining}/${tankySurvivor.maxHp}）。`,
      })
    );
  } else if (winRow && winRow.shotsFired >= 10 && (winRow.hitRatePercent ?? 0) >= 35) {
    const name = formatRowCallName(winRow, rows);
    highlights.push(
      pickStyleText(style, {
        standard: `勝因データ: 勝者 ${name} は命中率 ${(winRow.hitRatePercent ?? 0).toFixed(1)}% の正確な照準で着実に削り切りました。`,
        hype: `狙い澄ました一撃必殺！勝者 ${name} の命中率は脅威の ${(winRow.hitRatePercent ?? 0).toFixed(1)}%！`,
        analyst: `勝者精度: ${name} の命中率は ${(winRow.hitRatePercent ?? 0).toFixed(1)}%（${winRow.shotsHit}/${winRow.shotsFired}）。`,
      })
    );
  }

  // 3. Turning point from live commentary log
  const turningPoint = pickKeyTurningPoint(commentaryLog);
  if (turningPoint && highlights.length < 3) {
    highlights.push(`名場面 (${turningPoint.timeSec.toFixed(1)}s): ${turningPoint.speechText}`);
  }

  return {
    headline,
    highlights: highlights.slice(0, 3),
    style,
  };
}
