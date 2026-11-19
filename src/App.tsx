import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Download,
  Eye,
  EyeOff,
  GraduationCap,
  HelpCircle,
  Pause,
  Play,
  RotateCcw,
  Share2,
  SkipForward,
  Swords,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { BattleCanvas3D } from './components/BattleCanvas3D';
import { GridEditor } from './components/GridEditor';
import { ShareModal } from './components/ShareModal';
import {
  LEARNING_MISSIONS,
  LESSON_TITLES,
  resolveMissionVariant,
} from './data/learningMissions';
import { CHASSIS_SPECS, cpuIdForGridSize, SUB_WEAPON_SPECS } from './data/parts';
import { validateAndRepairBlueprint } from './utils/blueprintGatekeeper';
import {
  buildProgram,
  DEFAULT_PLAYER_BLUEPRINT,
  ENEMY_DUMMY,
  PRESET_ENEMIES,
  TUTORIAL_SECTION_TITLES,
  TUTORIAL_STAGES,
} from './data/presets';
import {
  ARENA_SIZE_SPECS,
  createBattleState,
  generateArenaObstacles,
  stepBattleTick,
} from './engine/simulator';
import {
  ArenaSizeId,
  BattleState,
  CameraMode,
  ChassisId,
  ChipProgram,
  MainGunId,
  ObstacleMode,
  RadarId,
  LearningMission,
  SubWeaponId,
  TankBlueprint,
} from './types/game';
import {
  getAutoTankColor,
  looksLikePythonSource,
  MAX_BATTLE_TANKS,
  parsePythonSourceWithAutoSize,
} from './utils/codeParser';
import {
  decodeShareCode,
  extractEnemyFromUrl,
  loadLearningClears,
  loadTutorialClears,
  markLearningCleared,
  markTutorialCleared,
  validateAndNormalizeBlueprint,
} from './utils/share';

const BASE_TPS = 20;
const MAX_MOBILE_BATTLE_TANKS = 4;
const FONT_SCALE_STORAGE_KEY = 'vstank_ui_font_scale';
type UiFontScale = 'normal' | 'large' | 'xlarge';
type LayoutPreset = 'mobile' | 'code' | 'balanced' | 'battle';

function getInitialLayoutPreset(): LayoutPreset {
  if (typeof window !== 'undefined' && window.innerWidth <= 768) {
    return 'mobile';
  }
  return 'balanced';
}

function loadUiFontScale(): UiFontScale {
  try {
    const raw = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (raw === 'normal' || raw === 'large' || raw === 'xlarge') return raw;
  } catch {
    // ignore storage errors
  }
  return 'normal';
}

function cloneBlueprint(bp: TankBlueprint): TankBlueprint {
  return validateAndRepairBlueprint(bp).blueprint;
}

function cloneCallStack(
  stack?: Array<{
    returnCoord: { x: number; y: number } | null;
    callerCoord: { x: number; y: number };
    subKey: string;
  }>
) {
  return stack?.map((f) => ({
    returnCoord: f.returnCoord ? { ...f.returnCoord } : null,
    callerCoord: { ...f.callerCoord },
    subKey: f.subKey,
  }));
}

function cloneBattleStateForStep(prev: BattleState): BattleState {
  return {
    ...prev,
    arena: {
      ...prev.arena,
      ...(prev.arena.tiles ? { tiles: prev.arena.tiles.map((tl) => ({ ...tl })) } : {}),
      ...(prev.arena.targets
        ? {
            targets: prev.arena.targets.map((tg) => ({
              ...tg,
              ...(tg.patrol ? { patrol: { ...tg.patrol } } : {}),
            })),
          }
        : {}),
      ...(prev.arena.learningRule ? { learningRule: { ...prev.arena.learningRule } } : {}),
    },
    tanks: prev.tanks.map((t) => ({
      ...t,
      stats: { ...t.stats },
      counters: { ...t.counters },
      loopCounters: { ...t.loopCounters },
      loopStack: t.loopStack?.map((f) => ({
        coord: { ...f.coord },
        callStack: cloneCallStack(f.callStack),
      })),
      detectedEnemy: t.detectedEnemy ? { ...t.detectedEnemy } : null,
      moveState: t.moveState
        ? {
            coord: { ...t.moveState.coord },
            speedRatio: t.moveState.speedRatio,
            remainingTicks: t.moveState.remainingTicks,
            callStack: cloneCallStack(t.moveState.callStack),
          }
        : null,
      sleepState: t.sleepState
        ? {
            coord: { ...t.sleepState.coord },
            remainingTicks: t.sleepState.remainingTicks,
            callStack: cloneCallStack(t.sleepState.callStack),
          }
        : null,
      turnState: t.turnState
        ? {
            ...t.turnState,
            coord: { ...t.turnState.coord },
            callStack: cloneCallStack(t.turnState.callStack),
          }
        : null,
      fireState: t.fireState
        ? {
            ...t.fireState,
            coord: { ...t.fireState.coord },
            callStack: cloneCallStack(t.fireState.callStack),
          }
        : null,
      tileEdgeState: t.tileEdgeState ? { ...t.tileEdgeState } : undefined,
      activePrintSpeech: t.activePrintSpeech
        ? { lines: [...t.activePrintSpeech.lines], tick: t.activePrintSpeech.tick }
        : null,
    })),
    projectiles: prev.projectiles.map((p) => ({ ...p })),
    mines: prev.mines.map((m) => ({ ...m })),
    ...(prev.smokes ? { smokes: prev.smokes.map((s) => ({ ...s })) } : {}),
    ...(prev.decoys ? { decoys: prev.decoys.map((d) => ({ ...d })) } : {}),
    explosions: prev.explosions.map((e) => ({ ...e })),
  };
}

function createBlankTutorialBlueprint(stageBp: TankBlueprint): TankBlueprint {
  const cloned = cloneBlueprint(stageBp);
  return {
    ...cloned,
    program: buildProgram(
      cloned.program.gridSize,
      cloned.program.coordinateMode,
      [{ x: 0, y: 0, type: 'start', next: null }]
    ),
  };
}

export function App() {
  const urlEnemy = useMemo(() => extractEnemyFromUrl(), []);
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(() => getInitialLayoutPreset());
  const isMobileLayout = layoutPreset === 'mobile';
  const maxBattleTanks = isMobileLayout ? MAX_MOBILE_BATTLE_TANKS : MAX_BATTLE_TANKS;
  const maxEnemySlots = maxBattleTanks - 1;

  const [gameMode, setGameMode] = useState<'learning' | 'tutorial' | 'free'>(() =>
    urlEnemy || getInitialLayoutPreset() === 'mobile' ? 'free' : 'learning'
  );
  const [learningIndex, setLearningIndex] = useState(0);
  const [learningVariantIndex, setLearningVariantIndex] = useState(0);
  const [passedLearningVariants, setPassedLearningVariants] = useState<number[]>([]);
  const shouldAutoAdvanceVariantRef = useRef<boolean>(false);
  const variantTimerRef = useRef<number | null>(null);
  const [clearedLearnings, setClearedLearnings] = useState<string[]>(() =>
    loadLearningClears()
  );
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [clearedTutorials, setClearedTutorials] = useState<string[]>(() =>
    loadTutorialClears()
  );

  const [freePlayerBp, setFreePlayerBp] = useState<TankBlueprint>(() =>
    cloneBlueprint(DEFAULT_PLAYER_BLUEPRINT)
  );
  const [freeEnemies, setFreeEnemies] = useState<TankBlueprint[]>(() => [
    urlEnemy ? cloneBlueprint(urlEnemy) : cloneBlueprint(ENEMY_DUMMY),
  ]);
  const [freeArenaSize, setFreeArenaSize] = useState<ArenaSizeId>('medium');
  const [obstacleMode, setObstacleMode] = useState<ObstacleMode>('none');
  const [mapSeed, setMapSeed] = useState<number>(-1);
  const [freeTeamBattle, setFreeTeamBattle] = useState<boolean>(false);
  const enemyFileInputRef = useRef<HTMLInputElement | null>(null);

  const activeLearningMission = LEARNING_MISSIONS[learningIndex];
  const [learningPlayerBp, setLearningPlayerBp] = useState<TankBlueprint>(() =>
    createBlankTutorialBlueprint(LEARNING_MISSIONS[0].playerStarter)
  );
  const activeStage = TUTORIAL_STAGES[tutorialIndex];
  const [tutorialPlayerBp, setTutorialPlayerBp] = useState<TankBlueprint>(() =>
    createBlankTutorialBlueprint(TUTORIAL_STAGES[0].playerStarter)
  );

  const freeEnemyBp = freeEnemies[0] ?? ENEMY_DUMMY;
  const currentPlayerBp =
    gameMode === 'learning'
      ? learningPlayerBp
      : gameMode === 'tutorial'
        ? tutorialPlayerBp
        : freePlayerBp;
  const currentEnemyList = useMemo(
    () =>
      gameMode === 'learning'
        ? activeLearningMission.enemies ?? []
        : gameMode === 'tutorial'
          ? activeStage.enemies && activeStage.enemies.length > 0
            ? activeStage.enemies
            : [activeStage.enemy]
          : freeEnemies,
    [
      gameMode,
      activeLearningMission.enemies,
      activeStage.enemies,
      activeStage.enemy,
      freeEnemies,
    ]
  );
  const currentEnemyBp = currentEnemyList[0] ?? activeStage.enemy;

  const clearVariantTimer = useCallback(() => {
    if (variantTimerRef.current !== null) {
      window.clearTimeout(variantTimerRef.current);
      variantTimerRef.current = null;
    }
  }, []);

  const buildMissionBattle = useCallback(
    (
      mission: LearningMission,
      playerBp: TankBlueprint,
      variantIdx: number,
      enemiesOverride?: TankBlueprint[]
    ): BattleState => {
      const resolved = resolveMissionVariant(mission, variantIdx);
      const mEnemies =
        enemiesOverride && enemiesOverride.length > 0 ? enemiesOverride : resolved.enemies;
      return createBattleState({
        player: cloneBlueprint(playerBp),
        enemies: mEnemies.map(cloneBlueprint),
        arenaSize: resolved.arenaSize,
        obstacles: resolved.obstacles,
        tiles: resolved.tiles,
        targets: resolved.targets,
        learningRule: mission.goalRule,
        maxTicks: mission.maxTicks,
        playerSpawn: resolved.playerSpawn,
        enemySpawns: resolved.enemySpawns,
        teamBattle: false,
      });
    },
    []
  );

  const buildInitialBattle = useCallback(
    (playerBp: TankBlueprint, enemiesInput: TankBlueprint[]): BattleState => {
      if (gameMode === 'learning') {
        return buildMissionBattle(
          LEARNING_MISSIONS[learningIndex],
          playerBp,
          learningVariantIndex,
          enemiesInput
        );
      }
      if (gameMode === 'tutorial') {
        const st = TUTORIAL_STAGES[tutorialIndex];
        const stEnemies =
          enemiesInput.length > 0
            ? enemiesInput
            : st.enemies && st.enemies.length > 0
              ? st.enemies
              : [st.enemy];
        return createBattleState({
          player: cloneBlueprint(playerBp),
          enemies: stEnemies.map(cloneBlueprint),
          arenaSize: st.arenaSize ?? 'large',
          obstacles: st.obstacles,
          maxTicks: st.maxTicks ?? 4800,
          playerSpawn: st.playerSpawn,
          enemySpawn: st.enemySpawn,
          enemySpawns: st.enemySpawns,
          enemyHpScale: st.enemyHpScale,
          teamBattle: Boolean(st.enemies && st.enemies.length > 1),
        });
      }
      const cappedEnemies = enemiesInput.slice(0, maxEnemySlots);
      return createBattleState({
        player: cloneBlueprint(playerBp),
        enemies: cappedEnemies.map(cloneBlueprint),
        arenaSize: freeArenaSize,
        obstacles: generateArenaObstacles(obstacleMode, mapSeed, freeArenaSize),
        teamBattle: freeTeamBattle && cappedEnemies.length > 1,
      });
    },
    [
      gameMode,
      learningIndex,
      learningVariantIndex,
      buildMissionBattle,
      tutorialIndex,
      obstacleMode,
      mapSeed,
      freeArenaSize,
      freeTeamBattle,
      maxEnemySlots,
    ]
  );

  const [battleState, setBattleState] = useState<BattleState>(() =>
    buildInitialBattle(currentPlayerBp, currentEnemyList)
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(0.5);
  const [cameraMode, setCameraMode] = useState<CameraMode>('tactical');
  const [battleZoom, setBattleZoom] = useState<number>(1.0);
  const [splitRatio, setSplitRatio] = useState<number>(55);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [showDebugOverlay, setShowDebugOverlay] = useState(true);
  const [showHints, setShowHints] = useState(false);
  const [uiFontScale, setUiFontScale] = useState<UiFontScale>(() => loadUiFontScale());

  const handleChangeUiFontScale = (scale: UiFontScale) => {
    setUiFontScale(scale);
    try {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, scale);
    } catch {
      // ignore storage errors
    }
  };

  const [showShareModal, setShowShareModal] = useState(false);
  const [mobileBattleDetailsOpen, setMobileBattleDetailsOpen] = useState(false);
  const [requestedSidebarTab, setRequestedSidebarTab] = useState<{
    mode: 'palette' | 'code';
    nonce: number;
  } | null>(null);

  // Sync battle reset when switching stages/enemies/obstacles
  const resetBattleWith = useCallback(
    (playerBp: TankBlueprint, enemyOrList: TankBlueprint | TankBlueprint[]) => {
      const list = Array.isArray(enemyOrList) ? enemyOrList : [enemyOrList];
      clearVariantTimer();
      shouldAutoAdvanceVariantRef.current = false;
      setIsPlaying(false);
      setBattleState(buildInitialBattle(playerBp, list));
    },
    [buildInitialBattle, clearVariantTimer]
  );

  const handleSelectLearning = (idx: number) => {
    clearVariantTimer();
    shouldAutoAdvanceVariantRef.current = false;
    const mission = LEARNING_MISSIONS[idx];
    const starter = createBlankTutorialBlueprint(mission.playerStarter);
    const resolved = resolveMissionVariant(mission, 0);
    if (resolved.enemies.length === 0 && cameraMode === 'chase_p2') {
      setCameraMode('tactical');
    }
    setGameMode('learning');
    setLearningIndex(idx);
    setLearningVariantIndex(0);
    setPassedLearningVariants([]);
    setLearningPlayerBp(starter);
    setShowHints(false);
    setIsPlaying(false);
    setBattleState(buildMissionBattle(mission, starter, 0));
  };

  const handleSelectLearningVariant = (variantIdx: number, autoPlay = false) => {
    clearVariantTimer();
    shouldAutoAdvanceVariantRef.current = autoPlay;
    setLearningVariantIndex(variantIdx);
    setIsPlaying(autoPlay);
    setBattleState(buildMissionBattle(activeLearningMission, learningPlayerBp, variantIdx));
  };

  const handleSelectTutorial = (idx: number) => {
    const stage = TUTORIAL_STAGES[idx];
    const starter = createBlankTutorialBlueprint(stage.playerStarter);
    const stEnemies = stage.enemies && stage.enemies.length > 0 ? stage.enemies : [stage.enemy];
    setGameMode('tutorial');
    setTutorialIndex(idx);
    setTutorialPlayerBp(starter);
    setShowHints(false);
    setIsPlaying(false);
    setBattleState(
      createBattleState({
        player: cloneBlueprint(starter),
        enemies: stEnemies.map(cloneBlueprint),
        arenaSize: stage.arenaSize ?? 'large',
        obstacles: stage.obstacles,
        maxTicks: stage.maxTicks ?? 4800,
        playerSpawn: stage.playerSpawn,
        enemySpawn: stage.enemySpawn,
        enemySpawns: stage.enemySpawns,
        enemyHpScale: stage.enemyHpScale,
        teamBattle: Boolean(stage.enemies && stage.enemies.length > 1),
      })
    );
  };

  const handleLoadStarterSolution = () => {
    const solution = cloneBlueprint(
      gameMode === 'learning' ? activeLearningMission.playerStarter : activeStage.playerStarter
    );
    if (gameMode === 'learning') {
      setLearningPlayerBp(solution);
    } else {
      setTutorialPlayerBp(solution);
    }
    resetBattleWith(solution, currentEnemyList);
  };

  const buildFreeBattle = (opts?: {
    enemies?: TankBlueprint[];
    obsMode?: ObstacleMode;
    seed?: number;
    arenaSize?: ArenaSizeId;
    teamBattle?: boolean;
  }): BattleState => {
    const maxSlots = opts?.enemies ? Math.min(opts.enemies.length, MAX_BATTLE_TANKS - 1) : maxEnemySlots;
    const capped = (opts?.enemies ?? freeEnemies).slice(0, maxSlots);
    const nextObsMode = opts?.obsMode ?? obstacleMode;
    const nextSeed = opts?.seed ?? mapSeed;
    const nextSize = opts?.arenaSize ?? freeArenaSize;
    const nextTeam = opts?.teamBattle ?? freeTeamBattle;
    return createBattleState({
      player: cloneBlueprint(freePlayerBp),
      enemies: capped.map(cloneBlueprint),
      arenaSize: nextSize,
      obstacles: generateArenaObstacles(nextObsMode, nextSeed, nextSize),
      teamBattle: nextTeam && capped.length > 1,
    });
  };

  const handleSwitchToFree = () => {
    setGameMode('free');
    setIsPlaying(false);
    setBattleState(buildFreeBattle());
  };

  const handleSelectLayoutPreset = (preset: LayoutPreset) => {
    setLayoutPreset(preset);
    if (preset === 'mobile') {
      const mobileMaxSlots = MAX_MOBILE_BATTLE_TANKS - 1;
      const trimmedEnemies = freeEnemies.slice(0, mobileMaxSlots);
      const didTrim = trimmedEnemies.length !== freeEnemies.length;
      if (didTrim) {
        setFreeEnemies(trimmedEnemies);
      }
      if (gameMode !== 'free' || didTrim) {
        setGameMode('free');
        setIsPlaying(false);
        setBattleState(buildFreeBattle({ enemies: trimmedEnemies }));
      }
      return;
    }
    if (preset === 'code') setSplitRatio(64);
    else if (preset === 'balanced') setSplitRatio(55);
    else if (preset === 'battle') setSplitRatio(38);
  };

  const scrollToMobileSection = (
    sectionId: string,
    sidebarTab?: 'palette' | 'code'
  ) => {
    if (sidebarTab) {
      setRequestedSidebarTab((prev) => ({
        mode: sidebarTab,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    }
    window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleSelectFreeEnemy = (enemy: TankBlueprint, slotIndex = 0) => {
    const cloned = cloneBlueprint(enemy);
    const nextList = [...freeEnemies];
    nextList[slotIndex] = cloned;
    const capped = nextList.slice(0, maxEnemySlots);
    setFreeEnemies(capped);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ enemies: capped }));
  };

  const handleAddFreeEnemy = (enemy: TankBlueprint) => {
    if (freeEnemies.length >= maxEnemySlots) return;
    const nextList = [...freeEnemies, cloneBlueprint(enemy)].slice(0, maxEnemySlots);
    setGameMode('free');
    setFreeEnemies(nextList);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ enemies: nextList }));
  };

  const handleRemoveFreeEnemy = (slotIndex: number) => {
    if (freeEnemies.length <= 1) return;
    const nextList = freeEnemies.filter((_, idx) => idx !== slotIndex);
    setFreeEnemies(nextList);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ enemies: nextList }));
  };

  const handleLoadMultiEnemyFiles = async (files: FileList) => {
    const maxSlots = maxEnemySlots;
    const available = maxSlots - freeEnemies.length;
    if (available <= 0) return;
    const nextList = [...freeEnemies];
    const baseEnemy = freeEnemies[0] ?? ENEMY_DUMMY;
    for (const file of Array.from(files).slice(0, available)) {
      try {
        const text = (await file.text()).trim();
        if (!text) continue;
        let loaded: TankBlueprint | null = null;
        if (looksLikePythonSource(text)) {
          const parsed = parsePythonSourceWithAutoSize(
            text,
            baseEnemy.program.gridSize,
            baseEnemy.program.coordinateMode
          );
          if (parsed.ok) {
            loaded = {
              ...baseEnemy,
              id: `enemy_file_${Date.now()}_${nextList.length}`,
              name: parsed.tankName ?? file.name.replace(/\.[^.]+$/, '').slice(0, 32),
              assembly: {
                ...baseEnemy.assembly,
                cpu: cpuIdForGridSize(parsed.program.gridSize),
                chassis: parsed.chassisId ?? baseEnemy.assembly.chassis,
                radar: parsed.radarId ?? baseEnemy.assembly.radar,
                mainGun: parsed.mainGunId ?? baseEnemy.assembly.mainGun,
                subWeapon: parsed.subWeaponId ?? baseEnemy.assembly.subWeapon,
              },
              program: parsed.program,
            };
          }
        } else {
          loaded = text.startsWith('{')
            ? validateAndNormalizeBlueprint(JSON.parse(text))
            : decodeShareCode(text);
        }
        if (loaded) {
          nextList.push(loaded);
        }
      } catch {
        // skip invalid file
      }
    }
    if (nextList.length !== freeEnemies.length) {
      const capped = nextList.slice(0, maxSlots);
      setGameMode('free');
      setFreeEnemies(capped);
      setIsPlaying(false);
      setBattleState(buildFreeBattle({ enemies: capped }));
    }
  };

  const handleChangeObstacleSettings = (nextMode: ObstacleMode, nextSeed: number) => {
    setObstacleMode(nextMode);
    setMapSeed(nextSeed);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ obsMode: nextMode, seed: nextSeed }));
  };

  const handleChangeFreeArenaSize = (nextSize: ArenaSizeId) => {
    setFreeArenaSize(nextSize);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ arenaSize: nextSize }));
  };

  const handleChangeFreeTeamBattle = (nextTeamBattle: boolean) => {
    setFreeTeamBattle(nextTeamBattle);
    setIsPlaying(false);
    setBattleState(buildFreeBattle({ teamBattle: nextTeamBattle }));
  };

  const updatePlayerBlueprint = (nextBp: TankBlueprint, resetMatch: boolean) => {
    if (gameMode === 'learning') {
      clearVariantTimer();
      shouldAutoAdvanceVariantRef.current = false;
      setPassedLearningVariants([]);
      setLearningVariantIndex(0);
      setLearningPlayerBp(nextBp);
    } else if (gameMode === 'tutorial') {
      setTutorialPlayerBp(nextBp);
    } else {
      setFreePlayerBp(nextBp);
    }
    if (resetMatch || battleState.tick > 0 || battleState.status === 'finished') {
      resetBattleWith(nextBp, currentEnemyList);
    } else {
      // Live update chip program & hardware inside battle state
      const nextChassis = CHASSIS_SPECS[nextBp.assembly.chassis];
      const nextSub = SUB_WEAPON_SPECS[nextBp.assembly.subWeapon];
      setBattleState((prev) => ({
        ...prev,
        tanks: prev.tanks.map((t) => {
          if (t.team !== 'player') return t;
          return {
            ...t,
            maxHp: nextChassis.maxHp,
            hp: prev.tick === 0 ? nextChassis.maxHp : Math.min(t.hp, nextChassis.maxHp),
            subAmmo: prev.tick === 0 ? nextSub.maxAmmo : Math.min(t.subAmmo, nextSub.maxAmmo),
            moveState: null,
            sleepState: null,
            turnState: null,
            fireState: null,
            halted: false,
            tileEdgeState: {},
            lastAimAngle: null,
            lastAimTick: -999,
            loopStack: [],
            blueprint: { ...cloneBlueprint(nextBp), color: getAutoTankColor(0) },
          };
        }),
      }));
    }
  };

  const handleChangeProgram = (
    nextProgram: ChipProgram,
    nextTankName?: string,
    nextRadarId?: RadarId,
    nextChassisId?: ChassisId,
    nextMainGunId?: MainGunId,
    nextSubWeaponId?: SubWeaponId
  ) => {
    const nextCpu = cpuIdForGridSize(nextProgram.gridSize);
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      name: nextTankName !== undefined ? nextTankName.slice(0, 32) : currentPlayerBp.name,
      assembly: {
        ...currentPlayerBp.assembly,
        cpu: nextCpu,
        chassis: nextChassisId ?? currentPlayerBp.assembly.chassis,
        radar: nextRadarId ?? currentPlayerBp.assembly.radar,
        mainGun: nextMainGunId ?? currentPlayerBp.assembly.mainGun,
        subWeapon: nextSubWeaponId ?? currentPlayerBp.assembly.subWeapon,
      },
      program: nextProgram,
    };
    updatePlayerBlueprint(updated, false);
  };

  const handleChangePlayerName = (nextName: string) => {
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      name: nextName.slice(0, 32),
    };
    updatePlayerBlueprint(updated, false);
  };

  const handleChangePlayerChassis = (nextChassis: ChassisId) => {
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      assembly: {
        ...currentPlayerBp.assembly,
        chassis: nextChassis,
      },
    };
    updatePlayerBlueprint(validateAndRepairBlueprint(updated).blueprint, false);
  };

  const handleChangePlayerRadar = (nextRadar: RadarId) => {
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      assembly: {
        ...currentPlayerBp.assembly,
        radar: nextRadar,
      },
    };
    updatePlayerBlueprint(updated, false);
  };

  const handleChangePlayerMainGun = (nextMainGun: MainGunId) => {
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      assembly: {
        ...currentPlayerBp.assembly,
        mainGun: nextMainGun,
      },
    };
    updatePlayerBlueprint(updated, false);
  };

  const handleChangePlayerSubWeapon = (nextSubWeapon: SubWeaponId) => {
    const updated: TankBlueprint = {
      ...currentPlayerBp,
      assembly: {
        ...currentPlayerBp.assembly,
        subWeapon: nextSubWeapon,
      },
    };
    updatePlayerBlueprint(updated, false);
  };

  const handleStartResizeSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      if (!workspaceRef.current) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const nextPct = Math.max(30, Math.min(72, Math.round(pct)));
      setSplitRatio(nextPct);
      setLayoutPreset(nextPct >= 60 ? 'code' : 'balanced');
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Simulation loop at BASE_TPS (20 TPS) scaled by speedMultiplier
  const accumulatorRef = useRef(0);
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastTime = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      accumulatorRef.current += (dt / 1000) * BASE_TPS * speedMultiplier;

      const steps = Math.min(8, Math.floor(accumulatorRef.current));
      if (steps > 0) {
        accumulatorRef.current -= steps;
        setBattleState((prev) => {
          if (prev.status === 'finished') return prev;
          const next = cloneBattleStateForStep(prev);
          for (let i = 0; i < steps; i++) {
            stepBattleTick(next);
            if (next.status === 'finished') break;
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, speedMultiplier]);

  // Stop playback & record mission / tutorial clear when finished
  useEffect(() => {
    if (battleState.status === 'finished') {
      setIsPlaying(false);
      if (
        gameMode === 'learning' &&
        battleState.winnerId === 'player' &&
        battleState.winType === 'mission'
      ) {
        const variants = activeLearningMission.variants;
        if (!variants || variants.length <= 1) {
          const updated = markLearningCleared(activeLearningMission.id);
          setClearedLearnings(updated);
        } else {
          const nextPassed = Array.from(new Set([...passedLearningVariants, learningVariantIndex]));
          setPassedLearningVariants(nextPassed);
          if (nextPassed.length >= variants.length) {
            const updated = markLearningCleared(activeLearningMission.id);
            setClearedLearnings(updated);
            shouldAutoAdvanceVariantRef.current = false;
          } else if (shouldAutoAdvanceVariantRef.current) {
            const nextVarIdx = variants.findIndex((_, i) => !nextPassed.includes(i));
            if (nextVarIdx >= 0) {
              clearVariantTimer();
              variantTimerRef.current = window.setTimeout(() => {
                variantTimerRef.current = null;
                setLearningVariantIndex(nextVarIdx);
                setBattleState(
                  buildMissionBattle(activeLearningMission, learningPlayerBp, nextVarIdx)
                );
                setIsPlaying(true);
              }, 900);
            }
          }
        }
      } else if (
        gameMode === 'tutorial' &&
        battleState.winnerId === 'player' &&
        battleState.winType === 'elimination'
      ) {
        const updated = markTutorialCleared(activeStage.id);
        setClearedTutorials(updated);
      }
    }
  }, [
    battleState.status,
    battleState.winnerId,
    battleState.winType,
    gameMode,
    activeLearningMission,
    learningVariantIndex,
    passedLearningVariants,
    learningPlayerBp,
    buildMissionBattle,
    clearVariantTimer,
    activeStage.id,
  ]);

  useEffect(() => () => clearVariantTimer(), [clearVariantTimer]);

  const handleTogglePlay = () => {
    clearVariantTimer();
    if (battleState.status === 'finished') {
      if (
        gameMode === 'learning' &&
        activeLearningMission.variants &&
        activeLearningMission.variants.length > 1 &&
        passedLearningVariants.length >= activeLearningMission.variants.length
      ) {
        setPassedLearningVariants([]);
        setLearningVariantIndex(0);
        shouldAutoAdvanceVariantRef.current = true;
        setBattleState(buildMissionBattle(activeLearningMission, learningPlayerBp, 0));
        setIsPlaying(true);
        return;
      }
      shouldAutoAdvanceVariantRef.current = true;
      const fresh = buildInitialBattle(currentPlayerBp, currentEnemyList);
      setBattleState(fresh);
      setIsPlaying(true);
    } else {
      setIsPlaying((p) => {
        const nextPlay = !p;
        shouldAutoAdvanceVariantRef.current = nextPlay;
        return nextPlay;
      });
    }
  };

  const handleStepOnce = () => {
    clearVariantTimer();
    shouldAutoAdvanceVariantRef.current = false;
    setIsPlaying(false);
    setBattleState((prev) => {
      if (prev.status === 'finished') return prev;
      return stepBattleTick(cloneBattleStateForStep(prev));
    });
  };

  const playerTank = battleState.tanks.find((t) => t.team === 'player');
  const enemyTank = battleState.tanks.find((t) => t.team === 'enemy');

  return (
    <div className={`app-shell ui-scale-${uiFontScale} ${isMobileLayout ? 'mobile-layout' : ''}`}>
      {/* Top Navigation */}
      <header className="top-nav">
        <div className="brand">
          <div className="brand-logo">CP</div>
          <div>
            <h1>CodePanzer.py</h1>
            <span className="brand-sub">Code Your Tank, Command the Arena.</span>
          </div>
        </div>

        {!isMobileLayout && (
          <div className="mode-switcher">
            <button
              type="button"
              className={`nav-tab ${gameMode === 'learning' ? 'active' : ''}`}
              onClick={() => handleSelectLearning(learningIndex)}
            >
              <GraduationCap size={15} /> 課題学習
            </button>
            <button
              type="button"
              className={`nav-tab ${gameMode === 'tutorial' ? 'active' : ''}`}
              onClick={() => handleSelectTutorial(tutorialIndex)}
            >
              <BookOpen size={15} /> 開発訓練
            </button>
            <button
              type="button"
              className={`nav-tab ${gameMode === 'free' ? 'active' : ''}`}
              onClick={handleSwitchToFree}
            >
              <Swords size={15} /> 機体開発
            </button>
            <button
              type="button"
              className="nav-tab"
              onClick={() => {}}
            >
              （未定）
            </button>
          </div>
        )}

        <div className="nav-actions">
          {!isMobileLayout && (
            <div className="layout-presets" title="全体の文字サイズを切り替え">
              <span className="nav-scale-label">文字</span>
              {(
                [
                  { id: 'normal', label: '標準' },
                  { id: 'large', label: '大' },
                  { id: 'xlarge', label: '特大' },
                ] as Array<{ id: UiFontScale; label: string }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`mini-btn ${uiFontScale === opt.id ? 'active' : ''}`}
                  onClick={() => handleChangeUiFontScale(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <div className="layout-presets" title="画面レイアウト切替">
            {(
              [
                { id: 'mobile', label: 'スマホ' },
                { id: 'code', label: 'コード' },
                { id: 'balanced', label: '標準' },
                // { id: 'battle', label: 'バトル' },
              ] as Array<{ id: LayoutPreset; label: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`mini-btn ${layoutPreset === opt.id ? 'active' : ''}`}
                onClick={() => handleSelectLayoutPreset(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowShareModal(true)}
          >
            <Share2 size={15} /> 共有・読込
          </button>
        </div>
      </header>

      {isMobileLayout && (
        <div className="mobile-sticky-bar">
          <div className="mobile-sticky-playback">
            <button type="button" className="btn-play mobile-play-btn" onClick={handleTogglePlay}>
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              {isPlaying ? '停止' : battleState.status === 'finished' ? '再戦' : '開始'}
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={handleStepOnce}
              disabled={battleState.status === 'finished'}
              title="1 Tick (1/20秒) 進む"
            >
              1Tick
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => resetBattleWith(currentPlayerBp, currentEnemyList)}
              title="リセット"
            >
              <RotateCcw size={12} />
            </button>
          </div>

          <div className="mobile-sticky-jumps">
            <button
              type="button"
              className="mini-btn"
              onClick={() => scrollToMobileSection('mobile-board-section')}
            >
              盤面
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => scrollToMobileSection('mobile-inspector-section')}
            >
              編集
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => scrollToMobileSection('mobile-code-section', 'palette')}
            >
              パレット
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => scrollToMobileSection('mobile-code-section', 'code')}
            >
              Python
            </button>
            <button
              type="button"
              className="mini-btn active"
              onClick={() => scrollToMobileSection('mobile-battle-section')}
            >
              バトル
            </button>
          </div>
        </div>
      )}

      {/* Main Split Workspace */}
      <main
        ref={workspaceRef}
        className="workspace"
        style={
          isMobileLayout
            ? undefined
            : {
                gridTemplateColumns: `minmax(360px, ${splitRatio}%) 6px minmax(340px, 1fr)`,
              }
        }
      >
        {/* Left Pane: Mission Info (if learning/tutorial) + 2D Chip Grid Editor */}
        <section className="pane-left">
          {!isMobileLayout && (gameMode === 'learning' || gameMode === 'tutorial') && (() => {
            const isLearning = gameMode === 'learning';
            const badgeText = isLearning
              ? `LESSON ${activeLearningMission.lessonNumber} · ${activeLearningMission.missionCode}`
              : `STAGE ${activeStage.number}`;
            const titleText = isLearning ? activeLearningMission.title : activeStage.title;
            const subText = isLearning ? activeLearningMission.subtitle : activeStage.subtitle;
            const descText = isLearning
              ? activeLearningMission.description
              : activeStage.description;
            const goalText = isLearning
              ? activeLearningMission.goalDescription
              : activeStage.goalDescription;
            const hintList = isLearning ? activeLearningMission.hints : activeStage.hints;
            return (
              <div className="tutorial-banner">
                <div className="tut-head">
                  <div className="tut-title-block">
                    <div className="tut-title-row">
                      <span className="tut-badge">{badgeText}</span>
                      <strong>{titleText}</strong>
                    </div>
                    <div className="tut-sub">{subText}</div>
                  </div>
                  <div className="tut-btns">
                    <button
                      type="button"
                      className={`mini-btn ${showHints ? 'active' : ''}`}
                      onClick={() => setShowHints((v) => !v)}
                    >
                      <HelpCircle size={12} /> ヒント
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={handleLoadStarterSolution}
                      title="このミッションの模範解答プログラムを入力します"
                    >
                      模範解答
                    </button>
                  </div>
                </div>
                <p className="tut-desc">{descText}</p>
                {showHints && (
                  <ul className="tut-hints">
                    <li>
                      <strong>目標:</strong> {goalText}
                    </li>
                    {hintList.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}

          <GridEditor
            program={currentPlayerBp.program}
            cpuId={currentPlayerBp.assembly.cpu}
            chassisId={currentPlayerBp.assembly.chassis}
            radarId={currentPlayerBp.assembly.radar}
            mainGunId={currentPlayerBp.assembly.mainGun}
            subWeaponId={currentPlayerBp.assembly.subWeapon}
            tankName={currentPlayerBp.name}
            trace={playerTank?.trace}
            isPlaying={isPlaying}
            allowLearningChips={!isMobileLayout && gameMode === 'learning'}
            allowedChips={
              !isMobileLayout
                ? gameMode === 'learning'
                  ? activeLearningMission.allowedChips
                  : gameMode === 'tutorial'
                    ? activeStage.allowedChips
                    : undefined
                : undefined
            }
            mobileMode={isMobileLayout}
            requestedSidebarTab={requestedSidebarTab}
            onChangeProgram={handleChangeProgram}
            onChangeTankName={handleChangePlayerName}
            onChangeChassis={handleChangePlayerChassis}
            onChangeRadar={handleChangePlayerRadar}
            onChangeMainGun={handleChangePlayerMainGun}
            onChangeSubWeapon={handleChangePlayerSubWeapon}
            onImportBlueprint={(bp) => updatePlayerBlueprint(cloneBlueprint(bp), true)}
          />
        </section>

        {!isMobileLayout && (
          <div
            className="pane-resizer"
            onPointerDown={handleStartResizeSplit}
            title="左右にドラッグして画面比率を調整"
          />
        )}

        {/* Right Pane: 3D Battle Viewport & Telemetry */}
        <section id="mobile-battle-section" className="pane-right">
          {!isMobileLayout && gameMode === 'learning' && (
            <div className="battle-top-controls tutorial-top-controls">
              <button
                type="button"
                className="mini-btn"
                disabled={learningIndex <= 0}
                onClick={() => handleSelectLearning(learningIndex - 1)}
                title="前のミッションへ"
              >
                <ChevronLeft size={13} /> 前へ
              </button>

              <label className="battle-ctrl-item tutorial-select-wrap">
                <select
                  aria-label="学習ミッション選択"
                  value={learningIndex}
                  onChange={(e) => handleSelectLearning(Number(e.target.value))}
                >
                  {([1, 2, 3, 4] as const)
                    .filter((lesson) =>
                      LEARNING_MISSIONS.some((m) => m.lessonNumber === lesson)
                    )
                    .map((lesson) => (
                      <optgroup key={lesson} label={LESSON_TITLES[lesson]}>
                        {LEARNING_MISSIONS.map((m, idx) => {
                          if (m.lessonNumber !== lesson) return null;
                          const cleared = clearedLearnings.includes(m.id);
                          const cleanTitle = m.title.replace(/\s*\(\d+×\d+\)$/, '');
                          return (
                            <option key={m.id} value={idx}>
                              {cleared ? '✓ ' : ''}
                              {m.missionCode} ({m.playerStarter.program.gridSize}×
                              {m.playerStarter.program.gridSize}): {cleanTitle}
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                </select>
              </label>

              <button
                type="button"
                className="mini-btn"
                disabled={learningIndex >= LEARNING_MISSIONS.length - 1}
                onClick={() => handleSelectLearning(learningIndex + 1)}
                title="次のミッションへ"
              >
                次へ <ChevronRight size={13} />
              </button>

              <span className="arena-size-badge" title={LESSON_TITLES[activeLearningMission.lessonNumber]}>
                広さ: {ARENA_SIZE_SPECS[activeLearningMission.arenaSize].label}
              </span>

              <span className="tutorial-progress-badge">
                達成: {LEARNING_MISSIONS.filter((m) => clearedLearnings.includes(m.id)).length} /{' '}
                {LEARNING_MISSIONS.length}
              </span>

              {activeLearningMission.variants && activeLearningMission.variants.length > 1 && (
                <div className="variant-pill-group">
                  {activeLearningMission.variants.map((v, vIdx) => {
                    const isPassed = passedLearningVariants.includes(vIdx);
                    const isCur = learningVariantIndex === vIdx;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`mini-btn ${isCur ? 'active' : ''}`}
                        onClick={() => handleSelectLearningVariant(vIdx)}
                        title={`${v.label} を表示・確認`}
                      >
                        {isPassed ? '✓ ' : ''}
                        {v.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {!isMobileLayout && gameMode === 'tutorial' && (
            <div className="battle-top-controls tutorial-top-controls">
              <button
                type="button"
                className="mini-btn"
                disabled={tutorialIndex <= 0}
                onClick={() => handleSelectTutorial(tutorialIndex - 1)}
                title="前のステージへ"
              >
                <ChevronLeft size={13} /> 前へ
              </button>

              <label className="battle-ctrl-item tutorial-select-wrap">
                <select
                  aria-label="ステージ選択"
                  value={tutorialIndex}
                  onChange={(e) => handleSelectTutorial(Number(e.target.value))}
                >
                  {([1, 2, 3, 4] as const)
                    .filter((sec) =>
                      TUTORIAL_STAGES.some((st) => (st.section ?? 1) === sec)
                    )
                    .map((sec) => (
                      <optgroup key={sec} label={TUTORIAL_SECTION_TITLES[sec]}>
                        {TUTORIAL_STAGES.map((st, idx) => {
                          if ((st.section ?? 1) !== sec) return null;
                          const cleared = clearedTutorials.includes(st.id);
                          const cleanTitle = st.title.replace(/\s*\(\d+×\d+\)$/, '');
                          return (
                            <option key={st.id} value={idx}>
                              {cleared ? '✓ ' : ''}St.{st.number} ({st.playerStarter.program.gridSize}×
                              {st.playerStarter.program.gridSize}): {cleanTitle}
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                </select>
              </label>

              <button
                type="button"
                className="mini-btn"
                disabled={tutorialIndex >= TUTORIAL_STAGES.length - 1}
                onClick={() => handleSelectTutorial(tutorialIndex + 1)}
                title="次のステージへ"
              >
                次へ <ChevronRight size={13} />
              </button>

              <span
                className="arena-size-badge"
                title="このステージに最適な戦場サイズ"
              >
                広さ: {ARENA_SIZE_SPECS[activeStage.arenaSize ?? 'large'].label}
              </span>

              <span className="tutorial-progress-badge">
                達成: {TUTORIAL_STAGES.filter((s) => clearedTutorials.includes(s.id)).length} /{' '}
                {TUTORIAL_STAGES.length}
              </span>

              {currentEnemyList.length > 1 && (
                <span className="team-battle-badge">
                  ⚔ 1 vs {currentEnemyList.length} 敵チーム戦
                </span>
              )}
            </div>
          )}

          {(isMobileLayout || gameMode === 'free') && (
            <div className="battle-top-controls">
              <label className="battle-ctrl-item battle-enemy-primary">
                <span>対戦相手1:</span>
                <select
                  value={
                    PRESET_ENEMIES.some((e) => e.id === freeEnemyBp.id)
                      ? freeEnemyBp.id
                      : '__custom__'
                  }
                  onChange={(e) => {
                    const found = PRESET_ENEMIES.find((p) => p.id === e.target.value);
                    if (found) handleSelectFreeEnemy(found, 0);
                  }}
                >
                  {PRESET_ENEMIES.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.program.gridSize}×{e.program.gridSize})
                    </option>
                  ))}
                  {!PRESET_ENEMIES.some((e) => e.id === freeEnemyBp.id) && (
                    <option value="__custom__">読込機体: {freeEnemyBp.name}</option>
                  )}
                </select>
              </label>

              <button
                type="button"
                className="mini-btn"
                title="選択中の対戦相手1のプログラムを自機エディタに読み込んで中身を確認・改造します"
                onClick={() => updatePlayerBlueprint(cloneBlueprint(freeEnemyBp), true)}
              >
                <Download size={12} /> 自機に読込
              </button>

              {isMobileLayout && (
                <button
                  type="button"
                  className={`mini-btn ${mobileBattleDetailsOpen ? 'active' : ''}`}
                  onClick={() => setMobileBattleDetailsOpen((v) => !v)}
                >
                  詳細({1 + freeEnemies.length}台·{ARENA_SIZE_SPECS[freeArenaSize].label})
                  {mobileBattleDetailsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              )}

              {(!isMobileLayout || mobileBattleDetailsOpen) && (
                <>
                  <label
                    className="battle-ctrl-item"
                    title={`対戦相手を追加（自機を含め最大${maxBattleTanks}台まで・自動色覚対応カラー割当）`}
                  >
                    <span>参加 {1 + freeEnemies.length}/{maxBattleTanks}台:</span>
                    <select
                      value=""
                      disabled={freeEnemies.length >= maxEnemySlots}
                      onChange={(e) => {
                        const found = PRESET_ENEMIES.find((p) => p.id === e.target.value);
                        if (found) handleAddFreeEnemy(found);
                      }}
                    >
                      <option value="">
                        {freeEnemies.length >= maxEnemySlots
                          ? `上限 (${maxBattleTanks}台)`
                          : '+ 相手を追加...'}
                      </option>
                      {PRESET_ENEMIES.map((e) => (
                        <option key={e.id} value={e.id}>
                          + {e.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="mini-btn"
                    disabled={freeEnemies.length >= maxEnemySlots}
                    onClick={() => enemyFileInputRef.current?.click()}
                    title={`複数ファイル(.vstank.json / .py)から対戦相手を追加（最大${maxBattleTanks}台まで）`}
                  >
                    <Upload size={12} /> 相手読込
                  </button>
                  <input
                    ref={enemyFileInputRef}
                    type="file"
                    multiple
                    accept=".json,.vstank.json,.py,.txt"
                    hidden
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleLoadMultiEnemyFiles(e.target.files);
                      }
                      e.target.value = '';
                    }}
                  />

                  <label className="battle-ctrl-item">
                    <span>広さ:</span>
                    <select
                      value={freeArenaSize}
                      onChange={(e) => handleChangeFreeArenaSize(e.target.value as ArenaSizeId)}
                    >
                      {(Object.keys(ARENA_SIZE_SPECS) as ArenaSizeId[]).map((sizeKey) => (
                        <option key={sizeKey} value={sizeKey}>
                          {ARENA_SIZE_SPECS[sizeKey].label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="battle-ctrl-item">
                    <span>遮蔽物:</span>
                    <select
                      value={obstacleMode}
                      onChange={(e) =>
                        handleChangeObstacleSettings(e.target.value as ObstacleMode, mapSeed)
                      }
                    >
                      <option value="none">遮蔽物なし</option>
                      <option value="few">少なめ</option>
                      <option value="many">多め</option>
                      <option value="maze">迷路</option>
                    </select>
                  </label>

                  <div className="battle-ctrl-item">
                    <span>Seed:</span>
                    <input
                      type="number"
                      className="seed-input"
                      value={mapSeed}
                      title="マップ生成シード (-1 で標準配置)"
                      onChange={(e) => {
                        const parsed = Number.parseInt(e.target.value, 10);
                        handleChangeObstacleSettings(
                          obstacleMode,
                          Number.isFinite(parsed) ? parsed : -1
                        );
                      }}
                    />
                    <button
                      type="button"
                      className="mini-btn"
                      title="ランダムシードを生成"
                      onClick={() =>
                        handleChangeObstacleSettings(
                          obstacleMode,
                          Math.floor(Math.random() * 99999) + 1
                        )
                      }
                    >
                      🎲
                    </button>
                    {mapSeed !== -1 && (
                      <button
                        type="button"
                        className="mini-btn"
                        title="標準シード (-1) に戻す"
                        onClick={() => handleChangeObstacleSettings(obstacleMode, -1)}
                      >
                        -1
                      </button>
                    )}
                  </div>

                  {freeEnemies.length > 1 && (
                    <label className="battle-ctrl-item" title="複数機参加時の対戦ルールを選択">
                      <span>ルール:</span>
                      <select
                        value={freeTeamBattle ? 'team' : 'ffa'}
                        onChange={(e) => handleChangeFreeTeamBattle(e.target.value === 'team')}
                      >
                        <option value="ffa">バトルロイヤル (乱戦)</option>
                        <option value="team">1 vs 敵チーム ({freeEnemies.length}台協力)</option>
                      </select>
                    </label>
                  )}

                  {freeEnemies.length > 1 && (
                    <div className="opponent-chip-bar">
                      <span className="opponent-chip">
                        <span
                          className="color-dot"
                          style={{ backgroundColor: getAutoTankColor(0) }}
                        />
                        <strong>{currentPlayerBp.name}</strong>
                      </span>
                      {freeEnemies.map((ep, idx) => (
                        <span key={`${ep.id}_${idx}`} className="opponent-chip">
                          <span
                            className="color-dot"
                            style={{ backgroundColor: getAutoTankColor(idx + 1) }}
                          />
                          <span>{ep.name}</span>
                          <button
                            type="button"
                            className="chip-remove-btn"
                            title="この相手を外す"
                            onClick={() => handleRemoveFreeEnemy(idx)}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Combatant Telemetry HUD */}
          {battleState.tanks.length <= 2 ? (
            <div className="battle-hud">
              <div className="hud-tank hud-player">
                <div className="hud-name-row">
                  <span
                    className="color-dot"
                    style={{
                      backgroundColor: playerTank?.blueprint.color ?? getAutoTankColor(0),
                    }}
                  />
                  <strong>{currentPlayerBp.name}</strong>
                  <span className="hp-num">
                    {playerTank ? `${Math.ceil(playerTank.hp)} / ${playerTank.maxHp}` : '0'}
                  </span>
                </div>
                <div className="hp-track">
                  <div
                    className="hp-fill player-hp"
                    style={{
                      width: playerTank
                        ? `${Math.max(0, (playerTank.hp / playerTank.maxHp) * 100)}%`
                        : '0%',
                      background: playerTank?.blueprint.color ?? getAutoTankColor(0),
                    }}
                  />
                </div>
                <div className="hud-substats">
                  <span>main_cd: {playerTank ? playerTank.gunHeat.toFixed(2) : '0.00'}</span>
                  <span>sp_cd: {playerTank ? playerTank.subCooldown : 0}t</span>
                  <span>
                    CNT A:{playerTank?.counters.A ?? 0} B:{playerTank?.counters.B ?? 0}
                  </span>
                  <span>M:{playerTank?.mode ?? 0}</span>
                </div>
              </div>

              <div className="hud-clock">
                <div className="clock-time">
                  {((battleState.arena.maxTicks - battleState.tick) / BASE_TPS).toFixed(1)}s
                </div>
                <div className="clock-tick">Tick {battleState.tick}</div>
              </div>

              {gameMode === 'learning' && !enemyTank ? (
                <div className="hud-tank hud-enemy">
                  <div className="hud-name-row">
                    <span className="hp-num">
                      {playerTank?.halted
                        ? 'stop() 停止'
                        : playerTank?.turnState
                          ? '旋回待機中'
                          : playerTank?.fireState
                            ? '冷却待機中'
                            : playerTank?.moveState
                              ? '移動中'
                              : '実行中'}
                    </span>
                    <strong>ミッション {activeLearningMission.missionCode}</strong>
                  </div>
                  <div className="hud-substats">
                    {(battleState.arena.targets?.length ?? 0) > 0 && (
                      <span>
                        🎈 風船:{' '}
                        {(battleState.arena.targets ?? []).filter((t) => t.popped).length}/
                        {battleState.arena.targets!.length}
                      </span>
                    )}
                    {(battleState.arena.tiles ?? []).some((t) => t.kind === 'checkpoint') && (
                      <span>
                        🚩 CP:{' '}
                        {
                          (battleState.arena.tiles ?? []).filter(
                            (t) => t.kind === 'checkpoint' && t.visited
                          ).length
                        }
                        /
                        {(battleState.arena.tiles ?? []).filter((t) => t.kind === 'checkpoint').length}
                      </span>
                    )}
                    {activeLearningMission.goalRule.reachGoalTile && (
                      <span>
                        🏁 ゴール:{' '}
                        {(battleState.arena.tiles ?? []).some(
                          (t) =>
                            t.kind === 'goal' &&
                            playerTank &&
                            playerTank.x >= t.x &&
                            playerTank.x <= t.x + t.width &&
                            playerTank.y >= t.y &&
                            playerTank.y <= t.y + t.height
                        )
                          ? '到達'
                          : '未到達'}
                      </span>
                    )}
                    <span>
                      🧱 壁接触: {playerTank?.stats.wallHits ?? 0}
                      {activeLearningMission.goalRule.maxWallHits !== undefined
                        ? `/${activeLearningMission.goalRule.maxWallHits}`
                        : ''}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="hud-tank hud-enemy">
                  <div className="hud-name-row">
                    <span className="hp-num">
                      {enemyTank ? `${Math.ceil(enemyTank.hp)} / ${enemyTank.maxHp}` : '0'}
                    </span>
                    <strong>{currentEnemyBp.name}</strong>
                    <span
                      className="color-dot"
                      style={{
                        backgroundColor: enemyTank?.blueprint.color ?? getAutoTankColor(1),
                      }}
                    />
                  </div>
                  <div className="hp-track">
                    <div
                      className="hp-fill enemy-hp"
                      style={{
                        width: enemyTank
                          ? `${Math.max(0, (enemyTank.hp / enemyTank.maxHp) * 100)}%`
                          : '0%',
                        background: enemyTank?.blueprint.color ?? getAutoTankColor(1),
                      }}
                    />
                  </div>
                  <div className="hud-substats">
                    <span>{enemyTank?.radarLock ? '⚠ ロック中' : '索敵中'}</span>
                    <span>main_cd: {enemyTank ? enemyTank.gunHeat.toFixed(2) : '0.00'}</span>
                    <span>sp_cd: {enemyTank ? enemyTank.subCooldown : 0}t</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="battle-hud-multi">
              <div className="hud-clock hud-clock-compact">
                <div className="clock-time">
                  {((battleState.arena.maxTicks - battleState.tick) / BASE_TPS).toFixed(1)}s
                </div>
                <div className="clock-tick">
                  T{battleState.tick} · 生存 {battleState.tanks.filter((t) => t.hp > 0).length}/
                  {battleState.tanks.length}
                </div>
              </div>
              <div className="hud-multi-grid">
                {battleState.tanks.map((t) => (
                  <div
                    key={t.id}
                    className={`hud-mini-card ${t.hp <= 0 ? 'ko' : ''} ${
                      t.team === 'player' ? 'is-player' : ''
                    }`}
                  >
                    <div className="hud-mini-top">
                      <span
                        className="color-dot"
                        style={{ backgroundColor: t.blueprint.color }}
                      />
                      <span className="hud-mini-name">{t.blueprint.name}</span>
                      <span className="hud-mini-hp">
                        {t.hp > 0 ? Math.ceil(t.hp) : 'KO'}
                      </span>
                    </div>
                    <div className="hp-track hp-track-sm">
                      <div
                        className="hp-fill"
                        style={{
                          width: `${Math.max(0, (t.hp / t.maxHp) * 100)}%`,
                          background: t.blueprint.color,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3D Canvas Container */}
          <div className="viewport-frame">
            <BattleCanvas3D
              battleState={battleState}
              cameraMode={cameraMode}
              showDebugOverlay={showDebugOverlay}
              zoomLevel={battleZoom}
              onChangeZoom={setBattleZoom}
            />

            {/* Floating Camera & Debug Toolbar */}
            <div className="viewport-overlay-top">
              <div className="cam-switcher">
                <Camera size={13} />
                {(
                  [
                    { id: 'tactical', label: '俯瞰' },
                    { id: 'chase_p1', label: '自機追従' },
                    { id: 'chase_p2', label: '相手追従' },
                    { id: 'orbit', label: 'フリー視点' },
                  ] as Array<{ id: CameraMode; label: string }>
                )
                  .filter((cam) => cam.id !== 'chase_p2' || Boolean(enemyTank))
                  .map((cam) => (
                  <button
                    key={cam.id}
                    type="button"
                    className={`cam-btn ${cameraMode === cam.id ? 'active' : ''}`}
                    onClick={() => setCameraMode(cam.id)}
                  >
                    {cam.label}
                  </button>
                ))}
              </div>

              <div className="viewport-right-controls">
                {cameraMode === 'tactical' && (
                  <div className="zoom-controls" title="バトルマップの表示倍率">
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() =>
                        setBattleZoom((z) => Math.max(0.55, Number((z - 0.15).toFixed(2))))
                      }
                      title="縮小"
                    >
                      <ZoomOut size={13} />
                    </button>
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() => setBattleZoom(1.0)}
                      title="全体表示に戻す"
                    >
                      {Math.round(battleZoom * 100)}%
                    </button>
                    <button
                      type="button"
                      className="cam-btn"
                      onClick={() =>
                        setBattleZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))
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
                {isMobileLayout
                  ? '指ドラッグで視点回転 / 2本指ピンチで拡大縮小'
                  : 'マウスドラッグで視点回転 / ホイールでズーム'}
              </div>
            )}

            {/* Match Result Overlay */}
            {battleState.status === 'finished' && (() => {
              const isLearning = gameMode === 'learning';
              const variants = activeLearningMission.variants;
              const hasVariants = isLearning && Boolean(variants && variants.length > 1);
              const nextUnpassedVarIdx = hasVariants
                ? variants!.findIndex((_, i) => !passedLearningVariants.includes(i))
                : -1;
              const isAllVariantsCleared = !hasVariants || nextUnpassedVarIdx < 0;
              const isPlayerWin = battleState.winnerId === 'player';
              const isMissionWin = isLearning && isPlayerWin && battleState.winType === 'mission';
              const isEliminationWin = isPlayerWin && battleState.winType === 'elimination';
              const isTutorialDecisionOnly =
                gameMode === 'tutorial' && isPlayerWin && !isEliminationWin;
              const titleClass =
                (isPlayerWin && !isTutorialDecisionOnly) || isMissionWin
                  ? 'win'
                  : battleState.winnerId === 'draw' && !isLearning
                    ? 'draw'
                    : isTutorialDecisionOnly
                      ? 'draw'
                      : 'lose';
              const titleText = isMissionWin
                ? isAllVariantsCleared
                  ? 'MISSION CLEAR!'
                  : 'PATTERN CLEAR!'
                : isLearning
                  ? 'TRY AGAIN'
                  : isEliminationWin
                    ? 'VICTORY!'
                    : isPlayerWin
                      ? gameMode === 'tutorial'
                        ? 'TIME UP'
                        : 'DECISION WIN!'
                      : battleState.winnerId === 'draw'
                        ? 'DRAW'
                        : 'DEFEAT';
              const resultReasonText =
                isMissionWin && hasVariants
                  ? isAllVariantsCleared
                    ? `全${variants!.length}パターンの検証をクリアしました！`
                    : `${variants![learningVariantIndex].label} 合格！ 続いて別パターンをテストします…`
                  : battleState.endReason;
              return (
                <div className="result-overlay">
                  <div className="result-card">
                    <div className={`result-title ${titleClass}`}>{titleText}</div>
                    <p className="result-reason">
                      {resultReasonText}
                      {isTutorialDecisionOnly
                        ? '（チュートリアル達成には敵機の撃破が必要です）'
                        : ''}
                    </p>

                    {playerTank && (
                      <div className="result-stats">
                        {isLearning ? (
                          <>
                            <div>
                              <span>クリア時間</span>
                              <strong>
                                {(battleState.tick / BASE_TPS).toFixed(1)}s ({battleState.tick}t)
                              </strong>
                            </div>
                            <div>
                              <span>壁・障害物接触</span>
                              <strong>{playerTank.stats.wallHits}回</strong>
                            </div>
                            <div>
                              <span>発射数</span>
                              <strong>{playerTank.stats.shotsFired}</strong>
                            </div>
                          </>
                        ) : (
                          <>
                            <div>
                              <span>発射数</span>
                              <strong>{playerTank.stats.shotsFired}</strong>
                            </div>
                            <div>
                              <span>命中率</span>
                              <strong>
                                {playerTank.stats.shotsFired > 0
                                  ? `${Math.round(
                                      (playerTank.stats.shotsHit / playerTank.stats.shotsFired) *
                                        100
                                    )}%`
                                  : '0%'}
                              </strong>
                            </div>
                            <div>
                              <span>与ダメージ</span>
                              <strong>{playerTank.stats.damageDealt.toFixed(1)}</strong>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    <div className="result-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          if (isLearning && hasVariants && isAllVariantsCleared) {
                            setPassedLearningVariants([]);
                            handleSelectLearningVariant(0, false);
                          } else {
                            resetBattleWith(currentPlayerBp, currentEnemyList);
                          }
                        }}
                      >
                        <RotateCcw size={15} /> {isLearning ? 'もう一度挑戦' : 'もう一度戦う'}
                      </button>
                      {isLearning &&
                        isMissionWin &&
                        !isAllVariantsCleared &&
                        nextUnpassedVarIdx >= 0 && (
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSelectLearningVariant(nextUnpassedVarIdx, true)}
                          >
                            次パターンをテスト ({variants![nextUnpassedVarIdx].label}){' '}
                            <ChevronRight size={15} />
                          </button>
                        )}
                      {isLearning &&
                        isMissionWin &&
                        isAllVariantsCleared &&
                        learningIndex < LEARNING_MISSIONS.length - 1 && (
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSelectLearning(learningIndex + 1)}
                          >
                            次のミッションへ <ChevronRight size={15} />
                          </button>
                        )}
                      {isLearning &&
                        isMissionWin &&
                        isAllVariantsCleared &&
                        learningIndex === LEARNING_MISSIONS.length - 1 && (
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSelectTutorial(0)}
                          >
                            開発訓練へ進む <ChevronRight size={15} />
                          </button>
                        )}
                      {gameMode === 'tutorial' &&
                        isEliminationWin &&
                        tutorialIndex < TUTORIAL_STAGES.length - 1 && (
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleSelectTutorial(tutorialIndex + 1)}
                          >
                            次のステージへ <ChevronRight size={15} />
                          </button>
                        )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Playback Controls Bar */}
          <div className="playback-bar">
            <div className="playback-left">
              <button
                type="button"
                className="btn-play"
                onClick={handleTogglePlay}
              >
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                {isPlaying
                  ? '一時停止'
                  : battleState.status === 'finished'
                    ? gameMode === 'learning'
                      ? '再実行'
                      : '再戦スタート'
                    : gameMode === 'learning'
                      ? '実行スタート'
                      : 'バトル開始'}
              </button>

              <button
                type="button"
                className="btn-secondary"
                onClick={handleStepOnce}
                disabled={battleState.status === 'finished'}
                title="1 Tick (1/20秒) だけ進めてチップ実行を確認"
              >
                <SkipForward size={15} /> 1 Tick進む
              </button>

              <button
                type="button"
                className="btn-secondary"
                onClick={() => resetBattleWith(currentPlayerBp, currentEnemyList)}
                title="バトルを初期状態にリセット"
              >
                <RotateCcw size={15} /> リセット
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
            </div>
          </div>
        </section>
      </main>

      {showShareModal && (
        <ShareModal
          playerBlueprint={currentPlayerBp}
          enemyBlueprint={currentEnemyBp}
          onImportAsPlayer={(bp) => updatePlayerBlueprint(cloneBlueprint(bp), true)}
          onImportAsEnemy={(bp) => {
            setGameMode('free');
            handleSelectFreeEnemy(bp, 0);
          }}
          onAddAsEnemy={handleAddFreeEnemy}
          canAddEnemy={freeEnemies.length < maxEnemySlots}
          maxBattleTanks={maxBattleTanks}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </div>
  );
}

export default App;
