import { describe, expect, it } from 'vitest';
import { transpileProgramToLines } from '../components/GridEditor';
import { LEARNING_MISSIONS } from '../data/learningMissions';
import {
  buildProgram,
  DEFAULT_PLAYER_BLUEPRINT,
  ENEMY_DUMMY,
  ENEMY_FIXED_TURRET,
  PRESET_ENEMIES,
  TUTORIAL_STAGES,
} from '../data/presets';
import { runTankChipProgram } from '../engine/chipRunner';
import { createBattleState, stepBattleTick } from '../engine/simulator';
import { TankBlueprint } from '../types/game';
import { validateAndRepairBlueprint } from './blueprintGatekeeper';
import { parsePythonSourceToProgram } from './codeParser';

describe('blueprintGatekeeper', () => {
  it('accepts DEFAULT_PLAYER_BLUEPRINT and LEARNING_MISSIONS without any repairs', () => {
    const res = validateAndRepairBlueprint(DEFAULT_PLAYER_BLUEPRINT);
    expect(res.isValid).toBe(true);
    expect(res.fixes).toEqual([]);

    for (const mission of LEARNING_MISSIONS) {
      const mRes = validateAndRepairBlueprint(mission.playerStarter);
      expect(mRes.isValid, `${mission.id} isValid`).toBe(true);
      expect(mRes.fixes, `${mission.id} fixes`).toEqual([]);
    }
  });

  it('clamps out-of-range numeric params, migrates legacy/invalid gun power tiers, and repairs invalid select options', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.assembly.mainGun = 'rapid'; // powerTiers: { fast: 0.5, normal: 1.0, heavy: 1.5 }
    // Replace (1,2) cond_proximity with out-of-range params
    bp.program.cells[2][1] = {
      id: 'test_prox',
      type: 'cond_proximity',
      params: { mode: 'bogus_mode', target: 'all', dist: 999 },
      yes: null,
      no: null,
    };
    // Replace (5,3) act_fire with out-of-range power -> repairs to 'normal'
    bp.program.cells[3][5] = {
      id: 'test_fire',
      type: 'act_fire',
      params: { power: 5.0 },
      next: null,
    };

    const res = validateAndRepairBlueprint(bp);
    expect(res.isValid).toBe(false);
    expect(res.blueprint.program.cells[2][1]?.params.mode).toBe('approaching');
    expect(res.blueprint.program.cells[2][1]?.params.dist).toBe(300);
    expect(res.blueprint.program.cells[3][5]?.params.power).toBe('normal');

    // Legacy valid numeric powers migrate to the closest gun tier
    const bpLegacyRapid: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bpLegacyRapid.assembly.mainGun = 'rapid';
    bpLegacyRapid.program.cells[3][5] = {
      id: 'legacy_rapid',
      type: 'act_fire',
      params: { power: 1.5 },
      next: null,
    };
    expect(validateAndRepairBlueprint(bpLegacyRapid).blueprint.program.cells[3][5]?.params.power).toBe('heavy');

    const bpLegacyCannon: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bpLegacyCannon.assembly.mainGun = 'cannon';
    bpLegacyCannon.program.cells[3][5] = {
      id: 'legacy_cannon',
      type: 'act_fire',
      params: { power: 2.0 },
      next: null,
    };
    expect(validateAndRepairBlueprint(bpLegacyCannon).blueprint.program.cells[3][5]?.params.power).toBe('fast');
  });

  it('migrates deprecated cond_wall_ahead to cond_proximity', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.program.cells[2][1] = {
      id: 'test_legacy_wall',
      type: 'cond_wall_ahead',
      params: { direction: 'left_closer', dist: 150 },
      yes: null,
      no: null,
    };

    const res = validateAndRepairBlueprint(bp);
    expect(res.isValid).toBe(false);
    expect(res.blueprint.program.cells[2][1]?.type).toBe('cond_proximity');
    expect(res.blueprint.program.cells[2][1]?.params).toEqual({
      mode: 'left_closer',
      target: 'all',
      dist: 150,
    });
  });

  it('validates all tanks/*.vstank.json files with zero repairs needed', () => {
    // @ts-expect-error Vite macro transformed at test/build time
    const tankModules = import.meta.glob('../../tanks/*.json', { eager: true });
    const entries = Object.entries(tankModules);
    expect(entries.length).toBeGreaterThan(0);

    for (const [filePath, mod] of entries) {
      const bp = ((mod as { default?: TankBlueprint }).default ?? mod) as TankBlueprint;
      const res = validateAndRepairBlueprint(bp);
      expect(res.fixes, `${filePath} fixes`).toEqual([]);
      expect(res.isValid, `${filePath} isValid`).toBe(true);
    }
  });

  it('converts turret-rotation chips to wire on fixedTurret (destroyer) chassis', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.assembly.chassis = 'destroyer';
    // (3,0) in DEFAULT_PLAYER_BLUEPRINT is act_aim_enemy
    const res = validateAndRepairBlueprint(bp);
    expect(res.isValid).toBe(false);
    expect(res.blueprint.program.cells[0][3]?.type).toBe('wire');
  });

  it('preserves numeric select values such as mode_set and cond_mode without spurious fixes', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.program.cells[0][2] = { id: 'm0', type: 'mode_set', params: { mode: 0 }, next: { x: 3, y: 0 } };
    bp.program.cells[0][3] = {
      id: 'cm0',
      type: 'cond_mode',
      params: { mode: 0 },
      yes: { x: 4, y: 0 },
      no: null,
    };
    bp.program.cells[0][4] = { id: 'm2', type: 'mode_set', params: { mode: 2 }, next: null };
    const res = validateAndRepairBlueprint(bp);
    expect(res.isValid).toBe(true);
    expect(res.fixes).toEqual([]);
    expect(res.blueprint.program.cells[0][2]?.params.mode).toBe(0);
    expect(res.blueprint.program.cells[0][3]?.params.mode).toBe(0);
    expect(res.blueprint.program.cells[0][4]?.params.mode).toBe(2);
  });

  it('validates and completes all Development Training Stages (Parts 1-4: St.1 .. St.19) with player victory and Python round-trip', () => {
    expect(TUTORIAL_STAGES).toHaveLength(19);
    const failures: string[] = [];

    for (const st of TUTORIAL_STAGES) {
      const check = validateAndRepairBlueprint(st.playerStarter);
      if (check.fixes.length > 0 || !check.isValid) {
        failures.push(`${st.id} gatekeeper: fixes=${JSON.stringify(check.fixes)}`);
      }

      // Verify every non-start chip in playerStarter is unlocked in stage.allowedChips
      // and every transition is strictly 4-direction orthogonal adjacent
      const cells = st.playerStarter.program.cells;
      for (let y = 0; y < cells.length; y++) {
        for (let x = 0; x < cells[y].length; x++) {
          const cell = cells[y][x];
          if (!cell) continue;
          if (st.allowedChips && cell.type !== 'start' && !st.allowedChips.includes(cell.type)) {
            failures.push(`${st.id} disallowed chip ${cell.type}`);
          }
          for (const target of [cell.next, cell.yes, cell.no]) {
            if (!target) continue;
            const manhattan = Math.abs(target.x - x) + Math.abs(target.y - y);
            if (manhattan !== 1) {
              failures.push(`${st.id} non-adjacent (${x},${y})->(${target.x},${target.y})`);
            }
          }
        }
      }

      const src = transpileProgramToLines(st.playerStarter.program, st.playerStarter.name, false)
        .map((l) => l.text)
        .join('\n');
      const reparsed = parsePythonSourceToProgram(
        src,
        st.playerStarter.program.gridSize,
        st.playerStarter.program.coordinateMode
      );
      if (!reparsed.ok) {
        failures.push(`${st.id} Python reparse: ${reparsed.error}`);
      }

      let battle = createBattleState({
        player: st.playerStarter,
        enemy: st.enemy,
        enemies: st.enemies,
        arenaSize: st.arenaSize,
        obstacles: st.obstacles,
        maxTicks: st.maxTicks,
        playerSpawn: st.playerSpawn,
        enemySpawn: st.enemySpawn,
        enemySpawns: st.enemySpawns,
        enemyHpScale: st.enemyHpScale,
        teamBattle: Boolean(st.enemies && st.enemies.length > 1),
      });

      const limit = st.maxTicks ?? 6000;
      while (battle.status === 'running' && battle.tick < limit) {
        battle = stepBattleTick(battle);
      }

      if (battle.status !== 'finished' || battle.winnerId !== 'player') {
        const p = battle.tanks[0];
        const e = battle.tanks[1];
        failures.push(
          `${st.id} battle: status=${battle.status}, winner=${battle.winnerId}, tick=${battle.tick}, pHp=${Math.round(p.hp)}, eHp=${Math.round(e.hp)}, pShots=${p.stats.shotsFired}/${p.stats.shotsHit}, eShots=${e.stats.shotsFired}/${e.stats.shotsHit}, wallHits=${p.stats.wallHits}`
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('runs timed act_move sequentially, pauses during time.sleep, and resets for the next cycle', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.program.cells[0][0] = { id: 's', type: 'start', params: {}, next: { x: 1, y: 0 } };
    bp.program.cells[0][1] = {
      id: 'timed_move',
      type: 'act_move',
      params: { speedPercent: 80, duration: 0.5 }, // 0.5s = 10 ticks @ 20 TPS
      next: null,
    };

    const battle = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
    const player = battle.tanks[0];

    for (let t = 1; t <= 10; t++) {
      const res = runTankChipProgram(player, t, battle.arena, battle.projectiles, battle.tanks);
      expect(res.commands.targetSpeedRatio).toBeCloseTo(0.8, 5);
    }
    // Tick 11: move(0.5s) finishes and ends cycle (0 speed), then restarts on next tick
    const done = runTankChipProgram(player, 11, battle.arena, battle.projectiles, battle.tanks);
    expect(done.commands.targetSpeedRatio).toBe(0);
    const restarted = runTankChipProgram(player, 12, battle.arena, battle.projectiles, battle.tanks);
    expect(restarted.commands.targetSpeedRatio).toBeCloseTo(0.8, 5);

    // Full St.2 sequence: move(+80, 0.4s=8t) -> sleep(0.3s=6t) -> fire -> move(-80, 0.4s=8t) -> fire -> loop
    const bpSeq: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bpSeq.program.cells[0][0] = { id: 's', type: 'start', params: {}, next: { x: 1, y: 0 } };
    bpSeq.program.cells[0][1] = {
      id: 'fwd',
      type: 'act_move',
      params: { speedPercent: 80, duration: 0.4 },
      next: { x: 2, y: 0 },
    };
    bpSeq.program.cells[0][2] = {
      id: 'slp',
      type: 'wire',
      params: { seconds: 0.3 },
      next: { x: 3, y: 0 },
    };
    bpSeq.program.cells[0][3] = {
      id: 'f1',
      type: 'act_fire',
      params: { power: 'normal' },
      next: { x: 3, y: 1 },
    };
    bpSeq.program.cells[1][3] = {
      id: 'bwd',
      type: 'act_move',
      params: { speedPercent: -80, duration: 0.4 },
      next: { x: 2, y: 1 },
    };
    bpSeq.program.cells[1][2] = {
      id: 'f2',
      type: 'act_fire',
      params: { power: 'normal' },
      next: null,
    };

    const bSeq = createBattleState({ player: bpSeq, enemy: ENEMY_DUMMY });
    const pSeq = bSeq.tanks[0];

    // Ticks 1..8: forward 0.4s
    for (let t = 1; t <= 8; t++) {
      const res = runTankChipProgram(pSeq, t, bSeq.arena, bSeq.projectiles, bSeq.tanks);
      expect(res.commands.targetSpeedRatio, `tick ${t}`).toBeCloseTo(0.8, 5);
      expect(res.commands.firePower).toBeNull();
    }
    // Ticks 9..14: sleep 0.3s (stopped)
    for (let t = 9; t <= 14; t++) {
      const res = runTankChipProgram(pSeq, t, bSeq.arena, bSeq.projectiles, bSeq.tanks);
      expect(res.commands.targetSpeedRatio, `tick ${t}`).toBe(0);
      expect(res.commands.firePower).toBeNull();
    }
    // Tick 15: wakes up -> fires 1st shot and starts backward 0.4s (ticks 15..22)
    const tick15 = runTankChipProgram(pSeq, 15, bSeq.arena, bSeq.projectiles, bSeq.tanks);
    expect(tick15.commands.firePower).toBe(1.8);
    expect(tick15.commands.targetSpeedRatio).toBeCloseTo(-0.8, 5);
    for (let t = 16; t <= 22; t++) {
      const res = runTankChipProgram(pSeq, t, bSeq.arena, bSeq.projectiles, bSeq.tanks);
      expect(res.commands.targetSpeedRatio, `tick ${t}`).toBeCloseTo(-0.8, 5);
    }
    // Tick 23: finishes backward -> fires 2nd shot and ends cycle
    const tick23 = runTankChipProgram(pSeq, 23, bSeq.arena, bSeq.projectiles, bSeq.tanks);
    expect(tick23.commands.firePower).toBe(1.8);
    expect(tick23.commands.targetSpeedRatio).toBe(0);
    // Tick 24: cycle resets to start -> forward again!
    const tick24 = runTankChipProgram(pSeq, 24, bSeq.arena, bSeq.projectiles, bSeq.tanks);
    expect(tick24.commands.targetSpeedRatio).toBeCloseTo(0.8, 5);
  });

  it('exercises both if (1.5s forward -> fire) and else (0.5s reverse) branches cleanly', () => {
    const bpBranch: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bpBranch.assembly.radar = 'long';
    bpBranch.program.cells[0][0] = { id: 's', type: 'start', params: {}, next: { x: 1, y: 0 } };
    bpBranch.program.cells[0][1] = {
      id: 'rng',
      type: 'cond_enemy_dist',
      params: { op: 'gte', dist: 315 },
      yes: { x: 2, y: 0 },
      no: { x: 1, y: 1 },
    };
    bpBranch.program.cells[0][2] = {
      id: 'fwd',
      type: 'act_move',
      params: { speedPercent: 80, duration: 1.5 },
      next: { x: 3, y: 0 },
    };
    bpBranch.program.cells[0][3] = {
      id: 'fire',
      type: 'act_fire',
      params: { power: 'normal' },
      next: null,
    };
    bpBranch.program.cells[1][1] = {
      id: 'rev',
      type: 'act_move',
      params: { speedPercent: -50, duration: 0.5 },
      next: null,
    };

    let battle = createBattleState({
      player: bpBranch,
      enemy: ENEMY_DUMMY,
      arenaSize: 'medium',
      maxTicks: 1500,
      playerSpawn: { x: 180, y: 400, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 560, y: 400, bodyAngle: 270, turretAngle: 270, radarAngle: 270 },
    });

    let sawForward = false;
    let sawReverse = false;
    let firstShotTick: number | null = null;
    let secondShotTick: number | null = null;
    while (battle.status === 'running' && battle.tick < 1500) {
      const prevShots = battle.tanks[0].stats.shotsFired;
      battle = stepBattleTick(battle);
      const p = battle.tanks[0];
      if (p.lastCommands.targetSpeedRatio > 0.1) sawForward = true;
      if (p.lastCommands.targetSpeedRatio < -0.1) sawReverse = true;
      if (p.stats.shotsFired > prevShots) {
        if (firstShotTick === null) firstShotTick = battle.tick;
        else if (secondShotTick === null) secondShotTick = battle.tick;
      }
    }

    expect(firstShotTick).toBe(31);
    expect(secondShotTick).toBeGreaterThanOrEqual(70);
    expect(battle.status).toBe('finished');
    expect(battle.winnerId).toBe('player');
    expect(sawForward).toBe(true);
    expect(sawReverse).toBe(true);
    expect(battle.tanks[0].stats.shotsFired).toBeGreaterThanOrEqual(4);
  });

  it('runs sequential loop_for blocks consecutively in Python order before restarting', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.program = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'loop_for', params: { iterations: 3 }, yes: { x: 1, y: 1 }, no: { x: 2, y: 0 } },
      { x: 1, y: 1, type: 'act_move', params: { speedPercent: 50, duration: 0 }, next: null },
      { x: 2, y: 0, type: 'loop_for', params: { iterations: 2 }, yes: { x: 2, y: 1 }, no: null },
      { x: 2, y: 1, type: 'act_turn_body', params: { mode: 'delta', angle: 5 }, next: null },
    ]);

    const battle = createBattleState({ player: bp, enemy: ENEMY_DUMMY });
    const p = battle.tanks[0];

    // Ticks 1..3: 1st for-loop (3x move 50%)
    for (let t = 1; t <= 3; t++) {
      const r = runTankChipProgram(p, t, battle.arena, battle.projectiles, battle.tanks);
      expect(r.commands.targetSpeedRatio, `tick ${t}`).toBeCloseTo(0.5);
      expect(r.commands.bodyTurnDelta, `tick ${t}`).toBe(0);
    }
    // Ticks 4..5: 2nd for-loop runs 2 times consecutively (2x turn_body 5) without restarting 1st loop
    for (let t = 4; t <= 5; t++) {
      const r = runTankChipProgram(p, t, battle.arena, battle.projectiles, battle.tanks);
      expect(r.commands.targetSpeedRatio, `tick ${t}`).toBe(0);
      expect(r.commands.bodyTurnDelta, `tick ${t}`).toBe(5);
    }
    // Tick 6: 2nd for-loop completes -> ends cycle; Tick 7: restarts 1st for-loop!
    const r6 = runTankChipProgram(p, 6, battle.arena, battle.projectiles, battle.tanks);
    expect(r6.commands.targetSpeedRatio).toBe(0);
    expect(r6.commands.bodyTurnDelta).toBe(0);
    const r7 = runTankChipProgram(p, 7, battle.arena, battle.projectiles, battle.tanks);
    expect(r7.commands.targetSpeedRatio).toBeCloseTo(0.5);
  });

  it('steers away from left, right, head-on, and corner walls with act_turn_body(mode="wall_away") and round-trips Python', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.assembly.cpu = 'mini_4x4';
    bp.program = buildProgram(4, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'act_turn_body', params: { mode: 'wall_away', angle: 12 }, next: null },
    ]);

    const validation = validateAndRepairBlueprint(bp);
    expect(validation.isValid).toBe(true);
    expect(validation.fixes).toEqual([]);

    const src = transpileProgramToLines(bp.program, bp.name, false).map((l) => l.text).join('\n');
    expect(src).toContain('turn_body(mode="wall_away", angle=12)');
    const reparsed = parsePythonSourceToProgram(src, bp.program.gridSize, bp.program.coordinateMode);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.program.cells[0][1]?.params.mode).toBe('wall_away');
      expect(reparsed.program.cells[0][1]?.params.angle).toBe(12);
    }

    const battle = createBattleState({ player: bp, enemy: ENEMY_DUMMY, arenaSize: 'small' });
    const tank = battle.tanks[0];

    // Near right wall facing North -> turn left (-12)
    tank.x = battle.arena.width - 45;
    tank.y = 250;
    tank.bodyAngle = 0;
    expect(runTankChipProgram(tank, 1, battle.arena, battle.projectiles, battle.tanks).commands.bodyTurnDelta).toBe(-12);

    // Near left wall facing North -> turn right (+12)
    tank.x = 45;
    tank.y = 250;
    tank.bodyAngle = 0;
    expect(runTankChipProgram(tank, 2, battle.arena, battle.projectiles, battle.tanks).commands.bodyTurnDelta).toBe(12);

    // Head-on into top wall from left of arena center -> turn right (+12) toward center
    tank.x = 200;
    tank.y = 55;
    tank.bodyAngle = 0;
    expect(runTankChipProgram(tank, 3, battle.arena, battle.projectiles, battle.tanks).commands.bodyTurnDelta).toBe(12);

    // Trapped in bottom-left corner heading South-West -> turn left (-12) out toward NE, no corner ping-pong
    tank.x = 30;
    tank.y = battle.arena.height - 30;
    tank.bodyAngle = 200;
    expect(runTankChipProgram(tank, 4, battle.arena, battle.projectiles, battle.tanks).commands.bodyTurnDelta).toBe(-12);
  });

  it('completes obstacle/evasion/SP/special development stages with zero wall hits and verifies core mechanics', () => {
    for (const id of [
      'tut_3',
      'tut_5',
      'tut_6',
      'tut_7',
      'tut_8',
      'tut_10',
      'tut_11',
      'tut_12',
      'tut_13',
      'tut_14',
      'tut_15',
      'tut_16',
      'tut_17',
      'tut_18',
      'tut_19',
    ]) {
      const st = TUTORIAL_STAGES.find((s) => s.id === id)!;
      let battle = createBattleState({
        player: st.playerStarter,
        enemy: st.enemy,
        enemies: st.enemies,
        arenaSize: st.arenaSize,
        obstacles: st.obstacles,
        maxTicks: st.maxTicks,
        playerSpawn: st.playerSpawn,
        enemySpawn: st.enemySpawn,
        enemySpawns: st.enemySpawns,
        enemyHpScale: st.enemyHpScale,
        teamBattle: Boolean(st.enemies && st.enemies.length > 1),
      });
      let sawMissile = false;
      let sawMine = false;
      let sawMineHit = false;
      let sawShield = false;
      let sawSmoke = false;
      let sawBoost = false;
      let sawDecoy = false;
      let sawEnemyShield = false;
      let sawUnderLockEvade = false;
      let sawMode1 = false;
      while (battle.status === 'running' && battle.tick < (st.maxTicks ?? 6000)) {
        battle = stepBattleTick(battle);
        if (battle.tanks[0].underLock && battle.tanks[0].lastCommands.targetSpeedRatio > 0.5) {
          sawUnderLockEvade = true;
        }
        if (battle.tanks[0].mode === 1) sawMode1 = true;
        if (battle.projectiles.some((p) => p.kind === 'missile' && p.ownerId === battle.tanks[0].id)) {
          sawMissile = true;
        }
        if (battle.mines.some((m) => m.ownerId === battle.tanks[0].id)) sawMine = true;
        if (battle.explosions.some((ex) => ex.color === '#ef4444' && ex.radius === 42)) {
          sawMineHit = true;
        }
        if (battle.tanks[0].shieldTicks > 0) sawShield = true;
        if ((battle.smokes ?? []).length > 0) sawSmoke = true;
        if (battle.tanks[0].boostTicks > 0) sawBoost = true;
        if ((battle.decoys ?? []).length > 0) sawDecoy = true;
        if (battle.tanks[1].shieldTicks > 0) sawEnemyShield = true;
      }
      expect(battle.winnerId, id).toBe('player');
      expect(battle.tanks[0].stats.wallHits, `${id} wallHits`).toBe(0);
      if (id === 'tut_3') expect(sawUnderLockEvade, 'tut_3 under_lock evasion').toBe(true);
      if (id === 'tut_11') expect(sawMissile, 'tut_11 missile').toBe(true);
      if (id === 'tut_12') {
        expect(sawMine, 'tut_12 mine placed').toBe(true);
        expect(sawMineHit, 'tut_12 mine detonated on charger').toBe(true);
      }
      if (id === 'tut_13') expect(sawShield, 'tut_13 shield').toBe(true);
      if (id === 'tut_14') expect(sawSmoke, 'tut_14 smoke').toBe(true);
      if (id === 'tut_15') expect(sawBoost, 'tut_15 boost').toBe(true);
      if (id === 'tut_16') {
        expect(sawDecoy, 'tut_16 decoy').toBe(true);
        expect(sawEnemyShield, 'tut_16 enemy guardian shield').toBe(true);
      }
      if (id === 'tut_17') expect(battle.tanks[0].blueprint.assembly.chassis).toBe('destroyer');
      if (id === 'tut_18') expect(battle.tanks.length).toBe(3);
      if (id === 'tut_19') {
        expect(sawMissile, 'tut_19 missile').toBe(true);
        expect(sawMode1, 'tut_19 mode 1 switch').toBe(true);
      }
    }

    // Verify Stage 4 actually detects blind-side hit (lastHitAngle populated) and recovers to win
    const st4 = TUTORIAL_STAGES.find((s) => s.id === 'tut_4')!;
    let b4 = createBattleState({
      player: st4.playerStarter,
      enemy: st4.enemy,
      arenaSize: st4.arenaSize,
      obstacles: st4.obstacles,
      maxTicks: st4.maxTicks,
      playerSpawn: st4.playerSpawn,
      enemySpawn: st4.enemySpawn,
      enemyHpScale: st4.enemyHpScale,
    });
    let sawHitReaction = false;
    while (b4.status === 'running' && b4.tick < (st4.maxTicks ?? 4800)) {
      b4 = stepBattleTick(b4);
      if (b4.tanks[0].lastHitAngle !== null) sawHitReaction = true;
    }
    expect(b4.winnerId).toBe('player');
    expect(sawHitReaction).toBe(true);

    // Verify Stage 9 transitions to tactical mode 1 when hp drops below threshold and wins
    const st9 = TUTORIAL_STAGES.find((s) => s.id === 'tut_9')!;
    let b9 = createBattleState({
      player: st9.playerStarter,
      enemy: st9.enemy,
      arenaSize: st9.arenaSize,
      obstacles: st9.obstacles,
      maxTicks: st9.maxTicks,
      playerSpawn: st9.playerSpawn,
      enemySpawn: st9.enemySpawn,
      enemyHpScale: st9.enemyHpScale,
    });
    let sawSt9Mode1 = false;
    while (b9.status === 'running' && b9.tick < (st9.maxTicks ?? 6000)) {
      b9 = stepBattleTick(b9);
      if (b9.tanks[0].mode === 1) sawSt9Mode1 = true;
    }
    expect(b9.winnerId).toBe('player');
    expect(sawSt9Mode1).toBe(true);
  });

  it('validates all PRESET_ENEMIES cleanly and verifies enemy mechanics including 12x12 masters and champion', () => {
    expect(PRESET_ENEMIES).toHaveLength(30);

    for (const enemyBp of PRESET_ENEMIES) {
      const check = validateAndRepairBlueprint(enemyBp);
      expect(check.isValid, `${enemyBp.id} isValid`).toBe(true);
      expect(check.fixes, `${enemyBp.id} fixes`).toEqual([]);
    }

    const verifySpecialBattle = (bpId: string, expectKind: 'smoke' | 'boost' | 'decoy' | 'shield' | 'missile' | 'none') => {
      const bp = PRESET_ENEMIES.find((e) => e.id === bpId)!;
      let battle = createBattleState({
        player: bp,
        enemy: DEFAULT_PLAYER_BLUEPRINT,
        arenaSize: 'medium',
      });
      let sawSmoke = false;
      let sawBoost = false;
      let sawDecoy = false;
      let sawShield = false;
      let sawMissile = false;
      while (battle.status === 'running' && battle.tick < 1800) {
        battle = stepBattleTick(battle);
        if ((battle.smokes?.length ?? 0) > 0) sawSmoke = true;
        if ((battle.decoys?.length ?? 0) > 0) sawDecoy = true;
        if (battle.tanks[0].boostTicks > 0) sawBoost = true;
        if (battle.tanks[0].shieldTicks > 0) sawShield = true;
        if (battle.projectiles.some((p) => p.ownerId === battle.tanks[0].id && p.kind === 'missile')) {
          sawMissile = true;
        }
      }
      expect(battle.tanks[0].stats.wallHits, `${bpId} wallHits`).toBe(0);
      expect(battle.tanks[0].stats.shotsFired, `${bpId} shotsFired`).toBeGreaterThan(0);
      if (expectKind === 'smoke') expect(sawSmoke).toBe(true);
      if (expectKind === 'boost') expect(sawBoost).toBe(true);
      if (expectKind === 'decoy') expect(sawDecoy).toBe(true);
      if (expectKind === 'shield') expect(sawShield).toBe(true);
      if (expectKind === 'missile') expect(sawMissile).toBe(true);
    };

    verifySpecialBattle('enemy_jagd', 'none');
    verifySpecialBattle('enemy_orbiter', 'none');
    verifySpecialBattle('enemy_smoke_phantom', 'smoke');
    verifySpecialBattle('enemy_boost_raider', 'boost');
    verifySpecialBattle('enemy_decoy_tricker', 'decoy');
    verifySpecialBattle('enemy_shuttle', 'none');
    verifySpecialBattle('enemy_circle_gunner', 'none');
    verifySpecialBattle('enemy_micromouse', 'none');
    verifySpecialBattle('enemy_square_patrol', 'none');
    verifySpecialBattle('enemy_random_walker', 'none');
    verifySpecialBattle('enemy_gale_mirage', 'none');
    verifySpecialBattle('enemy_aegis_command', 'shield');
    verifySpecialBattle('enemy_dreadnought', 'missile');
    verifySpecialBattle('enemy_light_master', 'none');
    verifySpecialBattle('enemy_standard_master', 'shield');
    verifySpecialBattle('enemy_heavy_master', 'shield');
    verifySpecialBattle('enemy_destroyer_master', 'shield');
    verifySpecialBattle('enemy_champion', 'shield');

    // Verify Sentinel detects rear hit and turns around to destroy attacker
    let sb = createBattleState({
      player: ENEMY_FIXED_TURRET,
      enemy: PRESET_ENEMIES.find((e) => e.id === 'enemy_sentinel')!,
      arenaSize: 'small',
      playerSpawn: { x: 180, y: 330, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
      enemySpawn: { x: 640, y: 330, bodyAngle: 90, turretAngle: 90, radarAngle: 90 },
    });
    while (sb.status === 'running' && sb.tick < 1200) {
      sb = stepBattleTick(sb);
    }
    expect(sb.winnerId).toBe('enemy');
    expect(sb.tanks[1].stats.shotsFired).toBeGreaterThan(0);
  });

  it('validates boolean wait params, visibility metadata, and Python round-trip for wait/stop/on_tile/mission_state', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.assembly.cpu = 'standard_8x8';
    bp.program = buildProgram(8, 'relative', [
      { x: 0, y: 0, type: 'start', next: { x: 1, y: 0 } },
      { x: 1, y: 0, type: 'cond_floor_tile', params: { target: 'goal' }, yes: { x: 1, y: 1 }, no: { x: 2, y: 0 } },
      { x: 1, y: 1, type: 'act_halt', params: {}, next: null },
      { x: 2, y: 0, type: 'cond_mission_state', params: { check: 'targets_remaining' }, yes: { x: 2, y: 1 }, no: { x: 3, y: 0 } },
      { x: 2, y: 1, type: 'act_turn_turret', params: { mode: 'delta', angle: 90, wait: 1 }, next: null },
      { x: 3, y: 0, type: 'act_turn_body', params: { mode: 'delta', angle: 90, wait: 1 }, next: { x: 3, y: 1 } },
      { x: 3, y: 1, type: 'act_halt', params: {}, next: null },
    ]);

    const checkValid = validateAndRepairBlueprint(bp);
    expect(checkValid.isValid).toBe(true);
    expect(checkValid.fixes).toEqual([]);

    // String/boolean coercion + invalid repair on boolean field
    const coerced: TankBlueprint = JSON.parse(JSON.stringify(bp));
    coerced.program.cells[0][3]!.params.wait = 'True';
    const checkCoerced = validateAndRepairBlueprint(coerced);
    expect(checkCoerced.isValid).toBe(true);
    expect(checkCoerced.blueprint.program.cells[0][3]?.params.wait).toBe(1);

    const broken: TankBlueprint = JSON.parse(JSON.stringify(bp));
    broken.program.cells[0][3]!.params.wait = 'bogus_bool';
    const checkBroken = validateAndRepairBlueprint(broken);
    expect(checkBroken.isValid).toBe(false);
    expect(checkBroken.fixes.length).toBe(1);
    expect(checkBroken.blueprint.program.cells[0][3]?.params.wait).toBe(0);

    // Python transpile + reparse round-trip
    const src = transpileProgramToLines(bp.program, bp.name, false).map((l) => l.text).join('\n');
    expect(src).toContain('if on_tile("goal"):');
    expect(src).toContain('if targets_left() > 0:');
    expect(src).toContain('turn_turret(mode="delta", angle=90, wait=True)');
    expect(src).toContain('turn_body(mode="delta", angle=90, wait=True)');
    expect(src).toContain('stop()');

    const reparsed = parsePythonSourceToProgram(src, 8, 'relative');
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      const flat = reparsed.program.cells.flat().filter((c): c is NonNullable<typeof c> => c !== null);
      const bodyTurn = flat.find((c) => c.type === 'act_turn_body');
      const turretTurn = flat.find((c) => c.type === 'act_turn_turret');
      const tileCond = flat.find((c) => c.type === 'cond_floor_tile');
      const missionCond = flat.find((c) => c.type === 'cond_mission_state');
      const haltChips = flat.filter((c) => c.type === 'act_halt');
      expect(bodyTurn?.params.wait).toBe(1);
      expect(bodyTurn?.params.angle).toBe(90);
      expect(turretTurn?.params.wait).toBe(1);
      expect(tileCond?.params.target).toBe('goal');
      expect(missionCond?.params.check).toBe('targets_remaining');
      expect(haltChips.length).toBe(2);
      expect(haltChips.every((c) => c.next === null)).toBe(true);
    }

    // Parse cond_floor_tile edge=True, fire_main wait=True, proximity_near mode="front", and cond_mission_state Python variants
    const variantsSrc = [
      'def on_tick():',
      '  if on_tile("blue", edge=True):',
      '    if checkpoints_done():',
      '      fire_main(power="heavy", wait=True)',
      '      stop()',
      '  else:',
      '    if proximity_near(mode="front", target="walls", dist=110):',
      '      stop()',
      '    if targets_left() == 0:',
      '      stop()',
    ].join('\n');
    const parsedVariants = parsePythonSourceToProgram(variantsSrc, 8, 'relative');
    expect(parsedVariants.ok).toBe(true);
    if (parsedVariants.ok) {
      const flat = parsedVariants.program.cells.flat().filter((c): c is NonNullable<typeof c> => c !== null);
      expect(flat.some((c) => c.type === 'cond_floor_tile' && c.params.target === 'blue' && c.params.edge === 1)).toBe(true);
      expect(flat.some((c) => c.type === 'cond_mission_state' && c.params.check === 'checkpoints_cleared')).toBe(true);
      expect(flat.some((c) => c.type === 'act_fire' && c.params.power === 'heavy' && c.params.wait === 1)).toBe(true);
      expect(flat.some((c) => c.type === 'cond_proximity' && c.params.mode === 'front' && c.params.target === 'walls' && c.params.dist === 110)).toBe(true);
      expect(flat.some((c) => c.type === 'cond_mission_state' && c.params.check === 'targets_cleared')).toBe(true);

      const reTranspiled = transpileProgramToLines(parsedVariants.program, 'edge_test', false)
        .map((l) => l.text)
        .join('\n');
      expect(reTranspiled).toContain('on_tile("blue", edge=True)');
      expect(reTranspiled).toContain('fire_main(power="heavy", wait=True)');
      expect(reTranspiled).toContain('proximity_near(mode="front", target="walls", dist=110)');
    }
  });
});
