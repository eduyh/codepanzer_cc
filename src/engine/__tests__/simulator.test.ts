import { describe, expect, it, vi } from 'vitest';
import { transpileProgramToLines } from '../../components/GridEditor';
import { CHIP_DEFINITIONS } from '../../data/chips';
import { LEARNING_MISSIONS, resolveMissionVariant } from '../../data/learningMissions';
import { CHASSIS_SPECS, computeShellMetrics, CPU_SPECS, cpuIdForGridSize, MAIN_GUN_SPECS, RADAR_SPECS, SUB_WEAPON_SPECS } from '../../data/parts';
import {
  buildProgram,
  DEFAULT_PLAYER_BLUEPRINT,
  ENEMY_DUMMY,
  ENEMY_PATROL,
  PRESET_ENEMIES,
  TUTORIAL_STAGES,
} from '../../data/presets';
import { ALLOWED_GRID_SIZES, ArenaSizeId, TankBlueprint } from '../../types/game';
import { validateAndRepairBlueprint } from '../../utils/blueprintGatekeeper';
import {
  AUTO_TANK_COLORS,
  compareSemver,
  CURRENT_GAME_VERSION,
  isNewerGameVersion,
  MAX_AUTHOR_NAME_LENGTH,
  MAX_AUTHOR_UUID_LENGTH,
  MAX_TANK_NAME_LENGTH,
  parsePythonSourceToProgram,
  parsePythonSourceWithAutoSize,
  validateGridBlockFit,
} from '../../utils/codeParser';
import {
  applyUserEnvironmentDump,
  buildUnitClearCode,
  buildUserEnvironmentDump,
  CLEAR_CODE_PREFIX,
  computeProgramFingerprint,
  decodeClearCode,
  decodeShareCode,
  decodeUserEnvironmentDump,
  encodeClearCode,
  encodeShareCode,
  encodeUserEnvironmentDump,
  ENV_DUMP_PREFIX,
  generateUuidV4,
  getExpectedDailyUnlockCode,
  isProgramIdenticalToStarter,
  loadClearTelemetry,
  loadLearningAttempts,
  loadLearningClears,
  loadSavedBlueprints,
  loadTutorialClears,
  loadUiFontScaleFromStorage,
  loadUserProfile,
  markLearningCleared,
  markLearningModelAnswerOpened,
  markTutorialCleared,
  recordLearningFailedAttempt,
  recordStageClearTelemetry,
  saveBlueprintToStorage,
  saveUserName,
  STORAGE_KEY_UI_FONT_SCALE,
  validateAndNormalizeBlueprint,
  verifyDailyUnlockCode,
} from '../../utils/share';
import { runTankChipProgram } from '../chipRunner';
import {
  angleToVector,
  calculateLeadAngle,
  circleIntersectsRect,
  normalizeAngle180,
  vectorToAngle,
} from '../math';
import {
  applyLeagueGameResult,
  applyRecommendedMapPreset,
  applyTournamentGameResult,
  applyTournamentMatchResult,
  assignRandomTeams,
  BATTLEFIELD_RECOMMENDED_PRESETS,
  BOUNTY_TUNING,
  buildMatchReport,
  buildParticipantsFromUnitPair,
  clearBattlefieldSession,
  CompetitionUnit,
  computeBattlefieldHudLayout,
  computeLeagueStandings,
  computeRammingDamage,
  createBattlefieldMatchState,
  createLeagueSchedule,
  createRosterEntryFromBlueprint,
  createTournamentBracket,
  DEFAULT_BATTLEFIELD_CONFIG,
  disambiguateRosterPlayerNames,
  formatLeagueStandingsText,
  formatMatchReportText,
  formatMatchReportTsv,
  formatTankListLabel,
  formatTournamentSummaryText,
  generateBattlefieldZones,
  getBountyStreakBuff,
  GRAVITY_PRESET_SPECS,
  isRecommendedMapPresetApplied,
  loadBattlefieldSession,
  pickBountyRespawnPoint,
  pickRandomBattleRoyaleEntries,
  RAMMING_DAMAGE_MULTIPLIER,
  resolveMatchConfigForGame,
  resolveRecommendedTankTier,
  SANDSTORM_PRESET_SPECS,
  saveBattlefieldSession,
  shuffleCompetitionRoster,
  simulateMatchHeadless,
  sortRosterEntries,
  stepBattlefieldTick,
  validateEntryForRegulation,
  validateTeamForRegulation,
} from '../battlefield';
import {
  buildMatchSummaryComment,
  CommentaryStyle,
  createCommentaryTracker,
  createStandbyCommentaryText,
  DEFAULT_COMMENTARY_SETTINGS,
  evaluateCommentaryStep,
} from '../battleCommentary';
import {
  applyDamage,
  ARENA_SIZE_SPECS,
  computeTankBaseContribution,
  createBattleState,
  EIGHT_PLAYER_SPAWNS,
  FOUR_PLAYER_SPAWNS,
  generateArenaObstacles,
  getDirectionalArmorMultiplier,
  getSpawnsForArena,
  RADAR_MEMORY_TICKS,
  stepBattleTick,
} from '../simulator';

describe('Math & Coordinate Conventions', () => {
  it('uses North=0, East=90, South=180, West=270 consistently', () => {
    const north = angleToVector(0);
    expect(north.dx).toBeCloseTo(0);
    expect(north.dy).toBeCloseTo(-1);
    expect(vectorToAngle(0, -1)).toBeCloseTo(0);

    const east = angleToVector(90);
    expect(east.dx).toBeCloseTo(1);
    expect(east.dy).toBeCloseTo(0);
    expect(vectorToAngle(1, 0)).toBeCloseTo(90);

    const south = angleToVector(180);
    expect(south.dx).toBeCloseTo(0);
    expect(south.dy).toBeCloseTo(1);
    expect(vectorToAngle(0, 1)).toBeCloseTo(180);

    const west = angleToVector(270);
    expect(west.dx).toBeCloseTo(-1);
    expect(west.dy).toBeCloseTo(0);
    expect(vectorToAngle(-1, 0)).toBeCloseTo(270);
  });

  it('normalizes signed angles into [-180, 180]', () => {
    expect(normalizeAngle180(270)).toBe(-90);
    expect(normalizeAngle180(-270)).toBe(90);
    expect(normalizeAngle180(370)).toBe(10);
  });

  it('calculates predictive lead angle ahead of moving target', () => {
    // Shooter at (200, 500), target at (500, 500) moving North (0, -4), bullet speed 14
    const lead = calculateLeadAngle(200, 500, 500, 500, 0, -4, 14);
    // Direct angle is 90° (East). Moving North (-Y) should bias lead angle < 90° (NE)
    expect(lead).toBeLessThan(90);
    expect(lead).toBeGreaterThan(60);
  });
});

describe('2D Grid Chip Runner & Coordinate Modes', () => {
  it('follows branches and clamps execution when a loop exceeds CPU step limit', () => {
    const loopTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'compact_6x6' }, // 24 step limit
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'counter_op', params: { reg: 'A', op: 'inc', value: 1 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'wire', next: { x: 1, y: 0 } },
      ]),
    };

    const state = createBattleState({ player: loopTank, enemy: ENEMY_DUMMY });
    const player = state.tanks[0];
    const { trace } = runTankChipProgram(player, 1, state.arena, state.projectiles);

    expect(trace.truncated).toBe(true);
    expect(trace.stepsUsed).toBe(24);
    expect(player.counters.A).toBeGreaterThan(5);
  });

  it('switches behavior cleanly between relative and absolute coordinate modes', () => {
    const absTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      program: buildProgram(6, 'absolute', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        // Target absolute heading 0° (North) while facing East (90°)
        { x: 1, y: 0, type: 'act_turn_body', params: { mode: 'auto', angle: 0 }, next: null },
      ]),
    };
    const state = createBattleState({
      player: absTank,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 400, bodyAngle: 90 },
    });
    const { commands } = runTankChipProgram(state.tanks[0], 1, state.arena, state.projectiles);
    expect(commands.bodyTurnDelta).toBeCloseTo(-90);
  });

  it('executes loop_while (both in-tick var_a_lt and physical enemy_not_detected)', () => {
    // 1. In-tick counter loop: while(A < 4) { A += 1; } then fire(2.0)
    const inTickWhileTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'loop_while',
          params: { cond: 'var_a_lt', value: 4 },
          yes: { x: 1, y: 1 },
          no: { x: 2, y: 0 },
        },
        { x: 1, y: 1, type: 'counter_op', params: { reg: 'A', op: 'inc', value: 1 }, next: null },
        { x: 2, y: 0, type: 'act_fire', params: { power: 'normal' }, next: null },
      ]),
    };

    const state1 = createBattleState({ player: inTickWhileTank, enemy: ENEMY_DUMMY });
    const res1 = runTankChipProgram(state1.tanks[0], 1, state1.arena, state1.projectiles);
    expect(state1.tanks[0].counters.A).toBe(4);
    expect(res1.commands.firePower).toBe(1.8);
    expect(res1.trace.truncated).toBe(false);

    // 2. Physical loop: while(enemy_not_detected) -> radar(15°), else -> fire(1.5)
    const sensorWhileTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'loop_while',
          params: { cond: 'enemy_not_detected', value: 0 },
          yes: { x: 1, y: 1 },
          no: { x: 2, y: 0 },
        },
        { x: 1, y: 1, type: 'act_turn_radar', params: { mode: 'delta', angle: 15 }, next: null },
        { x: 2, y: 0, type: 'act_fire', params: { power: 1.5 }, next: null },
      ]),
    };

    const state2 = createBattleState({ player: sensorWhileTank, enemy: ENEMY_DUMMY });
    const res2NoEnemy = runTankChipProgram(state2.tanks[0], 1, state2.arena, state2.projectiles);
    expect(res2NoEnemy.commands.radarTurnDelta).toBe(15);
    expect(res2NoEnemy.commands.firePower).toBeNull();
  });

  it('executes loop_for for N ticks then branches to completion and resets', () => {
    const forTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'loop_for',
          params: { iterations: 3 },
          yes: { x: 1, y: 1 },
          no: { x: 2, y: 0 },
        },
        { x: 1, y: 1, type: 'act_move', params: { speedPercent: 50 }, next: null },
        { x: 2, y: 0, type: 'act_fire', params: { power: 'heavy' }, next: null },
      ]),
    };

    const state = createBattleState({ player: forTank, enemy: ENEMY_DUMMY });
    // First 3 ticks: loop body runs (move 50%), no fire
    for (let t = 1; t <= 3; t++) {
      const r = runTankChipProgram(state.tanks[0], t, state.arena, state.projectiles);
      expect(r.commands.targetSpeedRatio).toBeCloseTo(0.5);
      expect(r.commands.firePower).toBeNull();
    }
    // 4th evaluation: loop exits (no branch -> fire heavy) and resets loop counter
    const rExit = runTankChipProgram(state.tanks[0], 4, state.arena, state.projectiles);
    expect(rExit.commands.firePower).toBe(2.5);
    expect(state.tanks[0].loopCounters['1,0']).toBe(0);
  });

  it('provides complete Python educational metadata and EN/JA labels on every chip', () => {
    for (const def of Object.values(CHIP_DEFINITIONS)) {
      expect(def.nameEn.trim().length).toBeGreaterThan(0);
      expect(def.shortLabelEn.trim().length).toBeGreaterThan(0);
      expect(def.pythonSyntax.trim().length).toBeGreaterThan(0);
      expect(def.conceptTag.trim().length).toBeGreaterThan(0);
      expect(def.signatureInfo.trim().length).toBeGreaterThan(0);
      expect(def.learningTip.trim().length).toBeGreaterThan(0);
      for (const field of def.paramSchema) {
        expect(field.labelEn.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Deterministic 3-Axis Simulator & Gun Heat', () => {
  it('rotates body, turret, and radar independently and enforces gun heat cooldown', () => {
    const triAxisTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_turn_body', params: { mode: 'delta', angle: 3 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_turn_turret', params: { mode: 'delta', angle: -5 }, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_turn_radar', params: { mode: 'delta', angle: 12 }, next: { x: 4, y: 0 } },
        { x: 4, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
      ]),
    };

    const state = createBattleState({
      player: triAxisTank,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 400, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
    });

    stepBattleTick(state);
    const p = state.tanks[0];
    expect(p.bodyAngle).toBeCloseTo(93);
    expect(p.turretAngle).toBeCloseTo(85);
    expect(p.radarAngle).toBeCloseTo(96);
    expect(p.stats.shotsFired).toBe(1);
    expect(p.gunHeat).toBeGreaterThan(1.0);

    // Tick 2 cannot fire because gunHeat > 0
    stepBattleTick(state);
    expect(p.stats.shotsFired).toBe(1);
  });

  it('completes Tutorial Stage 1 & Stage 2 deterministically with player victory', () => {
    for (const stage of TUTORIAL_STAGES.slice(0, 2)) {
      const state = createBattleState({
        player: stage.playerStarter,
        enemy: stage.enemy,
        arenaSize: stage.arenaSize,
        obstacles: stage.obstacles,
        maxTicks: stage.maxTicks,
        playerSpawn: stage.playerSpawn,
        enemySpawn: stage.enemySpawn,
        enemyHpScale: stage.enemyHpScale,
      });
      for (let i = 0; i < (stage.maxTicks ?? 3600); i++) {
        stepBattleTick(state);
        if (state.status === 'finished') break;
      }
      expect(state.status).toBe('finished');
      expect(state.winnerId).toBe('player');
    }
  });
});

describe('Import / Export Share Code Serialization', () => {
  it('round-trips a TankBlueprint cleanly through VST1 share code', () => {
    const code = encodeShareCode(DEFAULT_PLAYER_BLUEPRINT);
    expect(code.startsWith('VST1-')).toBe(true);
    const decoded = decodeShareCode(code);
    expect(decoded.name).toBe(DEFAULT_PLAYER_BLUEPRINT.name);
    expect(decoded.assembly).toEqual(DEFAULT_PLAYER_BLUEPRINT.assembly);
    expect(decoded.program.gridSize).toBe(DEFAULT_PLAYER_BLUEPRINT.program.gridSize);
    expect(decoded.program.coordinateMode).toBe(DEFAULT_PLAYER_BLUEPRINT.program.coordinateMode);
    expect(decoded.program.cells[0][0]?.type).toBe('start');
    expect(decoded.program.cells[0][1]?.yes).toEqual({ x: 2, y: 0 });
  });

  it('supports strictly 4x4, 6x6, 8x8, 12x12 grid sizes and rejects invalid sizes', () => {
    expect(ALLOWED_GRID_SIZES).toEqual([4, 6, 8, 12]);
    for (const size of ALLOWED_GRID_SIZES) {
      const cpuId = cpuIdForGridSize(size);
      expect(CPU_SPECS[cpuId].gridSize).toBe(size);

      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuId },
        program: buildProgram(size, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          { x: 1, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
        ]),
      };
      const code = encodeShareCode(bp);
      const decoded = decodeShareCode(code);
      expect(decoded.program.gridSize).toBe(size);
      expect(validateGridBlockFit(decoded.program.cells, size).valid).toBe(true);
    }

    expect(() =>
      validateAndNormalizeBlueprint({
        ...DEFAULT_PLAYER_BLUEPRINT,
        program: { ...DEFAULT_PLAYER_BLUEPRINT.program, gridSize: 5 },
      })
    ).toThrow();
  });

  it('parses Python source and checks block-count suitability against grid size', () => {
    const smallSource = `def on_tick():
  move(speed=60)
  turn_radar(mode="delta", angle=12)
  if main_cooldown == 0:
    fire_main(power=2.5)`;

    const fit4 = parsePythonSourceToProgram(smallSource, 4, 'relative');
    expect(fit4.ok).toBe(true);
    if (fit4.ok) {
      expect(fit4.blockCount).toBe(5);
      expect(fit4.maxBlocks).toBe(16);
      const parsedTank: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: fit4.program,
      };
      const state = createBattleState({ player: parsedTank, enemy: ENEMY_DUMMY });
      const res = runTankChipProgram(state.tanks[0], 1, state.arena, state.projectiles);
      expect(res.commands.targetSpeedRatio).toBeCloseTo(0.6);
      expect(res.commands.radarTurnDelta).toBe(12);
      expect(res.commands.firePower).toBe(2.5);
    }

    // 20 blocks (start + 19 move calls) exceeds 4x4 (16) but fits in 6x6 (36)
    const twentyBlockSource = [
      'def on_tick():',
      ...Array.from({ length: 19 }, () => '  move(speed=50)'),
    ].join('\n');

    const fail4 = parsePythonSourceToProgram(twentyBlockSource, 4, 'relative');
    expect(fail4.ok).toBe(false);
    if (!fail4.ok) {
      expect(fail4.blockCount).toBe(20);
      expect(fail4.maxBlocks).toBe(16);
      expect(fail4.suggestedSize).toBe(6);
      expect(fail4.error).toContain('4×4');
    }

    const pass6 = parsePythonSourceToProgram(twentyBlockSource, 6, 'relative');
    expect(pass6.ok).toBe(true);
    if (pass6.ok) {
      expect(pass6.blockCount).toBe(20);
      expect(pass6.maxBlocks).toBe(36);
    }
  });

  it('executes time.sleep(0) immediately and pauses execution for time.sleep(0.2), plus parses tank_name', () => {
    const sleepZeroSource = `import time
tank_name = "ゼロスリープ"
def on_tick():
  time.sleep(0)
  fire(power="normal")`;
    const zeroParsed = parsePythonSourceToProgram(sleepZeroSource, 4, 'relative');
    expect(zeroParsed.ok).toBe(true);
    if (zeroParsed.ok) {
      expect(zeroParsed.tankName).toBe('ゼロスリープ');
      expect(zeroParsed.blockCount).toBe(3); // start + sleep + fire (import & tank_name excluded)
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        name: zeroParsed.tankName ?? 'test',
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: zeroParsed.program,
      };
      const st0 = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
      const res0 = runTankChipProgram(st0.tanks[0], 1, st0.arena, st0.projectiles);
      expect(res0.commands.firePower).toBe(1.8);
    }

    const sleepWaitSource = `import time
tank_name = "スリープ待機"
def on_tick():
  time.sleep(0.2)
  fire(power=2.5)`;
    const waitParsed = parsePythonSourceToProgram(sleepWaitSource, 4, 'relative');
    expect(waitParsed.ok).toBe(true);
    if (waitParsed.ok) {
      expect(waitParsed.tankName).toBe('スリープ待機');
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        name: waitParsed.tankName ?? 'test',
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: waitParsed.program,
      };
      const st = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
      // Ticks 1..4 wait inside time.sleep(0.2) (0.2s * 20 TPS = 4 ticks)
      for (let t = 1; t <= 4; t++) {
        const res = runTankChipProgram(st.tanks[0], t, st.arena, st.projectiles);
        expect(res.commands.firePower).toBeNull();
      }
      // Tick 5 resumes and executes fire(2.5)
      const res5 = runTankChipProgram(st.tanks[0], 5, st.arena, st.projectiles);
      expect(res5.commands.firePower).toBe(2.5);
    }
  });

  it('supports main_cooldown == 0, sub_cooldown == 0, fire_main(), and fire_sub()', () => {
    const subSource = `import time
tank_name = "サブウェポン機"
def on_tick():
  if main_cooldown == 0:
    fire_main(power=2.0)
  else:
    if sub_cooldown == 0:
      fire_sub()`;

    const parsed = parsePythonSourceToProgram(subSource, 4, 'relative');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        name: parsed.tankName ?? 'sub',
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'missile' },
        program: parsed.program,
      };
      const st = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
      // Tick 1: main_cooldown == 0 is True -> fire_main() fires, sets gunHeat > 0
      stepBattleTick(st);
      expect(st.tanks[0].stats.shotsFired).toBe(1);
      expect(st.tanks[0].gunHeat).toBeGreaterThan(0);

      // Tick 2: main_cooldown == 0 is False -> checks sub_cooldown == 0 -> fire_sub() fires missile!
      stepBattleTick(st);
      expect(st.tanks[0].subAmmo).toBe(3);
      expect(st.tanks[0].subCooldown).toBeGreaterThan(0);

      // Tick 3: sub_cooldown == 0 is now False -> does not fire sub again
      stepBattleTick(st);
      expect(st.tanks[0].subAmmo).toBe(3);
    }
  });

  it('fits every Development Training Stage (Parts 1-4: St.1-19) into expected CPU grids with clean Python round-trip', () => {
    expect(TUTORIAL_STAGES.length).toBe(19);
    for (const stage of TUTORIAL_STAGES) {
      const expectedSize =
        stage.number <= 6 || (stage.number >= 11 && stage.number <= 13)
          ? 4
          : stage.number >= 18
            ? 8
            : 6;
      const expectedCpu = cpuIdForGridSize(expectedSize);
      const maxBlocks = expectedSize * expectedSize;

      const bp = stage.playerStarter;
      expect(bp.assembly.cpu, `${stage.id} player cpu`).toBe(expectedCpu);
      expect(bp.program.gridSize, `${stage.id} player grid`).toBe(expectedSize);

      const fit = validateGridBlockFit(bp.program.cells, expectedSize);
      expect(fit.valid, `${stage.id} player fit`).toBe(true);
      expect(fit.blockCount).toBeLessThanOrEqual(maxBlocks);

      const enemies =
        stage.enemies && stage.enemies.length > 0 ? stage.enemies : [stage.enemy];
      for (const ebp of enemies) {
        expect(ebp.assembly.cpu, `${stage.id} enemy ${ebp.id} cpu`).toBe(expectedCpu);
        expect(ebp.program.gridSize, `${stage.id} enemy ${ebp.id} grid`).toBe(expectedSize);
        const eFit = validateGridBlockFit(ebp.program.cells, expectedSize);
        expect(eFit.valid, `${stage.id} enemy ${ebp.id} fit`).toBe(true);
      }

      const source = transpileProgramToLines(bp.program, bp.name, false)
        .map((l) => l.text)
        .join('\n');
      const reparsed = parsePythonSourceToProgram(
        source,
        expectedSize,
        bp.program.coordinateMode
      );
      expect(reparsed.ok, `${stage.id} reparse`).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.blockCount).toBeLessThanOrEqual(maxBlocks);
        expect(reparsed.tankName).toBe(bp.name);
      }
    }
  });

  it('populates enemy_dist on radar capture, supports turn_body enemy_rel, and executes random.randint', () => {
    // 1. cond_enemy_dist & enemy_dist variable populated on radar lock
    const distSource = `import time
def on_tick():
  if enemy_dist <= 700:
    move(speed=-60)
  else:
    move(speed=80)`;
    const parsedDist = parsePythonSourceToProgram(distSource, 4, 'relative');
    expect(parsedDist.ok).toBe(true);
    if (parsedDist.ok) {
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: parsedDist.program,
      };
      // Radar facing North (0 deg) misses enemy to the East -> enemy_dist is null -> else (move 80)
      const stMiss = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        playerSpawn: { x: 200, y: 400, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
        enemySpawn: { x: 700, y: 400, bodyAngle: 270 },
      });
      stepBattleTick(stMiss);
      expect(stMiss.tanks[0].enemyDist).toBeNull();
      expect(stMiss.tanks[0].lastCommands.targetSpeedRatio).toBeCloseTo(0.8);

      // Radar facing East (90 deg) detects enemy 500px away -> enemy_dist == 500 <= 700 -> move(-60)
      const stHit = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        playerSpawn: { x: 200, y: 400, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
        enemySpawn: { x: 700, y: 400, bodyAngle: 270 },
      });
      stepBattleTick(stHit);
      expect(stHit.tanks[0].enemyDist).toBe(500);
      expect(stHit.tanks[0].counters.ENEMY_DIST).toBe(500);
      expect(stHit.tanks[0].lastCommands.targetSpeedRatio).toBeCloseTo(-0.6);
    }

    // 2. turn_body(mode="enemy_rel", angle=90) turns perpendicular to enemy bearing
    const strafeSource = `import time
def on_tick():
  turn_body(mode="enemy_rel", angle=90)
  move(speed=70)`;
    const parsedStrafe = parsePythonSourceToProgram(strafeSource, 4, 'relative');
    expect(parsedStrafe.ok).toBe(true);
    if (parsedStrafe.ok) {
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: parsedStrafe.program,
      };
      // Player facing East (90 deg), enemy due East -> enemy_rel +90 asks for South (180 deg) => +90 delta
      const st = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        playerSpawn: { x: 200, y: 400, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
        enemySpawn: { x: 600, y: 400, bodyAngle: 270 },
      });
      stepBattleTick(st);
      expect(st.tanks[0].lastCommands.bodyTurnDelta).toBeCloseTo(90);
    }

    // 3. random.randint round-trips and writes an integer within [min, max]
    const randSource = `import time
import random
def on_tick():
  a = random.randint(3, 5)
  if a >= 3:
    move(speed=50)`;
    const parsedRand = parsePythonSourceToProgram(randSource, 4, 'relative');
    expect(parsedRand.ok).toBe(true);
    if (parsedRand.ok) {
      expect(parsedRand.blockCount).toBe(4);
      const transpiled = transpileProgramToLines(parsedRand.program, '乱数テスト', false)
        .map((l) => l.text)
        .join('\n');
      expect(transpiled).toContain('import random');
      expect(transpiled).toContain('a = random.randint(3, 5)');

      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: parsedRand.program,
      };
      const st = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
      stepBattleTick(st);
      expect(st.tanks[0].counters.A).toBeGreaterThanOrEqual(3);
      expect(st.tanks[0].counters.A).toBeLessThanOrEqual(5);
      expect(st.tanks[0].lastCommands.targetSpeedRatio).toBeCloseTo(0.5);
    }
  });

  it('validates fire_main power tiers ("fast" | "normal" | "heavy"), supports legacy numbers, and rejects invalid values', () => {
    const validFast = parsePythonSourceToProgram('def on_tick():\n  fire_main(power="fast")', 4, 'relative');
    const validNormal = parsePythonSourceToProgram('def on_tick():\n  fire_main(power="normal")', 4, 'relative');
    const validHeavy = parsePythonSourceToProgram('def on_tick():\n  fire_main(power="heavy")', 4, 'relative');
    const validLegacyMin = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=0.5)', 4, 'relative');
    const validLegacyMax = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=3.0)', 4, 'relative');
    expect(validFast.ok).toBe(true);
    expect(validNormal.ok).toBe(true);
    expect(validHeavy.ok).toBe(true);
    expect(validLegacyMin.ok).toBe(true);
    expect(validLegacyMax.ok).toBe(true);

    const tooLow = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=0.4)', 4, 'relative');
    const tooHigh = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=3.5)', 4, 'relative');
    const badTier = parsePythonSourceToProgram('def on_tick():\n  fire_main(power="ultra")', 4, 'relative');
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) {
      expect(tooLow.error).toContain('"fast"');
    }
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) {
      expect(tooHigh.error).toContain('"heavy"');
    }
    expect(badTier.ok).toBe(false);
    if (!badTier.ok) {
      expect(badTier.error).toContain('"normal"');
    }

    expect(() =>
      validateAndNormalizeBlueprint({
        ...DEFAULT_PLAYER_BLUEPRINT,
        program: buildProgram(6, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          { x: 1, y: 0, type: 'act_fire', params: { power: 3.5 }, next: null },
        ]),
      })
    ).toThrow(/fast.*normal.*heavy/);

    expect(() =>
      validateAndNormalizeBlueprint({
        ...DEFAULT_PLAYER_BLUEPRINT,
        program: buildProgram(6, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          { x: 1, y: 0, type: 'act_fire', params: { power: 0.4 }, next: null },
        ]),
      })
    ).toThrow(/fast.*normal.*heavy/);
  });

  it('allows multiple simultaneous shells with rapid "fast" tier and enforces higher damage & longer cooldown with cannon "heavy" tier', () => {
    const rapidLowBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', mainGun: 'rapid' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 'fast' }, next: null },
      ]),
    };
    const heavyHighBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', mainGun: 'cannon' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 'heavy' }, next: null },
      ]),
    };

    // Place target 1000px away on the 1400x1100 arena
    const stLow = createBattleState({
      player: rapidLowBp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 1200, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    let maxProjectilesSeen = 0;
    for (let i = 0; i < 45; i++) {
      stepBattleTick(stLow);
      maxProjectilesSeen = Math.max(maxProjectilesSeen, stLow.projectiles.length);
    }
    expect(maxProjectilesSeen).toBeGreaterThanOrEqual(3);

    // Compare single-shot cooldown & damage between power=0.5 and power=3.0
    const stSingleLow = createBattleState({
      player: rapidLowBp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 1200, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    const stSingleHigh = createBattleState({
      player: heavyHighBp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 1200, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    stepBattleTick(stSingleLow);
    stepBattleTick(stSingleHigh);
    expect(stSingleHigh.projectiles[0].damage).toBeGreaterThan(stSingleLow.projectiles[0].damage * 3);
    expect(stSingleHigh.projectiles[0].speed).toBeLessThan(stSingleLow.projectiles[0].speed);
    expect(stSingleHigh.tanks[0].gunHeat).toBeGreaterThan(stSingleLow.tanks[0].gunHeat * 3);
  });

  it('outputs chassis/radar/main_gun/special (without color) in Python source and auto-reverts abnormal hardware values', () => {
    const bp = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        chassis: 'heavy' as const,
        radar: 'long' as const,
        mainGun: 'cannon' as const,
        subWeapon: 'shield' as const,
      },
    };
    const lines = transpileProgramToLines(
      bp.program,
      bp.name,
      false,
      bp.assembly.radar,
      bp.assembly.chassis,
      bp.assembly.mainGun,
      bp.assembly.subWeapon
    ).map((l) => l.text);
    const src = lines.join('\n');
    expect(src).toContain('chassis = {"type": "heavy", "hp": 190, "speed": 2.5, "turn": 3}');
    expect(src).toContain('radar = {"type": "long", "fov": 22, "range": 1550, "turn": 4.2}');
    expect(src).toContain('main_gun = {"type": "cannon", "damage": 1.35, "cooling": 0.052, "turn": 4.8}');
    expect(src).toContain('special = {"type": "shield", "ammo": 3, "cooldown": 240}');
    expect(src).not.toContain('sub_weapon =');
    expect(src).not.toContain('color =');

    const parsedValid = parsePythonSourceToProgram(src, 6, 'relative');
    expect(parsedValid.ok).toBe(true);
    if (parsedValid.ok) {
      expect(parsedValid.chassisId).toBe('heavy');
      expect(parsedValid.radarId).toBe('long');
      expect(parsedValid.mainGunId).toBe('cannon');
      expect(parsedValid.subWeaponId).toBe('shield');
      expect(parsedValid.warnings).toBeUndefined();
    }

    // 1. Abnormal spec values on valid presets automatically revert to those presets with warnings
    const tamperedPresets = parsePythonSourceToProgram(
      [
        'import time',
        'chassis = {"type": "light", "hp": 999, "speed": 99, "turn": 6}',
        'radar = {"type": "long", "fov": 90, "range": 5000, "turn": 8}',
        'main_gun = {"type": "rapid", "damage": 9.9, "cooling": 0.1, "turn": 11}',
        'sub_weapon = {"type": "mine", "ammo": 99, "cooldown": 90}',
        'def on_tick():',
        '  move(speed=50)',
      ].join('\n'),
      4,
      'relative'
    );
    expect(tamperedPresets.ok).toBe(true);
    if (tamperedPresets.ok) {
      expect(tamperedPresets.chassisId).toBe('light');
      expect(tamperedPresets.radarId).toBe('long');
      expect(tamperedPresets.mainGunId).toBe('rapid');
      expect(tamperedPresets.subWeaponId).toBe('mine');
      expect(tamperedPresets.warnings?.length).toBe(4);
    }

    // 2. Non-prescribed hardware names fall back to STANDARD_SETUP; legacy color line is ignored cleanly
    const unknownAll = parsePythonSourceToProgram(
      [
        'import time',
        'chassis = "titan"',
        'radar = "ultra_radar"',
        'main_gun = "railgun"',
        'sub_weapon = "nuke"',
        'color = "#123456"',
        'def on_tick():',
        '  move(speed=50)',
      ].join('\n'),
      4,
      'relative'
    );
    expect(unknownAll.ok).toBe(true);
    if (unknownAll.ok) {
      expect(unknownAll.chassisId).toBe('standard');
      expect(unknownAll.radarId).toBe('balanced');
      expect(unknownAll.mainGunId).toBe('standard');
      expect(unknownAll.subWeaponId).toBe('missile');
      expect(unknownAll.warnings?.length).toBe(4);
    }

    // 3. validateAndNormalizeBlueprint normalizes unknown hardware to STANDARD_SETUP
    const normalizedBp = validateAndNormalizeBlueprint({
      ...DEFAULT_PLAYER_BLUEPRINT,
      color: 'invalid_color',
      assembly: {
        chassis: 'titan' as unknown as TankBlueprint['assembly']['chassis'],
        radar: 'custom_x' as unknown as TankBlueprint['assembly']['radar'],
        mainGun: 'laser' as unknown as TankBlueprint['assembly']['mainGun'],
        subWeapon: 'nuke' as unknown as TankBlueprint['assembly']['subWeapon'],
        cpu: 'compact_6x6',
      },
    });
    expect(normalizedBp.assembly.chassis).toBe('standard');
    expect(normalizedBp.assembly.radar).toBe('balanced');
    expect(normalizedBp.assembly.mainGun).toBe('standard');
    expect(normalizedBp.assembly.subWeapon).toBe('missile');
    expect(normalizedBp.color).toBe(AUTO_TANK_COLORS[0]);
  });

  it('auto-assigns 8 distinct CVD-safe colors and supports up to 8 tanks fighting simultaneously', () => {
    expect(AUTO_TANK_COLORS.length).toBe(8);
    expect(new Set(AUTO_TANK_COLORS).size).toBe(8);
    expect(EIGHT_PLAYER_SPAWNS.length).toBe(8);

    const sevenOpponents = Array.from({ length: 7 }, (_, i) => ({
      ...PRESET_ENEMIES[i % PRESET_ENEMIES.length],
      id: `multi_enemy_${i + 1}`,
      name: `対戦機${i + 2}`,
    }));
    const state = createBattleState({
      player: DEFAULT_PLAYER_BLUEPRINT,
      enemies: sevenOpponents,
      obstacles: generateArenaObstacles('few', -1),
    });

    expect(state.tanks.length).toBe(8);
    const assignedColors = state.tanks.map((t) => t.blueprint.color);
    expect(assignedColors).toEqual([...AUTO_TANK_COLORS]);
    expect(new Set(assignedColors).size).toBe(8);

    for (let t = 0; t < 20; t++) {
      stepBattleTick(state);
    }
    expect(state.tick).toBe(20);
  });

  it('generates deterministic seeded arena obstacles across none/few/many/maze modes with safe spawn clearance', () => {
    expect(generateArenaObstacles('none', -1)).toEqual([]);

    const fewDefault = generateArenaObstacles('few', -1);
    expect(fewDefault.length).toBe(3);

    const manyDefaultA = generateArenaObstacles('many', -1);
    const manyDefaultB = generateArenaObstacles('many', -1);
    expect(manyDefaultA).toEqual(manyDefaultB);
    expect(manyDefaultA.length).toBeGreaterThanOrEqual(7);

    const mazeA = generateArenaObstacles('maze', 4242);
    const mazeB = generateArenaObstacles('maze', 4242);
    const mazeDiff = generateArenaObstacles('maze', 9999);
    expect(mazeA).toEqual(mazeB);
    expect(mazeA).not.toEqual(mazeDiff);
    expect(mazeA.length).toBeGreaterThanOrEqual(8);

    const spawns = [{ x: 260, y: 550 }, { x: 1140, y: 550 }, ...FOUR_PLAYER_SPAWNS];
    for (const obs of [...fewDefault, ...manyDefaultA, ...mazeA, ...mazeDiff]) {
      for (const sp of spawns) {
        expect(circleIntersectsRect(sp.x, sp.y, 130, obs)).toBe(false);
      }
    }
  });

  it('captures print() debug speech outputs with live values and round-trips through Python without block cost', () => {
    const printSource = `import time
def on_tick():
  print(f"enemy_dist={enemy_dist}")
  if enemy_dist <= 700:
    print("move(speed=-60)")
    move(speed=-60)
  else:
    move(speed=75)`;

    const parsed = parsePythonSourceToProgram(printSource, 4, 'relative');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // start + if(enemy_dist<=700) + move(-60) + move(75) = 4 blocks (print lines cost 0 blocks)
      expect(parsed.blockCount).toBe(4);
      const cells = parsed.program.cells.flat().filter((c): c is NonNullable<typeof c> => c !== null);
      const printCells = cells.filter((c) => Number(c.params._print ?? 0) === 1);
      expect(printCells.length).toBe(2);

      const transpiled = transpileProgramToLines(parsed.program, 'デバッグ機', false)
        .map((l) => l.text)
        .join('\n');
      expect(transpiled).toContain('print(f"enemy_dist={enemy_dist}")');
      expect(transpiled).toContain('print("move(speed=-60)")');

      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: parsed.program,
      };
      const st = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        playerSpawn: { x: 200, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
        enemySpawn: { x: 700, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
      });
      stepBattleTick(st);
      const p = st.tanks[0];
      expect(p.trace.printOutputs).toBeDefined();
      expect(p.trace.printOutputs?.length).toBe(2);
      expect(p.trace.printOutputs?.[0]).toContain('500px');
      expect(p.trace.printOutputs?.[1]).toContain('move(-60%)');
      expect(p.activePrintSpeech?.lines).toEqual(p.trace.printOutputs);
    }
  });

  it('uses strictly 4-direction orthogonal adjacent links across all presets and tutorials', () => {
    const allBlueprints: TankBlueprint[] = [
      DEFAULT_PLAYER_BLUEPRINT,
      ...PRESET_ENEMIES,
      ...TUTORIAL_STAGES.map((s) => s.playerStarter),
      ...TUTORIAL_STAGES.flatMap((s) =>
        s.enemies && s.enemies.length > 0 ? s.enemies : [s.enemy]
      ),
    ];

    for (const bp of allBlueprints) {
      const cells = bp.program.cells;
      for (let y = 0; y < cells.length; y++) {
        for (let x = 0; x < cells[y].length; x++) {
          const cell = cells[y][x];
          if (!cell) continue;
          const links = [cell.next, cell.yes, cell.no].filter(
            (lnk): lnk is NonNullable<typeof lnk> => lnk !== null && lnk !== undefined
          );
          for (const target of links) {
            const manhattan = Math.abs(target.x - x) + Math.abs(target.y - y);
            expect(manhattan, `${bp.id} (${x},${y}) -> (${target.x},${target.y})`).toBe(1);
          }
        }
      }
    }

    // Reconvergence join where no-branch points directly to join cell does not emit empty else
    const directJoinBp = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_gun_ready', yes: { x: 2, y: 0 }, no: { x: 1, y: 1 } },
      { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: { x: 2, y: 1 } },
      { x: 1, y: 1, type: 'wire', next: { x: 2, y: 1 } },
      { x: 2, y: 1, type: 'act_move', params: { speedPercent: 50 }, next: null },
    ]);
    const transpiled = transpileProgramToLines(directJoinBp, '合流テスト', false)
      .map((l) => l.text)
      .join('\n');
    expect(transpiled).toContain('if main_cooldown == 0:');
    expect(transpiled).toContain('move(speed=50)');

    const noElseDirectJoin = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_gun_ready', yes: { x: 2, y: 0 }, no: { x: 1, y: 1 } },
      { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: { x: 1, y: 1 } },
      { x: 1, y: 1, type: 'act_move', params: { speedPercent: 50 }, next: null },
    ]);
    const transpiledNoElse = transpileProgramToLines(noElseDirectJoin, '片側合流', false)
      .map((l) => l.text)
      .join('\n');
    expect(transpiledNoElse).not.toContain('else:');
    expect(transpiledNoElse.match(/move\(speed=50\)/g)?.length).toBe(1);

    // Non-orthogonal (diagonal/jump) links are not traversed at runtime
    const nonOrthoTank: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 2, y: 1 } },
        { x: 2, y: 1, type: 'act_fire', params: { power: 2.0 }, next: null },
      ]),
    };
    const stJump = createBattleState({ player: nonOrthoTank, enemy: ENEMY_DUMMY });
    const resJump = runTankChipProgram(stJump.tanks[0], 1, stJump.arena, stJump.projectiles);
    expect(resJump.commands.firePower).toBeNull();
    expect(resJump.trace.visited).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('Subroutines (A-D) & Special (SP)', () => {
  it('executes subroutine calls A-D, unwinds back to caller.next, blocks self-recursion, and avoids jump edges', () => {
    const bp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(6) },
      program: buildProgram(6, 'relative', [
        // Main flow: start -> sub_a() -> sub_d() -> fire_main(power="normal")
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'sub_call', params: { sub: 'A' }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'sub_call', params: { sub: 'D' }, next: { x: 2, y: 1 } },
        { x: 2, y: 1, type: 'act_fire', params: { power: 'normal' }, next: null },
        // Subroutine A: move(80) -> recursive sub_a() (must be safely skipped by recursion guard)
        { x: 0, y: 4, type: 'sub_def', params: { sub: 'A' }, next: { x: 1, y: 4 } },
        { x: 1, y: 4, type: 'act_move', params: { speedPercent: 80 }, next: { x: 2, y: 4 } },
        { x: 2, y: 4, type: 'sub_call', params: { sub: 'A' }, next: null },
        // Subroutine D: turn_radar(+15)
        { x: 3, y: 4, type: 'sub_def', params: { sub: 'D' }, next: { x: 4, y: 4 } },
        { x: 4, y: 4, type: 'act_turn_radar', params: { mode: 'delta', angle: 15 }, next: null },
      ]),
    };

    const st = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
    const res = runTankChipProgram(st.tanks[0], 1, st.arena, st.projectiles);

    expect(res.commands.targetSpeedRatio).toBeCloseTo(0.8);
    expect(res.commands.radarTurnDelta).toBe(15);
    expect(res.commands.firePower).toBe(1.8);
    expect(res.trace.visited).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 4 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 2, y: 0 },
      { x: 3, y: 4 },
      { x: 4, y: 4 },
      { x: 2, y: 1 },
    ]);

    // No non-orthogonal jump edge between call site (1,0) and def site (0,4)
    const hasJumpEdge = res.trace.edges.some(
      (e) =>
        (e.from.x === 1 && e.from.y === 0 && e.to.x === 0 && e.to.y === 4) ||
        (e.from.x === 2 && e.from.y === 0 && e.to.x === 3 && e.to.y === 4)
    );
    expect(hasJumpEdge).toBe(false);
    // Unwind edge back onto orthogonally adjacent caller.next is preserved
    expect(res.trace.edges).toContainEqual({
      from: { x: 1, y: 0 },
      to: { x: 2, y: 0 },
      branch: 'next',
    });
  });

  it('round-trips subroutines A-D through Python source (transpile -> parse -> execute)', () => {
    const bp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(6) },
      program: buildProgram(6, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'sub_call', params: { sub: 'A' }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'sub_call', params: { sub: 'B' }, next: null },
        { x: 0, y: 4, type: 'sub_def', params: { sub: 'A' }, next: { x: 1, y: 4 } },
        { x: 1, y: 4, type: 'act_move', params: { speedPercent: 60 }, next: null },
        { x: 0, y: 5, type: 'sub_def', params: { sub: 'B' }, next: { x: 1, y: 5 } },
        { x: 1, y: 5, type: 'act_turn_radar', params: { mode: 'delta', angle: 25 }, next: null },
      ]),
    };

    const src = transpileProgramToLines(bp.program, bp.name, false)
      .map((l) => l.text)
      .join('\n');

    expect(src).toContain('def sub_a():');
    expect(src).toContain('def sub_b():');
    expect(src).toContain('def on_tick():');
    expect(src).toContain('sub_a()');
    expect(src).toContain('sub_b()');
    expect(src).toContain('special = ');

    const parsed = parsePythonSourceToProgram(src, 6, 'relative');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const flatCells = parsed.program.cells.flat();
      const subDefs = flatCells.filter((c) => c?.type === 'sub_def').map((c) => c?.params?.sub);
      const subCalls = flatCells.filter((c) => c?.type === 'sub_call').map((c) => c?.params?.sub);
      expect(subDefs).toEqual(expect.arrayContaining(['A', 'B']));
      expect(subCalls).toEqual(expect.arrayContaining(['A', 'B']));

      const reparsedBp: TankBlueprint = { ...bp, program: parsed.program };
      const st = createBattleState({ player: reparsedBp, enemy: ENEMY_DUMMY });
      const res = runTankChipProgram(st.tanks[0], 1, st.arena, st.projectiles);
      expect(res.commands.targetSpeedRatio).toBeCloseTo(0.6);
      expect(res.commands.radarTurnDelta).toBe(25);
    }
  });

  it('uses Special (SP) syntax (sp_cooldown == 0 / fire_sp()) while preserving legacy sub_cooldown/fire_sub() parsing', () => {
    const spBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'missile' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'cond_sub_ready', yes: { x: 2, y: 0 }, no: null },
        { x: 2, y: 0, type: 'act_sub_weapon', next: null },
      ]),
    };

    const src = transpileProgramToLines(
      spBp.program,
      spBp.name,
      false,
      spBp.assembly.radar,
      spBp.assembly.chassis,
      spBp.assembly.mainGun,
      spBp.assembly.subWeapon
    )
      .map((l) => l.text)
      .join('\n');

    expect(src).toContain('special = {"type": "missile"');
    expect(src).toContain('if sp_cooldown == 0:');
    expect(src).toContain('fire_sp()');
    expect(src).not.toContain('sub_cooldown');
    expect(src).not.toContain('fire_sub()');

    const parsedNew = parsePythonSourceToProgram(src, 4, 'relative');
    expect(parsedNew.ok).toBe(true);
    if (parsedNew.ok) {
      const flatNewCells = parsedNew.program.cells.flat();
      expect(parsedNew.subWeaponId).toBe('missile');
      expect(flatNewCells.some((c) => c?.type === 'cond_sub_ready')).toBe(true);
      expect(flatNewCells.some((c) => c?.type === 'act_sub_weapon')).toBe(true);

      const st = createBattleState({
        player: { ...spBp, program: parsedNew.program },
        enemy: ENEMY_DUMMY,
      });
      stepBattleTick(st);
      expect(st.tanks[0].subAmmo).toBe(3);
      expect(st.tanks[0].subCooldown).toBeGreaterThan(0);
    }
  });
});

describe('Directional Armor & Radar Vision Mechanics', () => {
  it('computes front (0.8x), side (1.0x), and rear (1.25x) damage and hit sparks in live combat', () => {
    expect(getDirectionalArmorMultiplier(0, 0)).toEqual({ zone: 'front', multiplier: 0.8 });
    expect(getDirectionalArmorMultiplier(0, 45)).toEqual({ zone: 'front', multiplier: 0.8 });
    expect(getDirectionalArmorMultiplier(0, 90)).toEqual({ zone: 'side', multiplier: 1.0 });
    expect(getDirectionalArmorMultiplier(0, 180)).toEqual({ zone: 'rear', multiplier: 1.25 });

    const shooter: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'cond_gun_ready', yes: { x: 2, y: 0 }, no: null },
        { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
      ]),
    };

    const runHitScenario = (targetBodyAngle: number) => {
      const idleTarget: TankBlueprint = {
        ...ENEMY_DUMMY,
        program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
      };
      const st = createBattleState({
        player: shooter,
        enemy: idleTarget,
        playerSpawn: { x: 200, y: 400, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
        enemySpawn: {
          x: 270,
          y: 400,
          bodyAngle: targetBodyAngle,
          turretAngle: targetBodyAngle,
          radarAngle: targetBodyAngle,
        },
      });
      for (let t = 0; t < 20; t++) {
        stepBattleTick(st);
        if (st.tanks[1].stats.damageTaken > 0) break;
      }
      return {
        damage: st.tanks[1].stats.damageTaken,
        zone: st.tanks[1].lastHitZone,
        sparkColor: st.explosions[st.explosions.length - 1]?.color,
      };
    };

    // Shell travels East (angle 90), so incoming bearing from victim's center is West (270).
    const frontHit = runHitScenario(270);
    const sideHit = runHitScenario(0);
    const rearHit = runHitScenario(90);

    expect(frontHit.zone).toBe('front');
    expect(frontHit.sparkColor).toBe('#38bdf8');
    expect(sideHit.zone).toBe('side');
    expect(sideHit.sparkColor).toBe('#facc15');
    expect(rearHit.zone).toBe('rear');
    expect(rearHit.sparkColor).toBe('#f97316');

    expect(frontHit.damage / sideHit.damage).toBeCloseTo(0.8, 4);
    expect(rearHit.damage / sideHit.damage).toBeCloseTo(1.25, 4);
  });

  it('sweeps radar back and forth around body front, round-trips mode="sweep", and expires memory after RADAR_MEMORY_TICKS', () => {
    const sweepBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, radar: 'balanced', cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_turn_radar', params: { mode: 'sweep', angle: 30 }, next: null },
      ]),
    };

    const src = transpileProgramToLines(sweepBp.program, sweepBp.name, false)
      .map((l) => l.text)
      .join('\n');
    expect(src).toContain('turn_radar(mode="sweep", angle=30)');

    const parsed = parsePythonSourceToProgram(src, 4, 'relative');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const radarCell = parsed.program.cells.flat().find((c) => c?.type === 'act_turn_radar');
      expect(radarCell?.params.mode).toBe('sweep');
      expect(radarCell?.params.angle).toBe(30);
    }

    const stSweep = createBattleState({
      player: sweepBp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      enemySpawn: { x: 1100, y: 900, bodyAngle: 180 },
    });

    // balanced radar turnRate is 6 deg/tick -> 5 ticks reaches +30 deg, tick 6 reverses to 24 deg
    for (let i = 0; i < 5; i++) {
      stepBattleTick(stSweep);
    }
    expect(stSweep.tanks[0].radarAngle).toBeCloseTo(30);
    expect(stSweep.tanks[0].radarSweepDir).toBe(1);

    stepBattleTick(stSweep);
    expect(stSweep.tanks[0].radarSweepDir).toBe(-1);
    expect(stSweep.tanks[0].radarAngle).toBeCloseTo(24);

    // Memory retention test: enemy spotted at tick 1, radar looks away afterward
    const stationaryBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, radar: 'balanced', cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
    };
    const stMem = createBattleState({
      player: stationaryBp,
      enemy: {
        ...ENEMY_DUMMY,
        program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
      },
      playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      enemySpawn: { x: 400, y: 300, bodyAngle: 180 },
    });

    stepBattleTick(stMem);
    expect(stMem.tanks[0].radarLock).toBe(true);
    expect(stMem.tanks[0].enemyDist).toBe(200);

    // Point radar opposite direction so enemy leaves FOV
    stMem.tanks[0].radarAngle = 180;
    for (let t = 0; t < RADAR_MEMORY_TICKS; t++) {
      stepBattleTick(stMem);
    }
    expect(stMem.tanks[0].radarLock).toBe(false);
    expect(stMem.tanks[0].detectedEnemy).not.toBeNull();
    expect(stMem.tanks[0].enemyDist).toBe(200);

    stepBattleTick(stMem);
    expect(stMem.tanks[0].detectedEnemy).toBeNull();
    expect(stMem.tanks[0].enemyDist).toBeNull();
  });
});

describe('Turret-Relative Sweep, Under-Lock, Diagonal/Clearance Wall Sensors & Body-Turret Alignment', () => {
  it('sweeps radar around turret front (turretAngle) rather than body front', () => {
    const bp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, radar: 'balanced', cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_turn_radar', params: { mode: 'sweep', angle: 30 }, next: null },
      ]),
    };

    const st = createBattleState({
      player: bp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 1100, y: 900, bodyAngle: 180 },
    });

    for (let i = 0; i < 5; i++) {
      stepBattleTick(st);
    }
    expect(st.tanks[0].bodyAngle).toBeCloseTo(0);
    expect(st.tanks[0].turretAngle).toBeCloseTo(90);
    expect(st.tanks[0].radarAngle).toBeCloseTo(120);
    expect(st.tanks[0].radarSweepDir).toBe(1);

    stepBattleTick(st);
    expect(st.tanks[0].radarSweepDir).toBe(-1);
    expect(st.tanks[0].radarAngle).toBeCloseTo(114);
  });

  it('detects enemy radar lock-on via cond_under_lock (under_lock()) and round-trips through Python', () => {
    const lockAwareBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'cond_under_lock', yes: { x: 2, y: 0 }, no: { x: 1, y: 1 } },
        { x: 2, y: 0, type: 'act_move', params: { speedPercent: 70 }, next: null },
        { x: 1, y: 1, type: 'act_move', params: { speedPercent: 0 }, next: null },
      ]),
    };

    const src = transpileProgramToLines(lockAwareBp.program, lockAwareBp.name, false)
      .map((l) => l.text)
      .join('\n');
    expect(src).toContain('if under_lock():');

    const parsed = parsePythonSourceToProgram(src, 4, 'relative');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.program.cells.flat().some((c) => c?.type === 'cond_under_lock')).toBe(true);

    const st = createBattleState({
      player: { ...lockAwareBp, program: parsed.program },
      enemy: {
        ...ENEMY_DUMMY,
        program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
      },
      playerSpawn: { x: 400, y: 400, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      enemySpawn: { x: 700, y: 400, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });

    stepBattleTick(st);
    expect(st.tanks[0].underLock).toBe(true);
    expect(st.tanks[0].lastCommands.targetSpeedRatio).toBeCloseTo(0.7);

    // Enemy turns radar away -> after RADAR_MEMORY_TICKS expires, underLock clears
    st.tanks[1].radarAngle = 90;
    for (let t = 0; t <= RADAR_MEMORY_TICKS + 1; t++) {
      stepBattleTick(st);
    }
    expect(st.tanks[0].underLock).toBe(false);
    expect(st.tanks[0].lastCommands.targetSpeedRatio).toBeCloseTo(0);
  });

  it('supports cond_proximity left_closer, any, and directional approaching wall clearance checks', () => {
    const testProxMode = (
      mode: 'left_closer' | 'any' | 'approaching',
      obstacles: Array<{ id: string; x: number; y: number; width: number; height: number }>,
      movingForward = false
    ) => {
      const cells: Parameters<typeof buildProgram>[2] = movingForward
        ? [
            { x: 0, y: 0, type: 'start', next: { x: 0, y: 1 } },
            { x: 0, y: 1, type: 'act_move', params: { speedPercent: 80, duration: 0 }, next: { x: 1, y: 1 } },
            {
              x: 1,
              y: 1,
              type: 'cond_proximity',
              params: { mode, target: 'walls', dist: 140 },
              yes: { x: 2, y: 1 },
              no: null,
            },
            { x: 2, y: 1, type: 'act_fire', params: { power: 'normal' }, next: null },
          ]
        : [
            { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
            {
              x: 1,
              y: 0,
              type: 'cond_proximity',
              params: { mode, target: 'walls', dist: 140 },
              yes: { x: 2, y: 0 },
              no: null,
            },
            { x: 2, y: 0, type: 'act_fire', params: { power: 'normal' }, next: null },
          ];
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
        program: buildProgram(4, 'relative', cells),
      };
      const st = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        obstacles,
        playerSpawn: { x: 400, y: 400, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      });
      return runTankChipProgram(st.tanks[0], 1, st.arena, st.projectiles).commands.firePower;
    };

    const leftObs = [{ id: 'obs_nw', x: 310, y: 280, width: 70, height: 80 }];
    expect(testProxMode('left_closer', leftObs)).toBe(1.8);
    expect(testProxMode('any', leftObs)).toBe(1.8);
    expect(testProxMode('any', [])).toBeNull();

    const rightObs = [{ id: 'obs_ne', x: 420, y: 280, width: 70, height: 80 }];
    expect(testProxMode('left_closer', rightObs)).toBeNull();
    expect(testProxMode('approaching', leftObs, true)).toBe(1.8);

    const rearObs = [{ id: 'obs_s', x: 365, y: 460, width: 70, height: 80 }];
    expect(testProxMode('any', rearObs, true)).toBe(1.8);
    expect(testProxMode('approaching', rearObs, true)).toBeNull();
  });

  it('aligns body to turret (turret_rel) and turret to body (body_rel) cleanly with Python round-trip', () => {
    const bp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_turn_body', params: { mode: 'turret_rel', angle: 0 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_turn_turret', params: { mode: 'body_rel', angle: 0 }, next: null },
      ]),
    };

    const src = transpileProgramToLines(bp.program, bp.name, false)
      .map((l) => l.text)
      .join('\n');
    expect(src).toContain('turn_body(mode="turret_rel", angle=0)');
    expect(src).toContain('turn_turret(mode="body_rel", angle=0)');

    const parsed = parsePythonSourceToProgram(src, 4, 'relative');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const st = createBattleState({
      player: { ...bp, program: parsed.program },
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 400, y: 400, bodyAngle: 0, turretAngle: 90, radarAngle: 90 },
    });

    const res = runTankChipProgram(st.tanks[0], 1, st.arena, st.projectiles);
    expect(res.commands.bodyTurnDelta).toBeCloseTo(90);
    expect(res.commands.turretTurnDelta).toBeCloseTo(-90);
  });
});

describe('Team Battle Mode & Stage 15 Multi-Enemy Finale', () => {
  it('prevents enemy friendly fire (radar & shells) and ends only when an entire team is eliminated', () => {
    const idlePlayer: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
    };
    const shooterEast: TankBlueprint = {
      ...ENEMY_DUMMY,
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'cond_gun_ready', yes: { x: 2, y: 0 }, no: null },
        { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
      ]),
    };
    const idleAlly: TankBlueprint = {
      ...ENEMY_DUMMY,
      program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
    };

    const st = createBattleState({
      player: idlePlayer,
      enemies: [shooterEast, idleAlly],
      playerSpawn: { x: 120, y: 120, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      enemySpawns: [
        { x: 300, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
        { x: 410, y: 550, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
      ],
      teamBattle: true,
    });

    for (let t = 0; t < 25; t++) {
      stepBattleTick(st);
    }

    // Enemy shooter fired East right across ally position (410, 550): no friendly radar lock or damage!
    expect(st.tanks[1].stats.shotsFired).toBeGreaterThanOrEqual(1);
    expect(st.tanks[1].stats.shotsHit).toBe(0);
    expect(st.tanks[1].radarLock).toBe(false);
    expect(st.tanks[2].radarLock).toBe(false);
    expect(st.tanks[2].underLock).toBe(false);
    expect(st.tanks[2].stats.damageTaken).toBe(0);

    // Friendly projectile heading toward ally must not trigger incoming_shell() in teamBattle
    const allyShellGuard = runTankChipProgram(
      {
        ...st.tanks[2],
        blueprint: {
          ...st.tanks[2].blueprint,
          program: buildProgram(4, 'relative', [
            { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
            {
              x: 1,
              y: 0,
              type: 'cond_incoming_shell',
              params: { maxDist: 400 },
              yes: { x: 2, y: 0 },
              no: null,
            },
            { x: 2, y: 0, type: 'act_sub_weapon', next: null },
          ]),
        },
      },
      st.tick,
      st.arena,
      st.projectiles,
      st.tanks
    );
    expect(allyShellGuard.commands.useSubWeapon).toBe(false);

    // Eliminating only 1 enemy does not end the match; eliminating all enemies with active combat wins for player
    st.tanks[0].stats.shotsFired = 2;
    st.tanks[0].stats.damageDealt = 40;
    st.tanks[1].hp = 0;
    st.tanks[1].killedById = 'player';
    stepBattleTick(st);
    expect(st.status).toBe('running');

    st.tanks[2].hp = 0;
    st.tanks[2].killedById = 'player';
    stepBattleTick(st);
    expect(st.status).toBe('finished');
    expect(st.winnerId).toBe('player');
    expect(st.winType).toBe('elimination');

    // Player KO while at least one enemy lives -> enemy team victory
    const stLose = createBattleState({
      player: idlePlayer,
      enemies: [idleAlly, idleAlly],
      teamBattle: true,
    });
    stLose.tanks[0].hp = 0;
    stepBattleTick(stLose);
    expect(stLose.status).toBe('finished');
    expect(stLose.winnerId).toBe('enemy');
  });

  it('initializes 1v2 Team Battle with 2 cooperating enemies and fortress obstacles', () => {
    const battle = createBattleState({
      player: DEFAULT_PLAYER_BLUEPRINT,
      enemies: [ENEMY_PATROL, ENEMY_PATROL],
      arenaSize: 'large',
      obstacles: [
        { id: 'f1', x: 520, y: 260, width: 90, height: 190 },
        { id: 'f2', x: 520, y: 650, width: 90, height: 190 },
        { id: 'f3', x: 860, y: 440, width: 90, height: 220 },
      ],
      maxTicks: 10800,
      playerSpawn: { x: 200, y: 550, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawns: [
        { x: 1120, y: 310, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
        { x: 1120, y: 790, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
      ],
      teamBattle: true,
    });

    expect(battle.arena.teamBattle).toBe(true);
    expect(battle.tanks.length).toBe(3);
    expect(battle.tanks[0].team).toBe('player');
    expect(battle.tanks.slice(1).every((t) => t.team === 'enemy')).toBe(true);

    for (let i = 0; i < 10; i++) {
      stepBattleTick(battle);
    }
    expect(battle.status).toBe('running');
  });

  it('validates all 30 preset enemies (4x4 / 6x6 / 8x8 / 12x12) including normalization and Python round-trip', () => {
    expect(PRESET_ENEMIES.length).toBe(30);
    for (const enemyBp of PRESET_ENEMIES) {
      const size = enemyBp.program.gridSize;
      const fit = validateGridBlockFit(enemyBp.program.cells, size);
      expect(fit.valid, `${enemyBp.id} fit`).toBe(true);
      expect(enemyBp.assembly.cpu, `${enemyBp.id} cpu`).toBe(cpuIdForGridSize(size));

      const normalized = validateAndNormalizeBlueprint(enemyBp);
      expect(normalized.name).toBe(enemyBp.name);

      const src = transpileProgramToLines(
        enemyBp.program,
        enemyBp.name,
        false,
        enemyBp.assembly.radar,
        enemyBp.assembly.chassis,
        enemyBp.assembly.mainGun,
        enemyBp.assembly.subWeapon
      )
        .map((l) => l.text)
        .join('\n');

      const reparsed = parsePythonSourceToProgram(
        src,
        size,
        enemyBp.program.coordinateMode
      );
      expect(reparsed.ok, `${enemyBp.id} Python reparse`).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.blockCount).toBeLessThanOrEqual(size * size);
      }

      const st = createBattleState({ player: enemyBp, enemy: ENEMY_DUMMY });
      expect(() => stepBattleTick(st)).not.toThrow();
    }
  });

  it('supports 4 arena sizes (tiny/small/medium/large) with bounded obstacles, spawns, and tutorial stages', () => {
    const sizeOrder: ArenaSizeId[] = ['tiny', 'small', 'medium', 'large'];
    for (const sizeId of sizeOrder) {
      const spec = ARENA_SIZE_SPECS[sizeId];
      const battle = createBattleState({
        player: DEFAULT_PLAYER_BLUEPRINT,
        enemy: ENEMY_DUMMY,
        arenaSize: sizeId,
        obstacles: generateArenaObstacles('maze', 1234, sizeId),
      });
      expect(battle.arena.sizeId).toBe(sizeId);
      expect(battle.arena.width).toBe(spec.width);
      expect(battle.arena.height).toBe(spec.height);

      for (const sp of getSpawnsForArena(spec.width, spec.height)) {
        expect(sp.x).toBeGreaterThan(40);
        expect(sp.x).toBeLessThan(spec.width - 40);
        expect(sp.y).toBeGreaterThan(40);
        expect(sp.y).toBeLessThan(spec.height - 40);
      }

      for (const mode of ['few', 'many', 'maze'] as const) {
        const obsList = generateArenaObstacles(mode, mode === 'few' ? -1 : 777, sizeId);
        expect(obsList.length).toBeGreaterThan(0);
        for (const obs of obsList) {
          expect(obs.x).toBeGreaterThanOrEqual(0);
          expect(obs.y).toBeGreaterThanOrEqual(0);
          expect(obs.x + obs.width).toBeLessThanOrEqual(spec.width);
          expect(obs.y + obs.height).toBeLessThanOrEqual(spec.height);
        }
      }
    }

    for (const st of TUTORIAL_STAGES) {
      expect(st.arenaSize, `${st.id} arenaSize`).toBeDefined();
      const spec = ARENA_SIZE_SPECS[st.arenaSize!];
      expect(st.playerSpawn.x).toBeGreaterThan(30);
      expect(st.playerSpawn.x).toBeLessThan(spec.width - 30);
      expect(st.playerSpawn.y).toBeGreaterThan(30);
      expect(st.playerSpawn.y).toBeLessThan(spec.height - 30);
      expect(st.enemySpawn.x).toBeGreaterThan(30);
      expect(st.enemySpawn.x).toBeLessThan(spec.width - 30);
      expect(st.enemySpawn.y).toBeGreaterThan(30);
      expect(st.enemySpawn.y).toBeLessThan(spec.height - 30);
      for (const sp of st.enemySpawns ?? []) {
        expect(sp.x).toBeGreaterThan(30);
        expect(sp.x).toBeLessThan(spec.width - 30);
        expect(sp.y).toBeGreaterThan(30);
        expect(sp.y).toBeLessThan(spec.height - 30);
      }
      for (const obs of st.obstacles) {
        expect(obs.x).toBeGreaterThanOrEqual(0);
        expect(obs.y).toBeGreaterThanOrEqual(0);
        expect(obs.x + obs.width).toBeLessThanOrEqual(spec.width);
        expect(obs.y + obs.height).toBeLessThanOrEqual(spec.height);
      }
    }
  });

  it('does not award victory when player never fired or dealt damage, and ends draws cleanly on no-combat timeouts', () => {
    const idleBp = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'idle_unit',
      name: '待機テスト機',
      program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
    };

    // Case 1: Enemy KO'd with zero player shots/damage -> Draw (never false "撃破勝利")
    const stNoShot = createBattleState({ player: idleBp, enemy: ENEMY_DUMMY });
    stNoShot.tanks[1].hp = 0;
    stepBattleTick(stNoShot);
    expect(stNoShot.status).toBe('finished');
    expect(stNoShot.winnerId).toBe('draw');
    expect(stNoShot.winType).toBe('draw');
    expect(stNoShot.endReason).not.toContain('撃破勝利');

    // Case 2: Timeout with zero combat contribution even when enemy took non-combat damage -> Draw
    const stTimeout = createBattleState({ player: idleBp, enemy: ENEMY_DUMMY, maxTicks: 5 });
    stTimeout.tanks[1].hp = 50;
    for (let i = 0; i < 6; i++) {
      stepBattleTick(stTimeout);
    }
    expect(stTimeout.status).toBe('finished');
    expect(stTimeout.winnerId).toBe('draw');
    expect(stTimeout.winType).toBe('draw');
    expect(stTimeout.endReason).toContain('有効打なし');

    // Case 3: Active kill -> Player elimination victory
    const stKill = createBattleState({ player: idleBp, enemy: ENEMY_DUMMY });
    stKill.tanks[0].stats.shotsFired = 1;
    stKill.tanks[0].stats.damageDealt = 100;
    stKill.tanks[1].hp = 0;
    stKill.tanks[1].killedById = 'player';
    stepBattleTick(stKill);
    expect(stKill.status).toBe('finished');
    expect(stKill.winnerId).toBe('player');
    expect(stKill.winType).toBe('elimination');
    expect(stKill.endReason).toContain('撃破勝利');
  });

  it('activates updated boost (50t) and decoy (HP25, 3 ammo, 160t CD) durability accurately', () => {
    const boostBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'light', cpu: 'mini_4x4', subWeapon: 'boost' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_sub_weapon', next: null },
      ]),
    };
    const stBoost = createBattleState({ player: boostBp, enemy: ENEMY_DUMMY });
    stepBattleTick(stBoost);
    expect(stBoost.tanks[0].boostTicks).toBe(50);
    expect(stBoost.tanks[0].subAmmo).toBe(2);

    const decoyBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'mini_4x4', subWeapon: 'decoy' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_sub_weapon', next: null },
      ]),
    };
    const shooterBp: TankBlueprint = {
      ...ENEMY_DUMMY,
      assembly: { ...ENEMY_DUMMY.assembly, mainGun: 'rapid' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 'normal' }, next: null },
      ]),
    };
    const stDecoy = createBattleState({
      player: decoyBp,
      enemy: shooterBp,
      playerSpawn: { x: 200, y: 300, bodyAngle: 45, turretAngle: 45, radarAngle: 45 },
      enemySpawn: { x: 350, y: 300, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    stepBattleTick(stDecoy);
    expect(stDecoy.tanks[0].subAmmo).toBe(2); // 3 max -> 2 left
    expect(stDecoy.tanks[0].subCooldown).toBe(160);
    expect(stDecoy.decoys?.length).toBe(1);
    expect(stDecoy.decoys?.[0].hp).toBe(25);

    // Place decoy directly in front of enemy shell -> absorbs hit without dying from 1 rapid shot (~3 dmg)
    const decoy = stDecoy.decoys![0];
    decoy.x = 300;
    decoy.y = 300;
    for (let t = 0; t < 10; t++) {
      stepBattleTick(stDecoy);
    }
    expect(stDecoy.decoys?.[0].hp).toBeLessThan(25);
    expect(stDecoy.decoys?.[0].hp).toBeGreaterThan(0);
  });

  it('resolves tank-to-tank collisions with chassis weight/momentum, flank loophole, anti-deadlock, and boundary clamps', () => {
    const mkMover = (
      id: string,
      chassis: 'light' | 'standard' | 'heavy' | 'destroyer',
      boost = false
    ): TankBlueprint => ({
      ...DEFAULT_PLAYER_BLUEPRINT,
      id,
      name: id,
      assembly: {
        chassis,
        mainGun: 'rapid',
        radar: 'wide',
        cpu: 'mini_4x4',
        subWeapon: boost ? 'boost' : 'none',
      },
      program: buildProgram(
        4,
        'relative',
        boost
          ? [
              { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
              { x: 1, y: 0, type: 'act_sub_weapon', next: { x: 2, y: 0 } },
              { x: 2, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
            ]
          : [
              { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
              { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
            ]
      ),
    });

    // 1. Mass & momentum difference: Light boosted vs Destroyer head-on -> Light takes heavier rebound & angle change
    const headOn = createBattleState({
      player: mkMover('l_boost', 'light', true),
      enemy: mkMover('d_head', 'destroyer'),
      arenaSize: 'small',
      playerSpawn: { x: 260, y: 330, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 420, y: 330, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    const minHeadDist = CHASSIS_SPECS.light.radius + CHASSIS_SPECS.destroyer.radius;
    let bumped = false;
    let lightDeflect = 0;
    let dstHeadDeflect = 0;
    for (let t = 0; t < 35; t++) {
      stepBattleTick(headOn);
      const a = headOn.tanks[0];
      const b = headOn.tanks[1];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(minHeadDist - 1e-4);
      if (a.stats.damageTaken > 0 && !bumped) {
        bumped = true;
        lightDeflect = Math.abs(((a.bodyAngle - 90 + 540) % 360) - 180);
        dstHeadDeflect = Math.abs(((b.bodyAngle - 270 + 540) % 360) - 180);
        expect(a.stats.damageTaken).toBeGreaterThan(b.stats.damageTaken);
      }
    }
    expect(bumped).toBe(true);
    expect(lightDeflect).toBeGreaterThan(dstHeadDeflect);
    expect(dstHeadDeflect).toBeLessThanOrEqual(10);

    // 2. Destroyer counterplay loophole: fast boosted flank hit twists Destroyer hull noticeably more
    const flank = createBattleState({
      player: mkMover('l_flank', 'light', true),
      enemy: mkMover('d_flank', 'destroyer'),
      arenaSize: 'small',
      playerSpawn: { x: 350, y: 220, bodyAngle: 180, turretAngle: 180, radarAngle: 180 },
      enemySpawn: { x: 345, y: 330, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
    });
    let dstFlankDeflect = 0;
    for (let t = 0; t < 25; t++) {
      stepBattleTick(flank);
      if (flank.tanks[1].stats.damageTaken > 0 && dstFlankDeflect === 0) {
        dstFlankDeflect = Math.abs(((flank.tanks[1].bodyAngle - 90 + 540) % 360) - 180);
      }
    }
    expect(dstFlankDeflect).toBeGreaterThan(dstHeadDeflect);

    // 3. Anti-deadlock: identical Destroyers charging dead-center break symmetry and separate cleanly
    const mirror = createBattleState({
      player: mkMover('d1', 'destroyer'),
      enemy: mkMover('d2', 'destroyer'),
      arenaSize: 'small',
      playerSpawn: { x: 300, y: 330, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 400, y: 330, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });
    for (let t = 0; t < 80; t++) {
      stepBattleTick(mirror);
    }
    const finalDist = Math.hypot(
      mirror.tanks[0].x - mirror.tanks[1].x,
      mirror.tanks[0].y - mirror.tanks[1].y
    );
    expect(finalDist).toBeGreaterThan(CHASSIS_SPECS.destroyer.radius * 2 + 8);

    // 3b. Live ENEMY_DESTROYER_MASTER mirror match breaks head-on horn locks quickly
    const dstMaster = PRESET_ENEMIES.find((e) => e.name === '超重マスター');
    expect(dstMaster).toBeDefined();
    const dstMirror = createBattleState({
      player: dstMaster!,
      enemy: dstMaster!,
      arenaSize: 'medium',
    });
    let consecClose = 0;
    let maxConsecClose = 0;
    const minDistThreshold = CHASSIS_SPECS.destroyer.radius * 2 + 4;
    for (let t = 0; t < 500 && dstMirror.status === 'running'; t++) {
      stepBattleTick(dstMirror);
      for (const tk of dstMirror.tanks) {
        expect(Number.isFinite(tk.x)).toBe(true);
        expect(Number.isFinite(tk.y)).toBe(true);
        expect(tk.stats.wallHits).toBe(0);
      }
      const dist = Math.hypot(
        dstMirror.tanks[0].x - dstMirror.tanks[1].x,
        dstMirror.tanks[0].y - dstMirror.tanks[1].y
      );
      if (dist <= minDistThreshold) {
        consecClose++;
        if (consecClose > maxConsecClose) maxConsecClose = consecClose;
      } else {
        consecClose = 0;
      }
    }
    expect(maxConsecClose).toBeLessThanOrEqual(12);

    // 4. Wall & obstacle safeguard: corner pin keeps both tanks inside arena bounds
    const cornerPin = createBattleState({
      player: mkMover('h_wall', 'heavy'),
      enemy: mkMover('l_wall', 'light'),
      arenaSize: 'small',
      obstacles: [{ id: 'obs_pin', x: 80, y: 100, width: 60, height: 60 }],
      playerSpawn: { x: 75, y: 36, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
      enemySpawn: { x: 35, y: 36, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
    });
    for (let t = 0; t < 40; t++) {
      stepBattleTick(cornerPin);
      for (const tk of cornerPin.tanks) {
        const rr = CHASSIS_SPECS[tk.blueprint.assembly.chassis].radius;
        expect(tk.x).toBeGreaterThanOrEqual(rr - 1e-4);
        expect(tk.x).toBeLessThanOrEqual(cornerPin.arena.width - rr + 1e-4);
        expect(tk.y).toBeGreaterThanOrEqual(rr - 1e-4);
        expect(tk.y).toBeLessThanOrEqual(cornerPin.arena.height - rr + 1e-4);
      }
    }
  });

  it('executes blocking wait=True turns, stop() (act_halt), and learning-mode condition chips accurately', () => {
    // 1. Sequential move -> turn_body(delta=90, wait=True) -> move -> stop()
    const seqSrc = [
      'def on_tick():',
      '  move(speed=100, duration=0.2)',
      '  turn_body(mode="delta", angle=90, wait=True)',
      '  move(speed=100, duration=0.25)',
      '  stop()',
    ].join('\n');
    const seqParsed = parsePythonSourceToProgram(seqSrc, 6, 'relative');
    expect(seqParsed.ok).toBe(true);
    if (!seqParsed.ok) return;

    const seqBp: TankBlueprint = {
      ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'compact_6x6' },
      program: seqParsed.program,
    };
    let battle = createBattleState({
      player: seqBp,
      enemy: ENEMY_DUMMY,
      arenaSize: 'medium',
      playerSpawn: { x: 400, y: 600, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      enemySpawn: { x: 950, y: 600, bodyAngle: 180, turretAngle: 180, radarAngle: 180 },
    });

    let sawTurnWait = false;
    let sawMoveStopWhileWaiting = false;
    let haltedTick = -1;
    let headingAfterTurn = -1;

    for (let t = 0; t < 80; t++) {
      battle = stepBattleTick(battle);
      const p = battle.tanks[0];
      if (p.turnState) {
        sawTurnWait = true;
        if (p.lastCommands.targetSpeedRatio === 0) {
          sawMoveStopWhileWaiting = true;
        }
      } else if (sawTurnWait && headingAfterTurn < 0) {
        headingAfterTurn = p.bodyAngle;
      }
      if (p.halted && haltedTick < 0) {
        haltedTick = battle.tick;
        // Once halted, subsequent tick should execute 0 CPU steps and command 0 speed
        battle = stepBattleTick(battle);
        expect(battle.tanks[0].halted).toBe(true);
        expect(battle.tanks[0].trace.stepsUsed).toBe(0);
        expect(battle.tanks[0].lastCommands.targetSpeedRatio).toBe(0);
        break;
      }
    }

    expect(sawTurnWait).toBe(true);
    expect(sawMoveStopWhileWaiting).toBe(true);
    expect(Math.abs(normalizeAngle180(headingAfterTurn - 90))).toBeLessThanOrEqual(0.5);
    expect(haltedTick).toBeGreaterThan(0);
    // Tank moved north (~y < 600) first, then turned east (90 deg) and moved east (~x > 400)
    expect(battle.tanks[0].y).toBeLessThan(600);
    expect(battle.tanks[0].x).toBeGreaterThan(400);

    // 2. Cumulative delta +270 deg (>180) and -90 deg without wrapping shortcut
    const runDeltaCheck = (deltaDeg: number): number => {
      const pRes = parsePythonSourceToProgram(
        `def on_tick():\n  turn_body(mode="delta", angle=${deltaDeg}, wait=True)\n  stop()`,
        4,
        'relative'
      );
      expect(pRes.ok).toBe(true);
      if (!pRes.ok) return 0;
      const bp: TankBlueprint = {
        ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'mini_4x4' },
        program: pRes.program,
      };
      let st = createBattleState({
        player: bp,
        enemy: ENEMY_DUMMY,
        arenaSize: 'medium',
        playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      });
      let rotatedAccum = 0;
      let prev = st.tanks[0].bodyAngle;
      for (let t = 0; t < 160 && !st.tanks[0].halted; t++) {
        st = stepBattleTick(st);
        const cur = st.tanks[0].bodyAngle;
        rotatedAccum += normalizeAngle180(cur - prev);
        prev = cur;
      }
      expect(st.tanks[0].halted).toBe(true);
      return rotatedAccum;
    };
    expect(Math.abs(runDeltaCheck(270) - 270)).toBeLessThanOrEqual(1.0);
    expect(Math.abs(runDeltaCheck(-90) - -90)).toBeLessThanOrEqual(1.0);

    // 3. Preserves loopStack (for i in range(2)) and callStack (sub_a) across turnState wait
    const loopSubProg = buildProgram(6, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'loop_for', params: { iterations: 2 }, yes: { x: 1, y: 1 }, no: { x: 2, y: 0 } },
      { x: 1, y: 1, type: 'sub_call', params: { sub: 'A' }, next: null },
      { x: 2, y: 0, type: 'act_halt', params: {}, next: null },
      { x: 4, y: 0, type: 'sub_def', params: { sub: 'A' }, next: { x: 4, y: 1 } },
      { x: 4, y: 1, type: 'act_turn_body', params: { mode: 'delta', angle: 90, wait: 1 }, next: null },
    ]);
    let loopBattle = createBattleState({
      player: {
        ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'compact_6x6' },
        program: loopSubProg,
      },
      enemy: ENEMY_DUMMY,
      arenaSize: 'medium',
      playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
    });
    for (let t = 0; t < 120 && !loopBattle.tanks[0].halted; t++) {
      loopBattle = stepBattleTick(loopBattle);
    }
    expect(loopBattle.tanks[0].halted).toBe(true);
    expect(Math.abs(normalizeAngle180(loopBattle.tanks[0].bodyAngle - 180))).toBeLessThanOrEqual(1.0);

    // 4. act_turn_turret(wait=True) waits before firing; destroyer fixedTurret does not block
    const turretWaitSrc = [
      'def on_tick():',
      '  turn_turret(mode="delta", angle=90, wait=True)',
      '  fire_main(power="normal")',
      '  stop()',
    ].join('\n');
    const twParsed = parsePythonSourceToProgram(turretWaitSrc, 4, 'relative');
    expect(twParsed.ok).toBe(true);
    if (twParsed.ok) {
      let twBattle = createBattleState({
        player: {
          ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
          assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'mini_4x4' },
          program: twParsed.program,
        },
        enemy: ENEMY_DUMMY,
        arenaSize: 'medium',
        playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      });
      for (let t = 0; t < 40 && !twBattle.tanks[0].halted; t++) {
        twBattle = stepBattleTick(twBattle);
      }
      expect(twBattle.tanks[0].halted).toBe(true);
      expect(twBattle.tanks[0].stats.shotsFired).toBe(1);
      expect(Math.abs(normalizeAngle180(twBattle.tanks[0].turretAngle - 90))).toBeLessThanOrEqual(0.5);

      // Fixed-turret destroyer skips turret wait cleanly in 1 tick without blocking
      let fixedBattle = createBattleState({
        player: {
          ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
          assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'destroyer', cpu: 'mini_4x4' },
          program: twParsed.program,
        },
        enemy: ENEMY_DUMMY,
        arenaSize: 'medium',
        playerSpawn: { x: 400, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      });
      fixedBattle = stepBattleTick(fixedBattle);
      expect(fixedBattle.tanks[0].turnState).toBeNull();
      expect(fixedBattle.tanks[0].halted).toBe(true);
    }

    // 5. cond_floor_tile & cond_mission_state evaluation + learningOnly visibility flags
    expect(CHIP_DEFINITIONS.cond_floor_tile.learningOnly).toBe(true);
    expect(CHIP_DEFINITIONS.cond_mission_state.learningOnly).toBe(true);
    expect(CHIP_DEFINITIONS.act_halt.learningOnly).toBeUndefined();

    const sensorProg = buildProgram(6, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_floor_tile', params: { target: 'goal' }, yes: { x: 1, y: 1 }, no: { x: 2, y: 0 } },
      { x: 1, y: 1, type: 'mode_set', params: { mode: 2 }, next: null },
      { x: 2, y: 0, type: 'cond_mission_state', params: { check: 'targets_remaining' }, yes: { x: 2, y: 1 }, no: { x: 3, y: 0 } },
      { x: 2, y: 1, type: 'mode_set', params: { mode: 1 }, next: null },
      { x: 3, y: 0, type: 'act_halt', params: {}, next: null },
    ]);
    const sensorBattle = createBattleState({
      player: {
        ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'compact_6x6' },
        program: sensorProg,
      },
      enemy: ENEMY_DUMMY,
      arenaSize: 'small',
      playerSpawn: { x: 150, y: 150, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      tiles: [
        { id: 't_blue', kind: 'color', color: 'blue', x: 100, y: 100, width: 100, height: 100 },
        { id: 't_cp_done', kind: 'checkpoint', x: 100, y: 100, width: 100, height: 100, visited: true },
        { id: 't_goal', kind: 'goal', x: 500, y: 100, width: 100, height: 100 },
      ],
      targets: [
        { id: 'b1', kind: 'shoot_balloon', x: 600, y: 200, radius: 18, hp: 10, maxHp: 10, popped: false },
      ],
    });
    const pt = sensorBattle.tanks[0];
    // At (150, 150): not on goal, 1 target remaining -> sets mode = 1
    runTankChipProgram(pt, 1, sensorBattle.arena, sensorBattle.projectiles, sensorBattle.tanks);
    expect(pt.mode).toBe(1);
    // Pop target -> targets_remaining false -> reaches act_halt
    sensorBattle.arena.targets![0].popped = true;
    runTankChipProgram(pt, 2, sensorBattle.arena, sensorBattle.projectiles, sensorBattle.tanks);
    expect(pt.halted).toBe(true);
    // Reset halted and move onto goal tile -> cond_floor_tile('goal') true -> sets mode = 2
    pt.halted = false;
    pt.x = 550;
    pt.y = 150;
    runTankChipProgram(pt, 3, sensorBattle.arena, sensorBattle.projectiles, sensorBattle.tanks);
    expect(pt.mode).toBe(2);
  });

  it('supports cond_proximity(mode="front"), act_fire(wait=True), and edge-triggered cond_floor_tile(edge=True)', () => {
    // 1. cond_proximity(mode="front"): stationary forward-only ray check (ignores side corridor walls)
    const frontProg = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_proximity', params: { mode: 'front', target: 'walls', dist: 80 }, yes: { x: 1, y: 1 }, no: { x: 2, y: 0 } },
      { x: 1, y: 1, type: 'mode_set', params: { mode: 1 }, next: null },
      { x: 2, y: 0, type: 'mode_set', params: { mode: 2 }, next: null },
    ]);
    const corridorWallRight = { id: 'side_r', x: 335, y: 100, width: 40, height: 400 };
    const frontWallAhead = { id: 'front_obs', x: 250, y: 120, width: 100, height: 30 };
    const proxBattle = createBattleState({
      player: {
        ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', cpu: 'mini_4x4' },
        program: frontProg,
      },
      enemy: ENEMY_DUMMY,
      arenaSize: 'small',
      obstacles: [corridorWallRight, frontWallAhead],
      playerSpawn: { x: 300, y: 300, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
    });
    const pt = proxBattle.tanks[0];
    // Side wall is only 15px clearance to the right (335 - (300+20)), front wall is 130px ahead (>80) -> mode = 2 (False!)
    runTankChipProgram(pt, 1, proxBattle.arena, proxBattle.projectiles, proxBattle.tanks);
    expect(pt.mode).toBe(2);
    // Move closer to front wall (y=210 -> clearance 210-150-20 = 40px <= 80) -> mode = 1 (True!)
    pt.y = 210;
    runTankChipProgram(pt, 2, proxBattle.arena, proxBattle.projectiles, proxBattle.tanks);
    expect(pt.mode).toBe(1);

    // 2. act_fire(wait=True) inside for loop fires exact 2 shots despite turn finishing before gun cooldown
    const fireWaitSrc = [
      'def on_tick():',
      '  for i in range(2):',
      '    turn_turret(mode="delta", angle=90, wait=True)',
      '    fire_main(power="normal", wait=True)',
      '  stop()',
    ].join('\n');
    const fwParsed = parsePythonSourceToProgram(fireWaitSrc, 6, 'relative');
    expect(fwParsed.ok).toBe(true);
    if (fwParsed.ok) {
      let fwBattle = createBattleState({
        player: {
          ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
          assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard', mainGun: 'standard', cpu: 'compact_6x6' },
          program: fwParsed.program,
        },
        enemy: ENEMY_DUMMY,
        arenaSize: 'medium',
        playerSpawn: { x: 500, y: 500, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
      });
      let sawFireWait = false;
      for (let t = 0; t < 120 && !fwBattle.tanks[0].halted; t++) {
        fwBattle = stepBattleTick(fwBattle);
        if (fwBattle.tanks[0].fireState) sawFireWait = true;
      }
      expect(sawFireWait).toBe(true);
      expect(fwBattle.tanks[0].halted).toBe(true);
      expect(fwBattle.tanks[0].stats.shotsFired).toBe(2);
      expect(Math.abs(normalizeAngle180(fwBattle.tanks[0].turretAngle - 180))).toBeLessThanOrEqual(0.5);
    }

    // 3. cond_floor_tile(edge=True) fires once on entry, suppresses while staying, and resets upon leaving
    const edgeProg = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_floor_tile', params: { target: 'blue', edge: 1 }, yes: { x: 1, y: 1 }, no: null },
      { x: 1, y: 1, type: 'counter_op', params: { reg: 'A', op: 'inc', value: 1 }, next: null },
    ]);
    const edgeBattle = createBattleState({
      player: {
        ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
        program: edgeProg,
      },
      enemy: ENEMY_DUMMY,
      arenaSize: 'small',
      playerSpawn: { x: 150, y: 150, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      tiles: [
        { id: 't_b1', kind: 'color', color: 'blue', x: 100, y: 100, width: 100, height: 100 },
        { id: 't_b2', kind: 'color', color: 'blue', x: 300, y: 100, width: 100, height: 100 },
      ],
    });
    const et = edgeBattle.tanks[0];
    // Tick 1: enters t_b1 -> A becomes 1
    runTankChipProgram(et, 1, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    expect(et.counters.A).toBe(1);
    // Ticks 2 & 3: still on t_b1 -> A stays 1
    runTankChipProgram(et, 2, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    runTankChipProgram(et, 3, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    expect(et.counters.A).toBe(1);
    // Step onto t_b2 (different tile id) -> increments to 2
    et.x = 350;
    runTankChipProgram(et, 4, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    expect(et.counters.A).toBe(2);
    // Leave tile bounds -> clears latch, then re-entering t_b2 increments to 3
    et.x = 250;
    runTankChipProgram(et, 5, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    et.x = 350;
    runTankChipProgram(et, 6, edgeBattle.arena, edgeBattle.projectiles, edgeBattle.tanks);
    expect(et.counters.A).toBe(3);
  });

  it('completes all Lesson 1 learning missions (1-1 through 1-6) with starter solutions and verifies fail guards', () => {
    const l1Missions = LEARNING_MISSIONS.filter((m) => m.lessonNumber === 1);
    expect(l1Missions).toHaveLength(6);

    for (const mission of l1Missions) {
      // Grid fit & Python round-trip check
      const fit = validateGridBlockFit(
        mission.playerStarter.program.cells,
        mission.playerStarter.program.gridSize
      );
      expect(fit.valid, `${mission.id} grid fit`).toBe(true);
      const src = transpileProgramToLines(
        mission.playerStarter.program,
        mission.playerStarter.name,
        false,
        mission.playerStarter.assembly.radar,
        mission.playerStarter.assembly.chassis,
        mission.playerStarter.assembly.mainGun,
        mission.playerStarter.assembly.subWeapon
      )
        .map((l) => l.text)
        .join('\n');
      const reparsed = parsePythonSourceToProgram(
        src,
        mission.playerStarter.program.gridSize,
        mission.playerStarter.program.coordinateMode
      );
      expect(reparsed.ok, `${mission.id} Python reparse`).toBe(true);

      // Run simulation until finished
      let st = createBattleState({
        player: mission.playerStarter,
        enemies: mission.enemies ?? [],
        arenaSize: mission.arenaSize,
        obstacles: mission.obstacles,
        tiles: mission.tiles,
        targets: mission.targets,
        learningRule: mission.goalRule,
        maxTicks: mission.maxTicks,
        playerSpawn: mission.playerSpawn,
        enemySpawns: mission.enemySpawns,
      });

      while (st.status === 'running' && st.tick < mission.maxTicks) {
        st = stepBattleTick(st);
      }
      expect(st.status, `${mission.id} status`).toBe('finished');
      expect(st.winnerId, `${mission.id} winner`).toBe('player');
      expect(st.winType, `${mission.id} winType (${st.endReason})`).toBe('mission');
      expect(st.tanks[0].stats.wallHits, `${mission.id} wallHits`).toBe(0);
    }

    // Fail guards on 1-1:
    // (A) Without stop(), tank overshoots goal and hits east wall -> defeat
    const m1 = l1Missions[0];
    const noStopBp: TankBlueprint = {
      ...m1.playerStarter,
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 3.0 }, next: null },
      ]),
    };
    let noStopSt = createBattleState({
      player: noStopBp,
      arenaSize: m1.arenaSize,
      obstacles: m1.obstacles,
      tiles: m1.tiles,
      targets: m1.targets,
      learningRule: m1.goalRule,
      maxTicks: m1.maxTicks,
      playerSpawn: m1.playerSpawn,
    });
    while (noStopSt.status === 'running' && noStopSt.tick < m1.maxTicks) {
      noStopSt = stepBattleTick(noStopSt);
    }
    expect(noStopSt.status).toBe('finished');
    expect(noStopSt.winType).toBe('defeat');

    // (B) Stopping too early fails goal check promptly -> defeat
    const earlyStopBp: TankBlueprint = {
      ...m1.playerStarter,
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0.5 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_halt', params: {}, next: null },
      ]),
    };
    let earlySt = createBattleState({
      player: earlyStopBp,
      arenaSize: m1.arenaSize,
      obstacles: m1.obstacles,
      tiles: m1.tiles,
      targets: m1.targets,
      learningRule: m1.goalRule,
      maxTicks: m1.maxTicks,
      playerSpawn: m1.playerSpawn,
    });
    while (earlySt.status === 'running' && earlySt.tick < m1.maxTicks) {
      earlySt = stepBattleTick(earlySt);
    }
    expect(earlySt.status).toBe('finished');
    expect(earlySt.winType).toBe('defeat');
    expect(earlySt.endReason).toContain('stop()');
  });

  it('completes all Lesson 2 learning missions (2-1 through 2-6) across all variants and enforces anti-hardcode checks', () => {
    const l2Missions = LEARNING_MISSIONS.filter((m) => m.lessonNumber === 2);
    expect(l2Missions).toHaveLength(6);

    for (const mission of l2Missions) {
      const fit = validateGridBlockFit(
        mission.playerStarter.program.cells,
        mission.playerStarter.program.gridSize
      );
      expect(fit.valid, `${mission.id} grid fit`).toBe(true);

      const src = transpileProgramToLines(
        mission.playerStarter.program,
        mission.playerStarter.name,
        false,
        mission.playerStarter.assembly.radar,
        mission.playerStarter.assembly.chassis,
        mission.playerStarter.assembly.mainGun,
        mission.playerStarter.assembly.subWeapon
      )
        .map((l) => l.text)
        .join('\n');
      const reparsed = parsePythonSourceToProgram(
        src,
        mission.playerStarter.program.gridSize,
        mission.playerStarter.program.coordinateMode
      );
      expect(reparsed.ok, `${mission.id} Python reparse`).toBe(true);

      const varCount = mission.variants && mission.variants.length > 0 ? mission.variants.length : 1;
      for (let vIdx = 0; vIdx < varCount; vIdx++) {
        const resolved = resolveMissionVariant(mission, vIdx);
        let st = createBattleState({
          player: mission.playerStarter,
          enemies: resolved.enemies,
          arenaSize: resolved.arenaSize,
          obstacles: resolved.obstacles,
          tiles: resolved.tiles,
          targets: resolved.targets,
          learningRule: mission.goalRule,
          maxTicks: mission.maxTicks,
          playerSpawn: resolved.playerSpawn,
          enemySpawns: resolved.enemySpawns,
        });
        while (st.status === 'running' && st.tick < mission.maxTicks) {
          st = stepBattleTick(st);
        }
        const dbg = `pos=(${Math.round(st.tanks[0].x)},${Math.round(st.tanks[0].y)},ang=${Math.round(st.tanks[0].bodyAngle)}) halted=${st.tanks[0].halted} cps=${(st.arena.tiles ?? []).filter((t) => t.kind === 'checkpoint').map((t) => `${t.id}:${Boolean(t.visited)}`).join(',')} tgts=${(st.arena.targets ?? []).map((t) => `${t.id}:${Boolean(t.popped)}`).join(',')}`;
        expect(st.status, `${mission.id} var=${vIdx} status ${dbg}`).toBe('finished');
        expect(st.winnerId, `${mission.id} var=${vIdx} winner (${st.endReason}) ${dbg}`).toBe('player');
        expect(st.winType, `${mission.id} var=${vIdx} winType`).toBe('mission');
        expect(st.tanks[0].stats.wallHits, `${mission.id} var=${vIdx} wallHits`).toBe(0);
      }
    }

    // Anti-hardcode verification on 2-1: a fixed duration turn made for Pattern A fails on Pattern B
    const m21 = l2Missions[0];
    const hardcoded21: TankBlueprint = {
      ...m21.playerStarter,
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 2.2 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_turn_body', params: { mode: 'delta', angle: -90, wait: 1 }, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 4.5 }, next: null },
      ]),
    };
    const var21b = resolveMissionVariant(m21, 1);
    let failHardSt = createBattleState({
      player: hardcoded21,
      arenaSize: var21b.arenaSize,
      obstacles: var21b.obstacles,
      tiles: var21b.tiles,
      targets: var21b.targets,
      learningRule: m21.goalRule,
      maxTicks: m21.maxTicks,
      playerSpawn: var21b.playerSpawn,
    });
    while (failHardSt.status === 'running' && failHardSt.tick < m21.maxTicks) {
      failHardSt = stepBattleTick(failHardSt);
    }
    expect(failHardSt.status).toBe('finished');
    expect(failHardSt.winType).toBe('defeat');
  });
});

describe('Learning Mode Lesson 3 missions (3-1 to 3-6)', () => {
  const l3Missions = LEARNING_MISSIONS.filter((m) => m.lessonNumber === 3);

  function runLearningMissionSimulation(
    mission: (typeof LEARNING_MISSIONS)[number],
    bp: TankBlueprint,
    variantIndex = 0
  ) {
    const resolved = resolveMissionVariant(mission, variantIndex);
    let state = createBattleState({
      player: bp,
      enemies: resolved.enemies,
      arenaSize: resolved.arenaSize,
      obstacles: resolved.obstacles,
      tiles: resolved.tiles,
      targets: resolved.targets,
      learningRule: mission.goalRule,
      maxTicks: mission.maxTicks,
      playerSpawn: resolved.playerSpawn,
      enemySpawns: resolved.enemySpawns,
    });
    for (let i = 0; i < mission.maxTicks && state.status !== 'finished'; i += 1) {
      state = stepBattleTick(state);
    }
    return state;
  }

  it('provides 6 structured Lesson 3 missions (3-1 to 3-6) on 6x6 CPU that round-trip Python', () => {
    expect(l3Missions.map((m) => m.missionCode)).toEqual(['3-1', '3-2', '3-3', '3-4', '3-5', '3-6']);
    for (const mission of l3Missions) {
      expect(mission.playerStarter.assembly.cpu).toBe('compact_6x6');
      expect(mission.playerStarter.program.gridSize).toBe(6);

      const lines = transpileProgramToLines(
        mission.playerStarter.program,
        mission.playerStarter.name,
        false,
        mission.playerStarter.assembly.radar,
        mission.playerStarter.assembly.chassis,
        mission.playerStarter.assembly.mainGun,
        mission.playerStarter.assembly.subWeapon
      );
      const parsed = parsePythonSourceToProgram(
        lines.map((l) => l.text).join('\n'),
        mission.playerStarter.program.gridSize,
        mission.playerStarter.program.coordinateMode
      );
      expect(parsed.ok, `${mission.missionCode} parsePython`).toBe(true);
      if (parsed.ok) {
        expect(
          validateGridBlockFit(parsed.program.cells, mission.playerStarter.program.gridSize).valid,
          `${mission.missionCode} fit 6x6`
        ).toBe(true);
        const reparsedBp: TankBlueprint = {
          ...mission.playerStarter,
          program: parsed.program,
        };
        if (mission.missionCode !== '3-5') {
          const st = runLearningMissionSimulation(mission, reparsedBp, 0);
          expect(st.status, `${mission.missionCode} reparsed status`).toBe('finished');
          expect(st.winType, `${mission.missionCode} reparsed win`).toBe('mission');
        }
      }
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it('auto-clears every Lesson 3 mission and all multi-pattern variants cleanly', () => {
    for (const mission of l3Missions) {
      if (mission.missionCode === '3-5') continue; // verified deterministically across both random branches below
      const variantCount = mission.variants && mission.variants.length > 0 ? mission.variants.length : 1;
      for (let v = 0; v < variantCount; v += 1) {
        const finalState = runLearningMissionSimulation(mission, mission.playerStarter, v);
        expect(finalState.status, `${mission.missionCode} v${v}`).toBe('finished');
        expect(finalState.winType, `${mission.missionCode} v${v}`).toBe('mission');
        const player = finalState.tanks.find((t) => t.team === 'player')!;
        if (mission.goalRule.maxWallHits !== undefined) {
          expect(player.stats.wallHits, `${mission.missionCode} v${v} wallHits`).toBeLessThanOrEqual(
            mission.goalRule.maxWallHits
          );
        }
        if (mission.goalRule.requireAllTargetsPopped) {
          expect(
            (finalState.arena.targets ?? []).every((t) => t.popped),
            `${mission.missionCode} v${v} targets popped`
          ).toBe(true);
        }
        if (mission.goalRule.requireAllCheckpoints) {
          expect(
            (finalState.arena.tiles ?? []).filter((t) => t.kind === 'checkpoint').every((t) => t.visited),
            `${mission.missionCode} v${v} checkpoints visited`
          ).toBe(true);
        }
      }
    }
  });

  it('enforces variable count threshold on 3-1 (turning early at a == 1 hits ceiling wall)', () => {
    const m31 = l3Missions.find((m) => m.missionCode === '3-1')!;
    const earlyBp: TankBlueprint = structuredClone(m31.playerStarter);
    for (const row of earlyBp.program.cells) {
      for (const cell of row) {
        if (cell?.type === 'cond_counter') {
          cell.params.value = 1;
        }
      }
    }
    const st = runLearningMissionSimulation(m31, earlyBp, 0);
    expect(st.winType).not.toBe('mission');
  });

  it('proves 3-4 lead prediction hits moving balloons whereas direct aiming misses', () => {
    const m34 = l3Missions.find((m) => m.missionCode === '3-4')!;
    const directBp: TankBlueprint = structuredClone(m34.playerStarter);
    for (const row of directBp.program.cells) {
      for (const cell of row) {
        if (cell?.type === 'act_aim_enemy') {
          cell.params.lead = 'direct';
        }
      }
    }
    const directState = runLearningMissionSimulation(m34, directBp, 0);
    expect(directState.winType).not.toBe('mission');
  });

  it('clears 3-5 cleanly via both random.randint(0, 1) left (0) and right (1) detour branches', () => {
    const m35 = l3Missions.find((m) => m.missionCode === '3-5')!;

    const spyLeft = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    try {
      const leftState = runLearningMissionSimulation(m35, m35.playerStarter, 0);
      expect(leftState.status).toBe('finished');
      expect(leftState.winType).toBe('mission');
      const pLeft = leftState.tanks.find((t) => t.team === 'player')!;
      expect(pLeft.stats.wallHits).toBe(0);
      expect(pLeft.x).toBeLessThan(340);
    } finally {
      spyLeft.mockRestore();
    }

    const spyRight = vi.spyOn(Math, 'random').mockReturnValue(0.95);
    try {
      const rightState = runLearningMissionSimulation(m35, m35.playerStarter, 0);
      expect(rightState.status).toBe('finished');
      expect(rightState.winType).toBe('mission');
      const pRight = rightState.tanks.find((t) => t.team === 'player')!;
      expect(pRight.stats.wallHits).toBe(0);
      expect(pRight.x).toBeGreaterThan(460);
    } finally {
      spyRight.mockRestore();
    }
  });
});

describe('Learning Mode Lesson 4 missions (4-1 to 4-6) & full 24-mission curriculum', () => {
  const l4Missions = LEARNING_MISSIONS.filter((m) => m.lessonNumber === 4);

  function runMissionSim(
    mission: (typeof LEARNING_MISSIONS)[number],
    bp: TankBlueprint,
    variantIndex = 0
  ) {
    const resolved = resolveMissionVariant(mission, variantIndex);
    let state = createBattleState({
      player: bp,
      enemies: resolved.enemies,
      arenaSize: resolved.arenaSize,
      obstacles: resolved.obstacles,
      tiles: resolved.tiles,
      targets: resolved.targets,
      learningRule: mission.goalRule,
      maxTicks: mission.maxTicks,
      playerSpawn: resolved.playerSpawn,
      enemySpawns: resolved.enemySpawns,
    });
    for (let i = 0; i < mission.maxTicks && state.status !== 'finished'; i += 1) {
      state = stepBattleTick(state);
    }
    return state;
  }

  it('completes all 24 Learning Mode missions across 4 lessons with expected CPU sizes and Python round-trips', () => {
    expect(LEARNING_MISSIONS).toHaveLength(24);
    expect(l4Missions.map((m) => m.missionCode)).toEqual(['4-1', '4-2', '4-3', '4-4', '4-5', '4-6']);

    const expectedSizes: Record<string, number> = {
      '4-1': 6,
      '4-2': 8,
      '4-3': 6,
      '4-4': 6,
      '4-5': 8,
      '4-6': 8,
    };

    for (const mission of l4Missions) {
      const expectedGrid = expectedSizes[mission.missionCode];
      expect(mission.playerStarter.program.gridSize).toBe(expectedGrid);
      expect(mission.playerStarter.assembly.cpu).toBe(cpuIdForGridSize(expectedGrid as 6 | 8));

      const lines = transpileProgramToLines(
        mission.playerStarter.program,
        mission.playerStarter.name,
        false,
        mission.playerStarter.assembly.radar,
        mission.playerStarter.assembly.chassis,
        mission.playerStarter.assembly.mainGun,
        mission.playerStarter.assembly.subWeapon
      );
      const parsed = parsePythonSourceToProgram(
        lines.map((l) => l.text).join('\n'),
        mission.playerStarter.program.gridSize,
        mission.playerStarter.program.coordinateMode
      );
      expect(parsed.ok, `${mission.missionCode} parsePython`).toBe(true);
      if (parsed.ok) {
        expect(
          validateGridBlockFit(parsed.program.cells, mission.playerStarter.program.gridSize).valid,
          `${mission.missionCode} grid fit`
        ).toBe(true);
        const reparsedBp: TankBlueprint = {
          ...mission.playerStarter,
          program: parsed.program,
        };
        const reparsedState = runMissionSim(mission, reparsedBp, 0);
        expect(reparsedState.status, `${mission.missionCode} reparsed status`).toBe('finished');
        expect(reparsedState.winType, `${mission.missionCode} reparsed win`).toBe('mission');
      }
    }
  });

  it('auto-clears all Lesson 4 missions and variants cleanly', () => {
    for (const mission of l4Missions) {
      const variantCount = mission.variants && mission.variants.length > 0 ? mission.variants.length : 1;
      for (let v = 0; v < variantCount; v += 1) {
        const finalState = runMissionSim(mission, mission.playerStarter, v);
        const unvisited = (finalState.arena.tiles ?? [])
          .filter((t) => t.kind === 'checkpoint' && !t.visited)
          .map((t) => t.id);
        expect(finalState.status, `${mission.missionCode} v${v} (${finalState.endReason})`).toBe('finished');
        expect(
          finalState.winType,
          `${mission.missionCode} v${v}: ${finalState.endReason}; arena=${finalState.arena.width}x${finalState.arena.height}; unvisited=${unvisited.join(',')}; pos=(${Math.round(finalState.tanks[0]?.x ?? 0)},${Math.round(finalState.tanks[0]?.y ?? 0)})`
        ).toBe('mission');
        const player = finalState.tanks.find((t) => t.team === 'player')!;
        if (mission.goalRule.maxWallHits !== undefined) {
          expect(player.stats.wallHits, `${mission.missionCode} v${v} wallHits`).toBeLessThanOrEqual(
            mission.goalRule.maxWallHits
          );
        }
        if (mission.goalRule.requireAllTargetsPopped) {
          expect(
            (finalState.arena.targets ?? []).every((t) => t.popped),
            `${mission.missionCode} v${v} targets popped`
          ).toBe(true);
        }
        if (mission.goalRule.requireAllCheckpoints) {
          const cps = (finalState.arena.tiles ?? []).filter((t) => t.kind === 'checkpoint');
          expect(cps.every((t) => t.visited), `${mission.missionCode} v${v} checkpoints visited`).toBe(
            true
          );
          if (mission.missionCode === '4-5') {
            expect(cps).toHaveLength(8);
            expect(player.mode).toBe(1);
          }
        }
      }
    }
  });

  it('proves 4-3 requires absolute heading (relative delta fails when spawn angle flips)', () => {
    const m43 = l4Missions.find((m) => m.missionCode === '4-3')!;
    const relBp: TankBlueprint = structuredClone(m43.playerStarter);
    relBp.program.coordinateMode = 'relative';
    for (const row of relBp.program.cells) {
      for (const cell of row) {
        if (cell?.type === 'act_turn_body') {
          cell.params.mode = 'delta';
        }
      }
    }
    const v1Rel = runMissionSim(m43, relBp, 1);
    expect(v1Rel.winType).not.toBe('mission');
  });

  it('proves 4-4 rewards fast lightweight assembly over heavy slow hardware within strict time limit', () => {
    const m44 = l4Missions.find((m) => m.missionCode === '4-4')!;
    const fastState = runMissionSim(m44, m44.playerStarter, 0);
    expect(fastState.winType).toBe('mission');
    expect(fastState.tick).toBeLessThanOrEqual(m44.maxTicks);

    const heavyBp: TankBlueprint = structuredClone(m44.playerStarter);
    heavyBp.assembly.chassis = 'heavy';
    heavyBp.assembly.mainGun = 'cannon';
    heavyBp.assembly.radar = 'long';
    for (const row of heavyBp.program.cells) {
      for (const cell of row) {
        if (cell?.type === 'act_fire') {
          cell.params.power = 'heavy';
        }
      }
    }
    const heavyState = runMissionSim(m44, heavyBp, 0);
    expect(heavyState.winType).not.toBe('mission');
  });

  it('matches cond_enemy_sector against recent lead aim angle and bridges/auto-sizes Python imports cleanly', () => {
    // 1. cond_enemy_sector with narrow halfWidth=6 matches when turret aims at lastAimAngle from aim_enemy(lead)
    const leadBp: TankBlueprint = {
      ...JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)),
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'cond_enemy_sector',
          params: { ref: 'turret', centerAngle: 0, halfWidth: 6, maxDist: 900 },
          yes: { x: 2, y: 0 },
          no: null,
        },
        { x: 2, y: 0, type: 'act_fire', params: { power: 'normal' }, next: null },
      ]),
    };
    const stLead = createBattleState({
      player: leadBp,
      enemy: ENEMY_DUMMY,
      playerSpawn: { x: 200, y: 400, bodyAngle: 0, turretAngle: 108, radarAngle: 90 },
      enemySpawn: { x: 600, y: 400, bodyAngle: 0, turretAngle: 0, radarAngle: 0 },
    });
    const playerTank = stLead.tanks[0];
    // Direct bearing is 90 deg, turret is at 108 deg (18 deg off direct -> normally false for halfWidth=6),
    // but recent aim_enemy(lead) computed lastAimAngle = 109 deg (1 deg off turret -> true).
    playerTank.detectedEnemy = {
      id: stLead.tanks[1].id,
      x: 600,
      y: 400,
      vx: 0,
      vy: 5,
      speed: 5,
      heading: 180,
      hp: stLead.tanks[1].hp,
      distance: 400,
      bearingFromBody: 90,
      bearingFromTurret: -18,
      absoluteBearing: 90,
      lastSeenTick: 1,
    };
    playerTank.lastAimAngle = 109;
    playerTank.lastAimTick = 1;
    const resLead = runTankChipProgram(playerTank, 1, stLead.arena, stLead.projectiles, stLead.tanks);
    expect(resLead.commands.firePower).toBe(1.8);

    // 2. If without else followed by sequential statement bridges orthogonally with wire cells
    const ifContinueSrc = [
      'def on_tick():',
      '  if main_cooldown == 0:',
      '    fire_main(power="normal")',
      '  move(speed=80)',
    ].join('\n');
    const parsedBridge = parsePythonSourceToProgram(ifContinueSrc, 4, 'relative');
    expect(parsedBridge.ok).toBe(true);
    if (parsedBridge.ok) {
      const cells = parsedBridge.program.cells;
      for (let y = 0; y < cells.length; y++) {
        for (let x = 0; x < cells[y].length; x++) {
          const c = cells[y][x];
          if (!c) continue;
          for (const target of [c.next, c.yes, c.no]) {
            if (!target) continue;
            const dist = Math.abs(target.x - x) + Math.abs(target.y - y);
            expect(dist, `(${x},${y})->(${target.x},${target.y})`).toBe(1);
          }
        }
      }
    }

    // 3. Auto-size Python import upgrades 4x4 -> 6x6 when 20 blocks are parsed
    const twentyBlockSource = [
      'def on_tick():',
      ...Array.from({ length: 19 }, () => '  move(speed=50)'),
    ].join('\n');
    const autoSized = parsePythonSourceWithAutoSize(twentyBlockSource, 4, 'relative');
    expect(autoSized.ok).toBe(true);
    if (autoSized.ok) {
      expect(autoSized.program.gridSize).toBe(6);
      expect(autoSized.warnings?.[0]).toContain('4×4 → 6×6');
    }
  });

  it('embeds author_name and author_uuid in Python source, truncates oversized lengths on import, preserves share metadata, and manages UserProfile UUID', () => {
    const sampleUuid = generateUuidV4();
    expect(sampleUuid).toHaveLength(36);
    expect(sampleUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // 1. Transpile embeds tank_name, author_name, author_uuid right after import time
    const lines = transpileProgramToLines(
      DEFAULT_PLAYER_BLUEPRINT.program,
      'テスト戦車1号',
      true,
      DEFAULT_PLAYER_BLUEPRINT.assembly.radar,
      DEFAULT_PLAYER_BLUEPRINT.assembly.chassis,
      DEFAULT_PLAYER_BLUEPRINT.assembly.mainGun,
      DEFAULT_PLAYER_BLUEPRINT.assembly.subWeapon,
      DEFAULT_PLAYER_BLUEPRINT.color,
      'パイロット太郎',
      sampleUuid
    );
    const codeStrings = lines.map((l) => l.text);
    const importIdx = codeStrings.indexOf('import time');
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(codeStrings[importIdx + 1]).toContain('tank_name = "テスト戦車1号"');
    expect(codeStrings[importIdx + 2]).toContain('author_name = "パイロット太郎"');
    expect(codeStrings[importIdx + 3]).toContain(`author_uuid = "${sampleUuid}"`);
    expect(codeStrings[importIdx + 4]).toContain(`game_version = "${CURRENT_GAME_VERSION}"`);

    const roundTrip = parsePythonSourceToProgram(codeStrings.join('\n'), 4, 'relative');
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) {
      expect(roundTrip.tankName).toBe('テスト戦車1号');
      expect(roundTrip.authorName).toBe('パイロット太郎');
      expect(roundTrip.authorUuid).toBe(sampleUuid);
      expect(roundTrip.gameVersion).toBe(CURRENT_GAME_VERSION);
    }

    // 2. Oversized metadata in Python source truncates cleanly on import
    const oversizedSource = [
      'import time',
      'tank_name = "あいうえおかきくけこさしすせそたちつてと"', // 20 chars -> 16
      'author_name = "１２３４５６７８９０"', // 10 chars -> 8
      `author_uuid = "${sampleUuid}-extra-suffix"`, // > 36 -> 36
      'def on_tick():',
      '  move(speed=50)',
    ].join('\n');
    const parsedOversized = parsePythonSourceToProgram(oversizedSource, 4, 'relative');
    expect(parsedOversized.ok).toBe(true);
    if (parsedOversized.ok) {
      expect(parsedOversized.tankName).toBe('あいうえおかきくけこさしすせそた');
      expect(Array.from(parsedOversized.tankName ?? '').length).toBe(MAX_TANK_NAME_LENGTH);
      expect(parsedOversized.authorName).toBe('１２３４５６７８');
      expect(Array.from(parsedOversized.authorName ?? '').length).toBe(MAX_AUTHOR_NAME_LENGTH);
      expect(parsedOversized.authorUuid).toBe(sampleUuid);
      expect(Array.from(parsedOversized.authorUuid ?? '').length).toBe(MAX_AUTHOR_UUID_LENGTH);
    }

    // 3. Share code round-trip preserves author and authorUuid, and normalizer truncates oversized values
    const bpWithAuthor: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: 'テスト戦車1号',
      author: 'ユーザーA',
      authorUuid: sampleUuid,
    };
    const encoded = encodeShareCode(bpWithAuthor);
    const decoded = decodeShareCode(encoded);
    expect(decoded.name).toBe('テスト戦車1号');
    expect(decoded.author).toBe('ユーザーA');
    expect(decoded.authorUuid).toBe(sampleUuid);

    const oversizedBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: '一二三四五六七八九十一二三四五六七八九十',
      author: '全角八文字を超える長い名前',
      authorUuid: `${sampleUuid}ZZZZ`,
    };
    const normalized = validateAndNormalizeBlueprint(oversizedBp);
    expect(Array.from(normalized.name).length).toBe(MAX_TANK_NAME_LENGTH);
    expect(Array.from(normalized.author ?? '').length).toBe(MAX_AUTHOR_NAME_LENGTH);
    expect(normalized.author).toBe('全角八文字を超え');
    expect(normalized.authorUuid).toBe(sampleUuid);

    // Also encode oversized blueprint directly to confirm decodeShareCode enforces limits
    const encodedOversized = encodeShareCode(oversizedBp);
    const decodedOversized = decodeShareCode(encodedOversized);
    expect(Array.from(decodedOversized.name).length).toBe(MAX_TANK_NAME_LENGTH);
    expect(Array.from(decodedOversized.author ?? '').length).toBe(MAX_AUTHOR_NAME_LENGTH);
    expect(decodedOversized.authorUuid).toBe(sampleUuid);

    // 4. UserProfile loadUserProfile / saveUserName persists UUID across name edits
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
    });
    try {
      const initialProfile = loadUserProfile();
      expect(initialProfile.userId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(initialProfile.userName).toBe('Player');

      const updatedProfile = saveUserName('テストプレイヤー１２３');
      expect(updatedProfile.userName).toBe('テストプレイヤー');
      expect(Array.from(updatedProfile.userName).length).toBe(MAX_AUTHOR_NAME_LENGTH);
      expect(updatedProfile.userId).toBe(initialProfile.userId);

      const reloadedProfile = loadUserProfile();
      expect(reloadedProfile.userName).toBe('テストプレイヤー');
      expect(reloadedProfile.userId).toBe(initialProfile.userId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('builds, encodes, decodes, validates, and restores full user environment dumps (VSE1- and JSON)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
    });

    try {
      const profile = saveUserName('ゆうや太郎');
      saveBlueprintToStorage({
        ...DEFAULT_PLAYER_BLUEPRINT,
        id: 'saved_custom_1',
        name: 'カスタム一式',
        author: profile.userName,
        authorUuid: profile.userId,
      });
      markLearningCleared('learn_1_1');
      markLearningCleared('learn_2_3');
      markTutorialCleared('stage_1');
      markTutorialCleared('stage_5');
      localStorage.setItem(STORAGE_KEY_UI_FONT_SCALE, 'large');

      const currentBp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        id: 'current_dev_1',
        name: '開発中エース',
        author: profile.userName,
        authorUuid: profile.userId,
      };
      const dump = buildUserEnvironmentDump({
        currentBlueprint: currentBp,
        exportedAt: '2026-11-19T02:45:00.000Z',
      });
      expect(dump.version).toBe(1);
      expect(dump.userProfile).toEqual(profile);
      expect(dump.currentBlueprint?.name).toBe('開発中エース');
      expect(dump.savedBlueprints).toHaveLength(1);
      expect(dump.savedBlueprints[0].name).toBe('カスタム一式');
      expect(dump.learningClears).toEqual(['learn_1_1', 'learn_2_3']);
      expect(dump.tutorialClears).toEqual(['stage_1', 'stage_5']);
      expect(dump.uiSettings?.fontScale).toBe('large');

      // Encode -> decode VSE1- round-trip
      const envCode = encodeUserEnvironmentDump(dump);
      expect(envCode.startsWith(ENV_DUMP_PREFIX)).toBe(true);
      const fromCode = decodeUserEnvironmentDump(envCode);
      expect(fromCode.userProfile).toEqual(profile);
      expect(fromCode.currentBlueprint?.name).toBe('開発中エース');
      expect(fromCode.savedBlueprints[0].id).toBe('saved_custom_1');
      expect(fromCode.learningClears).toEqual(['learn_1_1', 'learn_2_3']);
      expect(fromCode.tutorialClears).toEqual(['stage_1', 'stage_5']);
      expect(fromCode.uiSettings?.fontScale).toBe('large');

      // Raw JSON round-trip with oversized values & duplicate clear IDs
      const oversizedJson = JSON.stringify({
        version: 1,
        exportedAt: '2026-11-19T02:45:00.000Z',
        userProfile: {
          userName: 'あいうえおかきくけこ',
          userId: `${profile.userId}-EXTRA`,
        },
        currentBlueprint: {
          ...currentBp,
          name: '一二三四五六七八九十一二三四五六七八九十',
        },
        savedBlueprints: [
          { ...currentBp, id: 'dup_1', name: '保存A' },
          { ...currentBp, id: 'dup_1', name: '保存B' },
        ],
        learningClears: ['learn_1_1', 'learn_1_1', '  learn_3_2  ', 123],
        tutorialClears: ['stage_2', 'stage_2'],
        uiSettings: { fontScale: 'xlarge' },
      });
      const fromJson = decodeUserEnvironmentDump(oversizedJson);
      expect(fromJson.userProfile.userName).toBe('あいうえおかきく');
      expect(fromJson.userProfile.userId).toBe(profile.userId);
      expect(Array.from(fromJson.currentBlueprint?.name ?? '').length).toBe(MAX_TANK_NAME_LENGTH);
      expect(fromJson.savedBlueprints).toHaveLength(1);
      expect(fromJson.savedBlueprints[0].name).toBe('保存A');
      expect(fromJson.learningClears).toEqual(['learn_1_1', 'learn_3_2']);
      expect(fromJson.tutorialClears).toEqual(['stage_2']);
      expect(fromJson.uiSettings?.fontScale).toBe('xlarge');

      // Wipe storage to simulate migrating to a fresh browser with a new random UUID, then restore VSE1-
      store.clear();
      const freshProfile = loadUserProfile();
      expect(freshProfile.userId).not.toBe(profile.userId);
      expect(loadLearningClears()).toEqual([]);

      const restored = applyUserEnvironmentDump(envCode);
      expect(restored.userProfile).toEqual(profile);
      expect(loadUserProfile()).toEqual(profile);
      expect(loadSavedBlueprints().map((b) => b.name)).toEqual(['カスタム一式']);
      expect(loadLearningClears()).toEqual(['learn_1_1', 'learn_2_3']);
      expect(loadTutorialClears()).toEqual(['stage_1', 'stage_5']);
      expect(loadUiFontScaleFromStorage()).toBe('large');

      // Single-tank VST1- share code or single-tank JSON must be rejected clearly
      const singleTankCode = encodeShareCode(currentBp);
      expect(() => decodeUserEnvironmentDump(singleTankCode)).toThrow('VST1-');
      expect(() => decodeUserEnvironmentDump(JSON.stringify(currentBp))).toThrow(
        '環境ダンプデータの形式が不正です'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tracks semantic gameVersion across Python, gatekeeper, share codes, and environment dumps', () => {
    expect(CURRENT_GAME_VERSION).toBe('1.8.2');
    expect(compareSemver('1.9.0', '1.8.2')).toBe(1);
    expect(compareSemver('1.8.2', '1.8.2')).toBe(0);
    expect(compareSemver('1.8.1', '1.8.2')).toBe(-1);
    expect(isNewerGameVersion('1.9.0', '1.8.2')).toBe(true);
    expect(isNewerGameVersion('1.8.2', '1.8.2')).toBe(false);
    expect(isNewerGameVersion('1.5.19', '1.8.2')).toBe(false);

    // Future game_version in Python source produces a clear compatibility warning
    const futurePy = [
      'import time',
      'tank_name = "未来戦車"',
      'game_version = "2.0.0"',
      'def on_tick():',
      '  move(speed=50)',
    ].join('\n');
    const parsedFuture = parsePythonSourceToProgram(futurePy, 4, 'relative');
    expect(parsedFuture.ok).toBe(true);
    if (parsedFuture.ok) {
      expect(parsedFuture.gameVersion).toBe('2.0.0');
      expect(parsedFuture.warnings?.some((w) => w.includes('2.0.0'))).toBe(true);
    }

    // Gatekeeper accepts current version cleanly and flags future schema/gameVersion
    const currentBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      gameVersion: CURRENT_GAME_VERSION,
    };
    const okGate = validateAndRepairBlueprint(currentBp);
    expect(okGate.isValid).toBe(true);
    expect(okGate.fixes).toEqual([]);

    const futureBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      version: 2,
      gameVersion: '2.0.0',
    };
    const futureGate = validateAndRepairBlueprint(futureBp);
    expect(futureGate.isValid).toBe(false);
    expect(futureGate.fixes.some((f) => f.includes('v2'))).toBe(true);
    expect(futureGate.fixes.some((f) => f.includes('v2.0.0'))).toBe(true);

    // validateAndNormalizeBlueprint delegates repair through gatekeeper and stamps gameVersion
    const rawOutOfRange = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT)) as TankBlueprint;
    delete rawOutOfRange.gameVersion;
    rawOutOfRange.program.cells[2][1] = {
      id: 'clamp_test',
      type: 'cond_proximity',
      params: { mode: 'approaching', target: 'all', dist: 999 },
      yes: null,
      no: null,
    };
    const normalized = validateAndNormalizeBlueprint(rawOutOfRange);
    expect(normalized.gameVersion).toBe(CURRENT_GAME_VERSION);
    expect(normalized.program.cells[2][1]?.params.dist).toBe(300);

    // Share code preserves gameVersion round-trip
    const encoded = encodeShareCode({ ...DEFAULT_PLAYER_BLUEPRINT, gameVersion: CURRENT_GAME_VERSION });
    const decoded = decodeShareCode(encoded);
    expect(decoded.gameVersion).toBe(CURRENT_GAME_VERSION);
  });

  it('encodes, decodes, verifies tamper resistance, and builds Excel-compatible 59-char Clear Codes (CP1-)', () => {
    const sampleUuid = '550e8400-e29b-41d4-a716-446655440000';
    const clearedAt = new Date(2026, 10, 19, 14, 5, 0); // 11/19 14:05 local time
    const code = encodeClearCode({
      userId: sampleUuid,
      unitId: 'L1',
      totalStages: 6,
      selfClearedStages: 5,
      clearedAt,
      gameVersion: CURRENT_GAME_VERSION,
      totalClearSeconds: 142,
      programFingerprint: 739,
    });

    expect(code).toHaveLength(59);
    expect(code.startsWith(CLEAR_CODE_PREFIX)).toBe(true);
    expect(code).toMatch(/^CP1-[0-9A-F]{32}-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{4}$/);

    const dec = decodeClearCode(code);
    expect(dec.valid).toBe(true);
    expect(dec.formattedUuid).toBe(sampleUuid);
    expect(dec.unitId).toBe('L1');
    expect(dec.unitCode).toBe(11);
    expect(dec.unitLabel).toBe('課題学習 第1回');
    expect(dec.totalStages).toBe(6);
    expect(dec.selfClearedStages).toBe(5);
    expect(dec.month).toBe(11);
    expect(dec.day).toBe(19);
    expect(dec.hour).toBe(14);
    expect(dec.minute).toBe(5);
    expect(dec.gameVersion).toBe(CURRENT_GAME_VERSION);
    expect(dec.totalClearSeconds).toBe(142);
    expect(dec.programFingerprint).toBe(739);

    // Simulate Excel formulas directly (1-indexed MID, HEX2DEC, DECIMAL(...,36), BITXOR, MOD)
    const xlMid = (s: string, start: number, len: number) => s.slice(start - 1, start - 1 + len);
    const b2 = xlMid(code, 5, 32);
    const u1 = Number.parseInt(xlMid(b2, 1, 8), 16);
    const u3 = Number.parseInt(xlMid(b2, 9, 8), 16);
    const u4 = Number.parseInt(xlMid(b2, 17, 8), 16);
    const u2 = Number.parseInt(xlMid(b2, 25, 8), 16);
    const xorNum = (a: number, b: number) => Number(BigInt(a) ^ BigInt(b));
    const c2Val = xorNum(Number.parseInt(xlMid(code, 38, 8), 36), xorNum(u1 * 193 + u2, 608472915341));
    const d2Val = xorNum(Number.parseInt(xlMid(code, 47, 8), 36), xorNum(u3 * 197 + u4, 839164720519));
    const [vMaj, vMin, vPat] = CURRENT_GAME_VERSION.split('.').map(Number);
    const expectedVerDigits = `${vMaj}${String(vMin).padStart(2, '0')}${String(vPat).padStart(2, '0')}`;
    expect(String(c2Val).padStart(12, '0')).toBe('116511191405');
    expect(String(d2Val).padStart(12, '0')).toBe(`${expectedVerDigits}0142739`);
    const sigSum = u1 * 3 + u2 * 5 + u3 * 7 + u4 * 11 + c2Val * 17 + d2Val * 29 + 948271635;
    expect(Number.isSafeInteger(sigSum)).toBe(true);
    const expectedSig = (sigSum % 1679609).toString(36).toUpperCase().padStart(4, '0');
    expect(expectedSig).toBe(xlMid(code, 56, 4));

    // Tamper any part (UUID, Block A, Block B, or Signature) -> must fail verification
    const flipCharAt = (s: string, idx: number) => {
      const alt = s[idx] === 'A' ? 'B' : 'A';
      return s.slice(0, idx) + alt + s.slice(idx + 1);
    };
    expect(decodeClearCode(flipCharAt(code, 6)).valid).toBe(false); // UUID tampered
    expect(decodeClearCode(flipCharAt(code, 40)).valid).toBe(false); // Block A tampered
    expect(decodeClearCode(flipCharAt(code, 50)).valid).toBe(false); // Block B tampered
    expect(decodeClearCode(flipCharAt(code, 57)).valid).toBe(false); // Signature tampered
    expect(decodeClearCode('INVALID').valid).toBe(false);

    // Partial vs full unit completion via buildUnitClearCode & clearTelemetry persistence
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
    });

    try {
      const lesson1Ids = LEARNING_MISSIONS.filter((m) => m.lessonNumber === 1).map((m) => m.id);
      const partialCode = buildUnitClearCode({
        unitId: 'L1',
        stageIds: lesson1Ids,
        clearedIds: lesson1Ids.slice(0, lesson1Ids.length - 1),
        telemetry: {},
        userId: sampleUuid,
      });
      expect(partialCode).toBeNull();

      lesson1Ids.forEach((id, idx) => {
        markLearningCleared(id);
        recordStageClearTelemetry({
          stageId: id,
          clearTicks: 100 + idx * 20,
          program: LEARNING_MISSIONS[idx].playerStarter.program,
          usedModelAnswer: idx === 0, // 1 mission used model answer, 5 self-cleared
          clearedAt: '2026-11-19T05:30:00.000Z',
        });
      });

      // Re-clearing mission 0 on own should upgrade usedModelAnswer -> false; later using model answer stays false
      recordStageClearTelemetry({
        stageId: lesson1Ids[0],
        clearTicks: 100,
        program: LEARNING_MISSIONS[0].playerStarter.program,
        usedModelAnswer: false,
        clearedAt: '2026-11-19T05:31:00.000Z',
      });
      recordStageClearTelemetry({
        stageId: lesson1Ids[0],
        clearTicks: 100,
        program: LEARNING_MISSIONS[0].playerStarter.program,
        usedModelAnswer: true,
        clearedAt: '2026-11-19T05:32:00.000Z',
      });

      const tel = loadClearTelemetry();
      expect(tel[lesson1Ids[0]].usedModelAnswer).toBe(false);
      expect(computeProgramFingerprint(DEFAULT_PLAYER_BLUEPRINT.program)).toBeGreaterThanOrEqual(0);
      expect(computeProgramFingerprint(DEFAULT_PLAYER_BLUEPRINT.program)).toBeLessThan(1000);

      const unitCode = buildUnitClearCode({
        unitId: 'L1',
        stageIds: lesson1Ids,
        clearedIds: loadLearningClears(),
        telemetry: tel,
        userId: sampleUuid,
        gameVersion: CURRENT_GAME_VERSION,
      });
      expect(unitCode).not.toBeNull();
      const decUnit = decodeClearCode(unitCode!);
      expect(decUnit.valid).toBe(true);
      expect(decUnit.unitId).toBe('L1');
      expect(decUnit.totalStages).toBe(6);
      expect(decUnit.selfClearedStages).toBe(6);
      expect(decUnit.totalClearSeconds).toBe(Math.round((100 + 120 + 140 + 160 + 180 + 200) / 20));

      // Clear telemetry survives environment dump export -> wipe -> restore
      const envCode = encodeUserEnvironmentDump(buildUserEnvironmentDump());
      store.clear();
      expect(loadClearTelemetry()).toEqual({});
      applyUserEnvironmentDump(envCode);
      expect(Object.keys(loadClearTelemetry())).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('enforces learning model-answer lock rules, irreversible open tracking, and starter clone detection', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
    });

    try {
      const m11 = LEARNING_MISSIONS.find((m) => m.id === 'learn_1_1')!;
      const m12 = LEARNING_MISSIONS.find((m) => m.id === 'learn_1_2')!;
      const m13 = LEARNING_MISSIONS.find((m) => m.id === 'learn_1_3')!;

      // 1. Two-block board or hints closed -> ignored
      const twoBlockProg = buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 50 }, next: null },
      ]);
      const threeBlockProgA = buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 50 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_halt', next: null },
      ]);

      expect(
        recordLearningFailedAttempt({ missionId: m13.id, program: threeBlockProgA, hintsOpen: false })[
          m13.id
        ]
      ).toBeUndefined();
      expect(
        recordLearningFailedAttempt({ missionId: m13.id, program: twoBlockProg, hintsOpen: true })[
          m13.id
        ]
      ).toBeUndefined();

      // Same 3-block program run multiple times deduplicates to 1 failure
      recordLearningFailedAttempt({ missionId: m13.id, program: threeBlockProgA, hintsOpen: true });
      const afterDup = recordLearningFailedAttempt({
        missionId: m13.id,
        program: threeBlockProgA,
        hintsOpen: true,
      });
      expect(afterDup[m13.id]?.failedFingerprints).toHaveLength(1);

      // 4 more distinct 3-block failing attempts unlock (total 5)
      for (const speed of [60, 70, 80, 90]) {
        recordLearningFailedAttempt({
          missionId: m13.id,
          hintsOpen: true,
          program: buildProgram(4, 'relative', [
            { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
            { x: 1, y: 0, type: 'act_move', params: { speedPercent: speed }, next: { x: 2, y: 0 } },
            { x: 2, y: 0, type: 'act_halt', next: null },
          ]),
        });
      }
      expect(loadLearningAttempts()[m13.id]?.failedFingerprints).toHaveLength(5);

      // 2. Opening model answer irreversibly marks openedModelAnswer even if later solved with custom board
      markLearningModelAnswerOpened(m13.id);
      expect(loadLearningAttempts()[m13.id]?.openedModelAnswer).toBe(true);
      const afterCustomClear = recordStageClearTelemetry({
        stageId: m13.id,
        clearTicks: 180,
        program: threeBlockProgA,
        usedModelAnswer: false, // Even if caller didn't pass flag (e.g. after page reload)
        starterProgram: m13.playerStarter.program,
      });
      expect(afterCustomClear[m13.id].usedModelAnswer).toBe(true);

      // 3. Self-cleared mission keeps review credit even if model answer opened afterward
      markLearningCleared(m12.id);
      recordStageClearTelemetry({
        stageId: m12.id,
        clearTicks: 140,
        program: threeBlockProgA,
        usedModelAnswer: false,
        starterProgram: m12.playerStarter.program,
      });
      markLearningModelAnswerOpened(m12.id);
      expect(loadLearningAttempts()[m12.id]?.openedModelAnswer).toBeFalsy();
      const afterReview = recordStageClearTelemetry({
        stageId: m12.id,
        clearTicks: 120,
        program: m12.playerStarter.program,
        usedModelAnswer: true,
        starterProgram: m12.playerStarter.program,
      });
      expect(afterReview[m12.id].usedModelAnswer).toBe(false);

      // 4. Exact copy of 4+ block starter without opening button is flagged, while 1-1 (<4 blocks) is exempted
      const m14 = LEARNING_MISSIONS.find((m) => m.id === 'learn_1_4')!;
      expect(isProgramIdenticalToStarter(m14.playerStarter.program, m14.playerStarter.program, m14.id)).toBe(
        true
      );
      expect(isProgramIdenticalToStarter(m11.playerStarter.program, m11.playerStarter.program, m11.id)).toBe(
        false
      );
      const copiedTel = recordStageClearTelemetry({
        stageId: m14.id,
        clearTicks: 200,
        program: m14.playerStarter.program,
        usedModelAnswer: false,
        starterProgram: m14.playerStarter.program,
      });
      expect(copiedTel[m14.id].usedModelAnswer).toBe(true);

      // 5. learningAttempts survives environment dump restore
      const envCode = encodeUserEnvironmentDump(buildUserEnvironmentDump());
      store.clear();
      expect(loadLearningAttempts()).toEqual({});
      applyUserEnvironmentDump(envCode);
      expect(loadLearningAttempts()[m13.id]?.openedModelAnswer).toBe(true);
      expect(loadLearningAttempts()[m13.id]?.failedFingerprints).toHaveLength(5);

      // 6. Daily 4-digit MMDD unlock code verification
      const sampleDate = new Date(2026, 10, 19); // Nov 19 -> "1119"
      expect(getExpectedDailyUnlockCode(sampleDate)).toBe('1119');
      expect(verifyDailyUnlockCode('1119', sampleDate)).toBe(true);
      expect(verifyDailyUnlockCode(' 1119 ', sampleDate)).toBe(true);
      expect(verifyDailyUnlockCode('1120', sampleDate)).toBe(false);
      expect(verifyDailyUnlockCode('abcd', sampleDate)).toBe(false);

      // 7. Development Training (開発訓練) self-cleared review credit preservation & irreversible open tracking
      const tut0 = TUTORIAL_STAGES[0];
      const tut1 = TUTORIAL_STAGES[1];
      type TestGridCell = (typeof tut0.playerStarter.program.cells)[number][number];
      const tutCustomProgram = {
        gridSize: tut0.playerStarter.program.gridSize,
        coordinateMode: tut0.playerStarter.program.coordinateMode,
        cells: Array.from({ length: tut0.playerStarter.program.gridSize }, () =>
          Array.from(
            { length: tut0.playerStarter.program.gridSize },
            () => null as TestGridCell
          )
        ),
      };
      tutCustomProgram.cells[0][0] = {
        id: 'tut_custom_start',
        type: 'start',
        params: {},
        next: { x: 1, y: 0 },
      };
      tutCustomProgram.cells[0][1] = {
        id: 'tut_custom_fire1',
        type: 'act_fire',
        params: {},
        next: { x: 2, y: 0 },
      };
      tutCustomProgram.cells[0][2] = {
        id: 'tut_custom_fire2',
        type: 'act_fire',
        params: {},
        next: { x: 3, y: 0 },
      };
      tutCustomProgram.cells[0][3] = {
        id: 'tut_custom_fire3',
        type: 'act_fire',
        params: {},
        next: { x: 3, y: 1 },
      };
      tutCustomProgram.cells[1][3] = {
        id: 'tut_custom_halt',
        type: 'act_halt',
        params: {},
      };

      markTutorialCleared(tut0.id);
      recordStageClearTelemetry({
        stageId: tut0.id,
        clearTicks: 30,
        program: tutCustomProgram,
        usedModelAnswer: false,
        starterProgram: tut0.playerStarter.program,
      });
      const afterTutReviewAttempts = markLearningModelAnswerOpened(tut0.id);
      expect(afterTutReviewAttempts[tut0.id]?.openedModelAnswer ?? false).toBe(false);
      const afterTutReviewTel = recordStageClearTelemetry({
        stageId: tut0.id,
        clearTicks: 30,
        program: tut0.playerStarter.program,
        usedModelAnswer: true,
        starterProgram: tut0.playerStarter.program,
      });
      expect(afterTutReviewTel[tut0.id]?.usedModelAnswer).toBe(false);

      // Opening model answer before clearing a tutorial stage persists openedModelAnswer irreversibly
      const afterTut1Opened = markLearningModelAnswerOpened(tut1.id);
      expect(afterTut1Opened[tut1.id]?.openedModelAnswer).toBe(true);
      const afterTut1Tel = recordStageClearTelemetry({
        stageId: tut1.id,
        clearTicks: 40,
        program: tutCustomProgram,
        usedModelAnswer: false,
        starterProgram: tut1.playerStarter.program,
      });
      expect(afterTut1Tel[tut1.id]?.usedModelAnswer).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Battlefield framework, weapon ban, regulations & tournament/league runner', () => {
  it('blocks act_fire (including wait=1) and act_sub_weapon when disableWeapons is enabled while movement still runs', () => {
    const shooterBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'bf_shooter',
      name: '砲撃テスト号',
      author: 'ALICE',
      assembly: {
        chassis: 'standard',
        mainGun: 'standard',
        radar: 'long',
        cpu: 'mini_4x4',
        subWeapon: 'missile',
      },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'act_fire',
          params: { power: 'heavy', wait: 1 },
          next: { x: 2, y: 0 },
        },
        { x: 2, y: 0, type: 'act_sub_weapon', params: {}, next: { x: 3, y: 0 } },
        {
          x: 3,
          y: 0,
          type: 'act_move',
          params: { speedPercent: 100, duration: 0 },
          next: null,
        },
      ]),
    };

    const entryA = createRosterEntryFromBlueprint(shooterBp, 'test');
    entryA.playerName = 'ALICE';
    entryA.machineName = 'シューター改';
    const entryB = createRosterEntryFromBlueprint(ENEMY_DUMMY, 'test');
    entryB.playerName = 'BOB';
    entryB.machineName = 'ダミー標的';

    const participants = [
      { entry: entryA, teamId: 'ffa_0', teamLabel: 'ALICE', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: entryB, teamId: 'ffa_1', teamLabel: 'BOB', teamColor: '#f59e0b', slotIndex: 1 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      disableWeapons: true,
      maxSeconds: 60,
    };

    const state = createBattlefieldMatchState(participants, cfg);
    const startX = state.tanks[0].x;
    const startY = state.tanks[0].y;
    const initAmmo = state.tanks[0].subAmmo;

    for (let t = 0; t < 40; t++) {
      stepBattlefieldTick(state, cfg);
    }

    expect(state.projectiles.length).toBe(0);
    expect(state.mines.length).toBe(0);
    expect(state.tanks[0].stats.shotsFired).toBe(0);
    expect(state.tanks[0].gunHeat).toBe(0);
    expect(state.tanks[0].subAmmo).toBe(initAmmo);
    expect(state.tanks[0].fireState).toBeNull();
    // Tank still advances and moves normally after act_fire & act_sub_weapon were blocked
    const movedDist = Math.hypot(state.tanks[0].x - startX, state.tanks[0].y - startY);
    expect(movedDist).toBeGreaterThan(20);
  });

  it('prevents friendly fire & radar lock across multi-team alliances and tracks kills/survival/hit rate in reports', () => {
    // Two teammates facing east; an attacker firing directly toward teammate at same angle should not hit ally
    const allyShooter: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'ally_1',
      name: 'ブルー1号',
      author: 'P1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'none' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 'fast', wait: 0 }, next: null },
      ]),
    };
    const allyWing: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'ally_2',
      name: 'ブルー2号',
      author: 'P2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'none' },
      program: buildProgram(4, 'relative', [{ x: 0, y: 0, type: 'start', next: null }]),
    };
    const enemyC: TankBlueprint = {
      ...ENEMY_DUMMY,
      id: 'red_1',
      name: 'レッド1号',
      author: 'P3',
    };

    const eA1 = createRosterEntryFromBlueprint(allyShooter, 'test');
    const eA2 = createRosterEntryFromBlueprint(allyWing, 'test');
    const eB1 = createRosterEntryFromBlueprint(enemyC, 'test');

    const participants = [
      { entry: eA1, teamId: 'team_0', teamLabel: 'Team A', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eB1, teamId: 'team_1', teamLabel: 'Team B', teamColor: '#e69f00', slotIndex: 0 },
      { entry: eA2, teamId: 'team_0', teamLabel: 'Team A', teamColor: '#38bdf8', slotIndex: 1 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      format: 'team_match' as const,
      obstacleMode: 'none' as const,
      maxSeconds: 60,
    };

    const state = createBattlefieldMatchState(participants, cfg);
    // Position allyWing directly in line of fire between allyShooter and enemyC
    state.tanks[0].x = 200;
    state.tanks[0].y = 500;
    state.tanks[0].turretAngle = 90; // east
    state.tanks[0].radarAngle = 90;
    state.tanks[2].x = 320;
    state.tanks[2].y = 500; // directly east of allyShooter
    state.tanks[1].x = 450;
    state.tanks[1].y = 500; // enemy beyond allyWing
    state.tanks[1].hp = 12; // low HP so shot eliminates enemy

    for (let i = 0; i < 60 && state.status !== 'finished'; i++) {
      stepBattlefieldTick(state, cfg);
    }

    // AllyWing was never locked on radar nor damaged by allyShooter's shell passing through
    expect(state.tanks[2].hp).toBe(state.tanks[2].maxHp);
    expect(state.tanks[0].detectedEnemy?.id).not.toBe(state.tanks[2].id);
    // EnemyC was eliminated by allyShooter, match finished with Team A victory
    expect(state.status).toBe('finished');
    expect(state.tanks[1].hp).toBe(0);
    expect(state.tanks[1].stats.eliminatedAtTick).not.toBeNull();
    expect(state.tanks[0].stats.kills).toBe(1);

    const report = buildMatchReport(state, participants, cfg);
    expect(report.winnerTeamId).toBe('team_0');
    expect(report.tankRows[0].playerName).toBe('P1');
    expect(report.tankRows[0].machineName).toBe('ブルー1号');
    expect(report.tankRows[0].kills).toBe(1);
    expect(report.tankRows[0].hitRatePercent).not.toBeNull();

    const loserRow = report.tankRows.find((r) => r.playerName === 'P3');
    expect(loserRow?.isAlive).toBe(false);
    expect(loserRow?.survivedSeconds).toBeGreaterThan(0);

    const text = formatMatchReportText(report);
    expect(text).toContain('P1');
    expect(text).toContain('ブルー1号');
    expect(text).toContain('レッド1号');
    const tsv = formatMatchReportTsv(report);
    expect(tsv.split('\n').length).toBe(4);
  });

  it('validates CPU regulations (including 6x6 + 4x4 pairs) and manages tournament & league runs', () => {
    const bp4 = createRosterEntryFromBlueprint(
      PRESET_ENEMIES.find((p) => p.program.gridSize === 4)!,
      'preset'
    );
    bp4.playerName = 'U4';
    const bp6 = createRosterEntryFromBlueprint(
      PRESET_ENEMIES.find((p) => p.program.gridSize === 6)!,
      'preset'
    );
    bp6.playerName = 'U6';
    const bp8 = createRosterEntryFromBlueprint(
      PRESET_ENEMIES.find((p) => p.program.gridSize === 8)!,
      'preset'
    );
    bp8.playerName = 'U8';

    expect(validateEntryForRegulation(bp4, 'only_4x4').valid).toBe(true);
    expect(validateEntryForRegulation(bp6, 'only_4x4').valid).toBe(false);
    expect(validateTeamForRegulation([bp6, bp4], 'pair_6x6_4x4').valid).toBe(true);
    expect(validateTeamForRegulation([bp4, bp4], 'pair_6x6_4x4').valid).toBe(true);
    expect(validateTeamForRegulation([bp6, bp6], 'pair_6x6_4x4').valid).toBe(false);
    expect(validateTeamForRegulation([bp8, bp4], 'pair_6x6_4x4').valid).toBe(false);

    const units: CompetitionUnit[] = [
      { unitId: 'u1', unitName: 'Unit1', entries: [bp4], color: '#38bdf8' },
      { unitId: 'u2', unitName: 'Unit2', entries: [bp6], color: '#e69f00' },
      { unitId: 'u3', unitName: 'Unit3', entries: [bp8], color: '#009e73' },
    ];

    // Tournament with 3 units (auto BYE for top seed)
    let bracket = createTournamentBracket(units);
    expect(bracket.rounds.length).toBe(2);
    expect(bracket.rounds[0][0].isBye).toBe(true);
    expect(bracket.rounds[0][0].winnerUnitId).toBe('u1');
    const semi = bracket.rounds[0][1];
    expect(semi.unitAId).not.toBeNull();
    expect(semi.unitBId).not.toBeNull();
    const semiWinnerId = semi.unitAId!;
    bracket = applyTournamentMatchResult(bracket, semi.matchId, semiWinnerId);
    const finalM = bracket.rounds[1][0];
    expect(finalM.unitAId).toBe('u1');
    expect(finalM.unitBId).toBe(semiWinnerId);
    bracket = applyTournamentMatchResult(bracket, finalM.matchId, 'u1');
    expect(bracket.championUnitId).toBe('u1');

    // League round-robin for 3 units -> 3 matches, all pairs represented
    const leagueMatches = createLeagueSchedule(units);
    expect(leagueMatches.length).toBe(3);
    const parts = buildParticipantsFromUnitPair(units[0], units[1]);
    expect(parts.length).toBe(2);
    expect(parts[0].teamId).toBe('unit_A');
    expect(parts[1].teamId).toBe('unit_B');

    const dummyState = createBattlefieldMatchState(parts, DEFAULT_BATTLEFIELD_CONFIG);
    dummyState.winnerId = 'bf_tank_0';
    dummyState.winType = 'elimination';
    dummyState.tanks[1].hp = 0;
    dummyState.tanks[1].stats.eliminatedAtTick = 100;
    dummyState.tanks[0].stats.kills = 1;
    dummyState.tanks[0].stats.damageDealt = 90;
    const dummyReport = buildMatchReport(dummyState, parts, DEFAULT_BATTLEFIELD_CONFIG);
    leagueMatches[0].winnerUnitId = leagueMatches[0].unitAId;
    leagueMatches[0].report = dummyReport;

    const standings = computeLeagueStandings(units, leagueMatches);
    expect(standings[0].unitId).toBe(leagueMatches[0].unitAId);
    expect(standings[0].points).toBe(3);

    // Roster sorting: user tanks on top (by Player name -> CPU ascending), preset tanks below (by Player -> CPU ascending)
    const preset4 = createRosterEntryFromBlueprint(bp4.blueprint, '規定戦車', true);
    const preset8 = createRosterEntryFromBlueprint(bp8.blueprint, '規定戦車', true);
    const userA6 = createRosterEntryFromBlueprint(bp6.blueprint, 'ユーザー', false);
    userA6.playerName = 'Alice';
    const userA4 = createRosterEntryFromBlueprint(bp4.blueprint, 'ユーザー', false);
    userA4.playerName = 'Alice';
    const userB6 = createRosterEntryFromBlueprint(bp6.blueprint, 'ユーザー', false);
    userB6.playerName = 'Bob';

    const sortedRoster = sortRosterEntries([preset8, userB6, preset4, userA6, userA4]);
    expect(sortedRoster.map((e) => `${e.isPreset ? 'P' : 'U'}:${e.playerName}:${e.blueprint.program.gridSize}`)).toEqual([
      'U:Alice:4',
      'U:Alice:6',
      'U:Bob:6',
      'P:CPU:4',
      'P:CPU:8',
    ]);
    expect(formatTankListLabel('突撃一番★', 'Alice', 4)).toBe('突撃一番★（Alice）（4x4）');
  });

  it('supports outerWallMode bounce reflection and lethal outer wall damage with pusher kill credit', () => {
    const runnerBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'wall_runner',
      name: '壁突進号',
      author: 'R1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'none' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
      ]),
    };

    const eA = createRosterEntryFromBlueprint(runnerBp, 'test');
    const eB = createRosterEntryFromBlueprint(ENEMY_DUMMY, 'test');
    const parts = [
      { entry: eA, teamId: 'ffa_0', teamLabel: 'R1', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eB, teamId: 'ffa_1', teamLabel: 'D1', teamColor: '#e69f00', slotIndex: 1 },
    ];

    // 1. Bounce wall pushes tank inward & reflects heading toward west when hitting East wall at angle 60
    const bounceCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      obstacleMode: 'none' as const,
      outerWallMode: 'bounce' as const,
      maxSeconds: 60,
    };
    const bounceState = createBattlefieldMatchState(parts, bounceCfg);
    bounceState.tanks[0].x = bounceState.arena.width - 10;
    bounceState.tanks[0].y = 500;
    bounceState.tanks[0].bodyAngle = 60;
    bounceState.tanks[0].speed = 3.5;

    stepBattlefieldTick(bounceState, bounceCfg);
    expect(bounceState.tanks[0].x).toBeLessThan(bounceState.arena.width - 35);
    // Heading reflected across East wall into western hemisphere (> 180 deg)
    expect(bounceState.tanks[0].bodyAngle).toBeGreaterThan(180);
    expect(bounceState.tanks[0].bodyAngle).toBeLessThan(360);
    expect(bounceState.tanks[0].hp).toBe(bounceState.tanks[0].maxHp);

    // 2. Electric damage wall deals 24 damage, can eliminate to HP 0, and credits pusher kill
    const dmgCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      obstacleMode: 'none' as const,
      outerWallMode: 'damage' as const,
      maxSeconds: 60,
    };
    const dmgState = createBattlefieldMatchState(parts, dmgCfg);
    const victim = dmgState.tanks[0];
    const pusher = dmgState.tanks[1];
    victim.hp = 20;
    victim.x = dmgState.arena.width - 5;
    victim.y = 500;
    victim.bodyAngle = 90;
    // Simulate prior enemy tank collision 5 ticks ago
    victim.lastCollidedTankId = pusher.id;
    victim.lastTankCollisionTick = 1;
    dmgState.tick = 5;

    stepBattlefieldTick(dmgState, dmgCfg);
    expect(victim.hp).toBe(0);
    expect(victim.killedById).toBe(pusher.id);
    expect(pusher.stats.kills).toBe(1);
    expect(pusher.stats.damageDealt).toBe(24);
    expect(dmgState.status).toBe('finished');
    expect(dmgState.winnerId).toBe(pusher.id);
  });

  it('enforces slow and no_weapon arena floor zones and generates non-overlapping zones clear of spawns', () => {
    const walkerBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'zone_walker',
      name: 'ゾーン歩行号',
      author: 'Z1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'missile' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        {
          x: 1,
          y: 0,
          type: 'act_fire',
          params: { power: 'fast', wait: 1 },
          next: { x: 2, y: 0 },
        },
        { x: 2, y: 0, type: 'act_sub_weapon', params: {}, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
      ]),
    };

    const eInside = createRosterEntryFromBlueprint(walkerBp, 'test');
    const eOutside = createRosterEntryFromBlueprint(walkerBp, 'test');
    const parts = [
      { entry: eInside, teamId: 'ffa_0', teamLabel: 'Z1', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eOutside, teamId: 'ffa_1', teamLabel: 'Z2', teamColor: '#e69f00', slotIndex: 1 },
    ];

    // A. Slow zone slows speed vs open ground
    const baseCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      obstacleMode: 'none' as const,
      zoneMode: 'none' as const,
      disableWeapons: true,
    };
    const sZones = createBattlefieldMatchState(parts, baseCfg);
    sZones.arena.tiles = [
      { id: 'z_slow', kind: 'slow', x: 150, y: 400, width: 250, height: 200 },
    ];
    sZones.tanks[0].x = 250;
    sZones.tanks[0].y = 500;
    sZones.tanks[0].bodyAngle = 90;
    sZones.tanks[1].x = 700;
    sZones.tanks[1].y = 500;
    sZones.tanks[1].bodyAngle = 90;

    for (let i = 0; i < 15; i++) {
      stepBattlefieldTick(sZones, baseCfg);
    }
    const slowDist = sZones.tanks[0].x - 250;
    const normalDist = sZones.tanks[1].x - 700;
    expect(slowDist).toBeGreaterThan(5);
    expect(slowDist).toBeLessThan(normalDist * 0.65);

    // B. No-weapon zone blocks act_fire (wait=1) + act_sub_weapon ONLY for tank inside zone
    const nwCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      obstacleMode: 'none' as const,
      zoneMode: 'none' as const,
      disableWeapons: false,
    };
    const sNoWep = createBattlefieldMatchState(parts, nwCfg);
    sNoWep.arena.tiles = [
      { id: 'z_nw', kind: 'no_weapon', x: 150, y: 400, width: 220, height: 200 },
    ];
    sNoWep.tanks[0].x = 220;
    sNoWep.tanks[0].y = 500;
    sNoWep.tanks[0].bodyAngle = 90;
    const initAmmo0 = sNoWep.tanks[0].subAmmo;

    sNoWep.tanks[1].x = 800;
    sNoWep.tanks[1].y = 500;
    sNoWep.tanks[1].bodyAngle = 270;

    for (let i = 0; i < 10; i++) {
      stepBattlefieldTick(sNoWep, nwCfg);
    }

    // Tank 0 inside no_weapon never fired nor lost subAmmo, yet still moved forward
    expect(sNoWep.tanks[0].stats.shotsFired).toBe(0);
    expect(sNoWep.tanks[0].subAmmo).toBe(initAmmo0);
    expect(sNoWep.tanks[0].fireState).toBeNull();
    expect(sNoWep.tanks[0].x).toBeGreaterThan(225);
    // Tank 1 outside no_weapon fired normally
    expect(sNoWep.tanks[1].stats.shotsFired).toBeGreaterThan(0);

    // C. generateBattlefieldZones places clear zones avoiding spawns & obstacles
    for (const sz of ['small', 'medium', 'large'] as ArenaSizeId[]) {
      const obs = generateArenaObstacles('many', 77, sz);
      const zones = generateBattlefieldZones('mixed', 77, sz, obs);
      expect(zones.length).toBeGreaterThanOrEqual(2);
      expect(zones.some((z) => z.kind === 'slow')).toBe(true);
      expect(zones.some((z) => z.kind === 'no_weapon')).toBe(true);
      const spec = ARENA_SIZE_SPECS[sz];
      const spawns = getSpawnsForArena(spec.width, spec.height);
      for (const z of zones) {
        for (const sp of spawns) {
          expect(circleIntersectsRect(sp.x, sp.y, 45, z)).toBe(false);
        }
        for (const o of obs) {
          const overlapsObs =
            z.x < o.x + o.width &&
            z.x + z.width > o.x &&
            z.y < o.y + o.height &&
            z.y + z.height > o.y;
          expect(overlapsObs).toBe(false);
        }
      }
    }
  });

  it('applies gravity presets (half-effect on turret, unaffected radar, slow-zone floor) and sandstorm radar scaling + reporting', () => {
    const moverBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'grav_mover',
      name: '重力テスト機',
      author: 'G1',
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        cpu: 'mini_4x4',
        chassis: 'standard',
        mainGun: 'standard',
        radar: 'balanced',
      },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_turn_turret', params: { mode: 'delta', angle: 90, wait: 0 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_turn_radar', params: { mode: 'delta', angle: 90 }, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
      ]),
    };
    const dummyBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'grav_dummy',
      name: 'カカシ機',
      author: 'G2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', radar: 'balanced' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: null },
      ]),
    };

    const eA = createRosterEntryFromBlueprint(moverBp, 'test');
    const eB = createRosterEntryFromBlueprint(dummyBp, 'test');
    const parts = [
      { entry: eA, teamId: 'ffa_0', teamLabel: 'G1', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eB, teamId: 'ffa_1', teamLabel: 'G2', teamColor: '#e69f00', slotIndex: 1 },
    ];

    const runGravityTrial = (gravityPreset: 'high_2' | 'normal' | 'low_2', inSlow = false) => {
      const cfg = {
        ...DEFAULT_BATTLEFIELD_CONFIG,
        obstacleMode: 'none' as const,
        zoneMode: 'none' as const,
        disableWeapons: true,
        gravityPreset,
      };
      const st = createBattlefieldMatchState(parts, cfg);
      if (inSlow) {
        st.arena.tiles = [
          { id: 'z_slow_g', kind: 'slow', x: 50, y: 400, width: 500, height: 200 },
        ];
      }
      st.tanks[0].x = 200;
      st.tanks[0].y = 500;
      st.tanks[0].bodyAngle = 90;
      st.tanks[0].turretAngle = 0;
      st.tanks[0].radarAngle = 0;
      st.tanks[1].x = 1200;
      st.tanks[1].y = 500;

      for (let i = 0; i < 10; i++) {
        stepBattlefieldTick(st, cfg);
      }
      return {
        distMoved: st.tanks[0].x - 200,
        finalSpeed: st.tanks[0].speed,
        turretDeg: st.tanks[0].turretAngle,
        radarDeg: st.tanks[0].radarAngle,
      };
    };

    const gHigh = runGravityTrial('high_2');
    const gNorm = runGravityTrial('normal');
    const gLow = runGravityTrial('low_2');
    const gHighSlow = runGravityTrial('high_2', true);

    const gunSpec = MAIN_GUN_SPECS.standard;
    const radarSpec = RADAR_SPECS.balanced;

    // Speed scales 0.5x / 1.0x / 1.5x
    expect(gHigh.distMoved).toBeCloseTo(gNorm.distMoved * 0.5, 4);
    expect(gLow.distMoved).toBeCloseTo(gNorm.distMoved * 1.5, 4);
    expect(gHigh.finalSpeed).toBeCloseTo(gNorm.finalSpeed * 0.5, 4);
    expect(gLow.finalSpeed).toBeCloseTo(gNorm.finalSpeed * 1.5, 4);

    // Turret turn scales by half-gravity: 0.75x / 1.0x / 1.25x over 10 ticks
    expect(gHigh.turretDeg).toBeCloseTo(gunSpec.turretTurnRate * 0.75 * 10, 4);
    expect(gNorm.turretDeg).toBeCloseTo(gunSpec.turretTurnRate * 1.0 * 10, 4);
    expect(gLow.turretDeg).toBeCloseTo(gunSpec.turretTurnRate * 1.25 * 10, 4);

    // Radar turn stays unaffected (1.0x)
    expect(gHigh.radarDeg).toBeCloseTo(radarSpec.turnRate * 10, 4);
    expect(gLow.radarDeg).toBeCloseTo(radarSpec.turnRate * 10, 4);

    // High gravity + slow zone clamps at 0.25x instead of 0.5 * 0.45 = 0.225x
    expect(gHighSlow.distMoved).toBeCloseTo(gNorm.distMoved * 0.25, 4);

    // Sandstorm radar range scaling: balanced base = 820px -> extreme (0.2x) = 164px
    const runSandstormCheck = (sandstormPreset: 'none' | 'extreme', enemyDist: number) => {
      const cfg = {
        ...DEFAULT_BATTLEFIELD_CONFIG,
        obstacleMode: 'none' as const,
        zoneMode: 'none' as const,
        sandstormPreset,
      };
      const scanner = createBattlefieldMatchState(parts, cfg);
      scanner.tanks[0].x = 300;
      scanner.tanks[0].y = 500;
      scanner.tanks[0].radarAngle = 90;
      scanner.tanks[1].x = 300 + enemyDist;
      scanner.tanks[1].y = 500;
      stepBattlefieldTick(scanner, cfg);
      return scanner.tanks[0].radarLock;
    };

    expect(runSandstormCheck('none', 220)).toBe(true);
    expect(runSandstormCheck('extreme', 220)).toBe(false);
    expect(runSandstormCheck('extreme', 140)).toBe(true);

    // Result formatting includes non-default Gravity & Sandstorm short labels
    const modCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      gravityPreset: 'low_2' as const,
      sandstormPreset: 'heavy' as const,
    };
    const modState = createBattlefieldMatchState(parts, modCfg);
    stepBattlefieldTick(modState, modCfg);
    const report = buildMatchReport(modState, parts, modCfg);
    const matchText = formatMatchReportText(report);
    expect(matchText).toContain(GRAVITY_PRESET_SPECS.low_2.shortLabel);
    expect(matchText).toContain(SANDSTORM_PRESET_SPECS.heavy.shortLabel);

    const units: CompetitionUnit[] = [
      { unitId: 'u1', unitName: 'Unit1', entries: [eA], color: '#38bdf8' },
      { unitId: 'u2', unitName: 'Unit2', entries: [eB], color: '#e69f00' },
    ];
    const leagueMatches = createLeagueSchedule(units);
    const standings = computeLeagueStandings(units, leagueMatches);
    const leagueText = formatLeagueStandingsText(standings, modCfg);
    expect(leagueText).toContain(GRAVITY_PRESET_SPECS.low_2.shortLabel);
    expect(leagueText).toContain(SANDSTORM_PRESET_SPECS.heavy.shortLabel);

    const bracket = createTournamentBracket(units);
    const tourneyText = formatTournamentSummaryText(bracket, modCfg);
    expect(tourneyText).toContain(GRAVITY_PRESET_SPECS.low_2.shortLabel);
    expect(tourneyText).toContain(SANDSTORM_PRESET_SPECS.heavy.shortLabel);

    // Default normal/none omits gravity & sandstorm labels
    const defReport = buildMatchReport(createBattlefieldMatchState(parts, DEFAULT_BATTLEFIELD_CONFIG), parts, DEFAULT_BATTLEFIELD_CONFIG);
    const defText = formatMatchReportText(defReport);
    expect(defText).not.toContain('標準重力');
    expect(defText).not.toContain('砂塵なし');
  });

  it('computes ramming_derby damage as mainGunMaxFirepower * 3 * speedFactor using pre-impact speed', () => {
    const baseCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'ramming_derby' as const,
      disableWeapons: true,
      obstacleMode: 'none' as const,
      zoneMode: 'none' as const,
    };

    const chargerBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'ram_charger',
      name: '突撃スタンダード',
      author: 'R1',
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        cpu: 'mini_4x4',
        chassis: 'standard',
        mainGun: 'standard',
      },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
      ]),
    };
    const cannonSentryBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'ram_sentry',
      name: '固定キャノン',
      author: 'R2',
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        cpu: 'mini_4x4',
        chassis: 'heavy',
        mainGun: 'cannon',
      },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: null },
      ]),
    };

    const eCharger = createRosterEntryFromBlueprint(chargerBp, 'test');
    const eSentry = createRosterEntryFromBlueprint(cannonSentryBp, 'test');
    const parts = [
      { entry: eCharger, teamId: 'ffa_0', teamLabel: 'R1', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eSentry, teamId: 'ffa_1', teamLabel: 'R2', teamColor: '#e69f00', slotIndex: 1 },
    ];

    const probeState = createBattlefieldMatchState(parts, baseCfg);
    const probe = probeState.tanks[0];

    // 1. Direct formula verification across guns and speed tiers
    for (const gunId of ['rapid', 'standard', 'cannon'] as const) {
      probe.blueprint.assembly.mainGun = gunId;
      const gunMax = computeShellMetrics(
        gunId,
        MAIN_GUN_SPECS[gunId].maxPower,
        probe.blueprint.assembly.chassis
      ).damage;

      probe.lastCollisionImpactSpeed = 0;
      probe.boostTicks = 0;
      expect(computeRammingDamage(probe)).toBeCloseTo(
        gunMax * RAMMING_DAMAGE_MULTIPLIER * 0.3,
        4
      );

      probe.lastCollisionImpactSpeed = 3.5;
      probe.boostTicks = 0;
      expect(computeRammingDamage(probe)).toBeCloseTo(
        gunMax * RAMMING_DAMAGE_MULTIPLIER * 1.0,
        4
      );

      probe.lastCollisionImpactSpeed = 6.0;
      probe.boostTicks = 10;
      expect(computeRammingDamage(probe)).toBeCloseTo(
        gunMax * RAMMING_DAMAGE_MULTIPLIER * 1.5,
        4
      );
    }

    // 2. Live collision: charging standard tank vs stationary heavy cannon tank
    const st = createBattlefieldMatchState(parts, baseCfg);
    const charger = st.tanks[0];
    const sentry = st.tanks[1];
    charger.x = 400;
    charger.y = 400;
    charger.bodyAngle = 90;
    charger.speed = 3.5;
    sentry.x = 438;
    sentry.y = 400;
    sentry.bodyAngle = 270;
    sentry.speed = 0;
    sentry.hp = 35;

    stepBattlefieldTick(st, baseCfg);

    // Pre-impact speed preserved on runtime state
    expect(charger.lastCollisionImpactSpeed).toBeGreaterThanOrEqual(3.5);
    expect(sentry.lastCollisionImpactSpeed).toBe(0);

    // Stationary cannon target deals only 0.3x recoil (~20.6) instead of full 1.0x (~68.7)
    const expectedRecoil =
      computeShellMetrics('cannon', MAIN_GUN_SPECS.cannon.maxPower, 'heavy').damage * 3 * 0.3;
    expect(sentry.stats.damageDealt).toBeCloseTo(expectedRecoil, 3);
    expect(sentry.stats.ruleScore).toBe(Math.round(expectedRecoil));

    // Charging standard tank deals > 1.0x (>39.3), higher than sentry's recoil, and finishes sentry
    expect(charger.stats.damageDealt).toBeGreaterThan(expectedRecoil);
    expect(charger.stats.ruleScore).toBe(Math.round(charger.stats.damageDealt));
    expect(sentry.hp).toBe(0);
    expect(sentry.killedById).toBe(charger.id);
    expect(charger.stats.kills).toBe(1);
    expect(st.status).toBe('finished');
    expect(st.winnerId).toBe(charger.id);
  });

  it('runs balloon_hunt: targets only balloons, blocks tank damage with amplified bounce, scores shoot/ram + respawns', () => {
    const shooterBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'bh_shooter',
      name: '風船ハンター',
      author: 'B1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', radar: 'balanced' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_aim_enemy', params: { lead: 'direct', offsetDeg: 0 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_fire', params: { power: 'fast', wait: 0 }, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0 }, next: null },
      ]),
    };
    const idleBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'bh_idle',
      name: '風船待機機',
      author: 'B2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', radar: 'balanced' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: null },
      ]),
    };

    const e1 = createRosterEntryFromBlueprint(shooterBp, 'test');
    const e2 = createRosterEntryFromBlueprint(idleBp, 'test');
    const parts = [
      { entry: e1, teamId: 'team_0', teamLabel: 'Blue', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: e2, teamId: 'team_1', teamLabel: 'Orange', teamColor: '#e69f00', slotIndex: 1 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'balloon_hunt' as const,
      arenaSize: 'medium' as const,
      obstacleMode: 'none' as const,
      outerWallMode: 'damage' as const,
      maxSeconds: 20,
    };
    const st = createBattlefieldMatchState(parts, cfg);
    expect(st.arena.targets?.length).toBe(6);

    // Override targets with controlled red (1pt) and gold (3pt) balloons; place enemy closer than red balloon
    st.arena.targets = [
      { id: 'b_red', kind: 'shoot_balloon', x: 520, y: 400, radius: 20, hp: 1, maxHp: 1, points: 1, color: '#f43f5e' },
      { id: 'b_gold', kind: 'shoot_balloon', x: 315, y: 600, radius: 17, hp: 1, maxHp: 1, points: 3, color: '#facc15' },
    ];
    const hunter = st.tanks[0];
    const enemy = st.tanks[1];
    hunter.x = 200;
    hunter.y = 400;
    hunter.bodyAngle = 90;
    hunter.turretAngle = 90;
    hunter.radarAngle = 90;
    enemy.x = 310;
    enemy.y = 400;

    // 1. Radar ignores closer enemy at 310 and locks onto b_red at 520; shell hits enemy without dealing damage
    for (let i = 0; i < 6; i++) {
      stepBattlefieldTick(st, cfg);
    }
    expect(hunter.radarLock).toBe(true);
    expect(hunter.detectedEnemy?.id).toBe('b_red');
    expect(enemy.hp).toBe(enemy.maxHp);
    expect(enemy.stats.damageTaken).toBe(0);

    // 2. Electric wall & tank-to-tank collision deal 0 damage; ramming gold balloon awards 3pt; respawns fill up to 6
    enemy.x = st.arena.width - 5;
    hunter.x = 305;
    hunter.y = 600;
    stepBattlefieldTick(st, cfg);
    expect(enemy.hp).toBe(enemy.maxHp);
    expect(hunter.hp).toBe(hunter.maxHp);
    expect(hunter.stats.ruleScore).toBeGreaterThanOrEqual(3);
    expect(st.arena.targets.length).toBe(6);

    // 3. Timeout decides winner strictly by balloon points
    st.tick = st.arena.maxTicks - 1;
    stepBattlefieldTick(st, cfg);
    expect(st.status).toBe('finished');
    expect(st.winType).toBe('decision');
    expect(st.winnerId).toBe(hunter.id);
    expect(st.endReason).toContain('風船');
  });

  it('runs domination: solo claim, contested neutralize, continues after wipeout, and awards majority tiles even if wiped out', () => {
    const stationaryBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'dom_idle',
      name: '陣取り機',
      author: 'D',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: null },
      ]),
    };

    const eA = createRosterEntryFromBlueprint(stationaryBp, 'test');
    const eB = createRosterEntryFromBlueprint(stationaryBp, 'test');
    const parts = [
      { entry: eA, teamId: 'team_0', teamLabel: 'Team A', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eB, teamId: 'team_1', teamLabel: 'Team B', teamColor: '#e69f00', slotIndex: 1 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'domination' as const,
      arenaSize: 'small' as const,
      obstacleMode: 'none' as const,
      maxSeconds: 20,
    };
    const st = createBattlefieldMatchState(parts, cfg);
    expect(st.territoryGrid).toBeDefined();
    const grid = st.territoryGrid!;
    expect(grid.cols).toBe(6);
    expect(grid.rows).toBe(5);

    const cellW = st.arena.width / grid.cols;
    const cellH = st.arena.height / grid.rows;

    // 1. Place Team A alone in cell (2,2), Team B in (4,4) -> both claim their cells
    st.tanks[0].x = cellW * 2.5;
    st.tanks[0].y = cellH * 2.5;
    st.tanks[1].x = cellW * 4.5;
    st.tanks[1].y = cellH * 4.5;
    stepBattlefieldTick(st, cfg);
    expect(grid.owners[2 * grid.cols + 2]).toBe('team_0');
    expect(grid.owners[4 * grid.cols + 4]).toBe('team_1');

    // 2. Team B enters cell (2,2) too -> contested cell becomes neutral (null)
    st.tanks[1].x = cellW * 2.4;
    st.tanks[1].y = cellH * 2.4;
    stepBattlefieldTick(st, cfg);
    expect(grid.owners[2 * grid.cols + 2]).toBeNull();

    // 3. Team A claims 3 cells, then gets wiped out -> match does NOT end early while Team B is alive,
    //    and at timeout wiped-out Team A still wins because it holds more tiles (3 > 1)
    for (let c = 0; c < 3; c++) {
      grid.owners[c] = 'team_0';
    }
    st.tanks[0].hp = 0;
    st.tanks[1].x = cellW * 5.5;
    st.tanks[1].y = cellH * 4.5;
    stepBattlefieldTick(st, cfg);
    expect(st.status).toBe('running');

    st.tick = st.arena.maxTicks - 1;
    stepBattlefieldTick(st, cfg);
    expect(st.status).toBe('finished');
    expect(st.winType).toBe('decision');
    expect(st.winnerId).toBe(st.tanks[0].id);
    expect(st.endReason).toContain('Team A');

    // 4. All teams wiped out (Double KO / delayed mine) ends early and awards tile leader
    const stAllDead = createBattlefieldMatchState(parts, cfg);
    stAllDead.territoryGrid!.owners[0] = 'team_1';
    stAllDead.territoryGrid!.owners[1] = 'team_1';
    stAllDead.territoryGrid!.owners[2] = 'team_0';
    stAllDead.tanks[0].hp = 0;
    stAllDead.tanks[1].hp = 0;
    stepBattlefieldTick(stAllDead, cfg);
    expect(stAllDead.status).toBe('finished');
    expect(stAllDead.winnerId).toBe(stAllDead.tanks[1].id);
  });

  it('runs tank_soccer (Combat Football): radar locks ball only, shell kicks ball, endline scores & resets kickoff, reports result', () => {
    const kickerBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'fb_kicker',
      name: 'ストライカー',
      author: 'F1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', radar: 'balanced' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_aim_enemy', params: { lead: 'direct', offsetDeg: 0 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_fire', params: { power: 'heavy', wait: 0 }, next: null },
      ]),
    };
    const keeperBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'fb_keeper',
      name: 'キーパー',
      author: 'F2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', radar: 'balanced' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: null },
      ]),
    };

    const eW = createRosterEntryFromBlueprint(kickerBp, 'test');
    const eE = createRosterEntryFromBlueprint(keeperBp, 'test');
    const parts = [
      { entry: eW, teamId: 'team_0', teamLabel: 'Team A', teamColor: '#56b4e9', slotIndex: 0 },
      { entry: eE, teamId: 'team_1', teamLabel: 'Team B', teamColor: '#e69f00', slotIndex: 0 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      format: 'team_match' as const,
      ruleId: 'tank_soccer' as const,
      arenaSize: 'medium' as const,
      obstacleMode: 'none' as const,
      maxSeconds: 20,
    };

    const st = createBattlefieldMatchState(parts, cfg);
    expect(st.football).toBeDefined();
    const fb = st.football!;
    const west = st.tanks[0];
    const east = st.tanks[1];

    // 0. Initial kickoff uses randomized placements inside each team's half
    expect(fb.kickoffCount).toBe(1);
    const firstWestSpawn = { ...fb.kickoffSpawns[west.id] };
    const firstEastSpawn = { ...fb.kickoffSpawns[east.id] };
    expect(firstWestSpawn.x).toBeGreaterThanOrEqual(st.arena.width * 0.1);
    expect(firstWestSpawn.x).toBeLessThanOrEqual(st.arena.width * 0.42);
    expect(firstEastSpawn.x).toBeGreaterThanOrEqual(st.arena.width * 0.58);
    expect(firstEastSpawn.x).toBeLessThanOrEqual(st.arena.width * 0.9);

    // 1. Place West striker inline with ball and East keeper between them; striker still locks onto football only & kicks ball East on shot
    west.x = 240;
    west.y = fb.y;
    west.bodyAngle = 90;
    west.turretAngle = 90;
    west.radarAngle = 90;
    east.x = 340;
    east.y = fb.y;
    stepBattlefieldTick(st, cfg);
    expect(west.radarLock).toBe(true);
    expect(west.detectedEnemy?.id).toBe('football');

    // Move keeper out of shot line and test shell kicking ball + zero tank damage when keeper intercepts
    east.x = st.arena.width - 120;
    west.gunHeat = 0;
    west.fireState = null;
    for (let i = 0; i < 40; i++) {
      stepBattlefieldTick(st, cfg);
    }
    expect(fb.vx).toBeGreaterThan(1.0);
    expect(east.hp).toBe(east.maxHp);
    expect(west.hp).toBe(west.maxHp);

    // 2. Move ball across East endline -> Team A (West) scores 1 and holds ball at endline for UI 1s beat;
    //    subsequent tick resets ball to center and generates new randomized kickoff positions
    west.x = 600;
    west.y = 200;
    st.projectiles.push({
      id: 'pre_goal_shell',
      ownerId: west.id,
      kind: 'shell',
      x: 500,
      y: 250,
      vx: 4,
      vy: 0,
      angle: 90,
      speed: 4,
      power: 1,
      damage: 5,
      color: '#38bdf8',
      ttl: 100,
    });
    fb.x = st.arena.width - fb.radius + 1;
    fb.vx = 4;
    stepBattlefieldTick(st, cfg);
    expect(st.ruleTeamScores?.[fb.westTeamId]).toBe(1);
    expect(st.ruleTeamScores?.[fb.eastTeamId]).toBe(0);
    expect(fb.pendingKickoffReset).toBe(true);
    expect(fb.x).toBeCloseTo(st.arena.width - fb.radius, 1);
    expect(fb.vx).toBe(0);
    expect(fb.lastGoalBanner?.teamId).toBe(fb.westTeamId);
    expect(st.projectiles.length).toBe(0);

    stepBattlefieldTick(st, cfg);
    expect(fb.pendingKickoffReset).toBe(false);
    expect(fb.x).toBeCloseTo(st.arena.width / 2, 1);
    expect(fb.y).toBeCloseTo(st.arena.height / 2, 1);
    expect(fb.kickoffCount).toBe(2);
    const secondWestSpawn = fb.kickoffSpawns[west.id];
    const secondEastSpawn = fb.kickoffSpawns[east.id];
    expect(
      secondWestSpawn.x !== firstWestSpawn.x ||
        secondWestSpawn.y !== firstWestSpawn.y ||
        secondEastSpawn.x !== firstEastSpawn.x ||
        secondEastSpawn.y !== firstEastSpawn.y
    ).toBe(true);
    expect(west.x).toBeCloseTo(secondWestSpawn.x, 1);
    expect(west.y).toBeCloseTo(secondWestSpawn.y, 1);
    expect(secondWestSpawn.x).toBeLessThanOrEqual(st.arena.width * 0.42);
    expect(secondEastSpawn.x).toBeGreaterThanOrEqual(st.arena.width * 0.58);
    expect(st.projectiles.some((p) => p.id === 'pre_goal_shell')).toBe(false);

    // 3. Finish at timeout -> Team A wins 1 - 0; report ranks winner correctly
    st.tick = st.arena.maxTicks - 1;
    stepBattlefieldTick(st, cfg);
    expect(st.status).toBe('finished');
    expect(st.winType).toBe('decision');
    expect(st.winnerId).toBe(west.id);
    expect(st.endReason).toContain('Team A 1 - 0 Team B');

    const report = buildMatchReport(st, parts, cfg);
    expect(report.winnerTeamId).toBe('team_0');
    expect(report.teamRows[0].teamId).toBe('team_0');
    const txt = formatMatchReportText(report);
    expect(txt).toContain('コンバットフットボール');
    expect(txt).toContain('Team A 1 - 0 Team B');

    // 4. Own-goal firing override blocks shells & missiles aimed past North-South line toward own goal
    const shooterBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'fb_fixed_gun',
      name: '固定角度砲手',
      author: 'F3',
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        cpu: 'mini_4x4',
        subWeapon: 'missile',
      },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 'normal', wait: 0 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_sub_weapon', params: {}, next: null },
      ]),
    };
    const eFireW = createRosterEntryFromBlueprint(shooterBp, 'test');
    const eFireE = createRosterEntryFromBlueprint(shooterBp, 'test');
    const fireParts = [
      { entry: eFireW, teamId: 'team_0', teamLabel: 'Team A', teamColor: '#56b4e9', slotIndex: 0 },
      { entry: eFireE, teamId: 'team_1', teamLabel: 'Team B', teamColor: '#e69f00', slotIndex: 0 },
    ];
    const checkOwnGoalBlock = (teamSide: 'west' | 'east', angle: number, expectBlocked: boolean) => {
      const fSt = createBattlefieldMatchState(fireParts, { ...cfg, obstacleSeed: 7 });
      fSt.tanks[0].x = 250;
      fSt.tanks[0].y = 400;
      fSt.tanks[1].x = 750;
      fSt.tanks[1].y = 400;
      const actor = teamSide === 'west' ? fSt.tanks[0] : fSt.tanks[1];
      const idleOther = teamSide === 'west' ? fSt.tanks[1] : fSt.tanks[0];
      actor.turretAngle = angle;
      // Aim idle tank toward its own goal so it never fires and never interferes
      idleOther.turretAngle = teamSide === 'west' ? 90 : 270;
      const initSubAmmo = actor.subAmmo;
      stepBattlefieldTick(fSt, cfg);
      if (expectBlocked) {
        expect(actor.stats.shotsFired).toBe(0);
        expect(actor.subAmmo).toBe(initSubAmmo);
        expect(fSt.projectiles.length).toBe(0);
      } else {
        expect(actor.stats.shotsFired).toBe(2); // main shell + missile
        expect(actor.subAmmo).toBe(initSubAmmo - 1);
      }
    };

    // West team: blocked when aiming West (225, 270, 315); allowed when North (0), South (180), or East (90)
    checkOwnGoalBlock('west', 270, true);
    checkOwnGoalBlock('west', 225, true);
    checkOwnGoalBlock('west', 315, true);
    checkOwnGoalBlock('west', 0, false);
    checkOwnGoalBlock('west', 180, false);
    checkOwnGoalBlock('west', 90, false);

    // East team: blocked when aiming East (45, 90, 135); allowed when North (0) or West (270)
    checkOwnGoalBlock('east', 90, true);
    checkOwnGoalBlock('east', 45, true);
    checkOwnGoalBlock('east', 135, true);
    checkOwnGoalBlock('east', 0, false);
    checkOwnGoalBlock('east', 270, false);
  });

  it('defines and applies curated recommended map presets for 4-tank and 8-tank modes', () => {
    const ruleIds = [
      'elimination',
      'ramming_derby',
      'balloon_hunt',
      'domination',
      'tank_soccer',
    ] as const;

    for (const ruleId of ruleIds) {
      expect(BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][4].summary.length).toBeGreaterThan(0);
      expect(BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][8].summary.length).toBeGreaterThan(0);
    }

    // User-specified defaults and random seed selection for obstacle-using modes
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.elimination[4]).toMatchObject({
      arenaSize: 'medium',
      obstacleMode: 'few',
      maxSeconds: 120,
      obstacleSeed: 'random',
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.elimination[8]).toMatchObject({
      arenaSize: 'large',
      obstacleMode: 'few',
      maxSeconds: 180,
      obstacleSeed: 'random',
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.ramming_derby[4]).toMatchObject({
      arenaSize: 'small',
      obstacleMode: 'none',
      outerWallMode: 'bounce',
      maxSeconds: 120,
      disableWeapons: true,
      obstacleSeed: -1,
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.ramming_derby[8]).toMatchObject({
      arenaSize: 'small',
      obstacleMode: 'none',
      outerWallMode: 'damage_bounce',
      maxSeconds: 120,
      disableWeapons: true,
      obstacleSeed: -1,
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.balloon_hunt[4]).toMatchObject({
      arenaSize: 'medium',
      obstacleMode: 'few',
      outerWallMode: 'bounce',
      maxSeconds: 60,
      obstacleSeed: 'random',
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.balloon_hunt[8]).toMatchObject({
      arenaSize: 'large',
      obstacleMode: 'few',
      outerWallMode: 'bounce',
      maxSeconds: 60,
      obstacleSeed: 'random',
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.domination[4]).toMatchObject({
      arenaSize: 'small',
      obstacleMode: 'few',
      maxSeconds: 60,
      obstacleSeed: 'random',
    });
    expect(BATTLEFIELD_RECOMMENDED_PRESETS.domination[8]).toMatchObject({
      arenaSize: 'large',
      obstacleMode: 'few',
      maxSeconds: 120,
      obstacleSeed: 'random',
    });
    for (const tier of [4, 8] as const) {
      expect(BATTLEFIELD_RECOMMENDED_PRESETS.tank_soccer[tier]).toMatchObject({
        arenaSize: 'medium',
        obstacleMode: 'none',
        outerWallMode: 'bounce',
        maxSeconds: 60,
        obstacleSeed: -1,
      });
    }

    // Tier resolution considers competition format (single/pair up to 4 on field) vs open roster size
    expect(resolveRecommendedTankTier('battle_royale', 1, 4)).toBe(4);
    expect(resolveRecommendedTankTier('battle_royale', 1, 5)).toBe(4);
    expect(resolveRecommendedTankTier('battle_royale', 1, 6)).toBe(8);
    expect(resolveRecommendedTankTier('team_match', 1, 8)).toBe(8);
    expect(resolveRecommendedTankTier('tournament', 1, 8)).toBe(4);
    expect(resolveRecommendedTankTier('league', 2, 12)).toBe(4);

    // Pure application & exact preset detection across all rules and tiers
    const parts = [
      DEFAULT_PLAYER_BLUEPRINT,
      ENEMY_DUMMY,
      ENEMY_PATROL,
      PRESET_ENEMIES[1],
    ].map((bp, i) => ({
      entry: createRosterEntryFromBlueprint(bp, 'CPU', true),
      teamId: `team_${i % 2}`,
      teamLabel: `Team ${i % 2 === 0 ? 'A' : 'B'}`,
      teamColor: i % 2 === 0 ? '#56b4e9' : '#e69f00',
      slotIndex: Math.floor(i / 2),
    }));

    for (const ruleId of ruleIds) {
      for (const tier of [4, 8] as const) {
        const dirtyCfg = {
          ...DEFAULT_BATTLEFIELD_CONFIG,
          format: 'team_match' as const,
          ruleId,
          cpuRegulation: 'max_8x8' as const,
          teamUnitSize: 2 as const,
          arenaSize: 'tiny' as const,
          obstacleMode: 'maze' as const,
          outerWallMode: 'damage' as const,
          zoneMode: 'mixed' as const,
          gravityPreset: 'low_2' as const,
          sandstormPreset: 'extreme' as const,
          maxSeconds: 300,
          disableWeapons: ruleId !== 'ramming_derby',
          disableSubWeapons: true,
          obstacleSeed: 9999,
        };
        const applied = applyRecommendedMapPreset(dirtyCfg, tier, () => 0.25);
        // Does not mutate dirtyCfg and preserves competition settings
        expect(dirtyCfg.arenaSize).toBe('tiny');
        expect(applied.format).toBe('team_match');
        expect(applied.ruleId).toBe(ruleId);
        expect(applied.cpuRegulation).toBe('max_8x8');
        expect(applied.teamUnitSize).toBe(2);
        expect(applied.gravityPreset).toBe('normal');
        expect(applied.sandstormPreset).toBe('none');
        expect(applied.zoneMode).toBe('none');
        expect(isRecommendedMapPresetApplied(applied, tier)).toBe(true);

        const usesRandomSeed = BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][tier].obstacleSeed === 'random';
        if (usesRandomSeed) {
          expect(applied.obstacleSeed).toBe(2251);
          const secondRoll = applyRecommendedMapPreset(dirtyCfg, tier, () => 0.75);
          expect(secondRoll.obstacleSeed).toBe(6751);
          expect(isRecommendedMapPresetApplied({ ...applied, obstacleSeed: 1234 }, tier)).toBe(true);
        } else {
          expect(applied.obstacleSeed).toBe(-1);
          expect(isRecommendedMapPresetApplied({ ...applied, obstacleSeed: 1234 }, tier)).toBe(false);
        }
        expect(isRecommendedMapPresetApplied({ ...applied, arenaSize: 'tiny' }, tier)).toBe(false);

        const matchState = createBattlefieldMatchState(parts, applied);
        expect(matchState.arena.sizeId).toBe(BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][tier].arenaSize);
        expect(matchState.arena.maxTicks).toBe(
          BATTLEFIELD_RECOMMENDED_PRESETS[ruleId][tier].maxSeconds * 20
        );
      }
    }
  });

  it('disambiguates colliding Battlefield player names with UUID tail or random 2-digit suffixes', () => {
    const alice = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Alice', authorUuid: '12345678-aaaa-4bbb-8ccc-1234567890ef' },
      'file'
    );
    const bob = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Bob', authorUuid: '12345678-aaaa-4bbb-8ccc-123456789011' },
      'file'
    );
    const distinct = disambiguateRosterPlayerNames([alice, bob]);
    expect(distinct.map((e) => e.playerName)).toEqual(['Alice', 'Bob']);

    // Duplicate player names with distinct authorUuids -> suffix with uppercase UUID tail 2 chars
    const p1 = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Player', authorUuid: '550e8400-e29b-41d4-a716-4466554400a9' },
      'file'
    );
    const p2 = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Player', authorUuid: '550e8400-e29b-41d4-a716-44665544003f' },
      'file'
    );
    // Same name AND same authorUuid as p1 -> first uses UUID tail, second falls back to unique 2-digit number
    const p3 = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Player', authorUuid: '550e8400-e29b-41d4-a716-4466554400a9' },
      'file'
    );
    const rngSeq = [0.42, 0.42, 0.77];
    let rIdx = 0;
    const deterministicRng = () => rngSeq[Math.min(rIdx++, rngSeq.length - 1)];

    const afterThree = disambiguateRosterPlayerNames([p1, p2, p3], deterministicRng);
    expect(afterThree.map((e) => e.playerName)).toEqual([
      'Player-A9',
      'Player-3F',
      'Player-42',
    ]);

    // Preserves already-assigned unique suffixes when adding a 4th colliding entry without UUID
    const p4 = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Player' },
      'file'
    );
    const afterFour = disambiguateRosterPlayerNames([...afterThree, p4], deterministicRng);
    expect(afterFour[0].playerName).toBe('Player-A9');
    expect(afterFour[1].playerName).toBe('Player-3F');
    expect(afterFour[2].playerName).toBe('Player-42');
    expect(afterFour[3].playerName).toBe('Player-77');
    expect(new Set(afterFour.map((e) => e.playerName)).size).toBe(4);

    // Preset CPU duplicates receive unique 2-digit numeric suffixes
    const cpu1 = createRosterEntryFromBlueprint(PRESET_ENEMIES[0], '規定戦車', true);
    const cpu2 = createRosterEntryFromBlueprint(PRESET_ENEMIES[1], '規定戦車', true);
    const cpuResult = disambiguateRosterPlayerNames([cpu1, cpu2]);
    expect(cpuResult[0].playerName).toMatch(/^CPU-\d{2}$/);
    expect(cpuResult[1].playerName).toMatch(/^CPU-\d{2}$/);
    expect(cpuResult[0].playerName).not.toBe(cpuResult[1].playerName);

    // Respects maxLength=16 even if an entry already collides with an existing suffixed name
    const longA = createRosterEntryFromBlueprint(
      { ...DEFAULT_PLAYER_BLUEPRINT, author: 'Player' },
      'file'
    );
    const longB = {
      ...createRosterEntryFromBlueprint({ ...DEFAULT_PLAYER_BLUEPRINT, author: 'LongName12345678' }, 'file'),
      playerName: '1234567890123-05',
      basePlayerName: '1234567890123',
    };
    const longC = {
      ...createRosterEntryFromBlueprint({ ...DEFAULT_PLAYER_BLUEPRINT, author: 'LongName12345678' }, 'file'),
      playerName: '1234567890123-05',
      basePlayerName: '1234567890123',
    };
    const safeLong = disambiguateRosterPlayerNames([longA, longB, longC], () => 0.05);
    expect(safeLong.every((e) => e.playerName.length <= 16)).toBe(true);
    expect(new Set(safeLong.map((e) => e.playerName)).size).toBe(3);
  });

  it('generates prioritized live commentary across styles and rules with speech defaulting off', () => {
    expect(DEFAULT_COMMENTARY_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_COMMENTARY_SETTINGS.speechEnabled).toBe(false);

    const standbyCfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'elimination' as const };
    const mkParts = (twoTeams = false) =>
      [DEFAULT_PLAYER_BLUEPRINT, PRESET_ENEMIES[1], PRESET_ENEMIES[6], PRESET_ENEMIES[7]].map(
        (bp, i) => ({
          entry: createRosterEntryFromBlueprint(bp, 'CPU', true),
          teamId: twoTeams ? `team_${i % 2}` : `solo_${i}`,
          teamLabel: twoTeams ? (i % 2 === 0 ? 'Team A' : 'Team B') : bp.name,
          teamColor: i % 2 === 0 ? '#56b4e9' : '#e69f00',
          slotIndex: i,
        })
      );

    // 1. Opening + cooldown suppression + rear critical + low HP pinch + KO (+ Duel) + Finish
    for (const style of ['standard', 'hype', 'analyst'] as CommentaryStyle[]) {
      const state = createBattlefieldMatchState(mkParts(false), standbyCfg);
      const tracker = createCommentaryTracker(state, standbyCfg);
      const settings = { ...DEFAULT_COMMENTARY_SETTINGS, style };

      expect(createStandbyCommentaryText(state, standbyCfg)).toContain('待機中');

      // Tick 1: opening (B)
      state.tick = 1;
      const openEntry = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 1000);
      expect(openEntry?.category).toBe('opening');
      expect(openEntry?.speechText).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);

      // Tick 20 (1200ms): first hit (B) should be suppressed within 1700ms hold window
      state.tick = 20;
      state.tanks[0].stats.damageDealt = 12;
      state.tanks[1].hp -= 12;
      const suppressedHit = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 1200);
      expect(suppressedHit).toBeNull();

      // Tick 80 (3200ms): rear critical hit (A)
      state.tick = 80;
      state.tanks[0].lastAttackHitTick = 80;
      state.tanks[1].lastHitZone = 'rear';
      state.tanks[1].hp = Math.max(10, state.tanks[1].maxHp * 0.5);
      const rearEntry = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 3200);
      expect(rearEntry?.category).toBe('critical');
      expect(rearEntry?.priority).toBe('A');

      // Low HP pinch (A) once elapsed >= 1700ms
      state.tick = 110;
      state.tanks[1].hp = 5;
      const lowEntry = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 5000);
      expect(lowEntry?.category).toBe('low_hp');

      // Eliminations drop 4 teams -> 2 teams -> triggers S-priority KO immediately (even at +100ms!) with duel suffix
      state.tick = 112;
      state.tanks[1].hp = 0;
      state.tanks[1].killedById = state.tanks[0].id;
      state.tanks[0].stats.kills = 1;
      state.tanks[2].hp = 0;
      state.tanks[2].killedById = state.tanks[0].id;
      const koEntry = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 5100);
      expect(koEntry?.priority).toBe('S');
      expect(koEntry?.category).toBe('ko');
      expect(koEntry?.text).toContain('一騎打ち');

      // Match Finish (S)
      state.tick = 150;
      state.tanks[3].hp = 0;
      state.status = 'finished';
      state.winnerId = state.tanks[0].id;
      state.winType = 'elimination';
      const finishEntry = evaluateCommentaryStep(tracker, state, standbyCfg, settings, 5200);
      expect(finishEntry?.priority).toBe('S');
      expect(finishEntry?.category).toBe('finish');
    }

    // 2. Disabled commentary updates tracker cleanly without emitting stale lines when turned back ON
    {
      const state = createBattlefieldMatchState(mkParts(false), standbyCfg);
      const tracker = createCommentaryTracker(state, standbyCfg);
      const offSettings = { ...DEFAULT_COMMENTARY_SETTINGS, enabled: false };
      state.tick = 10;
      state.tanks[1].hp = 0;
      expect(evaluateCommentaryStep(tracker, state, standbyCfg, offSettings, 1000)).toBeNull();
      state.tick = 11;
      const onSettings = { ...DEFAULT_COMMENTARY_SETTINGS, enabled: true };
      expect(evaluateCommentaryStep(tracker, state, standbyCfg, onSettings, 3000)).toBeNull();
    }

    // 3. Rule-specific commentary: Combat Football goal, Balloon Hunt gold +3pt, Domination wiped-out win
    {
      const fbCfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'tank_soccer' as const };
      const fbState = createBattlefieldMatchState(mkParts(true), fbCfg);
      const fbTracker = createCommentaryTracker(fbState, fbCfg);
      fbState.tick = 40;
      const fb = fbState.football!;
      fbState.ruleTeamScores = { [fb.westTeamId]: 1, [fb.eastTeamId]: 0 };
      fb.lastTouchTankId = fbState.tanks[0].id;
      fb.lastTouchTeamId = fb.westTeamId;
      fb.lastGoalBanner = {
        teamId: fb.westTeamId,
        teamLabel: fb.westTeamLabel,
        color: fb.westTeamColor,
        tick: 40,
      };
      const goalEntry = evaluateCommentaryStep(fbTracker, fbState, fbCfg, DEFAULT_COMMENTARY_SETTINGS, 2000);
      expect(goalEntry?.category).toBe('goal');
      expect(goalEntry?.text).toContain('GOAL');
      expect(goalEntry?.text).toContain('1 - 0');
    }

    {
      const bhCfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'balloon_hunt' as const };
      const bhState = createBattlefieldMatchState(mkParts(false), bhCfg);
      const bhTracker = createCommentaryTracker(bhState, bhCfg);
      bhState.tick = 50;
      bhState.tanks[0].stats.ruleScore = 3;
      const goldEntry = evaluateCommentaryStep(bhTracker, bhState, bhCfg, DEFAULT_COMMENTARY_SETTINGS, 3000);
      expect(goldEntry?.badge).toBe('金風船');
    }

    {
      const domCfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'domination' as const };
      const domState = createBattlefieldMatchState(mkParts(true), domCfg);
      const domTracker = createCommentaryTracker(domState, domCfg);
      domState.tick = 200;
      domState.tanks.forEach((t) => {
        t.hp = 0;
      });
      domState.ruleTeamScores = { team_0: 14, team_1: 6 };
      domState.status = 'finished';
      domState.winnerId = domState.tanks[0].id;
      domState.winType = 'decision';
      const domFinish = evaluateCommentaryStep(domTracker, domState, domCfg, DEFAULT_COMMENTARY_SETTINGS, 4000);
      expect(domFinish?.category).toBe('finish');
      expect(domFinish?.text).toContain('全滅');
      expect(domFinish?.text).toContain('14マス');
    }
  });

  it('decides non-score timeout matches by survivor count then base contribution so #1 aligns with MVP', () => {
    const cfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'elimination' as const, maxSeconds: 180 };
    const idleA = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: 'ライト逃げ切り',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'light' as const },
      program: buildProgram(6, 'relative', []),
    };
    const idleB = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: 'エース撃破王',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, chassis: 'standard' as const },
      program: buildProgram(6, 'relative', []),
    };
    const idleDead = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: '序盤脱落',
      program: buildProgram(6, 'relative', []),
    };

    const parts = [idleA, idleB, idleDead].map((bp, i) => ({
      entry: createRosterEntryFromBlueprint(bp, 'CPU', true),
      teamId: `solo_${i}`,
      teamLabel: bp.name,
      teamColor: ['#56b4e9', '#e69f00', '#009e73'][i],
      slotIndex: i,
    }));

    const st = createBattlefieldMatchState(parts, cfg);
    st.tick = st.arena.maxTicks - 1;

    // Tank 0: higher remaining HP ratio (15/90 = 16.7%) but 0 kills, lower base contribution
    st.tanks[0].maxHp = 90;
    st.tanks[0].hp = 15;
    st.tanks[0].stats.kills = 0;
    st.tanks[0].stats.damageDealt = 235.6;
    st.tanks[0].stats.shotsHit = 88;
    st.tanks[0].stats.shotsFired = 238;

    // Tank 1: lower remaining HP ratio (12/130 = 9.2%) but 3 kills and higher damage/contribution
    st.tanks[1].maxHp = 130;
    st.tanks[1].hp = 12;
    st.tanks[1].stats.kills = 3;
    st.tanks[1].stats.damageDealt = 272.4;
    st.tanks[1].stats.shotsHit = 24;
    st.tanks[1].stats.shotsFired = 118;

    // Tank 2: dead despite strong early stats -> must NEVER win over surviving tanks
    st.tanks[2].hp = 0;
    st.tanks[2].stats.eliminatedAtTick = 1000;
    st.tanks[2].stats.kills = 3;
    st.tanks[2].stats.damageDealt = 320;

    expect(computeTankBaseContribution(st.tanks[1], st.arena.maxTicks)).toBeGreaterThan(
      computeTankBaseContribution(st.tanks[0], st.arena.maxTicks)
    );

    stepBattlefieldTick(st, cfg);

    expect(st.status).toBe('finished');
    expect(st.winType).toBe('decision');
    expect(st.winnerId).toBe(st.tanks[1].id);
    expect(st.endReason).toContain('貢献度判定');

    const report = buildMatchReport(st, parts, cfg);
    expect(report.tankRows[0].tankId).toBe(st.tanks[1].id);
    expect(report.tankRows[0].rank).toBe(1);
    expect(report.tankRows[0].awards).toContain('🏆 MVP');

    // 2v2 team match: 2 survivors beat 1 survivor even if eliminated teammate dealt heavy damage earlier
    const teamParts = [idleA, idleA, idleB, idleDead].map((bp, i) => ({
      entry: createRosterEntryFromBlueprint(bp, 'CPU', true),
      teamId: i < 2 ? 'team_0' : 'team_1',
      teamLabel: i < 2 ? 'Team A' : 'Team B',
      teamColor: i < 2 ? '#56b4e9' : '#e69f00',
      slotIndex: i % 2,
    }));
    const teamState = createBattlefieldMatchState(teamParts, { ...cfg, format: 'team_match' });
    teamState.tick = teamState.arena.maxTicks - 1;
    teamState.tanks[0].stats.shotsFired = 10;
    teamState.tanks[0].stats.damageDealt = 80;
    teamState.tanks[1].stats.shotsFired = 6;
    teamState.tanks[1].stats.damageDealt = 40;
    teamState.tanks[2].stats.shotsFired = 20;
    teamState.tanks[2].stats.damageDealt = 300;
    teamState.tanks[2].stats.kills = 2;
    teamState.tanks[3].hp = 0;
    teamState.tanks[3].stats.eliminatedAtTick = 500;
    teamState.tanks[3].stats.shotsFired = 15;
    teamState.tanks[3].stats.damageDealt = 250;

    stepBattlefieldTick(teamState, cfg);
    expect(teamState.status).toBe('finished');
    expect(teamState.winType).toBe('decision');
    expect(teamState.winnerId).toBe(teamState.tanks[0].id);
    expect(teamState.endReason).toContain('生存数優位');
  });

  it('builds style-synced post-match system summary and includes it when formatting match report text', () => {
    const smallGiantSlayer = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: 'ライト新星',
      program: buildProgram(4, 'relative', []),
    };
    const bigBoss = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      name: '重装ボス',
      program: buildProgram(12, 'relative', []),
    };
    const parts = [smallGiantSlayer, bigBoss].map((bp, i) => ({
      entry: createRosterEntryFromBlueprint(bp, i === 0 ? 'file' : 'CPU', i !== 0),
      teamId: `team_${i}`,
      teamLabel: i === 0 ? 'Taro' : 'CPU',
      teamColor: i === 0 ? '#56b4e9' : '#e69f00',
      slotIndex: 0,
    }));

    const cfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'elimination' as const, maxSeconds: 180 };
    const st = createBattlefieldMatchState(parts, cfg);
    st.tick = 1600;
    st.status = 'finished';
    st.winnerId = st.tanks[0].id;
    st.winType = 'elimination';
    st.endReason = 'ライト新星 (Player) の撃破勝利！';
    st.tanks[0].hp = 72;
    st.tanks[0].stats.kills = 1;
    st.tanks[0].stats.damageDealt = 210;
    st.tanks[0].stats.shotsFired = 15;
    st.tanks[0].stats.shotsHit = 9;
    st.tanks[1].hp = 0;
    st.tanks[1].stats.eliminatedAtTick = 1600;
    st.tanks[1].killedById = st.tanks[0].id;
    st.tanks[1].stats.damageDealt = 140;
    st.tanks[1].stats.shotsFired = 25;
    st.tanks[1].stats.shotsHit = 9; // 36% high accuracy runner-up

    const report = buildMatchReport(st, parts, cfg);
    const sampleLog = [
      {
        id: 'cm_900_1',
        tick: 900,
        timeSec: 45,
        priority: 'A' as const,
        category: 'critical' as const,
        badge: '背面直撃',
        text: '🎯 ライト新星が背面に直撃！',
        speechText: 'ライト新星が背面に直撃！',
      },
    ];

    const std = buildMatchSummaryComment(report, 'standard', sampleLog);
    const hype = buildMatchSummaryComment(report, 'hype', sampleLog);
    const analyst = buildMatchSummaryComment(report, 'analyst', sampleLog);

    expect(std.headline).toContain('ジャイアントキリング');
    expect(hype.headline).toContain('下克上');
    expect(analyst.headline).toContain('12×12');
    expect(std.headline).not.toBe(hype.headline);
    expect(std.highlights.some((h) => h.includes('36.0%'))).toBe(true);
    expect(std.highlights.some((h) => h.includes('45.0s'))).toBe(true);

    const plainText = formatMatchReportText(report);
    expect(plainText).not.toContain('[総評]');

    const summaryText = formatMatchReportText(report, hype);
    expect(summaryText).toContain(`[総評] ${hype.headline}`);
    for (const hl of hype.highlights) {
      expect(summaryText).toContain(`  ・${hl}`);
    }

    // Football shutout summary
    const fbCfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'tank_soccer' as const };
    const fbSt = createBattlefieldMatchState(parts, fbCfg);
    fbSt.tick = 1200;
    fbSt.ruleTeamScores = { team_0: 3, team_1: 0 };
    fbSt.status = 'finished';
    fbSt.winnerId = fbSt.tanks[0].id;
    fbSt.winType = 'decision';
    fbSt.endReason = 'Taro 3 - 0 CPU（Taro の勝利！）';
    const fbRep = buildMatchReport(fbSt, parts, fbCfg);
    const fbSum = buildMatchSummaryComment(fbRep, 'standard', []);
    expect(fbSum.headline).toContain('完封勝利');
  });

  it('lays out Battlefield HP HUD rows at max 4 per row (3+3 for 6) and clusters team members together', () => {
    const mkSoloTanks = (count: number) => {
      const parts = Array.from({ length: count }, (_, i) => ({
        entry: createRosterEntryFromBlueprint(DEFAULT_PLAYER_BLUEPRINT, 'CPU', true),
        teamId: `ffa_${i}`,
        teamLabel: `Tank ${i + 1}`,
        teamColor: '#56b4e9',
        slotIndex: i,
      }));
      return createBattlefieldMatchState(parts, DEFAULT_BATTLEFIELD_CONFIG).tanks;
    };

    const solo4 = computeBattlefieldHudLayout(mkSoloTanks(4));
    expect(solo4.isTeamGrouped).toBe(false);
    expect(solo4.rows.map((r) => r.clusters.length)).toEqual([4]);

    const solo5 = computeBattlefieldHudLayout(mkSoloTanks(5));
    expect(solo5.rows.map((r) => r.clusters.length)).toEqual([3, 2]);
    expect(solo5.rows.map((r) => r.columns)).toEqual([3, 3]);

    const solo6 = computeBattlefieldHudLayout(mkSoloTanks(6));
    expect(solo6.rows.map((r) => r.clusters.length)).toEqual([3, 3]);
    expect(solo6.rows.map((r) => r.columns)).toEqual([3, 3]);

    const solo7 = computeBattlefieldHudLayout(mkSoloTanks(7));
    expect(solo7.rows.map((r) => r.clusters.length)).toEqual([4, 3]);

    const solo8 = computeBattlefieldHudLayout(mkSoloTanks(8));
    expect(solo8.rows.map((r) => r.clusters.length)).toEqual([4, 4]);

    const mkInterleavedTeams = (teamCounts: number[]) => {
      const parts: Array<{
        entry: ReturnType<typeof createRosterEntryFromBlueprint>;
        teamId: string;
        teamLabel: string;
        teamColor: string;
        slotIndex: number;
      }> = [];
      const maxLen = Math.max(...teamCounts);
      for (let slot = 0; slot < maxLen; slot++) {
        teamCounts.forEach((cnt, tIdx) => {
          if (slot < cnt) {
            parts.push({
              entry: createRosterEntryFromBlueprint(DEFAULT_PLAYER_BLUEPRINT, 'CPU', true),
              teamId: `team_${tIdx}`,
              teamLabel: `Team ${String.fromCharCode(65 + tIdx)}`,
              teamColor: '#56b4e9',
              slotIndex: slot,
            });
          }
        });
      }
      return createBattlefieldMatchState(parts, {
        ...DEFAULT_BATTLEFIELD_CONFIG,
        format: 'team_match',
      }).tanks;
    };

    // 2v2 (4): single row keeping Team A (2) and Team B (2) grouped contiguously
    const twoVtwo = computeBattlefieldHudLayout(mkInterleavedTeams([2, 2]));
    expect(twoVtwo.isTeamGrouped).toBe(true);
    expect(twoVtwo.rows.length).toBe(1);
    expect(twoVtwo.rows[0].clusters.map((c) => [c.teamId, c.tankIds.length])).toEqual([
      ['team_0', 2],
      ['team_1', 2],
    ]);

    // 3v3 (6): 3 on Row 1 (Team A) and 3 on Row 2 (Team B)
    const threeVthree = computeBattlefieldHudLayout(mkInterleavedTeams([3, 3]));
    expect(threeVthree.isTeamGrouped).toBe(true);
    expect(threeVthree.rows.map((r) => r.clusters.map((c) => [c.teamId, c.tankIds.length]))).toEqual([
      [['team_0', 3]],
      [['team_1', 3]],
    ]);

    // 4v4 (8): 4 on Row 1 (Team A) and 4 on Row 2 (Team B)
    const fourVfour = computeBattlefieldHudLayout(mkInterleavedTeams([4, 4]));
    expect(fourVfour.rows.map((r) => r.clusters.map((c) => [c.teamId, c.tankIds.length]))).toEqual([
      [['team_0', 4]],
      [['team_1', 4]],
    ]);

    // 2v2v2 (6 across 3 teams): packs A+B (2+2) on Row 1, C (2) on Row 2 without splitting any team
    const threePairs = computeBattlefieldHudLayout(mkInterleavedTeams([2, 2, 2]));
    expect(threePairs.rows.map((r) => r.clusters.map((c) => [c.teamId, c.tankIds.length]))).toEqual([
      [
        ['team_0', 2],
        ['team_1', 2],
      ],
      [['team_2', 2]],
    ]);

    // 2v2v2v2 (8 across 4 teams): A+B (4) on Row 1, C+D (4) on Row 2
    const fourPairs = computeBattlefieldHudLayout(mkInterleavedTeams([2, 2, 2, 2]));
    expect(fourPairs.rows.map((r) => r.clusters.map((c) => [c.teamId, c.tankIds.length]))).toEqual([
      [
        ['team_0', 2],
        ['team_1', 2],
      ],
      [
        ['team_2', 2],
        ['team_3', 2],
      ],
    ]);
  });

  it('supports Bo3 tournament & league series, per-match random seed resolution, and session persistence', () => {
    // 1. Per-match seed resolution
    const fixedCfg: typeof DEFAULT_BATTLEFIELD_CONFIG = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'elimination',
      obstacleMode: 'few',
      obstacleSeed: 500,
      randomizeSeedPerMatch: false,
    };
    expect(resolveMatchConfigForGame(fixedCfg, 0).obstacleSeed).toBe(500);
    expect(resolveMatchConfigForGame(fixedCfg, 1).obstacleSeed).not.toBe(500);

    const randSeedCfg = { ...fixedCfg, randomizeSeedPerMatch: true };
    expect(resolveMatchConfigForGame(randSeedCfg, 0, () => 0.1).obstacleSeed).toBe(901);
    expect(resolveMatchConfigForGame(randSeedCfg, 1, () => 0.5).obstacleSeed).toBe(4501);

    // Football and obstacle-less modes preserve config cleanly
    const fbRandCfg = {
      ...randSeedCfg,
      ruleId: 'tank_soccer' as const,
      obstacleMode: 'none' as const,
      obstacleSeed: -1,
    };
    expect(resolveMatchConfigForGame(fbRandCfg, 0, () => 0.5).obstacleSeed).toBe(-1);

    // 2. Bo3 Tournament (first to 2 wins)
    const entryA = createRosterEntryFromBlueprint(DEFAULT_PLAYER_BLUEPRINT, 'file');
    const entryB = createRosterEntryFromBlueprint(PRESET_ENEMIES[1], 'file');
    const entryC = createRosterEntryFromBlueprint(PRESET_ENEMIES[2], 'file');
    const unitA: CompetitionUnit = { unitId: 'uA', unitName: 'Unit A', entries: [entryA], color: '#56b4e9' };
    const unitB: CompetitionUnit = { unitId: 'uB', unitName: 'Unit B', entries: [entryB], color: '#e69f00' };
    const unitC: CompetitionUnit = { unitId: 'uC', unitName: 'Unit C', entries: [entryC], color: '#009e73' };

    const makeDummyReport = (winnerTeam: 'unit_A' | 'unit_B' | null, contribA: number, contribB: number) => {
      const st = createBattlefieldMatchState(buildParticipantsFromUnitPair(unitA, unitB), fixedCfg);
      st.tick = 400;
      const rep = buildMatchReport(st, buildParticipantsFromUnitPair(unitA, unitB), fixedCfg);
      rep.winType = winnerTeam ? 'elimination' : 'draw';
      rep.winnerTeamId = winnerTeam;
      rep.tankRows.forEach((tr) => {
        if (tr.teamId === 'unit_A') {
          tr.kills = winnerTeam === 'unit_A' ? 1 : 0;
          tr.contributionScore = contribA;
          tr.damageDealt = contribA;
        } else {
          tr.kills = winnerTeam === 'unit_B' ? 1 : 0;
          tr.contributionScore = contribB;
          tr.damageDealt = contribB;
        }
      });
      rep.teamRows.forEach((tm) => {
        tm.isWinner = tm.teamId === winnerTeam;
        tm.totalContribution = tm.teamId === 'unit_A' ? contribA : contribB;
      });
      return rep;
    };

    let bracket = createTournamentBracket([unitA, unitB, unitC], 3);
    const semiMatch = bracket.rounds[0].find((m) => !m.isBye && m.unitAId && m.unitBId)!;
    const semiA = semiMatch.unitAId!;
    const semiB = semiMatch.unitBId!;
    expect(semiMatch.seriesBestOf).toBe(3);

    // Game 1: A wins -> stays active (1-0)
    bracket = applyTournamentGameResult(bracket, semiMatch.matchId, semiA, makeDummyReport('unit_A', 220, 80), false, 3);
    let updatedSemi = bracket.rounds[0].find((m) => m.matchId === semiMatch.matchId)!;
    expect(updatedSemi.winnerUnitId).toBeNull();
    expect(updatedSemi.winsA).toBe(1);
    expect(updatedSemi.winsB).toBe(0);
    expect(updatedSemi.gameReports).toHaveLength(1);

    // Game 2: B wins -> stays active (1-1)
    bracket = applyTournamentGameResult(bracket, semiMatch.matchId, semiB, makeDummyReport('unit_B', 90, 230), false, 3);
    updatedSemi = bracket.rounds[0].find((m) => m.matchId === semiMatch.matchId)!;
    expect(updatedSemi.winnerUnitId).toBeNull();
    expect(updatedSemi.winsA).toBe(1);
    expect(updatedSemi.winsB).toBe(1);

    // Game 3: B wins -> completes Bo3 (1-2) and advances B to final
    bracket = applyTournamentGameResult(bracket, semiMatch.matchId, semiB, makeDummyReport('unit_B', 70, 240), false, 3);
    updatedSemi = bracket.rounds[0].find((m) => m.matchId === semiMatch.matchId)!;
    expect(updatedSemi.winnerUnitId).toBe(semiB);
    expect(updatedSemi.winsA).toBe(1);
    expect(updatedSemi.winsB).toBe(2);
    expect(updatedSemi.gameReports).toHaveLength(3);
    expect(bracket.rounds[1][0].unitBId).toBe(semiB);

    // 3. Bo3 League schedule + standing aggregation across all games in series
    let leagueMatches = createLeagueSchedule([unitA, unitB], 3);
    expect(leagueMatches).toHaveLength(1);
    const lmId = leagueMatches[0].matchId;
    leagueMatches = applyLeagueGameResult(leagueMatches, lmId, unitA.unitId, makeDummyReport('unit_A', 200, 100), false, 3);
    expect(leagueMatches[0].report).toBeUndefined();
    leagueMatches = applyLeagueGameResult(leagueMatches, lmId, unitA.unitId, makeDummyReport('unit_A', 210, 90), false, 3);
    expect(leagueMatches[0].report).toBeDefined();
    expect(leagueMatches[0].winnerUnitId).toBe(unitA.unitId);
    expect(leagueMatches[0].winsA).toBe(2);
    expect(leagueMatches[0].winsB).toBe(0);

    const standings = computeLeagueStandings([unitA, unitB], leagueMatches);
    expect(standings[0].unitId).toBe(unitA.unitId);
    expect(standings[0].played).toBe(1);
    expect(standings[0].wins).toBe(1);
    expect(standings[0].totalKills).toBe(2);
    expect(standings[0].totalContribution).toBe(410);
    expect(standings[0].avgSurvivedSeconds).toBe(20);

    // 4. Session persistence round-trip & corruption handling
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    try {
      const savedOk = saveBattlefieldSession({
        version: 1,
        savedAt: 123456,
        config: { ...fixedCfg, seriesFormat: 'bo3', randomizeSeedPerMatch: true },
        roster: [entryA, entryB],
        tournamentBracket: bracket,
        leagueData: null,
        activeMatchId: semiMatch.matchId,
        autoAdvance: true,
      });
      expect(savedOk).toBe(true);
      const loaded = loadBattlefieldSession();
      expect(loaded).not.toBeNull();
      expect(loaded!.roster).toHaveLength(2);
      expect(loaded!.config.seriesFormat).toBe('bo3');
      expect(loaded!.config.randomizeSeedPerMatch).toBe(true);
      expect(
        loaded!.tournamentBracket?.rounds[0].find((m) => m.matchId === semiMatch.matchId)?.winsB
      ).toBe(2);
      expect(loaded!.autoAdvance).toBe(true);

      store.set('codepanzer_bf_session_v1', '{broken-json');
      expect(loadBattlefieldSession()).toBeNull();

      clearBattlefieldSession();
      expect(loadBattlefieldSession()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('supports ice drift zones, cooldown 2x heat-dissipation zones, and 4-type mixed generation', () => {
    // Ice zone: moving north then cutting power + turning East keeps significant northward drift momentum vs normal ground
    const driftBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'ice_drifter',
      name: 'アイス検証機',
      author: 'Z1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', chassis: 'light' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 0.5 }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'act_turn_body', params: { mode: 'delta', angle: 90, wait: 1 }, next: { x: 3, y: 0 } },
        { x: 3, y: 0, type: 'act_move', params: { speedPercent: 100, duration: 1.0 }, next: null },
      ]),
    };

    const eA = createRosterEntryFromBlueprint(driftBp, 'test');
    const eB = createRosterEntryFromBlueprint(driftBp, 'test');
    const parts = [
      { entry: eA, teamId: 'ffa_0', teamLabel: 'IceTank', teamColor: '#38bdf8', slotIndex: 0 },
      { entry: eB, teamId: 'ffa_1', teamLabel: 'GripTank', teamColor: '#e69f00', slotIndex: 1 },
    ];

    const iceCfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      obstacleMode: 'none' as const,
      zoneMode: 'none' as const,
      disableWeapons: true,
    };
    const stIce = createBattlefieldMatchState(parts, iceCfg);
    stIce.arena.tiles = [
      { id: 'tile_ice', kind: 'ice', x: 50, y: 50, width: 600, height: 800 },
    ];
    stIce.tanks[0].x = 300;
    stIce.tanks[0].y = 500;
    stIce.tanks[0].bodyAngle = 0;
    stIce.tanks[1].x = 1000;
    stIce.tanks[1].y = 500;
    stIce.tanks[1].bodyAngle = 0;

    for (let i = 0; i < 28; i++) {
      stepBattlefieldTick(stIce, iceCfg);
    }
    // Tank 0 turned East mid-ice and kept drifting noticeably farther North than Tank 1 on normal ground
    expect(stIce.tanks[0].vy).toBeLessThan(-0.35);
    expect(Math.abs(stIce.tanks[1].vy)).toBeLessThan(Math.abs(stIce.tanks[0].vy));

    // Cooldown zone: gunHeat cools twice as fast inside 'cooldown' tile
    const idleBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'cool_idle',
      name: '冷却待機機',
      author: 'C',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
      program: buildProgram(4, 'relative', []),
    };
    const coolParts = [
      { entry: createRosterEntryFromBlueprint(idleBp, 't'), teamId: 'c0', teamLabel: 'Cool', teamColor: '#14b8a6', slotIndex: 0 },
      { entry: createRosterEntryFromBlueprint(idleBp, 't'), teamId: 'c1', teamLabel: 'Normal', teamColor: '#e69f00', slotIndex: 1 },
    ];
    const stCool = createBattlefieldMatchState(coolParts, iceCfg);
    stCool.arena.tiles = [
      { id: 'tile_cool', kind: 'cooldown', x: 100, y: 400, width: 300, height: 200 },
    ];
    stCool.tanks[0].x = 250;
    stCool.tanks[0].y = 500;
    stCool.tanks[0].gunHeat = 30;
    stCool.tanks[1].x = 900;
    stCool.tanks[1].y = 500;
    stCool.tanks[1].gunHeat = 30;

    for (let i = 0; i < 5; i++) {
      stepBattlefieldTick(stCool, iceCfg);
    }
    const coolDrop = 30 - stCool.tanks[0].gunHeat;
    const normDrop = 30 - stCool.tanks[1].gunHeat;
    expect(coolDrop).toBeCloseTo(normDrop * 2, 4);

    // generateBattlefieldZones supports ice, cooldown, and 4-kind mixed on large arena without overlap
    const largeObs = generateArenaObstacles('few', 42, 'large');
    const iceZones = generateBattlefieldZones('ice', 42, 'large', largeObs);
    const coolZones = generateBattlefieldZones('cooldown', 42, 'large', largeObs);
    const mixedLarge = generateBattlefieldZones('mixed', 42, 'large', []);
    expect(iceZones.length).toBe(4);
    expect(iceZones.every((z) => z.kind === 'ice')).toBe(true);
    expect(coolZones.length).toBe(4);
    expect(coolZones.every((z) => z.kind === 'cooldown')).toBe(true);
    expect(new Set(mixedLarge.map((z) => z.kind))).toEqual(
      new Set(['slow', 'no_weapon', 'ice', 'cooldown'])
    );
  });

  it('runs bounty_hunt: bounty transfer, HP+SP recovery, streak buffs, respawn w/ invulnerability cancellation, and balanced preset play', () => {
    const idleBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'bounty_victim',
      name: '標的戦車',
      author: 'V',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', subWeapon: 'missile' },
      program: buildProgram(4, 'relative', []),
    };
    const shooterBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'bounty_killer',
      name: '賞金稼ぎ',
      author: 'K',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', mainGun: 'standard', subWeapon: 'missile' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 5, wait: 1 }, next: { x: 0, y: 0 } },
      ]),
    };

    const parts = [
      { entry: createRosterEntryFromBlueprint(shooterBp, 'test'), teamId: 'k_team', teamLabel: 'Killer', teamColor: '#56b4e9', slotIndex: 0 },
      { entry: createRosterEntryFromBlueprint(idleBp, 'test'), teamId: 'v_team', teamLabel: 'Victim', teamColor: '#e69f00', slotIndex: 1 },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'bounty_hunt' as const,
      obstacleMode: 'none' as const,
      maxSeconds: 60,
    };

    const st = createBattlefieldMatchState(parts, cfg);
    const killer = st.tanks[0];
    const victim = st.tanks[1];
    expect(st.arena.respawnEnabled).toBe(true);
    expect(killer.bountyValue).toBe(BOUNTY_TUNING.baseValue);

    // Pre-damage killer & consume SP so we can observe kill heal + SP+1 cleanly
    killer.hp = 40;
    killer.subAmmo = 1;
    killer.x = 400;
    killer.y = 500;
    killer.bodyAngle = 90;
    killer.turretAngle = 90;
    victim.x = 460;
    victim.y = 500;
    victim.hp = 1; // 1 hit kills victim

    const tracker = createCommentaryTracker(st, cfg);
    let killCommentarySeen = false;
    // Step until victim dies
    for (let i = 0; i < 10 && victim.hp > 0; i++) {
      stepBattlefieldTick(st, cfg);
      const cm = evaluateCommentaryStep(tracker, st, cfg, DEFAULT_COMMENTARY_SETTINGS, 2000 + i * 100);
      if (cm && cm.badge.includes('KO')) killCommentarySeen = true;
    }
    expect(victim.hp).toBe(0);
    expect(victim.stats.deaths).toBe(1);
    expect(victim.respawnTicks).toBe(BOUNTY_TUNING.respawnTicks);
    expect(victim.bountyValue).toBe(BOUNTY_TUNING.baseValue);

    // Killer got 100pt, +20% HP heal, +1 SP, bounty rose to 200 & streak=1 buff
    expect(killer.stats.ruleScore).toBe(100);
    expect(killer.bountyStreak).toBe(1);
    expect(killer.bountyValue).toBe(200);
    expect(killer.bountyDamageMult).toBe(getBountyStreakBuff(1).damageMult);
    expect(killer.hp).toBe(40 + Math.round(killer.maxHp * BOUNTY_TUNING.killHealRatio));
    expect(killer.subAmmo).toBe(2);
    expect(st.ruleTeamScores?.['k_team']).toBe(100);
    expect(killCommentarySeen || tracker.tanks[killer.id].bountyValue === 200).toBe(true);

    // Wait 49 more ticks -> still dead until 50th tick passes
    for (let i = 0; i < BOUNTY_TUNING.respawnTicks - 1; i++) {
      stepBattlefieldTick(st, cfg);
    }
    expect(victim.hp).toBe(0);

    // 50th tick -> respawns with full HP, full SP, invulnerability=30
    const subMaxVictim = SUB_WEAPON_SPECS[victim.blueprint.assembly.subWeapon].maxAmmo;
    victim.subAmmo = 0;
    stepBattlefieldTick(st, cfg);
    expect(victim.hp).toBe(victim.maxHp);
    expect(victim.subAmmo).toBe(subMaxVictim);
    expect(victim.invulnerableTicks).toBe(BOUNTY_TUNING.invulnerableTicks);

    // Verify invulnerability blocks damage, and shooting immediately cancels invulnerability
    const preHp = victim.hp;
    const dealtInvuln = applyDamage(victim, 25, killer, st.tick);
    expect(dealtInvuln).toBe(0);
    expect(victim.hp).toBe(preHp);

    // Simulate firing while invulnerable: move idle victim aside and test killer invulnerability cancel on fire
    killer.invulnerableTicks = 25;
    killer.gunHeat = 0;
    stepBattlefieldTick(st, cfg);
    expect(killer.invulnerableTicks).toBe(0);

    // Empirical balance sweep across 4-tank & 8-tank standard preset brawlers (4 seeds)
    const presetPool = PRESET_ENEMIES.slice(0, 8).map((bp) => createRosterEntryFromBlueprint(bp, 'CPU', true));
    let totalKillsObserved = 0;
    let totalStreaks2Plus = 0;
    let totalBountyClaims = 0;
    let totalDeathsObserved = 0;

    for (const seed of [101, 202, 303, 404]) {
      const p4 = presetPool.slice(0, 4).map((entry, idx) => ({
        entry,
        teamId: `ffa_${idx}`,
        teamLabel: entry.playerName,
        teamColor: '#38bdf8',
        slotIndex: idx,
      }));
      const sweepCfg = {
        ...DEFAULT_BATTLEFIELD_CONFIG,
        ruleId: 'bounty_hunt' as const,
        arenaSize: 'medium' as const,
        obstacleMode: 'few' as const,
        obstacleSeed: seed,
        maxSeconds: 90,
      };
      const sim = simulateMatchHeadless(p4, sweepCfg);
      expect(sim.state.status).toBe('finished');
      for (const r of sim.report.tankRows) {
        totalKillsObserved += r.kills;
        totalDeathsObserved += r.deaths ?? 0;
        if ((r.maxBountyStreak ?? 0) >= 2) totalStreaks2Plus += 1;
        totalBountyClaims += r.bountyClaimedCount ?? 0;
      }
    }
    // Verify active back-and-forth fights, streaks achieved, AND bounty takedowns actually occur (no invincible snowball)
    expect(totalKillsObserved).toBeGreaterThanOrEqual(4);
    expect(totalDeathsObserved).toBeGreaterThanOrEqual(4);
    expect(totalStreaks2Plus).toBeGreaterThanOrEqual(1);
    expect(totalBountyClaims).toBeGreaterThanOrEqual(1);
  });

  it('assigns expanded special awards cleanly in buildMatchReport and formats them in text output', () => {
    const tinyBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'award_tiny',
      name: '下克上4x4',
      author: 'A1',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4' },
      program: buildProgram(4, 'relative', []),
    };
    const bigBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'award_big',
      name: '重装8x8',
      author: 'A2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(8) },
      program: buildProgram(8, 'relative', []),
    };
    const thirdBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'award_mid',
      name: '精密6x6',
      author: 'A3',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(6) },
      program: buildProgram(6, 'relative', []),
    };
    const fourthBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'award_fourth',
      name: '粘り機体',
      author: 'A4',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(6) },
      program: buildProgram(6, 'relative', []),
    };

    const entries = [tinyBp, bigBp, thirdBp, fourthBp].map((bp, i) => ({
      entry: createRosterEntryFromBlueprint(bp, 'test'),
      teamId: `t_${i}`,
      teamLabel: `P${i + 1}`,
      teamColor: '#38bdf8',
      slotIndex: i,
    }));
    const cfg = { ...DEFAULT_BATTLEFIELD_CONFIG, ruleId: 'bounty_hunt' as const };
    const st = createBattlefieldMatchState(entries, cfg);
    st.tick = 1000;
    st.winnerId = st.tanks[0].id;
    st.winType = 'decision';
    st.endReason = 'P1 の賞金王勝利！（獲得 400pt）';
    st.ruleTeamScores = { t_0: 400, t_1: 100, t_2: 100, t_3: 50 };

    // Tank 0 (4x4): winner, first kill, bounty hunter (200pt claimed), streak 2, tanky survivor (120 taken), outranks 8x8 -> giant killing!
    st.tanks[0].stats.kills = 2;
    st.tanks[0].stats.damageDealt = 240;
    st.tanks[0].stats.damageTaken = 120;
    st.tanks[0].stats.ruleScore = 400;
    st.tanks[0].stats.maxBountyStreak = 2;
    st.tanks[0].stats.bountyClaimedCount = 1;
    st.tanks[0].stats.maxBountyClaimed = 300;
    st.tanks[0].stats.firstKillTick = 90;

    // Tank 2 (6x6): sniper accuracy 80%
    st.tanks[2].stats.shotsFired = 10;
    st.tanks[2].stats.shotsHit = 8;
    st.tanks[2].stats.damageDealt = 180;
    st.tanks[2].stats.ruleScore = 100;

    // Tank 3 (6x6): active non-winner with zero top-stat awards -> gets 敢闘賞
    st.tanks[3].stats.shotsFired = 10;
    st.tanks[3].stats.shotsHit = 2;
    st.tanks[3].stats.damageDealt = 80;
    st.tanks[3].stats.ruleScore = 50;
    st.tanks[3].hp = 0;

    const report = buildMatchReport(st, entries, cfg);
    const row0 = report.tankRows.find((r) => r.tankId === st.tanks[0].id)!;
    const row2 = report.tankRows.find((r) => r.tankId === st.tanks[2].id)!;
    const row3 = report.tankRows.find((r) => r.tankId === st.tanks[3].id)!;

    expect(row0.awards).toContain('🏆 MVP');
    expect(row0.awards).toContain('👑 賞金首ハンター');
    expect(row0.awards).toContain('🔥 連勝の覇者');
    expect(row0.awards).toContain('⚡ 電光石火');
    expect(row0.awards).toContain('💥 最多ダメージ');
    expect(row0.awards).toContain('🛡️ 鉄壁');
    expect(row0.awards).toContain('🌟 ジャイアントキリング');
    expect(row2.awards).toContain('🎯 スナイパー');
    expect(row3.awards).toContain('💪 敢闘賞');

    const text = formatMatchReportText(report);
    expect(text).toContain('👑 賞金首ハンター');
    expect(text).toContain('🎯 スナイパー');
  });

  it('draws 8 eligible entries fairly with unplayed priority, shuffles roster order, and balances random teams', () => {
    const bigRoster = Array.from({ length: 12 }, (_, idx) =>
      createRosterEntryFromBlueprint(
        {
          ...DEFAULT_PLAYER_BLUEPRINT,
          id: `r_${idx}`,
          name: `戦車_${idx}`,
          author: `P${idx}`,
        },
        'file'
      )
    );
    const cfg = { ...DEFAULT_BATTLEFIELD_CONFIG, cpuRegulation: 'any' as const };

    // Round 1: picks 8 of 12
    const round1 = pickRandomBattleRoyaleEntries(bigRoster, cfg, 8, new Set(), () => 0.35);
    expect(round1.pickedIds).toHaveLength(8);
    expect(round1.resetCycle).toBe(false);
    expect(round1.nextRoster.filter((e) => e.enabled)).toHaveLength(8);

    // Round 2: passes round 1's 8 IDs -> MUST include all 4 unplayed IDs + 4 from played, signaling cycle reset
    const round1Set = new Set(round1.pickedIds);
    const remainingUnplayedIds = bigRoster
      .map((e) => e.entryId)
      .filter((id) => !round1Set.has(id));
    expect(remainingUnplayedIds).toHaveLength(4);

    const round2 = pickRandomBattleRoyaleEntries(bigRoster, cfg, 8, round1Set, () => 0.42);
    expect(round2.pickedIds).toHaveLength(8);
    expect(round2.resetCycle).toBe(true);
    for (const unplayedId of remainingUnplayedIds) {
      expect(round2.pickedIds).toContain(unplayedId);
    }

    // Shuffle preserves all items
    const shuffled = shuffleCompetitionRoster(bigRoster, () => 0.17);
    expect(shuffled).toHaveLength(12);
    expect(new Set(shuffled.map((e) => e.entryId))).toEqual(
      new Set(bigRoster.map((e) => e.entryId))
    );

    // assignRandomTeams creates two balanced teams of 4
    const teamSplit = assignRandomTeams(bigRoster, cfg, 2, new Set(), () => 0.25);
    expect(teamSplit.pickedIds).toHaveLength(8);
    const enabledTeams = teamSplit.nextRoster.filter((e) => e.enabled);
    expect(enabledTeams.filter((e) => e.teamSlot === 0)).toHaveLength(4);
    expect(enabledTeams.filter((e) => e.teamSlot === 1)).toHaveLength(4);
  });

  it('respawns bounty_hunt tanks outside alive enemy radar cones & turret lines and avoids repeating the death corner', () => {
    const stickyCamperBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'sticky_camper',
      name: '粘着砲台',
      author: 'S1',
      assembly: {
        ...DEFAULT_PLAYER_BLUEPRINT.assembly,
        cpu: cpuIdForGridSize(4),
        radar: 'wide', // 70 deg FOV, 620px range
      },
      program: buildProgram(4, 'relative', []),
    };
    const victimBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      id: 'respawn_victim',
      name: 'リスポン対象',
      author: 'S2',
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
      program: buildProgram(4, 'relative', []),
    };

    const parts = [
      {
        entry: createRosterEntryFromBlueprint(stickyCamperBp, 'test'),
        teamId: 's_camper',
        teamLabel: 'Camper',
        teamColor: '#ef4444',
        slotIndex: 0,
      },
      {
        entry: createRosterEntryFromBlueprint(victimBp, 'test'),
        teamId: 's_victim',
        teamLabel: 'Victim',
        teamColor: '#38bdf8',
        slotIndex: 1,
      },
    ];
    const cfg = {
      ...DEFAULT_BATTLEFIELD_CONFIG,
      ruleId: 'bounty_hunt' as const,
      arenaSize: 'medium' as const,
      obstacleMode: 'none' as const,
    };

    const st = createBattlefieldMatchState(parts, cfg);
    const camper = st.tanks[0];
    const victim = st.tanks[1];

    // Camper sits on West-center aiming radar & turret East covering the entire far-East side (where victim died)
    camper.x = 550;
    camper.y = 450;
    camper.radarAngle = 90;
    camper.turretAngle = 90;
    camper.bodyAngle = 90;

    victim.x = st.arena.width - 70;
    victim.y = 450;
    victim.hp = 0;

    const camperRadar = RADAR_SPECS[camper.blueprint.assembly.radar];
    const seenByCamper = (x: number, y: number) => {
      const dist = Math.hypot(x - camper.x, y - camper.y);
      const bearing = vectorToAngle(x - camper.x, y - camper.y);
      const diff = Math.abs(normalizeAngle180(bearing - camper.radarAngle));
      return dist <= camperRadar.range && diff <= camperRadar.fovDeg / 2;
    };

    // Even though the far-East corners might be far from something or near death spot, respawn MUST NOT land in camper's East radar cone!
    const pickedSpots: Array<{ x: number; y: number }> = [];
    for (let deathCount = 1; deathCount <= 4; deathCount++) {
      st.tick = 100 * deathCount;
      victim.stats.deaths = deathCount;
      const pt = pickBountyRespawnPoint(victim, st, 1);
      expect(seenByCamper(pt.x, pt.y)).toBe(false);
      // Should also avoid turret line of fire directly East
      const turretDiff = Math.abs(
        normalizeAngle180(vectorToAngle(pt.x - camper.x, pt.y - camper.y) - camper.turretAngle)
      );
      expect(turretDiff).toBeGreaterThan(16);
      // Should be well away from previous death coordinates
      expect(Math.hypot(pt.x - victim.x, pt.y - victim.y)).toBeGreaterThanOrEqual(180);
      pickedSpots.push({ x: pt.x, y: pt.y });
      victim.x = pt.x;
      victim.y = pt.y;
    }

    // Multiple respawns do not collapse to a single static coordinate
    const uniqueCoordKeys = new Set(pickedSpots.map((p) => `${Math.round(p.x)}:${Math.round(p.y)}`));
    expect(uniqueCoordKeys.size).toBeGreaterThanOrEqual(2);
  });
});




