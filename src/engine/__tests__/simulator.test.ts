import { describe, expect, it } from 'vitest';
import { transpileProgramToLines } from '../../components/GridEditor';
import { CHIP_DEFINITIONS } from '../../data/chips';
import { CPU_SPECS, cpuIdForGridSize } from '../../data/parts';
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
        { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
      ]),
    };

    const state1 = createBattleState({ player: inTickWhileTank, enemy: ENEMY_DUMMY });
    const res1 = runTankChipProgram(state1.tanks[0], 1, state1.arena, state1.projectiles);
    expect(state1.tanks[0].counters.A).toBe(4);
    expect(res1.commands.firePower).toBe(2.0);
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
        { x: 2, y: 0, type: 'act_fire', params: { power: 2.2 }, next: null },
      ]),
    };

    const state = createBattleState({ player: forTank, enemy: ENEMY_DUMMY });
    // First 3 ticks: loop body runs (move 50%), no fire
    for (let t = 1; t <= 3; t++) {
      const r = runTankChipProgram(state.tanks[0], t, state.arena, state.projectiles);
      expect(r.commands.targetSpeedRatio).toBeCloseTo(0.5);
      expect(r.commands.firePower).toBeNull();
    }
    // 4th evaluation: loop exits (no branch -> fire 2.2) and resets loop counter
    const rExit = runTankChipProgram(state.tanks[0], 4, state.arena, state.projectiles);
    expect(rExit.commands.firePower).toBe(2.2);
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
  fire(power=2.0)`;
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
      expect(res0.commands.firePower).toBe(2.0);
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

  it('fits every Tutorial Stage into 4x4 (St.1-18) with matching enemy sizes and clean Python round-trip', () => {
    expect(TUTORIAL_STAGES.length).toBe(18);
    for (const stage of TUTORIAL_STAGES) {
      const expectedSize = 4;
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

  it('validates fire_main power within 0.5..3.0 and rejects out-of-range values', () => {
    const validMin = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=0.5)', 4, 'relative');
    const validMax = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=3.0)', 4, 'relative');
    expect(validMin.ok).toBe(true);
    expect(validMax.ok).toBe(true);

    const tooLow = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=0.4)', 4, 'relative');
    const tooHigh = parsePythonSourceToProgram('def on_tick():\n  fire_main(power=3.5)', 4, 'relative');
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) {
      expect(tooLow.error).toContain('0.5〜3.0');
    }
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) {
      expect(tooHigh.error).toContain('0.5〜3.0');
    }

    expect(() =>
      validateAndNormalizeBlueprint({
        ...DEFAULT_PLAYER_BLUEPRINT,
        program: buildProgram(6, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          { x: 1, y: 0, type: 'act_fire', params: { power: 3.5 }, next: null },
        ]),
      })
    ).toThrow(/0\.5〜3\.0/);

    expect(() =>
      validateAndNormalizeBlueprint({
        ...DEFAULT_PLAYER_BLUEPRINT,
        program: buildProgram(6, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          { x: 1, y: 0, type: 'act_fire', params: { power: 0.4 }, next: null },
        ]),
      })
    ).toThrow(/0\.5〜3\.0/);
  });

  it('allows multiple simultaneous shells at power=0.5 and enforces higher damage & longer cooldown at power=3.0', () => {
    const rapidLowBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', mainGun: 'standard' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 0.5 }, next: null },
      ]),
    };
    const heavyHighBp: TankBlueprint = {
      ...DEFAULT_PLAYER_BLUEPRINT,
      assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: 'mini_4x4', mainGun: 'standard' },
      program: buildProgram(4, 'relative', [
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'act_fire', params: { power: 3.0 }, next: null },
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
    expect(src).toContain('radar = {"type": "long", "fov": 18, "range": 1550, "turn": 3.5}');
    expect(src).toContain('main_gun = {"type": "cannon", "damage": 1.35, "cooling": 0.045, "turn": 4.8}');
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
        // Main flow: start -> sub_a() -> sub_d() -> fire_main(1.5)
        { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
        { x: 1, y: 0, type: 'sub_call', params: { sub: 'A' }, next: { x: 2, y: 0 } },
        { x: 2, y: 0, type: 'sub_call', params: { sub: 'D' }, next: { x: 2, y: 1 } },
        { x: 2, y: 1, type: 'act_fire', params: { power: 1.5 }, next: null },
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
    expect(res.commands.firePower).toBe(1.5);
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

  it('supports diagonal front_left/front_right and left_closer wall clearance checks', () => {
    const testWallDir = (
      direction: 'front_left' | 'front_right' | 'left_closer',
      obstacles: Array<{ id: string; x: number; y: number; width: number; height: number }>
    ) => {
      const bp: TankBlueprint = {
        ...DEFAULT_PLAYER_BLUEPRINT,
        assembly: { ...DEFAULT_PLAYER_BLUEPRINT.assembly, cpu: cpuIdForGridSize(4) },
        program: buildProgram(4, 'relative', [
          { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
          {
            x: 1,
            y: 0,
            type: 'cond_wall_ahead',
            params: { direction, angle: 0, dist: 140 },
            yes: { x: 2, y: 0 },
            no: null,
          },
          { x: 2, y: 0, type: 'act_fire', params: { power: 2.0 }, next: null },
        ]),
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
    expect(testWallDir('front_left', leftObs)).toBe(2.0);
    expect(testWallDir('front_right', leftObs)).toBeNull();
    expect(testWallDir('left_closer', leftObs)).toBe(2.0);

    const rightObs = [{ id: 'obs_ne', x: 420, y: 280, width: 70, height: 80 }];
    expect(testWallDir('front_left', rightObs)).toBeNull();
    expect(testWallDir('front_right', rightObs)).toBe(2.0);
    expect(testWallDir('left_closer', rightObs)).toBeNull();
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

  it('validates all 11 preset enemies (4x4 / 6x6 / 8x8) including normalization and Python round-trip', () => {
    expect(PRESET_ENEMIES.length).toBe(11);
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
});

