import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Award,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FastForward,
  History,
  Mic,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings,
  Shuffle,
  Sparkles,
  Swords,
  Trash2,
  Trophy,
  Upload,
  Users,
  Volume2,
  Wrench,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { DEFAULT_PLAYER_BLUEPRINT, PRESET_ENEMIES } from '../data/presets';
import {
  BattleCommentaryTracker,
  buildMatchSummaryComment,
  COMMENTARY_STYLE_SPECS,
  CommentaryEntry,
  CommentarySettings,
  CommentaryStyle,
  createCommentaryTracker,
  createStandbyCommentaryText,
  evaluateCommentaryStep,
  isSpeechSynthesisSupported,
  loadCommentarySettings,
  saveCommentarySettings,
  speakCommentary,
  stopCommentarySpeech,
} from '../engine/battleCommentary';
import {
  applyLeagueGameResult,
  applyRecommendedMapPreset,
  applyTournamentGameResult,
  ARENA_ZONE_MODE_SPECS,
  ArenaZoneMode,
  assignRandomTeams,
  BATTLEFIELD_RULE_REGISTRY,
  BattlefieldConfig,
  BattlefieldFormat,
  BattlefieldParticipant,
  BattlefieldRosterEntry,
  BattlefieldRuleId,
  buildMatchReport,
  buildParticipantsFromUnitPair,
  clearBattlefieldSession,
  CompetitionUnit,
  computeBattlefieldHudLayout,
  computeLeagueStandings,
  CPU_REGULATION_SPECS,
  CpuRegulationId,
  createBattlefieldMatchState,
  createLeagueSchedule,
  createRosterEntryFromBlueprint,
  createTournamentBracket,
  DEFAULT_BATTLEFIELD_CONFIG,
  disambiguateRosterPlayerNames,
  formatConfigConditionSuffix,
  formatLeagueStandingsText,
  formatMatchReportText,
  formatMatchReportTsv,
  formatTankListLabel,
  formatTournamentSummaryText,
  getRecommendedMapPreset,
  GRAVITY_PRESET_SPECS,
  GravityPresetId,
  isRecommendedMapPresetApplied,
  LeagueMatch,
  loadBattlefieldSession,
  OUTER_WALL_MODE_SPECS,
  parseImportedTankContent,
  pickRandomBattleRoyaleEntries,
  resolveMatchConfigForGame,
  resolveRecommendedTankTier,
  SANDSTORM_PRESET_SPECS,
  SandstormPresetId,
  saveBattlefieldSession,
  shuffleCompetitionRoster,
  simulateMatchHeadless,
  sortRosterEntries,
  stepBattlefieldTick,
  TEAM_COLORS,
  TEAM_LABELS,
  TournamentBracket,
  validateEntryForRegulation,
  validateTeamForRegulation,
} from '../engine/battlefield';
import {
  ARENA_SIZE_SPECS,
  cloneBattleStateForStep,
} from '../engine/simulator';
import {
  ArenaSizeId,
  BattleState,
  CameraMode,
  ObstacleMode,
  OuterWallMode,
  TankBlueprint,
} from '../types/game';
import {
  CURRENT_GAME_VERSION,
  getAutoTankColor,
  sanitizeAuthorName,
} from '../utils/codeParser';
import { loadSavedBlueprints } from '../utils/share';
import { BattleCanvas3D } from './BattleCanvas3D';

const BASE_TPS = 20;

function createInitialRoster(): BattlefieldRosterEntry[] {
  const picks = [
    DEFAULT_PLAYER_BLUEPRINT,
    ...PRESET_ENEMIES.filter((e) => e.program.gridSize <= 6).slice(0, 3),
  ];
  return sortRosterEntries(
    disambiguateRosterPlayerNames(
      picks.map((bp, idx) => {
        const entry = createRosterEntryFromBlueprint(bp, '規定戦車', true);
        entry.teamSlot = idx % 2;
        return entry;
      })
    )
  );
}

function buildUnitsForCompetition(
  entries: BattlefieldRosterEntry[],
  config: BattlefieldConfig
): { units: CompetitionUnit[]; skippedNames: string[] } {
  const skippedNames: string[] = [];
  const enabled = entries.filter((e) => e.enabled);

  if (config.teamUnitSize === 1 && config.cpuRegulation !== 'pair_6x6_4x4') {
    const units: CompetitionUnit[] = [];
    enabled.forEach((entry) => {
      const chk = validateEntryForRegulation(entry, config.cpuRegulation);
      if (!chk.valid) {
        skippedNames.push(`${entry.machineName} (${chk.reason ?? '規格外'})`);
        return;
      }
      units.push({
        unitId: `unit_${entry.entryId}`,
        unitName: `${entry.machineName} (${entry.playerName})`,
        entries: [entry],
        color: getAutoTankColor(units.length),
      });
    });
    return { units, skippedNames };
  }

  // Pair unit assembly (2 tanks per unit)
  const units: CompetitionUnit[] = [];
  if (config.cpuRegulation === 'pair_6x6_4x4') {
    const fourPool = enabled.filter((e) => e.blueprint.program.gridSize === 4);
    const sixPool = enabled.filter((e) => e.blueprint.program.gridSize === 6);
    const invalid = enabled.filter((e) => e.blueprint.program.gridSize > 6);
    invalid.forEach((e) =>
      skippedNames.push(`${e.machineName} (${e.blueprint.program.gridSize}×${e.blueprint.program.gridSize}はペア規格外)`)
    );

    const usedIds = new Set<string>();
    // First pair 6x6 + 4x4 cleanly; leftover 4x4s can pair with each other (since 4<=6 and 4<=4)
    for (const s of sixPool) {
      const partner = fourPool.find((f) => !usedIds.has(f.entryId));
      if (!partner) {
        skippedNames.push(`${s.machineName} (4×4のパートナー不足)`);
        continue;
      }
      usedIds.add(s.entryId);
      usedIds.add(partner.entryId);
      const idx = units.length;
      units.push({
        unitId: `pair_${idx + 1}`,
        unitName: `${s.playerName} & ${partner.playerName}`,
        entries: [s, partner],
        color: getAutoTankColor(idx),
      });
    }
    const leftoverFour = fourPool.filter((f) => !usedIds.has(f.entryId));
    for (let i = 0; i + 1 < leftoverFour.length; i += 2) {
      const a = leftoverFour[i];
      const b = leftoverFour[i + 1];
      const idx = units.length;
      units.push({
        unitId: `pair_${idx + 1}`,
        unitName: `${a.playerName} & ${b.playerName}`,
        entries: [a, b],
        color: getAutoTankColor(idx),
      });
    }
    if (leftoverFour.length % 2 === 1) {
      const last = leftoverFour[leftoverFour.length - 1];
      skippedNames.push(`${last.machineName} (ペア相手不足)`);
    }
    return { units, skippedNames };
  }

  const eligible = enabled.filter((e) => {
    const chk = validateEntryForRegulation(e, config.cpuRegulation);
    if (!chk.valid) {
      skippedNames.push(`${e.machineName} (${chk.reason ?? '規格外'})`);
      return false;
    }
    return true;
  });
  for (let i = 0; i + 1 < eligible.length; i += 2) {
    const a = eligible[i];
    const b = eligible[i + 1];
    const idx = units.length;
    units.push({
      unitId: `pair_${idx + 1}`,
      unitName: `${a.playerName} & ${b.playerName}`,
      entries: [a, b],
      color: getAutoTankColor(idx),
    });
  }
  if (eligible.length % 2 === 1) {
    skippedNames.push(`${eligible[eligible.length - 1].machineName} (ペア相手不足)`);
  }
  return { units, skippedNames };
}

function buildParticipantsForSingleMatch(
  roster: BattlefieldRosterEntry[],
  config: BattlefieldConfig
): {
  participants: BattlefieldParticipant[];
  notice: string | null;
} {
  const enabled = roster.filter((e) => e.enabled);
  const isTwoTeamFootball = config.ruleId === 'tank_soccer';

  if (config.format === 'battle_royale' && !isTwoTeamFootball) {
    const eligible: BattlefieldParticipant[] = [];
    let skipped = 0;
    for (const entry of enabled) {
      const chk = validateEntryForRegulation(entry, config.cpuRegulation);
      if (!chk.valid) {
        skipped += 1;
        continue;
      }
      if (eligible.length >= 8) break;
      const idx = eligible.length;
      eligible.push({
        entry,
        teamId: `ffa_${idx}`,
        teamLabel: entry.playerName,
        teamColor: getAutoTankColor(idx),
        slotIndex: idx,
      });
    }
    return {
      participants: eligible,
      notice:
        skipped > 0
          ? `レギュレーション不適合の ${skipped}機を除外しました。`
          : eligible.length < 2
            ? 'バトルロワイヤルには適合機体が 2機以上必要です。'
            : null,
    };
  }

  // Team match (Team A..D grouped)
  const grouped: Map<number, BattlefieldRosterEntry[]> = new Map();
  for (const e of enabled) {
    const slot = Math.max(0, Math.min(3, e.teamSlot ?? 0));
    const arr = grouped.get(slot) ?? [];
    arr.push(e);
    grouped.set(slot, arr);
  }

  const validTeams: Array<{ slot: number; members: BattlefieldRosterEntry[] }> = [];
  const warnings: string[] = [];
  for (const [slot, members] of Array.from(grouped.entries()).sort((a, b) => a[0] - b[0])) {
    const ordered =
      config.cpuRegulation === 'pair_6x6_4x4'
        ? [...members].sort((a, b) => b.blueprint.program.gridSize - a.blueprint.program.gridSize)
        : members;
    const chk = validateTeamForRegulation(ordered, config.cpuRegulation);
    if (!chk.valid) {
      warnings.push(`${TEAM_LABELS[slot]}: ${chk.reason}`);
      continue;
    }
    validTeams.push({ slot, members: ordered });
  }

  // Combat Football is always 2-sided (West vs East); auto-balance if <2 or >2 teams
  if (isTwoTeamFootball && validTeams.length !== 2) {
    const eligibleEntries: BattlefieldRosterEntry[] = [];
    let skipped = 0;
    for (const entry of enabled) {
      const chk = validateEntryForRegulation(entry, config.cpuRegulation);
      if (!chk.valid) {
        skipped += 1;
        continue;
      }
      if (eligibleEntries.length >= 8) break;
      eligibleEntries.push(entry);
    }
    const splitParticipants: BattlefieldParticipant[] = eligibleEntries.map((entry, idx) => {
      const side = idx % 2;
      return {
        entry,
        teamId: `team_${side}`,
        teamLabel: TEAM_LABELS[side],
        teamColor: TEAM_COLORS[side],
        slotIndex: Math.floor(idx / 2),
      };
    });
    return {
      participants: splitParticipants,
      notice:
        eligibleEntries.length < 2
          ? 'コンバットフットボールには適合機体が 2機以上必要です。'
          : skipped > 0
            ? `レギュレーション不適合の ${skipped}機を除外し、2チームへ自動振り分けしました。`
            : '2チーム対抗戦用に自動で Team A / Team B へ均等振り分けしました。',
    };
  }

  const participants: BattlefieldParticipant[] = [];
  const maxRoundLen = Math.max(0, ...validTeams.map((t) => t.members.length));
  // Interleave spawn order across teams
  for (let i = 0; i < maxRoundLen; i++) {
    for (const t of validTeams) {
      if (t.members[i] && participants.length < 8) {
        participants.push({
          entry: t.members[i],
          teamId: `team_${t.slot}`,
          teamLabel: TEAM_LABELS[t.slot],
          teamColor: TEAM_COLORS[t.slot],
          slotIndex: i,
        });
      }
    }
  }

  const notice =
    warnings.length > 0
      ? warnings.join(' / ')
      : validTeams.length < 2
        ? 'チーム戦には適合するチームが 2つ以上必要です。'
        : null;

  return { participants, notice };
}

export const BattlefieldApp: React.FC = () => {
  const initialSetup = useMemo(() => {
    const restored = loadBattlefieldSession();
    const initRoster = restored ? restored.roster : createInitialRoster();
    const initConfig = restored ? restored.config : { ...DEFAULT_BATTLEFIELD_CONFIG };
    let initBracket = restored ? restored.tournamentBracket : null;
    let initLeague = restored ? restored.leagueData : null;
    let initActiveMatchId = restored ? restored.activeMatchId : null;
    const initAutoAdvance = restored ? restored.autoAdvance : false;

    let participants: BattlefieldParticipant[] = [];
    let matchConfig = resolveMatchConfigForGame(initConfig, 0);

    if (initConfig.format === 'tournament' && initBracket) {
      initLeague = null;
      const allMatches = initBracket.rounds.flat();
      const targetMatch =
        allMatches.find((m) => m.matchId === initActiveMatchId && m.unitAId && m.unitBId && !m.isBye) ??
        allMatches.find((m) => !m.winnerUnitId && m.unitAId && m.unitBId && !m.isBye) ??
        allMatches.find((m) => m.unitAId && m.unitBId && !m.isBye);
      if (targetMatch) {
        const uA = initBracket.units.find((u) => u.unitId === targetMatch.unitAId);
        const uB = initBracket.units.find((u) => u.unitId === targetMatch.unitBId);
        if (uA && uB) {
          initActiveMatchId = targetMatch.matchId;
          matchConfig = resolveMatchConfigForGame(initConfig, targetMatch.gameReports?.length ?? 0);
          participants = buildParticipantsFromUnitPair(uA, uB);
        }
      }
    } else if (initConfig.format === 'league' && initLeague) {
      initBracket = null;
      const targetMatch =
        initLeague.matches.find((m) => m.matchId === initActiveMatchId) ??
        initLeague.matches.find((m) => !m.report) ??
        initLeague.matches[0];
      if (targetMatch) {
        const uA = initLeague.units.find((u) => u.unitId === targetMatch.unitAId);
        const uB = initLeague.units.find((u) => u.unitId === targetMatch.unitBId);
        if (uA && uB) {
          initActiveMatchId = targetMatch.matchId;
          matchConfig = resolveMatchConfigForGame(initConfig, targetMatch.gameReports?.length ?? 0);
          participants = buildParticipantsFromUnitPair(uA, uB);
        }
      }
    } else {
      initBracket = null;
      initLeague = null;
      initActiveMatchId = null;
      participants = buildParticipantsForSingleMatch(initRoster, initConfig).participants;
    }

    return {
      wasRestored: Boolean(restored),
      initRoster,
      initConfig,
      initBracket,
      initLeague,
      initActiveMatchId,
      initAutoAdvance,
      matchConfig,
      participants,
      state: createBattlefieldMatchState(participants, matchConfig),
    };
  }, []);

  const [roster, setRoster] = useState<BattlefieldRosterEntry[]>(() => initialSetup.initRoster);
  const [config, setConfig] = useState<BattlefieldConfig>(() => initialSetup.initConfig);
  const [activeMatchConfig, setActiveMatchConfig] = useState<BattlefieldConfig>(
    () => initialSetup.matchConfig
  );

  const [activeParticipants, setActiveParticipants] = useState<BattlefieldParticipant[]>(
    initialSetup.participants
  );
  const [battleState, setBattleState] = useState<BattleState>(initialSetup.state);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(0.5);
  const [cameraMode, setCameraMode] = useState<CameraMode>('tactical');
  const [focusTankId, setFocusTankId] = useState<string | null>(null);
  const [showDebugOverlay, setShowDebugOverlay] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [setupCollapsed, setSetupCollapsed] = useState(false);

  const savedPickerItems = useMemo(() => {
    const saved = loadSavedBlueprints();
    return [...saved]
      .sort((a, b) => {
        const pA = sanitizeAuthorName(a.author, 'Player');
        const pB = sanitizeAuthorName(b.author, 'Player');
        const pCmp = pA.localeCompare(pB, 'ja');
        if (pCmp !== 0) return pCmp;
        const gsCmp = a.program.gridSize - b.program.gridSize;
        if (gsCmp !== 0) return gsCmp;
        return a.name.localeCompare(b.name, 'ja');
      })
      .map((bp) => ({
        key: `saved:${bp.id}`,
        bp,
        isPreset: false,
        label: formatTankListLabel(
          bp.name,
          sanitizeAuthorName(bp.author, 'Player'),
          bp.program.gridSize
        ),
      }));
  }, []);

  const presetPickerItems = useMemo(() => {
    const allPresets: TankBlueprint[] = [DEFAULT_PLAYER_BLUEPRINT, ...PRESET_ENEMIES];
    return [...allPresets]
      .sort((a, b) => {
        const gsCmp = a.program.gridSize - b.program.gridSize;
        if (gsCmp !== 0) return gsCmp;
        return a.name.localeCompare(b.name, 'ja');
      })
      .map((bp) => ({
        key: `preset:${bp.id}`,
        bp,
        isPreset: true,
        label: formatTankListLabel(bp.name, 'CPU', bp.program.gridSize),
      }));
  }, []);

  const [shareCodeInput, setShareCodeInput] = useState('');
  const [presetPickerId, setPresetPickerId] = useState(
    () => savedPickerItems[0]?.key ?? presetPickerItems[0]?.key ?? ''
  );
  const [importNotice, setImportNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [matchNotice, setMatchNotice] = useState<string | null>(null);

  const [tournamentBracket, setTournamentBracket] = useState<TournamentBracket | null>(
    () => initialSetup.initBracket
  );
  const [leagueData, setLeagueData] = useState<{
    units: CompetitionUnit[];
    matches: LeagueMatch[];
  } | null>(() => initialSetup.initLeague);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(
    () => initialSetup.initActiveMatchId
  );
  const [autoAdvance, setAutoAdvance] = useState(() => initialSetup.initAutoAdvance);

  const [latestReport, setLatestReport] = useState<ReturnType<typeof buildMatchReport> | null>(
    null
  );
  const [showResultModal, setShowResultModal] = useState(false);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [recentPlayedEntryIds, setRecentPlayedEntryIds] = useState<Set<string>>(() => new Set());
  const [vsBannerDismissed, setVsBannerDismissed] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const accumulatorRef = useRef(0);
  const recordedFinishRef = useRef(false);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const resultModalTimerRef = useRef<number | null>(null);
  const goalPauseUntilRef = useRef<number>(0);

  const [commentarySettings, setCommentarySettings] = useState<CommentarySettings>(() =>
    loadCommentarySettings()
  );
  const [commentaryLog, setCommentaryLog] = useState<CommentaryEntry[]>([]);
  const [commentarySettingsOpen, setCommentarySettingsOpen] = useState(false);
  const [commentaryHistoryOpen, setCommentaryHistoryOpen] = useState(false);
  const commentaryTrackerRef = useRef<BattleCommentaryTracker>(
    createCommentaryTracker(initialSetup.state, initialSetup.matchConfig)
  );
  const suppressNextCommentarySpeechRef = useRef(false);
  const speechSupported = useMemo(() => isSpeechSynthesisSupported(), []);

  useEffect(() => {
    saveCommentarySettings(commentarySettings);
  }, [commentarySettings]);

  const resetCommentary = useCallback((state: BattleState, nextConfig: BattlefieldConfig) => {
    stopCommentarySpeech();
    suppressNextCommentarySpeechRef.current = false;
    commentaryTrackerRef.current = createCommentaryTracker(state, nextConfig);
    setCommentaryLog([]);
  }, []);

  useEffect(() => {
    if (!isPlaying || !commentarySettings.enabled || !commentarySettings.speechEnabled) {
      stopCommentarySpeech();
    }
  }, [isPlaying, commentarySettings.enabled, commentarySettings.speechEnabled]);

  useEffect(() => {
    return () => {
      stopCommentarySpeech();
    };
  }, []);

  useEffect(() => {
    if (!commentarySettingsOpen && !commentaryHistoryOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCommentarySettingsOpen(false);
        setCommentaryHistoryOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commentarySettingsOpen, commentaryHistoryOpen]);

  useEffect(() => {
    const tracker = commentaryTrackerRef.current;
    if (
      battleState.tick <= tracker.lastTick &&
      !(battleState.status === 'finished' && !tracker.finishEmitted)
    ) {
      return;
    }
    const entry = evaluateCommentaryStep(
      tracker,
      battleState,
      activeMatchConfig,
      commentarySettings,
      performance.now()
    );
    const skipSpeech = suppressNextCommentarySpeechRef.current;
    suppressNextCommentarySpeechRef.current = false;
    if (entry) {
      setCommentaryLog((prev) => [...prev.slice(-39), entry]);
      if (!skipSpeech) {
        speakCommentary(entry, commentarySettings, speedMultiplier);
      }
    }
  }, [battleState, activeMatchConfig, commentarySettings, speedMultiplier]);

  const showToast = useCallback((msg: string) => {
    setCopyToast(msg);
  }, []);

  useEffect(() => {
    if (initialSetup.wasRestored) {
      showToast('前回のバトルフィールド進行状況を復元しました');
    }
  }, [initialSetup.wasRestored, showToast]);

  useEffect(() => {
    saveBattlefieldSession({
      version: 1,
      savedAt: Date.now(),
      config,
      roster,
      tournamentBracket,
      leagueData,
      activeMatchId,
      autoAdvance,
    });
  }, [config, roster, tournamentBracket, leagueData, activeMatchId, autoAdvance]);

  useEffect(() => {
    if (!copyToast) return;
    const t = window.setTimeout(() => setCopyToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [copyToast]);

  const clearAutoTimer = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  const clearResultModalTimer = useCallback(() => {
    if (resultModalTimerRef.current !== null) {
      window.clearTimeout(resultModalTimerRef.current);
      resultModalTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearAutoTimer();
      clearResultModalTimer();
    };
  }, [clearAutoTimer, clearResultModalTimer]);

  const loadSingleMatch = useCallback(
    (nextRoster: BattlefieldRosterEntry[], nextConfig: BattlefieldConfig, autoPlay = false) => {
      clearAutoTimer();
      clearResultModalTimer();
      goalPauseUntilRef.current = 0;
      const resolvedCfg = resolveMatchConfigForGame(nextConfig, 0);
      const { participants, notice } = buildParticipantsForSingleMatch(nextRoster, resolvedCfg);
      const nextState = createBattlefieldMatchState(participants, resolvedCfg);
      setActiveMatchConfig(resolvedCfg);
      setActiveParticipants(participants);
      setMatchNotice(notice);
      setActiveMatchId(null);
      setLatestReport(null);
      setShowResultModal(false);
      setVsBannerDismissed(false);
      recordedFinishRef.current = false;
      setFocusTankId(null);
      resetCommentary(nextState, resolvedCfg);
      setBattleState(nextState);
      setIsPlaying(autoPlay && participants.length >= 2);
    },
    [clearAutoTimer, clearResultModalTimer, resetCommentary]
  );

  const loadCompetitionMatchIntoArena = useCallback(
    (
      matchId: string,
      unitA: CompetitionUnit,
      unitB: CompetitionUnit,
      nextConfig: BattlefieldConfig,
      autoPlay: boolean,
      gameIndex = 0
    ) => {
      clearAutoTimer();
      clearResultModalTimer();
      goalPauseUntilRef.current = 0;
      const resolvedCfg = resolveMatchConfigForGame(nextConfig, gameIndex);
      const participants = buildParticipantsFromUnitPair(unitA, unitB);
      const nextState = createBattlefieldMatchState(participants, resolvedCfg);
      setActiveMatchConfig(resolvedCfg);
      setActiveParticipants(participants);
      setActiveMatchId(matchId);
      setLatestReport(null);
      setShowResultModal(false);
      setVsBannerDismissed(false);
      recordedFinishRef.current = false;
      setFocusTankId(null);
      resetCommentary(nextState, resolvedCfg);
      setBattleState(nextState);
      setIsPlaying(autoPlay);
    },
    [clearAutoTimer, clearResultModalTimer, resetCommentary]
  );

  const rebuildFormatAndMatch = useCallback(
    (nextRoster: BattlefieldRosterEntry[], nextConfig: BattlefieldConfig) => {
      clearAutoTimer();
      clearResultModalTimer();
      goalPauseUntilRef.current = 0;
      setIsPlaying(false);
      setLatestReport(null);
      setShowResultModal(false);
      setVsBannerDismissed(false);
      recordedFinishRef.current = false;

      if (nextConfig.format === 'battle_royale' || nextConfig.format === 'team_match') {
        setTournamentBracket(null);
        setLeagueData(null);
        loadSingleMatch(nextRoster, nextConfig, false);
        return;
      }

      const seriesBestOf: 1 | 3 = nextConfig.seriesFormat === 'bo3' ? 3 : 1;
      const { units, skippedNames } = buildUnitsForCompetition(nextRoster, nextConfig);
      const skipMsg =
        skippedNames.length > 0 ? `規格外・対象外: ${skippedNames.join(', ')}` : null;

      if (nextConfig.format === 'tournament') {
        setLeagueData(null);
        if (units.length < 2) {
          const emptyState = createBattlefieldMatchState([], nextConfig);
          setActiveMatchConfig(nextConfig);
          setActiveMatchId(null);
          setTournamentBracket(null);
          setMatchNotice(
            skipMsg ?? 'トーナメントの開催には適合ユニットが 2つ以上必要です。'
          );
          setActiveParticipants([]);
          resetCommentary(emptyState, nextConfig);
          setBattleState(emptyState);
          return;
        }
        const bracket = createTournamentBracket(units, seriesBestOf);
        setTournamentBracket(bracket);
        const firstPlayable = bracket.rounds
          .flat()
          .find((m) => !m.winnerUnitId && m.unitAId && m.unitBId);
        if (firstPlayable) {
          const uA = units.find((u) => u.unitId === firstPlayable.unitAId);
          const uB = units.find((u) => u.unitId === firstPlayable.unitBId);
          if (uA && uB) {
            setMatchNotice(skipMsg);
            loadCompetitionMatchIntoArena(
              firstPlayable.matchId,
              uA,
              uB,
              nextConfig,
              false,
              firstPlayable.gameReports?.length ?? 0
            );
            return;
          }
        }
        setMatchNotice(skipMsg);
        return;
      }

      // League
      setTournamentBracket(null);
      if (units.length < 2) {
        const emptyState = createBattlefieldMatchState([], nextConfig);
        setActiveMatchConfig(nextConfig);
        setActiveMatchId(null);
        setLeagueData(null);
        setMatchNotice(skipMsg ?? 'リーグ戦の開催には適合ユニットが 2つ以上必要です。');
        setActiveParticipants([]);
        resetCommentary(emptyState, nextConfig);
        setBattleState(emptyState);
        return;
      }
      const matches = createLeagueSchedule(units, seriesBestOf);
      setLeagueData({ units, matches });
      setMatchNotice(skipMsg);
      const first = matches[0];
      if (first) {
        const uA = units.find((u) => u.unitId === first.unitAId);
        const uB = units.find((u) => u.unitId === first.unitBId);
        if (uA && uB) {
          loadCompetitionMatchIntoArena(
            first.matchId,
            uA,
            uB,
            nextConfig,
            false,
            first.gameReports?.length ?? 0
          );
        }
      }
    },
    [clearAutoTimer, loadCompetitionMatchIntoArena, loadSingleMatch]
  );

  const handleFormatChange = (format: BattlefieldFormat) => {
    const nextConfig: BattlefieldConfig = {
      ...config,
      format,
      teamUnitSize:
        config.cpuRegulation === 'pair_6x6_4x4' ? 2 : config.teamUnitSize,
    };
    setConfig(nextConfig);
    rebuildFormatAndMatch(roster, nextConfig);
  };

  const handleRuleChange = (ruleId: BattlefieldRuleId) => {
    const spec = BATTLEFIELD_RULE_REGISTRY[ruleId];
    if (!spec || !spec.ready) return;
    const wasRamming = config.ruleId === 'ramming_derby';
    const nextDisableWeapons = spec.recommendedDisableWeapons
      ? true
      : wasRamming
        ? false
        : config.disableWeapons;
    const nextFormat: BattlefieldFormat =
      ruleId === 'tank_soccer' && config.format === 'battle_royale'
        ? 'team_match'
        : config.format;
    const nextConfig: BattlefieldConfig = {
      ...config,
      ruleId,
      format: nextFormat,
      disableWeapons: nextDisableWeapons,
    };
    setConfig(nextConfig);
    rebuildFormatAndMatch(roster, nextConfig);
  };

  const handleCpuRegulationChange = (cpuRegulation: CpuRegulationId) => {
    const isPairReg = cpuRegulation === 'pair_6x6_4x4';
    const nextFormat: BattlefieldFormat =
      isPairReg && config.format === 'battle_royale' ? 'team_match' : config.format;
    const nextConfig: BattlefieldConfig = {
      ...config,
      cpuRegulation,
      format: nextFormat,
      teamUnitSize: isPairReg ? 2 : config.teamUnitSize,
    };
    setConfig(nextConfig);
    rebuildFormatAndMatch(roster, nextConfig);
  };

  const updateConfigField = <K extends keyof BattlefieldConfig>(
    key: K,
    value: BattlefieldConfig[K]
  ) => {
    const nextConfig = { ...config, [key]: value };
    setConfig(nextConfig);
    rebuildFormatAndMatch(roster, nextConfig);
  };

  // Playback animation loop (with 1-second real-time hold on Combat Football goals)
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastTime = performance.now();

    const loop = (now: number) => {
      if (now < goalPauseUntilRef.current) {
        lastTime = now;
        accumulatorRef.current = 0;
        rafId = requestAnimationFrame(loop);
        return;
      }
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      accumulatorRef.current += (dt / 1000) * BASE_TPS * speedMultiplier;
      const steps = Math.min(16, Math.floor(accumulatorRef.current));
      if (steps > 0) {
        accumulatorRef.current -= steps;
        setBattleState((prev) => {
          if (prev.status === 'finished') return prev;
          if (prev.football?.pendingKickoffReset && performance.now() < goalPauseUntilRef.current) {
            return prev;
          }
          const next = cloneBattleStateForStep(prev);
          for (let i = 0; i < steps; i++) {
            stepBattlefieldTick(next, activeMatchConfig);
            if (next.status === 'finished') break;
            if (next.football?.pendingKickoffReset) {
              goalPauseUntilRef.current = performance.now() + 1000;
              break;
            }
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, speedMultiplier, activeMatchConfig]);

  // Handle battle finished -> build report & update Tournament/League & optional Auto-Advance (1s beat before modal)
  useEffect(() => {
    if (battleState.status !== 'finished') {
      recordedFinishRef.current = false;
      clearResultModalTimer();
      return;
    }
    setIsPlaying(false);
    if (recordedFinishRef.current) return;
    recordedFinishRef.current = true;

    const report = buildMatchReport(battleState, activeParticipants, activeMatchConfig);
    setLatestReport(report);
    clearResultModalTimer();
    resultModalTimerRef.current = window.setTimeout(() => {
      resultModalTimerRef.current = null;
      setShowResultModal(true);
    }, 1000);

    const seriesBestOf: 1 | 3 = config.seriesFormat === 'bo3' ? 3 : 1;

    if (config.format === 'tournament' && tournamentBracket && activeMatchId) {
      const currentMatch = tournamentBracket.rounds
        .flat()
        .find((m) => m.matchId === activeMatchId);
      const winUnitId =
        report.winnerTeamId === 'unit_A'
          ? currentMatch?.unitAId ?? null
          : report.winnerTeamId === 'unit_B'
            ? currentMatch?.unitBId ?? null
            : null;

      const updatedBracket = applyTournamentGameResult(
        tournamentBracket,
        activeMatchId,
        winUnitId,
        report,
        report.winType === 'draw',
        seriesBestOf
      );
      setTournamentBracket(updatedBracket);

      if (autoAdvance) {
        const allBracketMatches = updatedBracket.rounds.flat();
        const activeUpdated = allBracketMatches.find(
          (m) => m.matchId === activeMatchId && !m.winnerUnitId && m.unitAId && m.unitBId
        );
        const nextMatch =
          activeUpdated ??
          allBracketMatches.find((m) => !m.winnerUnitId && m.unitAId && m.unitBId);
        if (nextMatch) {
          const uA = updatedBracket.units.find((u) => u.unitId === nextMatch.unitAId);
          const uB = updatedBracket.units.find((u) => u.unitId === nextMatch.unitBId);
          if (uA && uB) {
            const nextGameIdx = nextMatch.gameReports?.length ?? 0;
            clearAutoTimer();
            autoAdvanceTimerRef.current = window.setTimeout(() => {
              loadCompetitionMatchIntoArena(
                nextMatch.matchId,
                uA,
                uB,
                config,
                true,
                nextGameIdx
              );
            }, 4500);
          }
        }
      }
    } else if (config.format === 'league' && leagueData && activeMatchId) {
      const currentMatch = leagueData.matches.find((m) => m.matchId === activeMatchId);
      const winnerUnitId =
        report.winnerTeamId === 'unit_A'
          ? currentMatch?.unitAId ?? null
          : report.winnerTeamId === 'unit_B'
            ? currentMatch?.unitBId ?? null
            : null;
      const updatedMatches = applyLeagueGameResult(
        leagueData.matches,
        activeMatchId,
        winnerUnitId,
        report,
        report.winType === 'draw',
        seriesBestOf
      );
      const nextLeague = { units: leagueData.units, matches: updatedMatches };
      setLeagueData(nextLeague);

      if (autoAdvance) {
        const activeUpdated = updatedMatches.find(
          (m) => m.matchId === activeMatchId && !m.report
        );
        const nextMatch = activeUpdated ?? updatedMatches.find((m) => !m.report);
        if (nextMatch) {
          const uA = nextLeague.units.find((u) => u.unitId === nextMatch.unitAId);
          const uB = nextLeague.units.find((u) => u.unitId === nextMatch.unitBId);
          if (uA && uB) {
            const nextGameIdx = nextMatch.gameReports?.length ?? 0;
            clearAutoTimer();
            autoAdvanceTimerRef.current = window.setTimeout(() => {
              loadCompetitionMatchIntoArena(
                nextMatch.matchId,
                uA,
                uB,
                config,
                true,
                nextGameIdx
              );
            }, 4500);
          }
        }
      }
    }
  }, [
    battleState,
    activeParticipants,
    config,
    activeMatchConfig,
    tournamentBracket,
    leagueData,
    activeMatchId,
    autoAdvance,
    clearAutoTimer,
    clearResultModalTimer,
    loadCompetitionMatchIntoArena,
  ]);

  const handleInstantFinishCurrentMatch = () => {
    if (activeParticipants.length < 2) return;
    setIsPlaying(false);
    suppressNextCommentarySpeechRef.current = true;
    setBattleState((prev) => {
      const next = cloneBattleStateForStep(prev);
      const guardMax = next.arena.maxTicks + 4;
      let guard = 0;
      while (next.status !== 'finished' && guard < guardMax) {
        stepBattlefieldTick(next, activeMatchConfig);
        guard += 1;
      }
      return next;
    });
  };

  const handleSimulateAllRemainingCompetition = () => {
    clearAutoTimer();
    setIsPlaying(false);
    const seriesBestOf: 1 | 3 = config.seriesFormat === 'bo3' ? 3 : 1;

    const applySimulatedFinalState = (
      parts: BattlefieldParticipant[],
      finalState: BattleState,
      finalRep: ReturnType<typeof buildMatchReport>,
      finalCfg: BattlefieldConfig,
      finalMatchId: string | null,
      toastMsg: string
    ) => {
      setActiveMatchConfig(finalCfg);
      setActiveParticipants(parts);
      if (finalMatchId) setActiveMatchId(finalMatchId);
      recordedFinishRef.current = true;
      stopCommentarySpeech();
      suppressNextCommentarySpeechRef.current = true;
      commentaryTrackerRef.current = createCommentaryTracker(
        { ...finalState, status: 'running', tick: Math.max(0, finalState.tick - 1) },
        finalCfg
      );
      setCommentaryLog([]);
      setBattleState(finalState);
      setLatestReport(finalRep);
      setShowResultModal(false);
      showToast(toastMsg);
    };

    if (config.format === 'tournament' && tournamentBracket) {
      let cur = tournamentBracket;
      let lastRep: ReturnType<typeof buildMatchReport> | null = null;
      let lastState: BattleState | null = null;
      let lastParts: BattlefieldParticipant[] = [];
      let lastCfg = config;
      let lastMatchId: string | null = null;
      let safety = 0;
      while (safety < 256) {
        safety += 1;
        const nextM = cur.rounds.flat().find((m) => !m.winnerUnitId && m.unitAId && m.unitBId);
        if (!nextM) break;
        const uA = cur.units.find((u) => u.unitId === nextM.unitAId);
        const uB = cur.units.find((u) => u.unitId === nextM.unitBId);
        if (!uA || !uB) break;
        const parts = buildParticipantsFromUnitPair(uA, uB);
        const gameIdx = nextM.gameReports?.length ?? 0;
        const matchCfg = resolveMatchConfigForGame(config, gameIdx);
        const sim = simulateMatchHeadless(parts, matchCfg);
        const winId =
          sim.report.winnerTeamId === 'unit_A'
            ? uA.unitId
            : sim.report.winnerTeamId === 'unit_B'
              ? uB.unitId
              : null;
        cur = applyTournamentGameResult(
          cur,
          nextM.matchId,
          winId,
          sim.report,
          sim.report.winType === 'draw',
          seriesBestOf
        );
        lastRep = sim.report;
        lastState = sim.state;
        lastParts = parts;
        lastCfg = matchCfg;
        lastMatchId = nextM.matchId;
      }
      setTournamentBracket(cur);
      if (lastState && lastRep) {
        applySimulatedFinalState(
          lastParts,
          lastState,
          lastRep,
          lastCfg,
          lastMatchId,
          'トーナメントの全未消化試合を高速シミュレートしました'
        );
      }
      return;
    }

    if (config.format === 'league' && leagueData) {
      let lastRep: ReturnType<typeof buildMatchReport> | null = null;
      let lastState: BattleState | null = null;
      let lastParts: BattlefieldParticipant[] = [];
      let lastCfg = config;
      let lastMatchId: string | null = null;
      const updatedMatches: LeagueMatch[] = [];
      for (const m of leagueData.matches) {
        if (m.report) {
          updatedMatches.push(m);
          continue;
        }
        const uA = leagueData.units.find((u) => u.unitId === m.unitAId);
        const uB = leagueData.units.find((u) => u.unitId === m.unitBId);
        if (!uA || !uB) {
          updatedMatches.push(m);
          continue;
        }
        let curMatch: LeagueMatch = m;
        let gameGuard = 0;
        while (!curMatch.report && gameGuard < 12) {
          gameGuard += 1;
          const parts = buildParticipantsFromUnitPair(uA, uB);
          const gameIdx = curMatch.gameReports?.length ?? 0;
          const matchCfg = resolveMatchConfigForGame(config, gameIdx);
          const sim = simulateMatchHeadless(parts, matchCfg);
          const winId =
            sim.report.winnerTeamId === 'unit_A'
              ? uA.unitId
              : sim.report.winnerTeamId === 'unit_B'
                ? uB.unitId
                : null;
          const nextList = applyLeagueGameResult(
            [curMatch],
            curMatch.matchId,
            winId,
            sim.report,
            sim.report.winType === 'draw',
            seriesBestOf
          );
          curMatch = nextList[0];
          lastRep = sim.report;
          lastState = sim.state;
          lastParts = parts;
          lastCfg = matchCfg;
          lastMatchId = curMatch.matchId;
        }
        updatedMatches.push(curMatch);
      }
      setLeagueData({ units: leagueData.units, matches: updatedMatches });
      if (lastState && lastRep) {
        applySimulatedFinalState(
          lastParts,
          lastState,
          lastRep,
          lastCfg,
          lastMatchId,
          'リーグ戦の全未消化試合を高速シミュレートしました'
        );
      }
    }
  };

  // File / share code / preset importing
  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: BattlefieldRosterEntry[] = [];
    const errors: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const res = parseImportedTankContent(text, file.name);
        if (res.ok) {
          added.push({
            ...res.entry,
            teamSlot: (roster.length + added.length) % 2,
          });
        } else {
          errors.push(res.error);
        }
      } catch {
        errors.push(`${file.name}: 読み込みに失敗しました`);
      }
    }

    if (added.length > 0) {
      const nextRoster = sortRosterEntries(disambiguateRosterPlayerNames([...roster, ...added]));
      setRoster(nextRoster);
      rebuildFormatAndMatch(nextRoster, config);
      setImportNotice({
        type: errors.length > 0 ? 'err' : 'ok',
        text: `${added.length}機の戦車を登録しました${errors.length > 0 ? `（失敗: ${errors.join(' / ')}）` : ''}`,
      });
    } else if (errors.length > 0) {
      setImportNotice({ type: 'err', text: errors.join(' / ') });
    }
  };

  const handleImportShareCode = () => {
    const trimmed = shareCodeInput.trim();
    if (!trimmed) return;
    const res = parseImportedTankContent(trimmed, 'シェアコード');
    if (!res.ok) {
      setImportNotice({ type: 'err', text: res.error });
      return;
    }
    res.entry.teamSlot = roster.length % 2;
    const nextRoster = sortRosterEntries(disambiguateRosterPlayerNames([...roster, res.entry]));
    const addedEntry = nextRoster.find((e) => e.entryId === res.entry.entryId) ?? res.entry;
    setRoster(nextRoster);
    setShareCodeInput('');
    setImportNotice({
      type: 'ok',
      text: `「${formatTankListLabel(addedEntry.machineName, addedEntry.playerName, addedEntry.blueprint.program.gridSize)}」を追加しました`,
    });
    rebuildFormatAndMatch(nextRoster, config);
  };

  const handleAddPresetSingle = () => {
    const picked =
      savedPickerItems.find((item) => item.key === presetPickerId) ??
      presetPickerItems.find((item) => item.key === presetPickerId);
    if (!picked) return;
    const entry = createRosterEntryFromBlueprint(
      picked.bp,
      picked.isPreset ? '規定戦車' : 'ユーザー追加',
      picked.isPreset
    );
    entry.teamSlot = roster.length % 2;
    const nextRoster = sortRosterEntries(disambiguateRosterPlayerNames([...roster, entry]));
    const addedEntry = nextRoster.find((e) => e.entryId === entry.entryId) ?? entry;
    setRoster(nextRoster);
    setImportNotice({
      type: 'ok',
      text: `「${formatTankListLabel(addedEntry.machineName, addedEntry.playerName, addedEntry.blueprint.program.gridSize)}」をエントリーに追加しました`,
    });
    rebuildFormatAndMatch(nextRoster, config);
  };

  const handleUpdateEntry = (
    entryId: string,
    patch: Partial<Pick<BattlefieldRosterEntry, 'playerName' | 'machineName' | 'enabled' | 'teamSlot'>>
  ) => {
    const mapped = roster.map((e) => {
      if (e.entryId !== entryId) return e;
      if (patch.playerName !== undefined) {
        return {
          ...e,
          ...patch,
          basePlayerName: patch.playerName.trim() || undefined,
        };
      }
      return { ...e, ...patch };
    });
    const nextRoster =
      patch.enabled !== undefined || patch.teamSlot !== undefined
        ? sortRosterEntries(mapped)
        : mapped;
    setRoster(nextRoster);
    if (patch.enabled !== undefined || patch.teamSlot !== undefined) {
      rebuildFormatAndMatch(nextRoster, config);
    }
  };

  const handleCommitRosterSort = () => {
    const sorted = sortRosterEntries(disambiguateRosterPlayerNames(roster));
    setRoster(sorted);
    if (!isPlaying) {
      rebuildFormatAndMatch(sorted, config);
    }
  };

  const handleRemoveEntry = (entryId: string) => {
    const nextRoster = roster.filter((e) => e.entryId !== entryId);
    setRoster(nextRoster);
    rebuildFormatAndMatch(nextRoster, config);
  };

  const handleFairRandomDraw = () => {
    if (roster.length === 0) return;
    const res =
      config.format === 'team_match'
        ? assignRandomTeams(roster, config, 2, recentPlayedEntryIds)
        : pickRandomBattleRoyaleEntries(roster, config, 8, recentPlayedEntryIds);
    if (res.pickedIds.length === 0) {
      showToast('現在のレギュレーションに適合する戦車がありません');
      return;
    }
    const nextPlayed = res.resetCycle
      ? new Set<string>(res.pickedIds)
      : new Set<string>([...recentPlayedEntryIds, ...res.pickedIds]);
    setRecentPlayedEntryIds(nextPlayed);
    setRoster(res.nextRoster);
    rebuildFormatAndMatch(res.nextRoster, config);
    const cycleMsg = res.resetCycle ? '（全員1周したため巡回リセット）' : '';
    showToast(
      config.format === 'team_match'
        ? `${res.pickedIds.length}機を抽選してチーム分けしました${cycleMsg}`
        : `未出場優先で ${res.pickedIds.length}機を抽選しました${cycleMsg}`
    );
  };

  const handleShuffleOrder = () => {
    if (roster.length < 2) return;
    const shuffled = shuffleCompetitionRoster(roster);
    setRoster(shuffled);
    rebuildFormatAndMatch(shuffled, config);
    showToast('エントリー順・対戦組合せをシャッフルしました');
  };

  const handleRandomTeamSplit = () => {
    if (roster.length < 2) return;
    const res = assignRandomTeams(roster, config, 2, recentPlayedEntryIds);
    if (res.pickedIds.length === 0) {
      showToast('チーム戦に適合する戦車がありません');
      return;
    }
    const nextPlayed = res.resetCycle
      ? new Set<string>(res.pickedIds)
      : new Set<string>([...recentPlayedEntryIds, ...res.pickedIds]);
    setRecentPlayedEntryIds(nextPlayed);
    setRoster(res.nextRoster);
    rebuildFormatAndMatch(res.nextRoster, config);
    showToast(`${res.pickedIds.length}機をランダムにチームへ割り振りました`);
  };

  const handleEnableAllRoster = () => {
    if (roster.length === 0) return;
    const nextRoster = roster.map((e) => ({ ...e, enabled: true }));
    setRoster(nextRoster);
    setRecentPlayedEntryIds(new Set());
    rebuildFormatAndMatch(nextRoster, config);
    showToast(`全 ${nextRoster.length}機を有効化しました`);
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label}をクリップボードにコピーしました`);
    } catch {
      showToast('クリップボードへのコピーに失敗しました');
    }
  };

  const leagueStandings = useMemo(() => {
    if (!leagueData) return [];
    return computeLeagueStandings(leagueData.units, leagueData.matches);
  }, [leagueData]);

  const latestMatchSummary = useMemo(
    () =>
      latestReport
        ? buildMatchSummaryComment(latestReport, commentarySettings.style, commentaryLog)
        : null,
    [latestReport, commentarySettings.style, commentaryLog]
  );

  const currentRuleSpec = BATTLEFIELD_RULE_REGISTRY[config.ruleId];
  const enabledTankCount = useMemo(
    () => roster.filter((r) => r.enabled).length,
    [roster]
  );
  const recommendedTier = resolveRecommendedTankTier(
    config.format,
    config.teamUnitSize,
    enabledTankCount
  );
  const recommendedPreset = getRecommendedMapPreset(config.ruleId, recommendedTier);
  const isRecommendedPresetActive = isRecommendedMapPresetApplied(config, recommendedTier);

  const handleApplyRecommendedPreset = () => {
    const nextConfig = applyRecommendedMapPreset(config, recommendedTier);
    setConfig(nextConfig);
    rebuildFormatAndMatch(roster, nextConfig);
    showToast(
      `「${currentRuleSpec?.name ?? config.ruleId}」の推奨設定（${recommendedTier}台向け: ${recommendedPreset.summary}）を適用しました`
    );
  };
  const currentActiveTeamLabel = useMemo(() => {
    if (config.format === 'battle_royale') {
      return `バトルロワイヤル（${activeParticipants.length}機）`;
    }
    if (config.format === 'team_match') {
      const teamSet = Array.from(new Set(activeParticipants.map((p) => p.teamLabel)));
      return `チーム戦: ${teamSet.join(' vs ')}`;
    }
    if (config.format === 'tournament' && tournamentBracket && activeMatchId) {
      const m = tournamentBracket.rounds.flat().find((x) => x.matchId === activeMatchId);
      const uA = tournamentBracket.units.find((u) => u.unitId === m?.unitAId);
      const uB = tournamentBracket.units.find((u) => u.unitId === m?.unitBId);
      if (m && uA && uB) {
        const seriesSuffix =
          (m.seriesBestOf ?? 1) === 3
            ? m.winnerUnitId
              ? ` [Bo3決着 ${m.winsA ?? 0}-${m.winsB ?? 0}]`
              : ` [第${Math.max(1, (m.gameReports?.length ?? 0) + (battleState.status === 'finished' ? 0 : 1))}戦 (${m.winsA ?? 0}-${m.winsB ?? 0})]`
            : '';
        return `${m.roundLabel}: ${uA.unitName} vs ${uB.unitName}${seriesSuffix}`;
      }
    }
    if (config.format === 'league' && leagueData && activeMatchId) {
      const m = leagueData.matches.find((x) => x.matchId === activeMatchId);
      const uA = leagueData.units.find((u) => u.unitId === m?.unitAId);
      const uB = leagueData.units.find((u) => u.unitId === m?.unitBId);
      if (m && uA && uB) {
        const seriesSuffix =
          (m.seriesBestOf ?? 1) === 3
            ? m.report
              ? ` [Bo3決着 ${m.winsA ?? 0}-${m.winsB ?? 0}]`
              : ` [第${Math.max(1, (m.gameReports?.length ?? 0) + (battleState.status === 'finished' ? 0 : 1))}戦 (${m.winsA ?? 0}-${m.winsB ?? 0})]`
            : '';
        return `第${m.roundNumber}節: ${uA.unitName} vs ${uB.unitName}${seriesSuffix}`;
      }
    }
    return 'バトルフィールド待機中';
  }, [
    activeParticipants,
    config.format,
    tournamentBracket,
    leagueData,
    activeMatchId,
    battleState.status,
  ]);

  const activeCompetitionCard = useMemo(() => {
    if (config.format === 'tournament' && tournamentBracket && activeMatchId) {
      const m = tournamentBracket.rounds.flat().find((x) => x.matchId === activeMatchId);
      const uA = tournamentBracket.units.find((u) => u.unitId === m?.unitAId);
      const uB = tournamentBracket.units.find((u) => u.unitId === m?.unitBId);
      if (m && uA && uB && !m.isBye) {
        const seriesLabel =
          (m.seriesBestOf ?? 1) === 3
            ? m.winnerUnitId
              ? `Bo3 決着 (${m.winsA ?? 0}-${m.winsB ?? 0})`
              : `Bo3 第${(m.gameReports?.length ?? 0) + 1}戦 (${m.winsA ?? 0}-${m.winsB ?? 0})`
            : null;
        return {
          mode: 'tournament' as const,
          stageLabel: m.roundLabel,
          seriesLabel,
          ruleLabel: BATTLEFIELD_RULE_REGISTRY[config.ruleId]?.shortLabel ?? config.ruleId,
          unitA: {
            title: uA.entries.length === 1 ? uA.entries[0].playerName : uA.unitName,
            subtitle: uA.entries
              .map((e) => `${e.machineName} (${e.blueprint.program.gridSize}×${e.blueprint.program.gridSize})`)
              .join(' / '),
            color: activeParticipants.find((p) => p.teamId === 'unit_A')?.teamColor ?? uA.color,
          },
          unitB: {
            title: uB.entries.length === 1 ? uB.entries[0].playerName : uB.unitName,
            subtitle: uB.entries
              .map((e) => `${e.machineName} (${e.blueprint.program.gridSize}×${e.blueprint.program.gridSize})`)
              .join(' / '),
            color: activeParticipants.find((p) => p.teamId === 'unit_B')?.teamColor ?? uB.color,
          },
        };
      }
    }
    if (config.format === 'league' && leagueData && activeMatchId) {
      const m = leagueData.matches.find((x) => x.matchId === activeMatchId);
      const uA = leagueData.units.find((u) => u.unitId === m?.unitAId);
      const uB = leagueData.units.find((u) => u.unitId === m?.unitBId);
      if (m && uA && uB) {
        const seriesLabel =
          (m.seriesBestOf ?? 1) === 3
            ? m.report
              ? `Bo3 決着 (${m.winsA ?? 0}-${m.winsB ?? 0})`
              : `Bo3 第${(m.gameReports?.length ?? 0) + 1}戦 (${m.winsA ?? 0}-${m.winsB ?? 0})`
            : null;
        return {
          mode: 'league' as const,
          stageLabel: `第${m.roundNumber}節`,
          seriesLabel,
          ruleLabel: BATTLEFIELD_RULE_REGISTRY[config.ruleId]?.shortLabel ?? config.ruleId,
          unitA: {
            title: uA.entries.length === 1 ? uA.entries[0].playerName : uA.unitName,
            subtitle: uA.entries
              .map((e) => `${e.machineName} (${e.blueprint.program.gridSize}×${e.blueprint.program.gridSize})`)
              .join(' / '),
            color: activeParticipants.find((p) => p.teamId === 'unit_A')?.teamColor ?? uA.color,
          },
          unitB: {
            title: uB.entries.length === 1 ? uB.entries[0].playerName : uB.unitName,
            subtitle: uB.entries
              .map((e) => `${e.machineName} (${e.blueprint.program.gridSize}×${e.blueprint.program.gridSize})`)
              .join(' / '),
            color: activeParticipants.find((p) => p.teamId === 'unit_B')?.teamColor ?? uB.color,
          },
        };
      }
    }
    return null;
  }, [config.format, config.ruleId, tournamentBracket, leagueData, activeMatchId, activeParticipants]);

  const handleReplayCurrentMatch = () => {
    clearAutoTimer();
    clearResultModalTimer();
    goalPauseUntilRef.current = 0;
    recordedFinishRef.current = false;
    setLatestReport(null);
    setShowResultModal(false);
    setVsBannerDismissed(false);
    setIsPlaying(false);
    const nextState = createBattlefieldMatchState(activeParticipants, activeMatchConfig);
    resetCommentary(nextState, activeMatchConfig);
    setBattleState(nextState);
  };

  const handleLoadNextPendingMatch = (autoPlay = false) => {
    if (config.format === 'tournament' && tournamentBracket) {
      const allMatches = tournamentBracket.rounds.flat();
      const activePending = activeMatchId
        ? allMatches.find(
            (m) => m.matchId === activeMatchId && !m.winnerUnitId && m.unitAId && m.unitBId
          )
        : undefined;
      const nextM =
        activePending ?? allMatches.find((m) => !m.winnerUnitId && m.unitAId && m.unitBId);
      if (nextM) {
        const uA = tournamentBracket.units.find((u) => u.unitId === nextM.unitAId);
        const uB = tournamentBracket.units.find((u) => u.unitId === nextM.unitBId);
        if (uA && uB) {
          loadCompetitionMatchIntoArena(
            nextM.matchId,
            uA,
            uB,
            config,
            autoPlay,
            nextM.gameReports?.length ?? 0
          );
          return;
        }
      }
    } else if (config.format === 'league' && leagueData) {
      const activePending = activeMatchId
        ? leagueData.matches.find((m) => m.matchId === activeMatchId && !m.report)
        : undefined;
      const nextM = activePending ?? leagueData.matches.find((m) => !m.report);
      if (nextM) {
        const uA = leagueData.units.find((u) => u.unitId === nextM.unitAId);
        const uB = leagueData.units.find((u) => u.unitId === nextM.unitBId);
        if (uA && uB) {
          loadCompetitionMatchIntoArena(
            nextM.matchId,
            uA,
            uB,
            config,
            autoPlay,
            nextM.gameReports?.length ?? 0
          );
          return;
        }
      }
    }
    showToast('すべての試合が消化済みです');
  };

  const handleResetSavedSession = () => {
    clearAutoTimer();
    clearResultModalTimer();
    clearBattlefieldSession();
    const defaultRoster = createInitialRoster();
    const defaultCfg: BattlefieldConfig = { ...DEFAULT_BATTLEFIELD_CONFIG };
    setRoster(defaultRoster);
    setConfig(defaultCfg);
    setAutoAdvance(false);
    setRecentPlayedEntryIds(new Set());
    rebuildFormatAndMatch(defaultRoster, defaultCfg);
    showToast('保存された設定と大会進行を初期化しました');
  };

  const hasMoreCompetitionMatches = useMemo(() => {
    if (config.format === 'tournament' && tournamentBracket) {
      return tournamentBracket.rounds
        .flat()
        .some((m) => !m.winnerUnitId && m.unitAId && m.unitBId);
    }
    if (config.format === 'league' && leagueData) {
      return leagueData.matches.some((m) => !m.report);
    }
    return false;
  }, [config.format, tournamentBracket, leagueData]);

  const hasPendingActiveSeriesGame = useMemo(() => {
    if (config.format === 'tournament' && tournamentBracket && activeMatchId) {
      const m = tournamentBracket.rounds.flat().find((x) => x.matchId === activeMatchId);
      return Boolean(
        m && !m.winnerUnitId && (m.seriesBestOf ?? 1) === 3 && (m.gameReports?.length ?? 0) > 0
      );
    }
    if (config.format === 'league' && leagueData && activeMatchId) {
      const m = leagueData.matches.find((x) => x.matchId === activeMatchId);
      return Boolean(
        m && !m.report && (m.seriesBestOf ?? 1) === 3 && (m.gameReports?.length ?? 0) > 0
      );
    }
    return false;
  }, [config.format, tournamentBracket, leagueData, activeMatchId]);

  return (
    <div className="app-shell bf-shell">
      <header className="top-nav bf-top-nav">
        <div className="brand">
          <div className="brand-logo bf-logo">CP</div>
          <div>
            <h1 className="brand-title-row">
              <span>CodePanzer.py</span>
              <span className="brand-ver">v{CURRENT_GAME_VERSION}</span>
            </h1>
            <div className="bf-brand-meta">
              <span className="bf-badge">BATTLEFIELD</span>
            </div>
          </div>
        </div>

        <div className="mode-switcher bf-format-tabs">
          {(
            [
              { id: 'battle_royale', label: 'バトルロワイヤル', icon: <Swords size={14} /> },
              { id: 'team_match', label: 'チーム・ペア戦', icon: <Users size={14} /> },
              { id: 'tournament', label: 'トーナメント', icon: <Trophy size={14} /> },
              { id: 'league', label: 'リーグ戦', icon: <Award size={14} /> },
            ] as Array<{ id: BattlefieldFormat; label: string; icon: React.ReactNode }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`nav-tab ${config.format === tab.id ? 'active' : ''}`}
              onClick={() => handleFormatChange(tab.id)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        <div className="nav-actions">
          <button
            type="button"
            className="mini-btn"
            onClick={() => setSetupCollapsed((v) => !v)}
            title="設定・エントリーパネルの表示を切り替え（プロジェクター観戦向け）"
          >
            {setupCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            {setupCollapsed ? '設定/機体一覧を表示' : '観戦拡大 (設定を隠す)'}
          </button>
          <a href="./index.html" className="btn-primary bf-back-link">
            <Wrench size={14} /> 開発画面
          </a>
        </div>
      </header>

      <main className={`bf-workspace ${setupCollapsed ? 'is-collapsed' : ''}`}>
        {!setupCollapsed && (
          <aside className="bf-left-panel">
            {/* Rules & Regulation Card */}
            <section className="bf-card">
              <div className="bf-card-header">
                <h2>⚙ ルール・レギュレーション設定</h2>
                <div className="bf-card-header-actions">
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => rebuildFormatAndMatch(roster, config)}
                    title="現在の設定で試合・大会を再構成"
                  >
                    <RotateCcw size={12} /> 再構築
                  </button>
                  <button
                    type="button"
                    className="mini-btn danger"
                    onClick={handleResetSavedSession}
                    title="保存済みの設定・エントリー・大会進行を初期状態にリセット"
                  >
                    <Trash2 size={12} /> 初期化
                  </button>
                </div>
              </div>

              <div className="bf-form-grid">
                <label className="bf-field">
                  <span>対戦ルール</span>
                  <select
                    value={config.ruleId}
                    onChange={(e) => handleRuleChange(e.target.value as BattlefieldRuleId)}
                  >
                    {Object.values(BATTLEFIELD_RULE_REGISTRY).map((r) => (
                      <option key={r.id} value={r.id} disabled={!r.ready}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>CPU 要件（レギュレーション）</span>
                  <select
                    value={config.cpuRegulation}
                    onChange={(e) =>
                      handleCpuRegulationChange(e.target.value as CpuRegulationId)
                    }
                  >
                    {Object.values(CPU_REGULATION_SPECS).map((reg) => (
                      <option key={reg.id} value={reg.id}>
                        {reg.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="bf-hint-text">
                {currentRuleSpec?.description} / {CPU_REGULATION_SPECS[config.cpuRegulation].description}
              </p>

              <div className="bf-weapon-locks">
                <label
                  className={`bf-check-pill ${config.disableWeapons ? 'is-active' : ''}`}
                  title="主砲・副武装すべて発射不可"
                >
                  <input
                    type="checkbox"
                    checked={config.disableWeapons}
                    onChange={(e) => updateConfigField('disableWeapons', e.target.checked)}
                  />
                  <span>全武装禁止</span>
                </label>

                <label
                  className={`bf-check-pill ${
                    config.disableWeapons || config.disableSubWeapons ? 'is-active' : ''
                  }`}
                  title="副武装 (SP) のみ発射不可"
                >
                  <input
                    type="checkbox"
                    checked={config.disableWeapons || config.disableSubWeapons}
                    disabled={config.disableWeapons}
                    onChange={(e) => updateConfigField('disableSubWeapons', e.target.checked)}
                  />
                  <span>SP禁止</span>
                </label>

                <label
                  className={`bf-check-pill ${config.randomizeSeedPerMatch ? 'is-accent' : ''}`}
                  title="各試合・Bo3各セットごとに障害物シードをランダム抽選（戦車サッカー・障害物なしを除く）"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(config.randomizeSeedPerMatch)}
                    onChange={(e) => updateConfigField('randomizeSeedPerMatch', e.target.checked)}
                  />
                  <span>🎲 毎試合シード変更</span>
                </label>
              </div>

              <div className="bf-form-grid bf-form-grid-4">
                {(config.format === 'tournament' || config.format === 'league') && (
                  <>
                    <label className="bf-field">
                      <span>1組の構成</span>
                      <select
                        value={config.teamUnitSize}
                        disabled={config.cpuRegulation === 'pair_6x6_4x4'}
                        onChange={(e) =>
                          updateConfigField('teamUnitSize', Number(e.target.value) as 1 | 2)
                        }
                      >
                        <option value={1}>1機シングル</option>
                        <option value={2}>2機ペア</option>
                      </select>
                    </label>

                    <label className="bf-field">
                      <span>試合方式</span>
                      <select
                        value={config.seriesFormat ?? 'bo1'}
                        onChange={(e) =>
                          updateConfigField('seriesFormat', e.target.value as 'bo1' | 'bo3')
                        }
                      >
                        <option value="bo1">1本勝負 (Bo1)</option>
                        <option value="bo3">2本先取 (Bo3)</option>
                      </select>
                    </label>
                  </>
                )}

                <label className="bf-field">
                  <span>戦場広さ</span>
                  <select
                    value={config.arenaSize}
                    onChange={(e) => updateConfigField('arenaSize', e.target.value as ArenaSizeId)}
                  >
                    {(['tiny', 'small', 'medium', 'large'] as ArenaSizeId[]).map((sz) => (
                      <option key={sz} value={sz}>
                        {ARENA_SIZE_SPECS[sz].label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>障害物</span>
                  <select
                    value={config.obstacleMode}
                    onChange={(e) =>
                      updateConfigField('obstacleMode', e.target.value as ObstacleMode)
                    }
                  >
                    <option value="none">なし</option>
                    <option value="few">少なめ</option>
                    <option value="many">多め</option>
                    <option value="maze">迷路</option>
                  </select>
                </label>

                <label className="bf-field">
                  <span>外周壁ギミック</span>
                  <select
                    value={config.outerWallMode}
                    onChange={(e) =>
                      updateConfigField('outerWallMode', e.target.value as OuterWallMode)
                    }
                  >
                    {Object.values(OUTER_WALL_MODE_SPECS).map((wm) => (
                      <option key={wm.id} value={wm.id}>
                        {wm.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>特殊エリア</span>
                  <select
                    value={config.zoneMode}
                    onChange={(e) =>
                      updateConfigField('zoneMode', e.target.value as ArenaZoneMode)
                    }
                  >
                    {Object.values(ARENA_ZONE_MODE_SPECS).map((zm) => (
                      <option key={zm.id} value={zm.id}>
                        {zm.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>重力</span>
                  <select
                    value={config.gravityPreset}
                    onChange={(e) =>
                      updateConfigField('gravityPreset', e.target.value as GravityPresetId)
                    }
                  >
                    {Object.values(GRAVITY_PRESET_SPECS).map((gp) => (
                      <option key={gp.id} value={gp.id}>
                        {gp.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>砂塵（レーダー射程）</span>
                  <select
                    value={config.sandstormPreset}
                    onChange={(e) =>
                      updateConfigField('sandstormPreset', e.target.value as SandstormPresetId)
                    }
                  >
                    {Object.values(SANDSTORM_PRESET_SPECS).map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="bf-field">
                  <span>制限時間</span>
                  <select
                    value={config.maxSeconds}
                    onChange={(e) => updateConfigField('maxSeconds', Number(e.target.value))}
                  >
                    <option value={60}>60秒</option>
                    <option value={120}>120秒</option>
                    <option value={180}>180秒</option>
                    <option value={300}>300秒</option>
                  </select>
                </label>

                <div className="bf-field bf-seed-field">
                  <label htmlFor="bf-map-seed">マップシード</label>
                  <div className="bf-seed-row">
                    <input
                      id="bf-map-seed"
                      type="number"
                      value={config.obstacleSeed}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        const parsed = Number(raw);
                        updateConfigField(
                          'obstacleSeed',
                          raw === '' ? -1 : Number.isFinite(parsed) ? Math.trunc(parsed) : -1
                        );
                      }}
                    />
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() =>
                        updateConfigField('obstacleSeed', Math.floor(Math.random() * 9000) + 1)
                      }
                      title="ランダムシード生成"
                    >
                      <Shuffle size={12} />
                    </button>
                    <button
                      type="button"
                      className={`mini-btn bf-preset-btn ${
                        isRecommendedPresetActive ? 'is-matched' : ''
                      }`}
                      onClick={handleApplyRecommendedPreset}
                      title={`${currentRuleSpec?.name ?? ''}の推奨設定（${recommendedTier}台向け）を適用: ${recommendedPreset.summary}`}
                    >
                      <Sparkles size={12} /> 推奨設定
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Roster Import & Player Assignment Card */}
            <section className="bf-card bf-roster-card">
              <div className="bf-card-header">
                <h2>🚩 戦車エントリー＆Player割当 ({roster.length}機)</h2>
                <button
                  type="button"
                  className="mini-btn danger"
                  onClick={() => {
                    setRoster([]);
                    setRecentPlayedEntryIds(new Set());
                    rebuildFormatAndMatch([], config);
                  }}
                >
                  <Trash2 size={12} /> 全クリア
                </button>
              </div>

              <div
                className={`bf-dropzone ${isDragOver ? 'is-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  void handleFilesSelected(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={16} />
                <span>
                  <code>.vstank.json</code> / <code>.py</code> ファイルをここに複数ドロップ、またはクリックして選択
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".json,.vstank.json,.py,.txt"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    void handleFilesSelected(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="bf-share-row">
                <input
                  type="text"
                  placeholder="VST1-... シェアコードを貼り付けて追加"
                  value={shareCodeInput}
                  onChange={(e) => setShareCodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleImportShareCode();
                  }}
                />
                <button type="button" className="mini-btn active" onClick={handleImportShareCode}>
                  <Plus size={13} /> 追加
                </button>
              </div>

              <div className="bf-preset-quick">
                <select
                  value={presetPickerId}
                  onChange={(e) => setPresetPickerId(e.target.value)}
                >
                  {savedPickerItems.length > 0 && (
                    <optgroup label="ユーザー戦車（保存済）">
                      {savedPickerItems.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="規定（プリセット）戦車">
                    {presetPickerItems.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={handleAddPresetSingle}
                >
                  追加
                </button>
              </div>

              {roster.length >= 2 && (
                <div className="bf-roster-tools">
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleFairRandomDraw}
                    title="未出場機を優先して最大8機を有効化（1周したら自動リセット）"
                  >
                    <Sparkles size={12} /> 抽選 (最大8機)
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleShuffleOrder}
                    title="エントリー順・トーナメント表／リーグ順をシャッフル"
                  >
                    <Shuffle size={12} /> シャッフル
                  </button>
                  {config.format === 'team_match' && (
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={handleRandomTeamSplit}
                      title="適合機体を抽選してランダムにTeam A/Bへ均等配分"
                    >
                      <Users size={12} /> ランダム組分け
                    </button>
                  )}
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleEnableAllRoster}
                    title="登録されている全機体を有効化"
                  >
                    <Check size={12} /> 全有効
                  </button>
                </div>
              )}

              {importNotice && (
                <div className={`bf-notice ${importNotice.type}`}>{importNotice.text}</div>
              )}

              <div className="bf-roster-list">
                {roster.length === 0 ? (
                  <div className="bf-empty-msg">
                    戦車が登録されていません。ファイル読込またはプリセットから追加してください。
                  </div>
                ) : (
                  roster.map((entry) => {
                    const regCheck = validateEntryForRegulation(
                      entry,
                      config.cpuRegulation
                    );
                    const displayLabel = formatTankListLabel(
                      entry.machineName,
                      entry.playerName || 'Player',
                      entry.blueprint.program.gridSize
                    );
                    return (
                      <div
                        key={entry.entryId}
                        className={`bf-roster-item ${!entry.enabled ? 'is-disabled' : ''} ${
                          !regCheck.valid ? 'is-invalid' : ''
                        }`}
                      >
                        <div className="bf-roster-item-top">
                          <label className="bf-entry-enable">
                            <input
                              type="checkbox"
                              checked={entry.enabled}
                              onChange={(e) =>
                                handleUpdateEntry(entry.entryId, { enabled: e.target.checked })
                              }
                            />
                            <strong className="bf-roster-title" title={displayLabel}>
                              {displayLabel}
                            </strong>
                          </label>

                          <span
                            className={`bf-origin-badge ${entry.isPreset ? 'preset' : 'user'}`}
                          >
                            {entry.isPreset ? '規定' : 'ユーザー'}
                          </span>

                          <span
                            className={`bf-reg-badge ${regCheck.valid ? 'ok' : 'warn'}`}
                            title={regCheck.reason ?? 'レギュレーション適合'}
                          >
                            {regCheck.valid ? '✓ 適合' : `⚠ ${regCheck.reason}`}
                          </span>

                          {config.format === 'team_match' && (
                            <select
                              className="bf-team-select"
                              value={entry.teamSlot ?? 0}
                              onChange={(e) =>
                                handleUpdateEntry(entry.entryId, {
                                  teamSlot: Number(e.target.value),
                                })
                              }
                            >
                              {TEAM_LABELS.map((lbl, sIdx) => (
                                <option key={lbl} value={sIdx}>
                                  {lbl}
                                </option>
                              ))}
                            </select>
                          )}

                          <button
                            type="button"
                            className="mini-btn danger"
                            onClick={() => handleRemoveEntry(entry.entryId)}
                            title="エントリーから削除"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>

                        <div className="bf-roster-inputs">
                          <label>
                            <span>Player名</span>
                            <input
                              type="text"
                              maxLength={16}
                              value={entry.playerName}
                              onChange={(e) =>
                                handleUpdateEntry(entry.entryId, { playerName: e.target.value })
                              }
                              onBlur={handleCommitRosterSort}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCommitRosterSort();
                              }}
                            />
                          </label>
                          <label>
                            <span>マシーン名</span>
                            <input
                              type="text"
                              maxLength={20}
                              value={entry.machineName}
                              onChange={(e) =>
                                handleUpdateEntry(entry.entryId, { machineName: e.target.value })
                              }
                              onBlur={handleCommitRosterSort}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCommitRosterSort();
                              }}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </aside>
        )}

        {/* Right Arena & Tournament / League Area */}
        <section className="bf-right-panel">
          <div className="bf-match-banner">
            <div className="bf-match-banner-left">
              <strong>{currentActiveTeamLabel}</strong>
              <span className="bf-tag">{currentRuleSpec?.shortLabel}</span>
              <span className="bf-tag">{CPU_REGULATION_SPECS[config.cpuRegulation].label}</span>
              {config.outerWallMode !== 'normal' && (
                <span className="bf-tag is-warn">
                  {OUTER_WALL_MODE_SPECS[config.outerWallMode].shortLabel}
                </span>
              )}
              {config.zoneMode !== 'none' && (
                <span className="bf-tag is-warn">
                  {ARENA_ZONE_MODE_SPECS[config.zoneMode].shortLabel}
                </span>
              )}
              {config.gravityPreset !== 'normal' && (
                <span className="bf-tag is-warn">
                  {GRAVITY_PRESET_SPECS[config.gravityPreset].shortLabel}
                </span>
              )}
              {config.sandstormPreset !== 'none' && (
                <span className="bf-tag is-warn">
                  {SANDSTORM_PRESET_SPECS[config.sandstormPreset].shortLabel}
                </span>
              )}
              {(config.format === 'tournament' || config.format === 'league') &&
                config.seriesFormat === 'bo3' && (
                  <span className="bf-tag is-warn">Bo3 (2本先取)</span>
                )}
              {config.randomizeSeedPerMatch &&
                activeMatchConfig.obstacleMode !== 'none' &&
                config.ruleId !== 'tank_soccer' && (
                  <span className="bf-tag">Seed #{activeMatchConfig.obstacleSeed}</span>
                )}
              {config.disableWeapons && (
                <span className="bf-tag is-danger">🚫 射撃禁止 (SP含む)</span>
              )}
              {!config.disableWeapons && config.disableSubWeapons && (
                <span className="bf-tag is-warn">🚫 副武装禁止</span>
              )}
            </div>
            <div className="bf-clock-pill">
              経過: <strong>{(battleState.tick / BASE_TPS).toFixed(1)}s</strong> /{' '}
              {(battleState.arena.maxTicks / BASE_TPS).toFixed(0)}s
            </div>
          </div>

          {matchNotice && <div className="bf-notice warn">{matchNotice}</div>}

          {/* Rule-specific Live Scoreboard */}
          {battleState.football && (
            <div className="bf-rule-scoreboard bf-football-board">
              <div className="bf-fb-team is-west">
                <span
                  className="bf-color-dot"
                  style={{ backgroundColor: battleState.football.westTeamColor }}
                />
                <strong>{battleState.football.westTeamLabel}</strong>
                <span className="bf-fb-dir">西→東攻め</span>
              </div>
              <div className="bf-football-score">
                <span>{battleState.ruleTeamScores?.[battleState.football.westTeamId] ?? 0}</span>
                <em>-</em>
                <span>{battleState.ruleTeamScores?.[battleState.football.eastTeamId] ?? 0}</span>
              </div>
              <div className="bf-fb-team is-east">
                <span className="bf-fb-dir">東→西攻め</span>
                <strong>{battleState.football.eastTeamLabel}</strong>
                <span
                  className="bf-color-dot"
                  style={{ backgroundColor: battleState.football.eastTeamColor }}
                />
              </div>
              {battleState.football.lastGoalBanner &&
                battleState.tick - battleState.football.lastGoalBanner.tick <= 35 && (
                  <span
                    className="bf-goal-flash"
                    style={{ borderColor: battleState.football.lastGoalBanner.color }}
                  >
                    GOAL! {battleState.football.lastGoalBanner.teamLabel}
                  </span>
                )}
            </div>
          )}

          {battleState.territoryGrid && (() => {
            const tg = battleState.territoryGrid;
            let playable = 0;
            const counts: Record<string, number> = {};
            for (let i = 0; i < tg.owners.length; i++) {
              if (tg.blocked[i]) continue;
              playable += 1;
              const owner = tg.owners[i];
              if (owner) counts[owner] = (counts[owner] ?? 0) + 1;
            }
            const totalOwned = Object.values(counts).reduce((a, b) => a + b, 0);
            const neutral = Math.max(0, playable - totalOwned);
            const entries = Object.keys(tg.teamLabels).map((tid) => ({
              tid,
              label: tg.teamLabels[tid],
              color: tg.teamColors[tid] ?? '#94a3b8',
              count: counts[tid] ?? 0,
            }));
            return (
              <div className="bf-rule-scoreboard bf-territory-board">
                <div className="bf-territory-bar">
                  {entries.map((en) => (
                    <div
                      key={en.tid}
                      className="bf-territory-seg"
                      style={{
                        width: `${playable > 0 ? (en.count / playable) * 100 : 0}%`,
                        backgroundColor: en.color,
                      }}
                    />
                  ))}
                  {neutral > 0 && (
                    <div
                      className="bf-territory-seg is-neutral"
                      style={{ width: `${playable > 0 ? (neutral / playable) * 100 : 0}%` }}
                    />
                  )}
                </div>
                <div className="bf-territory-legend">
                  {entries.map((en) => (
                    <span key={en.tid} className="bf-score-pill">
                      <span className="bf-color-dot" style={{ backgroundColor: en.color }} />
                      {en.label}: <strong>{en.count}</strong>マス
                    </span>
                  ))}
                  <span className="bf-score-pill is-muted">中立: {neutral}マス</span>
                </div>
              </div>
            );
          })()}

          {(config.ruleId === 'balloon_hunt' || config.ruleId === 'bounty_hunt') &&
            battleState.ruleTeamScores && (() => {
              const wantedTop =
                config.ruleId === 'bounty_hunt'
                  ? [...battleState.tanks]
                      .filter((t) => (t.bountyValue ?? 100) >= 200)
                      .sort((a, b) => (b.bountyValue ?? 100) - (a.bountyValue ?? 100))[0] ?? null
                  : null;
              return (
                <div className="bf-rule-scoreboard">
                  <div className="bf-territory-legend">
                    {Object.entries(battleState.ruleTeamScores)
                      .sort((a, b) => b[1] - a[1])
                      .map(([tid, score]) => (
                        <span key={tid} className="bf-score-pill">
                          <span
                            className="bf-color-dot"
                            style={{
                              backgroundColor: battleState.ruleTeamColors?.[tid] ?? '#38bdf8',
                            }}
                          />
                          {battleState.ruleTeamLabels?.[tid] ?? tid}: <strong>{score}pt</strong>
                        </span>
                      ))}
                    {wantedTop && (
                      <span className="bf-bounty-badge">
                        👑 現賞金首: {wantedTop.blueprint.name} ★{wantedTop.bountyValue}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Multi-Tank Live HUD */}
          {(() => {
            const tankById = new Map(battleState.tanks.map((t) => [t.id, t]));
            const metaByTankId = new Map<string, BattlefieldParticipant>(
              activeParticipants.map((p, i) => [`bf_tank_${i}`, p])
            );
            const teamLabels: Record<string, string> = { ...(battleState.ruleTeamLabels ?? {}) };
            const teamColors: Record<string, string> = { ...(battleState.ruleTeamColors ?? {}) };
            for (const p of activeParticipants) {
              if (!teamLabels[p.teamId]) teamLabels[p.teamId] = p.teamLabel;
              if (!teamColors[p.teamId]) teamColors[p.teamId] = p.teamColor;
            }
            const hudLayout = computeBattlefieldHudLayout(
              battleState.tanks,
              teamLabels,
              teamColors
            );

            const renderTankHudCard = (t: (typeof battleState.tanks)[number]) => {
              const meta = metaByTankId.get(t.id);
              const hpPct = Math.max(0, Math.round((t.hp / Math.max(1, t.maxHp)) * 100));
              const isFocused =
                cameraMode !== 'tactical' && cameraMode !== 'orbit' && focusTankId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`bf-hud-card ${t.hp <= 0 ? 'is-dead' : ''} ${
                    isFocused ? 'is-focused' : ''
                  }`}
                  style={{ borderLeftColor: t.blueprint.color }}
                  onClick={() => {
                    if (isFocused) {
                      setFocusTankId(null);
                      setCameraMode('tactical');
                    } else {
                      setFocusTankId(t.id);
                      setCameraMode('chase_p1');
                    }
                  }}
                  title={isFocused ? 'クリックして俯瞰視点に戻す' : 'クリックしてカメラ追跡'}
                >
                  <div className="bf-hud-card-top">
                    <span className="bf-hud-team" style={{ color: t.blueprint.color }}>
                      {meta?.teamLabel ?? t.teamId}
                    </span>
                    {config.ruleId === 'bounty_hunt' &&
                      t.hp > 0 &&
                      (t.bountyValue ?? 100) >= 200 && (
                        <span className="bf-bounty-badge is-mini">
                          {(t.bountyValue ?? 100) >= 400 ? '👑' : ''}★{t.bountyValue}
                        </span>
                      )}
                    <span className="bf-hud-cpu">
                      {t.blueprint.program.gridSize}×{t.blueprint.program.gridSize}
                    </span>
                  </div>
                  <div className="bf-hud-names">
                    <strong>{t.blueprint.name}</strong>
                    <span>{t.playerName || t.blueprint.author || 'Player'}</span>
                  </div>
                  <div className="bf-hp-track">
                    <div
                      className="bf-hp-fill"
                      style={{ width: `${hpPct}%`, backgroundColor: t.blueprint.color }}
                    />
                  </div>
                  <div className="bf-hud-stats">
                    {config.ruleId === 'bounty_hunt' &&
                    t.hp <= 0 &&
                    (t.respawnTicks ?? 0) > 0 ? (
                      <span className="bf-respawn-tag">
                        復帰 {((t.respawnTicks ?? 0) / BASE_TPS).toFixed(1)}s
                      </span>
                    ) : (
                      <span>
                        HP {Math.max(0, Math.round(t.hp))}/{t.maxHp}
                      </span>
                    )}
                    {config.ruleId === 'elimination' ? (
                      <>
                        <span>撃破:{t.stats.kills ?? 0}</span>
                        <span>与:{Math.round(t.stats.damageDealt)}</span>
                      </>
                    ) : (
                      <>
                        {!battleState.arena.disableTankDamage && (
                          <span>撃破:{t.stats.kills ?? 0}</span>
                        )}
                        <span>{currentRuleSpec?.computeContributionLabel?.(t)}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            };

            return (
              <div className={`bf-hud-rows ${hudLayout.isTeamGrouped ? 'is-grouped' : ''}`}>
                {!hudLayout.isTeamGrouped
                  ? hudLayout.rows.map((row, rIdx) => (
                      <div
                        key={`hud_row_${rIdx}`}
                        className="bf-hud-row"
                        style={{ gridTemplateColumns: `repeat(${row.columns}, minmax(0, 1fr))` }}
                      >
                        {row.clusters.flatMap((c) =>
                          c.tankIds
                            .map((id) => tankById.get(id))
                            .filter((t): t is NonNullable<typeof t> => Boolean(t))
                            .map(renderTankHudCard)
                        )}
                      </div>
                    ))
                  : hudLayout.rows.map((row, rIdx) => (
                      <div key={`hud_team_row_${rIdx}`} className="bf-hud-team-row">
                        {row.clusters.map((cluster) => {
                          const clusterTanks = cluster.tankIds
                            .map((id) => tankById.get(id))
                            .filter((t): t is NonNullable<typeof t> => Boolean(t));
                          const aliveCount = clusterTanks.filter((t) => t.hp > 0).length;
                          return (
                            <div
                              key={cluster.teamId}
                              className="bf-hud-team-cluster"
                              style={{
                                flexGrow: Math.min(4, cluster.tankIds.length),
                                borderColor: `${cluster.teamColor}55`,
                              }}
                            >
                              <div className="bf-hud-team-cluster-head">
                                <span className="bf-hud-team-cluster-title">
                                  <span
                                    className="bf-color-dot"
                                    style={{ backgroundColor: cluster.teamColor }}
                                  />
                                  {cluster.teamLabel}
                                </span>
                                <span className="bf-hud-team-cluster-count">
                                  {aliveCount}/{clusterTanks.length}
                                </span>
                              </div>
                              <div
                                className="bf-hud-team-cluster-grid"
                                style={{
                                  gridTemplateColumns: `repeat(${Math.min(4, cluster.tankIds.length)}, minmax(0, 1fr))`,
                                }}
                              >
                                {clusterTanks.map(renderTankHudCard)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
              </div>
            );
          })()}

          {/* Live Commentary Bar + Settings Popover */}
          {(() => {
            const latestCommentary = commentaryLog[commentaryLog.length - 1] ?? null;
            const standbyText = createStandbyCommentaryText(battleState, activeMatchConfig);
            return (
              <div className="bf-commentary-wrap">
                <div
                  className={`bf-commentary-bar ${
                    !commentarySettings.enabled
                      ? 'is-muted'
                      : latestCommentary
                        ? `is-priority-${latestCommentary.priority}`
                        : ''
                  }`}
                >
                  <span className="bf-commentary-label">
                    <Mic size={11} /> 実況
                  </span>
                  {commentarySettings.enabled && (
                    <span className="bf-commentary-badge">
                      {latestCommentary ? latestCommentary.badge : '待機'}
                    </span>
                  )}
                  <div
                    key={commentarySettings.enabled ? latestCommentary?.id ?? 'standby' : 'off'}
                    className="bf-commentary-text"
                    title={commentarySettings.enabled ? latestCommentary?.text ?? standbyText : undefined}
                  >
                    {commentarySettings.enabled
                      ? latestCommentary?.text ?? standbyText
                      : '実況オフ（右の「設定」からONにできます）'}
                  </div>
                  {commentarySettings.enabled && latestCommentary && (
                    <span className="bf-commentary-time">{latestCommentary.timeSec.toFixed(1)}s</span>
                  )}
                  {commentarySettings.enabled && commentarySettings.speechEnabled && (
                    <span
                      className="bf-commentary-speech-dot"
                      title="Web Speech 音声読み上げ ON"
                    >
                      <Volume2 size={12} />
                    </span>
                  )}
                  <div className="bf-commentary-actions">
                    <button
                      type="button"
                      className={`mini-btn ${commentaryHistoryOpen ? 'active' : ''}`}
                      onClick={() => {
                        setCommentaryHistoryOpen((v) => !v);
                        setCommentarySettingsOpen(false);
                      }}
                      title="試合中の実況ハイライト履歴を表示"
                    >
                      <History size={11} /> 履歴({commentaryLog.length})
                    </button>
                    <button
                      type="button"
                      className={`mini-btn ${commentarySettingsOpen ? 'active' : ''}`}
                      onClick={() => {
                        setCommentarySettingsOpen((v) => !v);
                        setCommentaryHistoryOpen(false);
                      }}
                      title="実況スタイル・Web Speech 読み上げ設定"
                    >
                      <Settings size={11} /> 設定
                    </button>
                  </div>
                </div>

                {commentarySettingsOpen && (
                  <div className="bf-commentary-popover" role="dialog" aria-label="実況設定">
                    <div className="bf-commentary-popover-head">
                      <span>🎙 実況設定</span>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setCommentarySettingsOpen(false)}
                      >
                        閉じる
                      </button>
                    </div>

                    <label className="bf-commentary-setting-row">
                      <span>実況バーを表示</span>
                      <input
                        type="checkbox"
                        checked={commentarySettings.enabled}
                        onChange={(e) =>
                          setCommentarySettings((prev) => ({
                            ...prev,
                            enabled: e.target.checked,
                          }))
                        }
                      />
                    </label>

                    <div className="bf-commentary-note">実況スタイル</div>
                    <div className="bf-commentary-style-tabs">
                      {(['standard', 'hype', 'analyst'] as CommentaryStyle[]).map((st) => (
                        <button
                          key={st}
                          type="button"
                          disabled={!commentarySettings.enabled}
                          className={`mini-btn ${commentarySettings.style === st ? 'active' : ''}`}
                          onClick={() =>
                            setCommentarySettings((prev) => ({ ...prev, style: st }))
                          }
                          title={COMMENTARY_STYLE_SPECS[st].description}
                        >
                          {COMMENTARY_STYLE_SPECS[st].label}
                        </button>
                      ))}
                    </div>

                    <label className="bf-commentary-setting-row">
                      <span>音声読み上げ (Web Speech)</span>
                      <input
                        type="checkbox"
                        checked={commentarySettings.speechEnabled}
                        disabled={!speechSupported || !commentarySettings.enabled}
                        onChange={(e) =>
                          setCommentarySettings((prev) => ({
                            ...prev,
                            speechEnabled: e.target.checked,
                          }))
                        }
                      />
                    </label>

                    {!speechSupported ? (
                      <div className="bf-commentary-note">
                        このブラウザ環境では Web Speech API に対応していません。
                      </div>
                    ) : commentarySettings.speechEnabled && commentarySettings.enabled ? (
                      <div className="bf-commentary-subrow">
                        <span>速度 ×{commentarySettings.speechRate.toFixed(2)}</span>
                        <input
                          type="range"
                          min={0.8}
                          max={1.6}
                          step={0.05}
                          value={commentarySettings.speechRate}
                          onChange={(e) =>
                            setCommentarySettings((prev) => ({
                              ...prev,
                              speechRate: Number(e.target.value),
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => {
                            const sample: CommentaryEntry = {
                              id: 'speech_test',
                              tick: battleState.tick,
                              timeSec: Math.round((battleState.tick / 20) * 10) / 10,
                              priority: 'S',
                              category: 'opening',
                              badge: 'テスト',
                              text: 'バトルフィールド実況テスト。各戦車、準備完了です！',
                              speechText: 'バトルフィールド実況テスト。各戦車、準備完了です！',
                            };
                            speakCommentary(sample, commentarySettings, 1, true);
                          }}
                        >
                          テスト
                        </button>
                      </div>
                    ) : (
                      <div className="bf-commentary-note">
                        基本オフ（ブラウザ標準音声で読み上げ / ×2倍速以下推奨）
                      </div>
                    )}
                  </div>
                )}

                {commentaryHistoryOpen && (
                  <div className="bf-commentary-history" role="dialog" aria-label="実況ハイライト履歴">
                    <div className="bf-commentary-popover-head">
                      <span>📜 実況ハイライト ({commentaryLog.length}件)</span>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setCommentaryHistoryOpen(false)}
                      >
                        閉じる
                      </button>
                    </div>
                    {commentaryLog.length === 0 ? (
                      <div className="bf-commentary-note">
                        まだ実況ログがありません（試合を開始すると自動で記録されます）。
                      </div>
                    ) : (
                      <div className="bf-commentary-history-list">
                        {[...commentaryLog].reverse().map((item) => (
                          <div
                            key={item.id}
                            className={`bf-commentary-history-item is-priority-${item.priority}`}
                          >
                            <span className="bf-commentary-history-time">
                              {item.timeSec.toFixed(1)}s
                            </span>
                            <span className="bf-commentary-history-badge">[{item.badge}]</span>
                            <span>{item.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 3D Viewport */}
          <div className="viewport-frame bf-viewport-frame">
            <BattleCanvas3D
              battleState={battleState}
              cameraMode={cameraMode}
              showDebugOverlay={showDebugOverlay}
              zoomLevel={zoomLevel}
              onChangeZoom={setZoomLevel}
              focusTankId={focusTankId}
            />

            <div className="viewport-overlay-top">
              <div className="cam-switcher">
                <Camera size={13} />
                <button
                  type="button"
                  className={`cam-btn ${cameraMode === 'tactical' ? 'active' : ''}`}
                  onClick={() => {
                    setFocusTankId(null);
                    setCameraMode('tactical');
                  }}
                >
                  俯瞰
                </button>
                <button
                  type="button"
                  className={`cam-btn ${cameraMode === 'chase_p1' ? 'active' : ''}`}
                  onClick={() => {
                    if (!focusTankId && battleState.tanks.length > 0) {
                      setFocusTankId(battleState.tanks[0].id);
                    }
                    setCameraMode('chase_p1');
                  }}
                >
                  追従視点
                </button>
                <button
                  type="button"
                  className={`cam-btn ${cameraMode === 'orbit' ? 'active' : ''}`}
                  onClick={() => {
                    setFocusTankId(null);
                    setCameraMode('orbit');
                  }}
                >
                  フリー視点
                </button>
              </div>

              <div className="viewport-right-controls">
                {cameraMode === 'tactical' && (
                  <div className="zoom-controls" title="バトルマップの表示倍率">
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() =>
                        setZoomLevel((z) => Math.max(0.55, Number((z - 0.15).toFixed(2))))
                      }
                      title="縮小"
                    >
                      <ZoomOut size={13} />
                    </button>
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() => setZoomLevel(1.0)}
                      title="全体表示に戻す"
                    >
                      {Math.round(zoomLevel * 100)}%
                    </button>
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() =>
                        setZoomLevel((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))
                      }
                      title="拡大"
                    >
                      <ZoomIn size={13} />
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className={`cam-btn overlay-pill-btn ${showDebugOverlay ? 'active' : ''}`}
                  onClick={() => setShowDebugOverlay((v) => !v)}
                  title="レーダー扇形・照準線の表示切替"
                >
                  {showDebugOverlay ? <Eye size={13} /> : <EyeOff size={13} />}
                  レーダー可視化
                </button>
              </div>
            </div>

            {cameraMode === 'orbit' && (
              <div className="orbit-hint">
                マウスドラッグで視点回転 / ホイールでズーム
              </div>
            )}

            {battleState.football?.pendingKickoffReset &&
              battleState.football.lastGoalBanner && (
                <div
                  className="bf-goal-viewport-overlay"
                  style={{ borderColor: battleState.football.lastGoalBanner.color }}
                >
                  <span
                    className="bf-color-dot"
                    style={{ backgroundColor: battleState.football.lastGoalBanner.color }}
                  />
                  <strong>GOAL!</strong>
                  <span>{battleState.football.lastGoalBanner.teamLabel}</span>
                </div>
              )}

            {activeCompetitionCard &&
              !vsBannerDismissed &&
              !isPlaying &&
              battleState.tick === 0 &&
              battleState.status === 'running' &&
              activeParticipants.length >= 2 && (
                <div className="bf-vs-banner-overlay" role="region" aria-label="対戦カード表示">
                  <div className="bf-vs-kicker">
                    <span className="bf-vs-stage">
                      {activeCompetitionCard.mode === 'tournament' ? (
                        <Trophy size={14} />
                      ) : (
                        <Award size={14} />
                      )}
                      {activeCompetitionCard.stageLabel}
                    </span>
                    <span className="bf-tag">{activeCompetitionCard.ruleLabel}</span>
                    {activeCompetitionCard.seriesLabel && (
                      <span className="bf-vs-series">{activeCompetitionCard.seriesLabel}</span>
                    )}
                  </div>

                  <div className="bf-vs-matchup">
                    <div
                      className="bf-vs-side is-left"
                      style={{ borderColor: activeCompetitionCard.unitA.color }}
                    >
                      <div
                        className="bf-vs-player"
                        style={{ color: activeCompetitionCard.unitA.color }}
                      >
                        {activeCompetitionCard.unitA.title}
                      </div>
                      <div className="bf-vs-machine">{activeCompetitionCard.unitA.subtitle}</div>
                    </div>

                    <div className="bf-vs-divider">VS</div>

                    <div
                      className="bf-vs-side is-right"
                      style={{ borderColor: activeCompetitionCard.unitB.color }}
                    >
                      <div
                        className="bf-vs-player"
                        style={{ color: activeCompetitionCard.unitB.color }}
                      >
                        {activeCompetitionCard.unitB.title}
                      </div>
                      <div className="bf-vs-machine">{activeCompetitionCard.unitB.subtitle}</div>
                    </div>
                  </div>

                  <div className="bf-vs-actions">
                    <button
                      type="button"
                      className="btn-play"
                      onClick={() => {
                        clearAutoTimer();
                        clearResultModalTimer();
                        setIsPlaying(true);
                      }}
                    >
                      <Play size={15} /> 試合開始
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setVsBannerDismissed(true)}
                    >
                      <Eye size={13} /> マップを見る
                    </button>
                  </div>
                </div>
              )}
          </div>

          {/* Playback Controls */}
          <div className="playback-bar bf-playback-bar">
            <div className="playback-left">
              <button
                type="button"
                className="btn-play"
                disabled={activeParticipants.length < 2}
                onClick={() => {
                  clearAutoTimer();
                  clearResultModalTimer();
                  goalPauseUntilRef.current = 0;
                  if (battleState.status === 'finished') {
                    recordedFinishRef.current = false;
                    setLatestReport(null);
                    setShowResultModal(false);
                    const rematchCfg =
                      config.format === 'battle_royale' || config.format === 'team_match'
                        ? resolveMatchConfigForGame(config, 0)
                        : activeMatchConfig;
                    setActiveMatchConfig(rematchCfg);
                    const nextState = createBattlefieldMatchState(activeParticipants, rematchCfg);
                    resetCommentary(nextState, rematchCfg);
                    setBattleState(nextState);
                    setIsPlaying(true);
                  } else {
                    setIsPlaying((v) => !v);
                  }
                }}
              >
                {isPlaying ? <Pause size={15} /> : <Play size={15} />}
                {isPlaying ? '一時停止' : battleState.status === 'finished' ? '再戦' : '試合開始'}
              </button>

              <button
                type="button"
                className="mini-btn"
                disabled={battleState.status === 'finished' || activeParticipants.length < 2}
                onClick={() => {
                  setIsPlaying(false);
                  setBattleState((prev) =>
                    stepBattlefieldTick(cloneBattleStateForStep(prev), activeMatchConfig)
                  );
                }}
              >
                1Tick
              </button>

              <button
                type="button"
                className="mini-btn"
                disabled={activeParticipants.length < 2}
                onClick={handleReplayCurrentMatch}
              >
                <RotateCcw size={13} /> リセット
              </button>

              <button
                type="button"
                className="mini-btn"
                disabled={activeParticipants.length < 2 || battleState.status === 'finished'}
                onClick={handleInstantFinishCurrentMatch}
                title="現在の試合を瞬時に最後までシミュレート"
              >
                <Zap size={13} /> 瞬時決着
              </button>
            </div>

            <div className="speed-controls">
              <Cpu size={14} />
              <span>再生速度:</span>
              {[
                { value: 0.25, label: 'slow' },
                { value: 0.5, label: 'normal' },
                { value: 1.0, label: 'high' },
                { value: 2.0, label: 'rapid' },
                { value: 4.0, label: 'express' },
              ].map((spd) => (
                <button
                  key={spd.value}
                  type="button"
                  className={`spd-btn ${speedMultiplier === spd.value ? 'active' : ''}`}
                  onClick={() => setSpeedMultiplier(spd.value)}
                >
                  {spd.label}
                </button>
              ))}
              {latestReport && (
                <button
                  type="button"
                  className="mini-btn active"
                  onClick={() => {
                    clearResultModalTimer();
                    setShowResultModal(true);
                  }}
                >
                  <Award size={13} /> リザルト表示
                </button>
              )}
            </div>
          </div>

          {/* Competition Panel: Tournament & League */}
          {config.format === 'tournament' && tournamentBracket && (
            <div className="bf-competition-panel">
              <div className="bf-comp-toolbar">
                <div className="bf-comp-title">
                  <Trophy size={16} /> <strong>トーナメント進行表</strong>
                  {tournamentBracket.championUnitId && (
                    <span className="bf-champion-badge">
                      🏆 優勝:{' '}
                      {tournamentBracket.units.find(
                        (u) => u.unitId === tournamentBracket.championUnitId
                      )?.unitName ?? '-'}
                    </span>
                  )}
                </div>

                <div className="bf-comp-actions">
                  <label className="bf-check-inline">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    <span>自動進行 (次の試合へ)</span>
                  </label>
                  {hasMoreCompetitionMatches && (
                    <>
                      <button
                        type="button"
                        className="mini-btn active"
                        onClick={() => handleLoadNextPendingMatch(true)}
                      >
                        <FastForward size={13} /> 次の未消化試合を開始
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={handleSimulateAllRemainingCompetition}
                      >
                        <Zap size={13} /> 全試合を一括高速シミュレート
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleShuffleOrder}
                    title="出場ユニットの並び順をシャッフルして組合せを再構築"
                  >
                    <Shuffle size={13} /> 組合せシャッフル
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() =>
                      void handleCopyText(
                        formatTournamentSummaryText(tournamentBracket, config),
                        'トーナメント結果'
                      )
                    }
                  >
                    <Copy size={13} /> トーナメント結果コピー
                  </button>
                </div>
              </div>

              <div className="bf-bracket-rounds">
                {tournamentBracket.rounds.map((round) => (
                  <div key={round[0]?.roundLabel} className="bf-bracket-col">
                    <h4>{round[0]?.roundLabel}</h4>
                    {round.map((m) => {
                      const uA = m.unitAId
                        ? tournamentBracket.units.find((u) => u.unitId === m.unitAId)
                        : null;
                      const uB = m.unitBId
                        ? tournamentBracket.units.find((u) => u.unitId === m.unitBId)
                        : null;
                      const isCur = activeMatchId === m.matchId;
                      const isBo3Match =
                        (m.seriesBestOf ?? 1) === 3 || (m.gameReports?.length ?? 0) > 0;
                      const playedGames = m.gameReports?.length ?? 0;
                      return (
                        <div
                          key={m.matchId}
                          className={`bf-bracket-match ${isCur ? 'is-current' : ''} ${
                            m.winnerUnitId ? 'is-done' : ''
                          }`}
                        >
                          <div
                            className={`bf-match-slot ${
                              m.winnerUnitId && m.winnerUnitId === m.unitAId ? 'is-winner' : ''
                            }`}
                          >
                            <span>{uA ? uA.unitName : m.isBye ? '(BYE)' : '未定'}</span>
                            {isBo3Match && uA && uB && (
                              <strong className="bf-series-score">{m.winsA ?? 0}</strong>
                            )}
                          </div>
                          <div
                            className={`bf-match-slot ${
                              m.winnerUnitId && m.winnerUnitId === m.unitBId ? 'is-winner' : ''
                            }`}
                          >
                            <span>{uB ? uB.unitName : m.isBye ? '(BYE)' : '未定'}</span>
                            {isBo3Match && uA && uB && (
                              <strong className="bf-series-score">{m.winsB ?? 0}</strong>
                            )}
                          </div>
                          {uA && uB && !m.isBye && (
                            <button
                              type="button"
                              className="mini-btn bf-watch-btn"
                              onClick={() =>
                                loadCompetitionMatchIntoArena(
                                  m.matchId,
                                  uA,
                                  uB,
                                  config,
                                  false,
                                  playedGames
                                )
                              }
                            >
                              {m.winnerUnitId
                                ? '再戦 / 観戦'
                                : playedGames > 0
                                  ? '続きをセット'
                                  : 'この試合をセット'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {config.format === 'league' && leagueData && (
            <div className="bf-competition-panel">
              <div className="bf-comp-toolbar">
                <div className="bf-comp-title">
                  <Award size={16} /> <strong>リーグ総当たり戦 順位表</strong>
                </div>

                <div className="bf-comp-actions">
                  <label className="bf-check-inline">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    <span>自動進行 (次の試合へ)</span>
                  </label>
                  {hasMoreCompetitionMatches && (
                    <>
                      <button
                        type="button"
                        className="mini-btn active"
                        onClick={() => handleLoadNextPendingMatch(true)}
                      >
                        <FastForward size={13} /> 次の試合を開始
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={handleSimulateAllRemainingCompetition}
                      >
                        <Zap size={13} /> 全試合を一括高速シミュレート
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleShuffleOrder}
                    title="出場ユニットの対戦順をシャッフルしてリーグ戦を再構築"
                  >
                    <Shuffle size={13} /> 組合せシャッフル
                  </button>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() =>
                      void handleCopyText(
                        formatLeagueStandingsText(leagueStandings, config),
                        'リーグ順位表'
                      )
                    }
                  >
                    <Copy size={13} /> 順位表をコピー
                  </button>
                </div>
              </div>

              <div className="bf-table-scroll">
                <table className="bf-stats-table">
                  <thead>
                    <tr>
                      <th>順位</th>
                      <th>Player名</th>
                      <th>マシーン名</th>
                      <th>CPU</th>
                      <th>試合</th>
                      <th>勝/分/負</th>
                      <th>勝点</th>
                      <th>撃破</th>
                      <th>与ダメ</th>
                      <th>被ダメ</th>
                      <th>命中率</th>
                      <th>平均生存</th>
                      <th>総貢献</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leagueStandings.map((row) => (
                      <tr key={row.unitId} className={row.rank === 1 && row.played > 0 ? 'is-top' : ''}>
                        <td>{row.rank}位</td>
                        <td>{row.playerSummary}</td>
                        <td>
                          <span className="bf-color-dot" style={{ backgroundColor: row.color }} />
                          {row.machineSummary}
                        </td>
                        <td>{row.cpuSummary}</td>
                        <td>{row.played}</td>
                        <td>
                          {row.wins}/{row.draws}/{row.losses}
                        </td>
                        <td>
                          <strong>{row.points}</strong>
                        </td>
                        <td>{row.totalKills}</td>
                        <td>{row.totalDamageDealt.toFixed(1)}</td>
                        <td>{row.totalDamageTaken.toFixed(1)}</td>
                        <td>
                          {row.hitRatePercent !== null
                            ? `${row.hitRatePercent.toFixed(1)}% (${row.totalShotsHit}/${row.totalShotsFired})`
                            : '-'}
                        </td>
                        <td>{row.avgSurvivedSeconds.toFixed(1)}s</td>
                        <td>{row.totalContribution}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bf-league-schedule">
                {leagueData.matches.map((m) => {
                  const uA = leagueData.units.find((u) => u.unitId === m.unitAId);
                  const uB = leagueData.units.find((u) => u.unitId === m.unitBId);
                  if (!uA || !uB) return null;
                  const winName = m.winnerUnitId
                    ? leagueData.units.find((u) => u.unitId === m.winnerUnitId)?.unitName
                    : null;
                  return (
                    <button
                      key={m.matchId}
                      type="button"
                      className={`bf-schedule-chip ${activeMatchId === m.matchId ? 'is-current' : ''} ${
                        m.report ? 'is-done' : ''
                      }`}
                      onClick={() =>
                        loadCompetitionMatchIntoArena(
                          m.matchId,
                          uA,
                          uB,
                          config,
                          false,
                          m.gameReports?.length ?? 0
                        )
                      }
                    >
                      <span>第{m.roundNumber}節</span>
                      <strong>
                        {uA.unitName} vs {uB.unitName}
                      </strong>
                      <em>
                        {m.report
                          ? `${m.isDraw ? '引分' : `勝: ${winName}`}${
                              (m.seriesBestOf ?? 1) === 3
                                ? ` (${m.winsA ?? 0}-${m.winsB ?? 0})`
                                : ''
                            }`
                          : (m.seriesBestOf ?? 1) === 3 && (m.gameReports?.length ?? 0) > 0
                            ? `途中 (${m.winsA ?? 0}-${m.winsB ?? 0})`
                            : '未対戦'}
                      </em>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Post-Match Result Modal */}
      {showResultModal && latestReport && (
        <div className="modal-backdrop" onClick={() => setShowResultModal(false)}>
          <div className="result-card bf-result-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bf-result-header">
              <div>
                <span className="bf-result-kicker">
                  {BATTLEFIELD_RULE_REGISTRY[latestReport.configSnapshot.ruleId]?.name} /{' '}
                  {CPU_REGULATION_SPECS[latestReport.configSnapshot.cpuRegulation].label}
                  {formatConfigConditionSuffix(latestReport.configSnapshot)}
                </span>
                <h2>{latestReport.endReason}</h2>
                <p>経過時間: {latestReport.durationSeconds.toFixed(1)}秒</p>
              </div>
              <div className="bf-result-actions">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    void handleCopyText(
                      formatMatchReportText(latestReport, latestMatchSummary),
                      '試合結果テキスト'
                    )
                  }
                >
                  <Copy size={14} /> 結果をテキストでコピー
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() =>
                    void handleCopyText(formatMatchReportTsv(latestReport), 'Excel用TSVデータ')
                  }
                >
                  <Copy size={14} /> Excel用 (TSV) コピー
                </button>
                {hasMoreCompetitionMatches && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleLoadNextPendingMatch(true)}
                  >
                    <FastForward size={14} />{' '}
                    {hasPendingActiveSeriesGame ? '次のゲームへ (Bo3)' : '次の試合へ'}
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => setShowResultModal(false)}
                >
                  閉じる
                </button>
              </div>
            </div>

            {latestMatchSummary && (
              <div className="bf-result-summary">
                <div className="bf-result-summary-badge">
                  <Mic size={12} /> 試合総評（{COMMENTARY_STYLE_SPECS[latestMatchSummary.style].label}）
                </div>
                <p className="bf-result-summary-headline">{latestMatchSummary.headline}</p>
                {latestMatchSummary.highlights.length > 0 && (
                  <ul className="bf-result-summary-list">
                    {latestMatchSummary.highlights.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {(() => {
              const awardEntries = latestReport.tankRows.flatMap((r) =>
                r.awards.map((award) => ({
                  award,
                  label: `${r.machineName} (${r.playerName})`,
                  color: r.teamColor,
                }))
              );
              if (awardEntries.length === 0) return null;
              return (
                <div className="bf-awards-strip">
                  <span className="bf-awards-strip-label">🏅 今試合の特別賞</span>
                  {awardEntries.map((item, idx) => (
                    <span key={`${item.award}_${idx}`} className="bf-award-chip">
                      <span className="bf-color-dot" style={{ backgroundColor: item.color }} />
                      <strong>{item.award}</strong>
                      <em>{item.label}</em>
                    </span>
                  ))}
                </div>
              );
            })()}

            <div className="bf-table-scroll">
              <table className="bf-stats-table">
                <thead>
                  <tr>
                    <th>順位</th>
                    <th>チーム</th>
                    <th>Player名</th>
                    <th>マシーン名</th>
                    <th>CPU</th>
                    <th>撃破</th>
                    <th>与ダメ</th>
                    <th>被ダメ</th>
                    <th>命中率</th>
                    <th>生存時間</th>
                    <th>貢献度</th>
                    <th>賞</th>
                  </tr>
                </thead>
                <tbody>
                  {latestReport.tankRows.map((row) => (
                    <tr key={row.tankId} className={row.rank === 1 ? 'is-top' : ''}>
                      <td>
                        <strong>{row.rank}位</strong>
                      </td>
                      <td>
                        <span className="bf-color-dot" style={{ backgroundColor: row.teamColor }} />
                        {row.teamLabel}
                      </td>
                      <td>
                        <strong>{row.playerName}</strong>
                      </td>
                      <td>{row.machineName}</td>
                      <td>
                        {row.gridSize}×{row.gridSize}
                      </td>
                      <td>{row.kills}</td>
                      <td>{row.damageDealt.toFixed(1)}</td>
                      <td>{row.damageTaken.toFixed(1)}</td>
                      <td>
                        {row.hitRatePercent !== null
                          ? `${row.hitRatePercent.toFixed(1)}% (${row.shotsHit}/${row.shotsFired})`
                          : '- (0/0)'}
                      </td>
                      <td>
                        {row.survivedSeconds.toFixed(1)}s{' '}
                        <span className="bf-sub-note">
                          {latestReport.configSnapshot.ruleId === 'bounty_hunt'
                            ? `(${row.killedByLabel})`
                            : row.isAlive
                              ? '(生存)'
                              : `(${row.killedByLabel})`}
                        </span>
                      </td>
                      <td>
                        <strong>{row.contributionScore}</strong>{' '}
                        <span className="bf-sub-note">({row.ruleMetricText})</span>
                      </td>
                      <td>
                        {row.awards.length > 0
                          ? row.awards.map((aw) => (
                              <span key={aw} className="bf-award-chip">
                                {aw}
                              </span>
                            ))
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {copyToast && (
        <div className="copy-toast" role="status">
          <Check size={14} /> {copyToast}
        </div>
      )}
    </div>
  );
};
