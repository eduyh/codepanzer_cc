import { describe, expect, it, vi } from 'vitest';
import { transpileProgramToLines } from '../../components/GridEditor';
import { CHIP_DEFINITIONS } from '../../data/chips';
import { LEARNING_MISSIONS, resolveMissionVariant } from '../../data/learningMissions';
import { CHASSIS_SPECS, CPU_SPECS, cpuIdForGridSize } from '../../data/parts';
import {
  buildProgram,
  DEFAULT_PLAYER_BLUEPRINT,
  ENEMY_DUMMY,
  ENEMY_PATROL,
  PRESET_ENEMIES,
  TUTORIAL_STAGES,
} from '../../data/presets';
import { ALLOWED_GRID_SIZES, ArenaSizeId, TankBlueprint } from '../../types/game';
import {
  AUTO_TANK_COLORS,
  parsePythonSourceToProgram,
  parsePythonSourceWithAutoSize,
  validateGridBlockFit,
} from '../../utils/codeParser';
import {
  decodeShareCode,
  encodeShareCode,
  validateAndNormalizeBlueprint,
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
  ARENA_SIZE_SPECS,
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
});



