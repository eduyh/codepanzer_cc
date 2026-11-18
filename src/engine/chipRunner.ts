import { CHIP_DEFINITIONS } from '../data/chips';
import {
  CHASSIS_SPECS,
  CPU_SPECS,
  MAIN_GUN_SPECS,
  normalizeFirePowerTier,
  RADAR_MEMORY_TICKS,
  RADAR_SPECS,
  resolveFirePower,
} from '../data/parts';
import {
  ArenaConfig,
  ArenaTile,
  ExecutionEdge,
  ExecutionTrace,
  GridCell,
  GridCoord,
  Projectile,
  TankRuntime,
  TankTickCommands,
} from '../types/game';
import {
  angleToVector,
  calculateLeadAngle,
  clamp,
  computeWallAwayTurnSign,
  distanceBetween,
  normalizeAngle180,
  normalizeAngle360,
  ProximityTarget,
  raycastWallDistance,
  scanProximity,
  vectorToAngle,
} from './math';

export function findStartCell(cells: (GridCell | null)[][]): GridCoord | null {
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < cells[y].length; x++) {
      if (cells[y][x]?.type === 'start') {
        return { x, y };
      }
    }
  }
  return null;
}

export function findSubDefCell(
  cells: (GridCell | null)[][],
  subKey: string
): GridCoord | null {
  const target = subKey.trim().toUpperCase();
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < cells[y].length; x++) {
      const c = cells[y][x];
      if (
        c?.type === 'sub_def' &&
        String(c.params.sub ?? 'A').trim().toUpperCase() === target
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

function isTankInsideTile(tank: TankRuntime, tile: ArenaTile): boolean {
  return (
    tank.x >= tile.x &&
    tank.x <= tile.x + tile.width &&
    tank.y >= tile.y &&
    tank.y <= tile.y + tile.height
  );
}

function isValidOrthoTransition(
  from: GridCoord,
  to: GridCoord | null | undefined,
  cells: (GridCell | null)[][]
): to is GridCoord {
  if (!to) return false;
  if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) !== 1) return false;
  return (
    to.y >= 0 &&
    to.y < cells.length &&
    to.x >= 0 &&
    to.x < cells[to.y].length &&
    cells[to.y][to.x] !== null
  );
}

export function runTankChipProgram(
  tank: TankRuntime,
  tick: number,
  arena: ArenaConfig,
  projectiles: Projectile[],
  tanks: TankRuntime[] = []
): { commands: TankTickCommands; trace: ExecutionTrace } {
  const program = tank.blueprint.program;
  const cpu = CPU_SPECS[tank.blueprint.assembly.cpu];
  const gun = MAIN_GUN_SPECS[tank.blueprint.assembly.mainGun];
  const radar = RADAR_SPECS[tank.blueprint.assembly.radar];

  const commands: TankTickCommands = {
    targetSpeedRatio: 0,
    bodyTurnDelta: 0,
    turretTurnDelta: 0,
    radarTurnDelta: 0,
    firePower: null,
    useSubWeapon: false,
  };

  const visited: GridCoord[] = [];
  const edges: ExecutionEdge[] = [];
  const startCoord = findStartCell(program.cells);

  if (!startCoord || tank.halted) {
    return {
      commands,
      trace: { visited, edges, stepsUsed: 0, truncated: false },
    };
  }

  // Release any edge-triggered floor tile latch as soon as the tank exits that tile
  if (tank.tileEdgeState) {
    const tiles = arena.tiles ?? [];
    for (const [edgeCoordKey, tileId] of Object.entries(tank.tileEdgeState)) {
      const matched = tiles.find((t) => t.id === tileId);
      if (!matched || !isTankInsideTile(tank, matched)) {
        delete tank.tileEdgeState[edgeCoordKey];
      }
    }
  }

  let current: GridCoord | null = startCoord;
  let steps = 0;
  let truncated = false;
  const maxSteps = cpu.maxStepsPerTick;
  const coordMode = program.coordinateMode;
  let activeInTickLoopCoord: GridCoord | null = null;
  type CallFrame = { returnCoord: GridCoord | null; callerCoord: GridCoord; subKey: string };
  let callStack: CallFrame[] = [];
  const unwindCallStack = (): GridCoord | null => {
    while (callStack.length > 0) {
      const frame = callStack.pop()!;
      if (isValidOrthoTransition(frame.callerCoord, frame.returnCoord, program.cells)) {
        edges.push({
          from: frame.callerCoord,
          to: frame.returnCoord,
          branch: 'next',
        });
        return frame.returnCoord;
      }
    }
    return null;
  };
  const printOutputs: string[] = [];
  const pushPrintOutput = (line: string) => {
    if (printOutputs.length < 3) {
      printOutputs.push(line);
    }
  };
  const cloneCallStack = (
    stack: Array<{ returnCoord: GridCoord | null; callerCoord: GridCoord; subKey: string }>
  ) =>
    stack.map((f) => ({
      returnCoord: f.returnCoord ? { ...f.returnCoord } : null,
      callerCoord: { ...f.callerCoord },
      subKey: f.subKey,
    }));
  const isMultiTickLoopCell = (c: GridCell | null | undefined): boolean =>
    Boolean(
      c &&
        (c.type === 'loop_for' ||
          (c.type === 'loop_while' && String(c.params.cond ?? '') !== 'var_a_lt'))
    );

  // Resume active turn(..., wait=True), time.sleep(), or timed move(duration > 0) across ticks
  const resumeTimedNext = (
    coord: GridCoord,
    cell: GridCell,
    savedCallStack?: CallFrame[]
  ): GridCoord | null => {
    if (savedCallStack && savedCallStack.length > 0) {
      callStack = cloneCallStack(savedCallStack);
    }
    const resumeNext = cell.next ?? null;
    if (isValidOrthoTransition(coord, resumeNext, program.cells)) {
      edges.push({
        from: { x: coord.x, y: coord.y },
        to: { x: resumeNext.x, y: resumeNext.y },
        branch: 'next',
      });
      return resumeNext;
    }
    return unwindCallStack();
  };

  if (tank.turnState) {
    const ts = tank.turnState;
    const expectedType = ts.axis === 'body' ? 'act_turn_body' : 'act_turn_turret';
    const turnCell = program.cells[ts.coord.y]?.[ts.coord.x];
    if (!turnCell || turnCell.type !== expectedType) {
      tank.turnState = null;
    } else {
      visited.push({ x: ts.coord.x, y: ts.coord.y });
      steps += 1;
      const curAngle = ts.axis === 'body' ? tank.bodyAngle : tank.turretAngle;
      const actualStep = normalizeAngle180(curAngle - ts.lastAngle);
      ts.remainingDelta -= actualStep;
      ts.lastAngle = curAngle;
      ts.remainingTicks -= 1;

      const fixedTurretDone =
        ts.axis === 'turret' && Boolean(CHASSIS_SPECS[tank.blueprint.assembly.chassis]?.fixedTurret);
      const err = ts.isDelta
        ? ts.remainingDelta
        : normalizeAngle180(ts.targetAbsAngle - curAngle);
      const isDone = fixedTurretDone || Math.abs(err) <= 0.5 || ts.remainingTicks <= 0;

      if (!isDone) {
        if (ts.axis === 'body') {
          commands.targetSpeedRatio = 0;
          commands.bodyTurnDelta = err;
        } else {
          commands.turretTurnDelta = err;
        }
        return {
          commands,
          trace: { visited, edges, stepsUsed: steps, truncated: false },
        };
      }

      const savedCallStack = ts.callStack;
      tank.turnState = null;
      current = resumeTimedNext(ts.coord, turnCell, savedCallStack);
    }
  } else if (tank.fireState) {
    const fs = tank.fireState;
    const fireCell = program.cells[fs.coord.y]?.[fs.coord.x];
    if (!fireCell || fireCell.type !== 'act_fire') {
      tank.fireState = null;
    } else {
      visited.push({ x: fs.coord.x, y: fs.coord.y });
      steps += 1;
      fs.remainingTicks -= 1;
      const gunReady = tank.gunHeat <= 0.0001;
      if (!gunReady && fs.remainingTicks > 0) {
        return {
          commands,
          trace: { visited, edges, stepsUsed: steps, truncated: false },
        };
      }
      if (gunReady) {
        commands.firePower = fs.firePower;
      }
      const savedCallStack = fs.callStack;
      tank.fireState = null;
      current = resumeTimedNext(fs.coord, fireCell, savedCallStack);
    }
  } else {
    const activeTimed = tank.sleepState
      ? { kind: 'sleep' as const, state: tank.sleepState, expectedType: 'wire' as const }
      : tank.moveState
        ? { kind: 'move' as const, state: tank.moveState, expectedType: 'act_move' as const }
        : null;
    if (activeTimed) {
      const timedCoord = activeTimed.state.coord;
      const timedCell = program.cells[timedCoord.y]?.[timedCoord.x];
      if (!timedCell || timedCell.type !== activeTimed.expectedType) {
        if (activeTimed.kind === 'sleep') tank.sleepState = null;
        else tank.moveState = null;
      } else {
        visited.push({ x: timedCoord.x, y: timedCoord.y });
        steps += 1;
        activeTimed.state.remainingTicks -= 1;
        if (activeTimed.state.remainingTicks > 0) {
          if (activeTimed.kind === 'move' && tank.moveState) {
            commands.targetSpeedRatio = tank.moveState.speedRatio;
          }
          return {
            commands,
            trace: { visited, edges, stepsUsed: steps, truncated: false },
          };
        }
        const savedCallStack = activeTimed.state.callStack;
        if (activeTimed.kind === 'sleep') tank.sleepState = null;
        else tank.moveState = null;
        current = resumeTimedNext(timedCoord, timedCell, savedCallStack);
      }
    } else if (tank.loopStack && tank.loopStack.length > 0) {
      // Resume active Python for/while loop until its exit condition completes
      while (tank.loopStack.length > 0) {
        const top = tank.loopStack[tank.loopStack.length - 1];
        const loopCell = program.cells[top.coord.y]?.[top.coord.x];
        if (isMultiTickLoopCell(loopCell)) {
          current = { x: top.coord.x, y: top.coord.y };
          if (top.callStack && top.callStack.length > 0) {
            callStack = cloneCallStack(top.callStack);
          }
          break;
        }
        tank.loopStack.pop();
      }
    }
  }

  while (current !== null) {
    if (steps >= maxSteps) {
      truncated = true;
      break;
    }

    const row: (GridCell | null)[] | undefined = program.cells[current.y];
    const cell: GridCell | null = row ? row[current.x] : null;
    if (!cell) break;

    visited.push({ x: current.x, y: current.y });
    steps += 1;

    const def = CHIP_DEFINITIONS[cell.type];
    let nextCoord: GridCoord | null = null;
    let branch: 'next' | 'yes' | 'no' = 'next';

    if (def.isCondition) {
      const coordKey = `${current.x},${current.y}`;
      const result = evaluateCondition(cell, coordKey, tank, tick, arena, projectiles, tanks, commands);
      if (Number(cell.params._print ?? 0) === 1 && cell.type !== 'start') {
        pushPrintOutput(formatChipDebugPrint(cell, tank, result, coordKey));
      }
      branch = result ? 'yes' : 'no';
      nextCoord = result ? cell.yes ?? null : cell.no ?? null;

      if (cell.type === 'loop_while' && String(cell.params.cond ?? '') === 'var_a_lt') {
        activeInTickLoopCoord = result ? { x: current.x, y: current.y } : null;
      } else if (isMultiTickLoopCell(cell)) {
        if (result) {
          if (isValidOrthoTransition(current, cell.yes ?? null, program.cells)) {
            if (!tank.loopStack) tank.loopStack = [];
            const top = tank.loopStack[tank.loopStack.length - 1];
            if (!top || top.coord.x !== current.x || top.coord.y !== current.y) {
              tank.loopStack.push({
                coord: { x: current.x, y: current.y },
                ...(callStack.length > 0 ? { callStack: cloneCallStack(callStack) } : {}),
              });
            }
          }
        } else if (tank.loopStack && tank.loopStack.length > 0) {
          const top = tank.loopStack[tank.loopStack.length - 1];
          if (top.coord.x === current.x && top.coord.y === current.y) {
            tank.loopStack.pop();
          }
        }
      }
    } else if (cell.type === 'sub_call') {
      if (Number(cell.params._print ?? 0) === 1) {
        pushPrintOutput(formatChipDebugPrint(cell, tank));
      }
      const subKey = String(cell.params.sub ?? 'A').trim().toUpperCase();
      const rawNext = cell.next ?? null;
      const returnCoord: GridCoord | null = isValidOrthoTransition(current, rawNext, program.cells)
        ? rawNext
        : null;
      const defCoord = findSubDefCell(program.cells, subKey);
      const alreadyInStack = callStack.some((f) => f.subKey === subKey);
      if (defCoord && !alreadyInStack && callStack.length < 4) {
        callStack.push({
          returnCoord,
          callerCoord: { x: current.x, y: current.y },
          subKey,
        });
        current = defCoord;
        continue;
      }
      branch = 'next';
      nextCoord = returnCoord;
    } else {
      if (cell.type === 'wire') {
        const seconds = Number(cell.params.seconds ?? 0);
        if (seconds > 0) {
          tank.sleepState = {
            coord: { x: current.x, y: current.y },
            remainingTicks: Math.max(1, Math.round(seconds * 20)),
            ...(callStack.length > 0 ? { callStack: cloneCallStack(callStack) } : {}),
          };
          if (Number(cell.params._print ?? 0) === 1) {
            pushPrintOutput(formatChipDebugPrint(cell, tank));
          }
          break;
        }
      } else if (cell.type === 'act_move') {
        const duration = Math.max(0, Number(cell.params.duration ?? 0));
        const limitTicks = duration > 0 ? Math.max(1, Math.round(duration * 20)) : 0;
        if (limitTicks > 1) {
          const pct = Number(cell.params.speedPercent ?? 80);
          const ratio = clamp(pct / 100, -1, 1);
          commands.targetSpeedRatio = ratio;
          tank.moveState = {
            coord: { x: current.x, y: current.y },
            speedRatio: ratio,
            remainingTicks: limitTicks,
            ...(callStack.length > 0 ? { callStack: cloneCallStack(callStack) } : {}),
          };
          if (Number(cell.params._print ?? 0) === 1) {
            pushPrintOutput(formatChipDebugPrint(cell, tank));
          }
          break;
        }
      } else if (cell.type === 'act_halt') {
        commands.targetSpeedRatio = 0;
        commands.bodyTurnDelta = 0;
        commands.turretTurnDelta = 0;
        commands.radarTurnDelta = 0;
        tank.moveState = null;
        tank.sleepState = null;
        tank.turnState = null;
        tank.fireState = null;
        tank.loopStack = [];
        tank.halted = true;
        if (Number(cell.params._print ?? 0) === 1) {
          pushPrintOutput(formatChipDebugPrint(cell, tank));
        }
        break;
      } else if (cell.type === 'act_fire' && Number(cell.params.wait ?? 0) === 1) {
        if (tank.gunHeat > 0.0001) {
          const firePower = resolveFirePower(
            cell.params.power,
            tank.blueprint.assembly.mainGun
          ).power;
          tank.fireState = {
            coord: { x: current.x, y: current.y },
            firePower,
            remainingTicks: 180,
            ...(callStack.length > 0 ? { callStack: cloneCallStack(callStack) } : {}),
          };
          if (Number(cell.params._print ?? 0) === 1) {
            pushPrintOutput(formatChipDebugPrint(cell, tank));
          }
          break;
        }
      } else if (
        (cell.type === 'act_turn_body' || cell.type === 'act_turn_turret') &&
        Number(cell.params.wait ?? 0) === 1
      ) {
        const isBody = cell.type === 'act_turn_body';
        const isFixedTurret =
          !isBody && Boolean(CHASSIS_SPECS[tank.blueprint.assembly.chassis]?.fixedTurret);
        if (isBody) {
          commands.targetSpeedRatio = 0;
        }
        if (!isFixedTurret) {
          const resolved = isBody
            ? resolveBodyTurnDelta(cell.params, tank, tick, arena, coordMode, commands)
            : resolveTurretTurnDelta(cell.params, tank, coordMode);
          if (resolved.delta !== null && Math.abs(resolved.delta) > 0.5) {
            const curAngle = isBody ? tank.bodyAngle : tank.turretAngle;
            const maxWaitTicks = Math.max(
              40,
              Math.min(400, Math.ceil(Math.abs(resolved.delta) * 1.2) + 20)
            );
            if (isBody) {
              commands.bodyTurnDelta = resolved.delta;
            } else {
              commands.turretTurnDelta = resolved.delta;
            }
            tank.turnState = {
              coord: { x: current.x, y: current.y },
              axis: resolved.axis,
              isDelta: resolved.isDelta,
              targetAbsAngle: resolved.targetAbsAngle,
              remainingDelta: resolved.delta,
              lastAngle: curAngle,
              remainingTicks: maxWaitTicks,
              ...(callStack.length > 0 ? { callStack: cloneCallStack(callStack) } : {}),
            };
            if (Number(cell.params._print ?? 0) === 1) {
              pushPrintOutput(formatChipDebugPrint(cell, tank));
            }
            break;
          }
        }
      }
      const coordKey = `${current.x},${current.y}`;
      executeActionCell(
        cell,
        coordKey,
        tank,
        tick,
        arena,
        coordMode,
        gun.speedBonus,
        radar.turnRate,
        commands
      );
      if (Number(cell.params._print ?? 0) === 1 && cell.type !== 'start') {
        pushPrintOutput(formatChipDebugPrint(cell, tank));
      }
      branch = 'next';
      nextCoord = cell.next ?? null;
    }

    if (isValidOrthoTransition(current, nextCoord, program.cells)) {
      edges.push({
        from: { x: current.x, y: current.y },
        to: { x: nextCoord.x, y: nextCoord.y },
        branch,
      });
      current = nextCoord;
    } else if (activeInTickLoopCoord && steps < maxSteps) {
      edges.push({
        from: { x: current.x, y: current.y },
        to: { x: activeInTickLoopCoord.x, y: activeInTickLoopCoord.y },
        branch,
      });
      current = activeInTickLoopCoord;
      activeInTickLoopCoord = null;
    } else {
      current = unwindCallStack();
    }
  }

  return {
    commands,
    trace: {
      visited,
      edges,
      stepsUsed: steps,
      truncated,
      ...(printOutputs.length > 0 ? { printOutputs } : {}),
    },
  };
}

function formatChipDebugPrint(
  cell: GridCell,
  tank: TankRuntime,
  condResult?: boolean,
  coordKey?: string
): string {
  const p = cell.params;
  const tf = condResult ? 'True' : 'False';
  switch (cell.type) {
    case 'cond_enemy_detected':
      return `detected: ${tf}${tank.enemyDist !== null ? ` (${tank.enemyDist}px)` : ''}`;
    case 'cond_enemy_dist':
      return `dist ${p.op === 'gte' ? '>=' : '<='} ${p.dist ?? 300}: ${tf} (${tank.enemyDist ?? '-'}px)`;
    case 'cond_enemy_sector':
      return `sector(±${p.halfWidth ?? 20}°): ${tf}${tank.enemyDist !== null ? ` (${tank.enemyDist}px)` : ''}`;
    case 'cond_wall_ahead':
      if (p.direction === 'left_closer') return `wall(L<=R): ${tf}`;
      return `wall_near(${p.dist ?? 110}): ${tf}`;
    case 'cond_proximity':
      if (p.mode === 'front') return `prox(front<=${p.dist ?? 90}): ${tf}`;
      if (p.mode === 'left_closer') return `prox(L<=R): ${tf}`;
      if (p.mode === 'left_open') return `prox(L_open>${p.dist ?? 90}): ${tf}`;
      if (p.mode === 'right_open') return `prox(R_open>${p.dist ?? 90}): ${tf}`;
      return `prox(${p.dist ?? 90}): ${tf}`;
    case 'cond_hit_from':
      return `hit_from(${p.zone ?? 'any'}): ${tf}`;
    case 'cond_gun_ready':
      return `main_cd==0: ${tf} (${tank.gunHeat.toFixed(2)})`;
    case 'cond_sub_ready':
      return `sp_cd==0: ${tf} (cd:${tank.subCooldown})`;
    case 'cond_hp_below': {
      const hpPct = Math.round((tank.hp / tank.maxHp) * 100);
      return `hp<=${p.percent ?? 45}%: ${tf} (${hpPct}%)`;
    }
    case 'cond_counter': {
      const reg = String(p.reg ?? 'A');
      const lbl = reg === 'ENEMY_DIST' ? 'enemy_dist' : reg.toLowerCase();
      const cur = reg === 'ENEMY_DIST' ? (tank.enemyDist ?? '-') : (tank.counters[reg] ?? 0);
      return `${lbl}: ${tf} (${cur})`;
    }
    case 'cond_incoming_shell':
      return `shell_near(${p.maxDist ?? 220}): ${tf}`;
    case 'cond_under_lock':
      return `under_lock: ${tf}`;
    case 'cond_mode':
      return `mode==${p.mode ?? 1}: ${tf} (m=${tank.mode})`;
    case 'cond_floor_tile':
      return `on_tile(${p.target ?? 'goal'}${Number(p.edge ?? 0) === 1 ? ',edge' : ''}): ${tf}`;
    case 'cond_mission_state': {
      const check = String(p.check ?? 'targets_remaining');
      if (check === 'targets_cleared') return `targets_left==0: ${tf}`;
      if (check === 'checkpoints_remaining') return `checkpoints_left>0: ${tf}`;
      if (check === 'checkpoints_cleared') return `checkpoints_done: ${tf}`;
      return `targets_left>0: ${tf}`;
    }
    case 'loop_while':
      return `while(${String(p.cond ?? 'loop')}): ${tf} (a=${tank.counters.A ?? 0})`;
    case 'loop_for':
      return `for(${tank.loopCounters[coordKey ?? ''] ?? 0}/${p.iterations ?? 15}): ${tf}`;
    case 'wire':
      return `sleep(${p.seconds ?? 0}s)`;
    case 'sub_def':
      return `def sub_${String(p.sub ?? 'A').toLowerCase()}()`;
    case 'sub_call':
      return `call sub_${String(p.sub ?? 'A').toLowerCase()}()`;
    case 'counter_op': {
      const reg = String(p.reg ?? 'A');
      return `${reg.toLowerCase()} = ${tank.counters[reg] ?? 0}`;
    }
    case 'random_op': {
      const reg = String(p.reg ?? 'A');
      return `rand -> ${reg.toLowerCase()}=${tank.counters[reg] ?? 0}`;
    }
    case 'mode_set':
      return `mode = ${tank.mode}`;
    case 'act_halt':
      return 'stop()';
    case 'act_move':
      return `move(${p.speedPercent ?? 80}%)`;
    case 'act_turn_body': {
      const waitTag = Number(p.wait ?? 0) === 1 ? '(待)' : '';
      if (p.mode === 'wall_away') return `turn_body(回避${p.angle ?? 12}°)${waitTag}`;
      if (p.mode === 'turret_rel') return `turn_body(砲塔${p.angle ?? 0}°)${waitTag}`;
      return p.mode === 'enemy_rel'
        ? `turn_body(敵${p.angle ?? 0}°)${waitTag}`
        : `turn_body(${p.angle ?? 4}°)${waitTag}`;
    }
    case 'act_turn_turret': {
      const waitTag = Number(p.wait ?? 0) === 1 ? '(待)' : '';
      if (p.mode === 'body_rel') return `turn_turret(車体${p.angle ?? 0}°)${waitTag}`;
      return `turn_turret(${p.angle ?? 6}°)${waitTag}`;
    }
    case 'act_aim_enemy':
      return `aim(${p.lead ?? 'direct'})`;
    case 'act_turn_radar':
      if (p.mode === 'lock_enemy') return 'radar(lock)';
      if (p.mode === 'sweep') return `radar(±${p.angle ?? 60}°)`;
      return `radar(${p.angle ?? 14}°)`;
    case 'act_fire': {
      const waitTag = Number(p.wait ?? 0) === 1 ? '(待)' : '';
      return `fire_main("${normalizeFirePowerTier(p.power, tank.blueprint.assembly.mainGun)}")${waitTag}`;
    }
    case 'act_sub_weapon':
      return `fire_sp(残${tank.subAmmo})`;
    default:
      return `${cell.type}`;
  }
}

function getActiveEnemyDist(tank: TankRuntime, tick: number): number | null {
  if (tank.detectedEnemy && tick - tank.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS) {
    const d = Math.round(
      distanceBetween(tank.x, tank.y, tank.detectedEnemy.x, tank.detectedEnemy.y)
    );
    tank.enemyDist = d;
    tank.counters.ENEMY_DIST = d;
    return d;
  }
  tank.enemyDist = null;
  return null;
}

function computeRadarSweepDelta(tank: TankRuntime, rawHalfArc: number): number {
  const halfArc = clamp(Math.abs(rawHalfArc) > 0 ? Math.abs(rawHalfArc) : 60, 15, 175);
  let dir: 1 | -1 = tank.radarSweepDir ?? 1;
  const relRadar = normalizeAngle180(tank.radarAngle - tank.turretAngle);
  if (relRadar >= halfArc - 1) {
    dir = -1;
  } else if (relRadar <= -halfArc + 1) {
    dir = 1;
  }
  tank.radarSweepDir = dir;
  return dir * halfArc - relRadar;
}

function evaluateCondition(
  cell: GridCell,
  coordKey: string,
  tank: TankRuntime,
  tick: number,
  arena: ArenaConfig,
  projectiles: Projectile[],
  tanks: TankRuntime[],
  commands: TankTickCommands
): boolean {
  const p = cell.params;
  const coordMode = tank.blueprint.program.coordinateMode;
  const chassis = CHASSIS_SPECS[tank.blueprint.assembly.chassis];

  switch (cell.type) {
    case 'loop_while': {
      const cond = String(p.cond ?? 'enemy_not_detected');
      const val = Number(p.value ?? 60);
      if (cond === 'enemy_not_detected') {
        return !tank.detectedEnemy || tick - tank.detectedEnemy.lastSeenTick > RADAR_MEMORY_TICKS;
      }
      if (cond === 'wall_ahead') {
        const rayDist = raycastWallDistance(
          tank.x,
          tank.y,
          tank.bodyAngle,
          val + chassis.radius + 5,
          arena.width,
          arena.height,
          arena.obstacles
        );
        return rayDist <= val + chassis.radius;
      }
      if (cond === 'turret_not_aligned') {
        if (!tank.detectedEnemy || tick - tank.detectedEnemy.lastSeenTick > RADAR_MEMORY_TICKS) {
          return false;
        }
        const targetAngle =
          tank.lastAimAngle !== null &&
          tank.lastAimAngle !== undefined &&
          tank.lastAimTick !== undefined &&
          tick - tank.lastAimTick <= 2
            ? tank.lastAimAngle
            : vectorToAngle(tank.detectedEnemy.x - tank.x, tank.detectedEnemy.y - tank.y);
        return Math.abs(normalizeAngle180(targetAngle - tank.turretAngle)) > val;
      }
      if (cond === 'var_a_lt') {
        return (tank.counters['A'] ?? 0) < val;
      }
      return false;
    }
    case 'loop_for': {
      const count = tank.loopCounters[coordKey] ?? 0;
      const limit = Math.max(1, Number(p.iterations ?? 15));
      if (count < limit) {
        tank.loopCounters[coordKey] = count + 1;
        return true;
      }
      tank.loopCounters[coordKey] = 0;
      return false;
    }
    case 'cond_enemy_detected': {
      const maxAge = Number(p.maxAgeTicks ?? RADAR_MEMORY_TICKS);
      if (!tank.detectedEnemy) return false;
      return tick - tank.detectedEnemy.lastSeenTick <= maxAge;
    }
    case 'cond_enemy_dist': {
      const d = getActiveEnemyDist(tank, tick);
      if (d === null) return false;
      const op = String(p.op ?? 'lte');
      const dist = Number(p.dist ?? 300);
      return op === 'gte' ? d >= dist : d <= dist;
    }
    case 'cond_enemy_sector': {
      if (!tank.detectedEnemy || tick - tank.detectedEnemy.lastSeenTick > RADAR_MEMORY_TICKS) {
        return false;
      }
      const enemy = tank.detectedEnemy;
      const dist = distanceBetween(tank.x, tank.y, enemy.x, enemy.y);
      const maxDist = Number(p.maxDist ?? 700);
      if (dist > maxDist) return false;

      const absBearing = vectorToAngle(enemy.x - tank.x, enemy.y - tank.y);
      const rawRef = String(p.ref ?? 'turret');
      const effectiveRef =
        rawRef === 'auto' ? (coordMode === 'absolute' ? 'absolute' : 'turret') : rawRef;

      let measuredAngle = absBearing;
      if (effectiveRef === 'turret') {
        measuredAngle = normalizeAngle180(absBearing - tank.turretAngle);
      } else if (effectiveRef === 'body') {
        measuredAngle = normalizeAngle180(absBearing - tank.bodyAngle);
      }

      const centerAngle = Number(p.centerAngle ?? 0);
      const halfWidth = Number(p.halfWidth ?? 20);
      return Math.abs(normalizeAngle180(measuredAngle - centerAngle)) <= halfWidth;
    }
    // 旧壁センサー (cond_wall_ahead) は近接センサー (cond_proximity) へ移行のため無効化
    // case 'cond_wall_ahead': {
    //   const direction = String(p.direction ?? 'front');
    //   const distCheck = Number(p.dist ?? 110);
    //   if (direction === 'left_closer') {
    //     const probeMax = Math.max(distCheck, 360) + chassis.radius + 5;
    //     const leftDist = raycastWallDistance(
    //       tank.x,
    //       tank.y,
    //       tank.bodyAngle - 45,
    //       probeMax,
    //       arena.width,
    //       arena.height,
    //       arena.obstacles
    //     );
    //     const rightDist = raycastWallDistance(
    //       tank.x,
    //       tank.y,
    //       tank.bodyAngle + 45,
    //       probeMax,
    //       arena.width,
    //       arena.height,
    //       arena.obstacles
    //     );
    //     return leftDist <= rightDist;
    //   }
    //
    //   let worldAngle = tank.bodyAngle;
    //   if (direction === 'front_left') worldAngle = tank.bodyAngle - 45;
    //   else if (direction === 'front_right') worldAngle = tank.bodyAngle + 45;
    //   else if (direction === 'back') worldAngle = tank.bodyAngle + 180;
    //   else if (direction === 'left') worldAngle = tank.bodyAngle - 90;
    //   else if (direction === 'right') worldAngle = tank.bodyAngle + 90;
    //   else if (direction === 'angle') {
    //     const ang = Number(p.angle ?? 0);
    //     worldAngle = coordMode === 'absolute' ? ang : tank.bodyAngle + ang;
    //   }
    //
    //   const rayDist = raycastWallDistance(
    //     tank.x,
    //     tank.y,
    //     worldAngle,
    //     distCheck + chassis.radius + 5,
    //     arena.width,
    //     arena.height,
    //     arena.obstacles
    //   );
    //   return rayDist <= distCheck + chassis.radius;
    // }
    case 'cond_proximity': {
      const mode = String(p.mode ?? 'approaching');
      const rawTarget = String(p.target ?? 'all');
      const target: ProximityTarget =
        rawTarget === 'walls' || rawTarget === 'tanks' ? rawTarget : 'all';
      const distCheck = clamp(Number(p.dist ?? 90), 20, 300);

      const otherTanks = tanks.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        radius: CHASSIS_SPECS[t.blueprint.assembly.chassis].radius,
        hp: t.hp,
      }));

      if (mode === 'front') {
        if (target !== 'tanks') {
          const rayDist = raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle,
            distCheck + chassis.radius + 5,
            arena.width,
            arena.height,
            arena.obstacles
          );
          if (rayDist <= distCheck + chassis.radius) {
            return true;
          }
        }
        if (target !== 'walls') {
          const fwd = angleToVector(tank.bodyAngle);
          for (const ot of otherTanks) {
            if (ot.id === tank.id || ot.hp <= 0) continue;
            const dx = ot.x - tank.x;
            const dy = ot.y - tank.y;
            const along = dx * fwd.dx + dy * fwd.dy;
            if (along <= 0) continue;
            const perp = Math.abs(dx * -fwd.dy + dy * fwd.dx);
            const hitBand = chassis.radius + ot.radius;
            if (perp <= hitBand) {
              const chord = Math.sqrt(Math.max(0, hitBand * hitBand - perp * perp));
              if (along - chord <= distCheck) {
                return true;
              }
            }
          }
        }
        return false;
      }

      let approachingDir: { dx: number; dy: number; minDot?: number } | undefined;
      if (mode === 'approaching') {
        let moveSign = 1;
        if (Math.abs(tank.speed) > 0.1) {
          moveSign = tank.speed >= 0 ? 1 : -1;
        } else if (Math.abs(commands.targetSpeedRatio) > 0.01) {
          moveSign = commands.targetSpeedRatio >= 0 ? 1 : -1;
        }
        const fwd = angleToVector(tank.bodyAngle);
        approachingDir = { dx: fwd.dx * moveSign, dy: fwd.dy * moveSign, minDot: 0.05 };
      }

      const { nearestDist, nearestPoint } = scanProximity(
        { id: tank.id, x: tank.x, y: tank.y, radius: chassis.radius },
        arena.width,
        arena.height,
        arena.obstacles,
        otherTanks,
        target,
        approachingDir
      );

      if (!nearestPoint) return false;

      if (mode === 'left_open' || mode === 'right_open') {
        const sign = mode === 'left_open' ? -1 : 1;
        const sideAngle = tank.bodyAngle + sign * 90;
        const threshold = distCheck + chassis.radius;
        const sideDist = raycastWallDistance(
          tank.x,
          tank.y,
          sideAngle,
          threshold + 5,
          arena.width,
          arena.height,
          arena.obstacles
        );
        const rearDist = Math.min(
          raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle + sign * 120,
            threshold + 80,
            arena.width,
            arena.height,
            arena.obstacles
          ),
          raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle + sign * 135,
            threshold + 80,
            arena.width,
            arena.height,
            arena.obstacles
          ),
          raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle + sign * 150,
            threshold + 80,
            arena.width,
            arena.height,
            arena.obstacles
          )
        );
        // True only when the side just opened up while a wall is still behind on that side (corner passed)
        return sideDist > threshold && rearDist <= threshold + 75;
      }

      if (mode === 'left_closer') {
        if (target !== 'tanks') {
          const probeMax = Math.max(distCheck, 360) + chassis.radius + 5;
          const leftDist = raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle - 45,
            probeMax,
            arena.width,
            arena.height,
            arena.obstacles
          );
          const rightDist = raycastWallDistance(
            tank.x,
            tank.y,
            tank.bodyAngle + 45,
            probeMax,
            arena.width,
            arena.height,
            arena.obstacles
          );
          return leftDist <= rightDist;
        }
        const relAngle = normalizeAngle180(
          vectorToAngle(nearestPoint.x - tank.x, nearestPoint.y - tank.y) - tank.bodyAngle
        );
        return relAngle <= 0;
      }

      return nearestDist <= distCheck;
    }
    case 'cond_hit_from': {
      const zone = String(p.zone ?? 'any');
      const windowTicks = Math.max(1, Number(p.ticks ?? 20));
      if (tick - tank.lastAttackHitTick > windowTicks) return false;
      if (zone === 'any') return true;
      return tank.lastHitZone === zone;
    }
    case 'cond_gun_ready': {
      return tank.gunHeat <= 0.0001;
    }
    case 'cond_sub_ready': {
      return (
        tank.subCooldown <= 0 &&
        (tank.blueprint.assembly.subWeapon === 'none' || tank.subAmmo > 0)
      );
    }
    case 'cond_hp_below': {
      const threshold = Number(p.percent ?? 45);
      return (tank.hp / tank.maxHp) * 100 <= threshold;
    }
    case 'cond_counter': {
      const reg = String(p.reg ?? 'A');
      const op = String(p.op ?? 'gte');
      const val = Number(p.value ?? 60);
      let cur: number;
      if (reg === 'ENEMY_DIST') {
        const d = getActiveEnemyDist(tank, tick);
        if (d === null) return false;
        cur = d;
      } else {
        cur = tank.counters[reg] ?? 0;
      }
      if (op === 'gte') return cur >= val;
      if (op === 'lte') return cur <= val;
      if (op === 'eq') return cur === val;
      if (op === 'mod0') return val !== 0 && cur % val === 0;
      return false;
    }
    case 'cond_incoming_shell': {
      const maxDist = Number(p.maxDist ?? 220);
      for (const proj of projectiles) {
        if (proj.ownerId === tank.id) continue;
        if (arena.teamBattle) {
          const owner = tanks.find((t) => t.id === proj.ownerId);
          if (owner && owner.team === tank.team) continue;
        }
        const d = distanceBetween(proj.x, proj.y, tank.x, tank.y);
        if (d > maxDist) continue;
        const dx = tank.x - proj.x;
        const dy = tank.y - proj.y;
        const dot = dx * proj.vx + dy * proj.vy;
        if (dot <= 0) continue;
        // Closest point of approach distance
        const vLenSq = proj.vx * proj.vx + proj.vy * proj.vy;
        if (vLenSq < 1e-6) continue;
        const cross = Math.abs(dx * proj.vy - dy * proj.vx);
        const perpDist = cross / Math.sqrt(vLenSq);
        if (perpDist <= chassis.radius * 3.0) {
          return true;
        }
      }
      return false;
    }
    case 'cond_under_lock': {
      return Boolean(tank.underLock);
    }
    case 'cond_mode': {
      return tank.mode === Number(p.mode ?? 0);
    }
    case 'cond_floor_tile': {
      const target = String(p.target ?? 'goal');
      const isEdgeOnly = Number(p.edge ?? 0) === 1;
      const tiles = arena.tiles ?? [];
      let matchedTile: ArenaTile | null = null;
      for (const tile of tiles) {
        if (!isTankInsideTile(tank, tile)) continue;
        if (target === 'goal' && tile.kind === 'goal') {
          matchedTile = tile;
          break;
        }
        if (target === 'checkpoint' && tile.kind === 'checkpoint' && !tile.visited) {
          matchedTile = tile;
          break;
        }
        if (target === 'hazard' && tile.kind === 'hazard') {
          matchedTile = tile;
          break;
        }
        if (target === 'any_color' && tile.kind === 'color') {
          matchedTile = tile;
          break;
        }
        if (
          (target === 'red' || target === 'blue' || target === 'green' || target === 'yellow') &&
          tile.kind === 'color' &&
          tile.color === target
        ) {
          matchedTile = tile;
          break;
        }
      }
      if (!matchedTile) {
        if (isEdgeOnly && tank.tileEdgeState && coordKey) {
          delete tank.tileEdgeState[coordKey];
        }
        return false;
      }
      if (!isEdgeOnly) {
        return true;
      }
      if (!tank.tileEdgeState) {
        tank.tileEdgeState = {};
      }
      if (coordKey && tank.tileEdgeState[coordKey] === matchedTile.id) {
        return false;
      }
      if (coordKey) {
        tank.tileEdgeState[coordKey] = matchedTile.id;
      }
      return true;
    }
    case 'cond_mission_state': {
      const check = String(p.check ?? 'targets_remaining');
      const targetsLeft = (arena.targets ?? []).filter((t) => !t.popped).length;
      const checkpointsLeft = (arena.tiles ?? []).filter(
        (t) => t.kind === 'checkpoint' && !t.visited
      ).length;
      if (check === 'targets_remaining') return targetsLeft > 0;
      if (check === 'targets_cleared') return targetsLeft === 0;
      if (check === 'checkpoints_remaining') return checkpointsLeft > 0;
      if (check === 'checkpoints_cleared') return checkpointsLeft === 0;
      return false;
    }
    default:
      return false;
  }
}

interface TurnResolveResult {
  axis: 'body' | 'turret';
  isDelta: boolean;
  delta: number | null;
  targetAbsAngle: number;
}

function resolveBodyTurnDelta(
  p: Record<string, string | number>,
  tank: TankRuntime,
  tick: number,
  arena: ArenaConfig,
  coordMode: 'relative' | 'absolute',
  commands: TankTickCommands
): TurnResolveResult {
  const rawMode = String(p.mode ?? 'auto');
  const effectiveMode =
    rawMode === 'auto' ? (coordMode === 'absolute' ? 'heading' : 'delta') : rawMode;
  const ang = Number(p.angle ?? 0);
  if (effectiveMode === 'enemy_rel') {
    if (tank.detectedEnemy && tick - tank.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS) {
      const absBearing = vectorToAngle(
        tank.detectedEnemy.x - tank.x,
        tank.detectedEnemy.y - tank.y
      );
      const targetAbsAngle = normalizeAngle360(absBearing + ang);
      return {
        axis: 'body',
        isDelta: false,
        delta: normalizeAngle180(targetAbsAngle - tank.bodyAngle),
        targetAbsAngle,
      };
    }
    return { axis: 'body', isDelta: false, delta: null, targetAbsAngle: tank.bodyAngle };
  }
  if (effectiveMode === 'turret_rel') {
    const targetAbsAngle = normalizeAngle360(tank.turretAngle + ang);
    return {
      axis: 'body',
      isDelta: false,
      delta: normalizeAngle180(targetAbsAngle - tank.bodyAngle),
      targetAbsAngle,
    };
  }
  if (effectiveMode === 'last_hit') {
    if (tank.lastHitAngle !== null) {
      const targetAbsAngle = normalizeAngle360(tank.lastHitAngle + ang);
      return {
        axis: 'body',
        isDelta: false,
        delta: normalizeAngle180(targetAbsAngle - tank.bodyAngle),
        targetAbsAngle,
      };
    }
    return { axis: 'body', isDelta: false, delta: null, targetAbsAngle: tank.bodyAngle };
  }
  if (effectiveMode === 'wall_away') {
    const chassis = CHASSIS_SPECS[tank.blueprint.assembly.chassis];
    let moveSign = 1;
    if (Math.abs(tank.speed) > 0.1) {
      moveSign = tank.speed >= 0 ? 1 : -1;
    } else if (Math.abs(commands.targetSpeedRatio) > 0.01) {
      moveSign = commands.targetSpeedRatio >= 0 ? 1 : -1;
    }
    const moveHeading = moveSign < 0 ? tank.bodyAngle + 180 : tank.bodyAngle;
    const mag = Math.abs(ang || 12);
    const turnSign = computeWallAwayTurnSign(
      { x: tank.x, y: tank.y, radius: chassis.radius },
      moveHeading,
      arena.width,
      arena.height,
      arena.obstacles
    );
    const signedDelta = turnSign * mag;
    return {
      axis: 'body',
      isDelta: true,
      delta: signedDelta,
      targetAbsAngle: normalizeAngle360(tank.bodyAngle + signedDelta),
    };
  }
  if (effectiveMode === 'heading') {
    const targetAbsAngle = normalizeAngle360(ang);
    return {
      axis: 'body',
      isDelta: false,
      delta: normalizeAngle180(targetAbsAngle - tank.bodyAngle),
      targetAbsAngle,
    };
  }
  return {
    axis: 'body',
    isDelta: true,
    delta: ang,
    targetAbsAngle: normalizeAngle360(tank.bodyAngle + ang),
  };
}

function resolveTurretTurnDelta(
  p: Record<string, string | number>,
  tank: TankRuntime,
  coordMode: 'relative' | 'absolute'
): TurnResolveResult {
  const rawMode = String(p.mode ?? 'auto');
  const effectiveMode =
    rawMode === 'auto' ? (coordMode === 'absolute' ? 'heading' : 'delta') : rawMode;
  const ang = Number(p.angle ?? 0);
  if (effectiveMode === 'body_rel') {
    const targetAbsAngle = normalizeAngle360(tank.bodyAngle + ang);
    return {
      axis: 'turret',
      isDelta: false,
      delta: normalizeAngle180(targetAbsAngle - tank.turretAngle),
      targetAbsAngle,
    };
  }
  if (effectiveMode === 'heading') {
    const targetAbsAngle = normalizeAngle360(ang);
    return {
      axis: 'turret',
      isDelta: false,
      delta: normalizeAngle180(targetAbsAngle - tank.turretAngle),
      targetAbsAngle,
    };
  }
  return {
    axis: 'turret',
    isDelta: true,
    delta: ang,
    targetAbsAngle: normalizeAngle360(tank.turretAngle + ang),
  };
}

function executeActionCell(
  cell: GridCell,
  _coordKey: string,
  tank: TankRuntime,
  tick: number,
  arena: ArenaConfig,
  coordMode: 'relative' | 'absolute',
  gunSpeedBonus: number,
  _radarTurnRate: number,
  commands: TankTickCommands
): void {
  const p = cell.params;

  switch (cell.type) {
    case 'start':
    case 'wire':
    case 'sub_def':
    case 'sub_call':
    case 'act_halt':
      break;
    case 'counter_op': {
      const reg = String(p.reg ?? 'A');
      const op = String(p.op ?? 'inc');
      const val = Number(p.value ?? 1);
      const cur = tank.counters[reg] ?? 0;
      if (op === 'inc') tank.counters[reg] = cur + val;
      else if (op === 'dec') tank.counters[reg] = cur - val;
      else if (op === 'set') tank.counters[reg] = val;
      break;
    }
    case 'random_op': {
      const reg = String(p.reg ?? 'A');
      const rawMin = Math.trunc(Number(p.min ?? 0));
      const rawMax = Math.trunc(Number(p.max ?? 1));
      const lo = Math.min(rawMin, rawMax);
      const hi = Math.max(rawMin, rawMax);
      tank.counters[reg] = Math.floor(Math.random() * (hi - lo + 1)) + lo;
      break;
    }
    case 'mode_set': {
      tank.mode = Number(p.mode ?? 0);
      break;
    }
    case 'act_move': {
      const pct = Number(p.speedPercent ?? 80);
      commands.targetSpeedRatio = clamp(pct / 100, -1, 1);
      break;
    }
    case 'act_turn_body': {
      const resolved = resolveBodyTurnDelta(p, tank, tick, arena, coordMode, commands);
      if (resolved.delta !== null) {
        commands.bodyTurnDelta = resolved.delta;
      }
      break;
    }
    case 'act_turn_turret': {
      const resolved = resolveTurretTurnDelta(p, tank, coordMode);
      if (resolved.delta !== null) {
        commands.turretTurnDelta = resolved.delta;
      }
      break;
    }
    case 'act_aim_enemy': {
      if (tank.detectedEnemy && tick - tank.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS) {
        const enemy = tank.detectedEnemy;
        const offset = Number(p.offset ?? 0);
        let desiredAbsAngle: number;
        if (String(p.lead ?? 'direct') === 'lead') {
          const age = Math.max(0, tick - enemy.lastSeenTick);
          const velocityFreshness = age <= 8 ? 1 : Math.max(0.2, 1 - (age - 8) / 28);
          const extrapTicks = Math.min(age, 16);
          const estX = enemy.x + enemy.vx * extrapTicks;
          const estY = enemy.y + enemy.vy * extrapTicks;
          const nominalPower = commands.firePower ?? tank.lastCommands?.firePower ?? 2.0;
          const bulletSpeed = Math.max(4.5, (14.5 - 1.8 * nominalPower + gunSpeedBonus) * 0.65);
          desiredAbsAngle = calculateLeadAngle(
            tank.x,
            tank.y,
            estX,
            estY,
            enemy.vx * velocityFreshness,
            enemy.vy * velocityFreshness,
            bulletSpeed
          );
        } else {
          desiredAbsAngle = vectorToAngle(enemy.x - tank.x, enemy.y - tank.y);
        }
        const resolvedAim = normalizeAngle360(desiredAbsAngle + offset);
        tank.lastAimAngle = resolvedAim;
        tank.lastAimTick = tick;
        commands.turretTurnDelta = normalizeAngle180(resolvedAim - tank.turretAngle);
      }
      break;
    }
    case 'act_turn_radar': {
      const rawMode = String(p.mode ?? 'sweep');
      const effectiveMode =
        rawMode === 'auto' ? (coordMode === 'absolute' ? 'heading' : 'delta') : rawMode;
      const ang = Number(p.angle ?? 60);
      if (effectiveMode === 'sweep') {
        commands.radarTurnDelta = computeRadarSweepDelta(tank, ang);
      } else if (effectiveMode === 'lock_enemy') {
        if (tank.detectedEnemy && tick - tank.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS) {
          const absBearing = vectorToAngle(
            tank.detectedEnemy.x - tank.x,
            tank.detectedEnemy.y - tank.y
          );
          commands.radarTurnDelta = normalizeAngle180(absBearing - tank.radarAngle);
        } else {
          commands.radarTurnDelta = computeRadarSweepDelta(tank, 60);
        }
      } else if (effectiveMode === 'last_hit') {
        if (tank.lastHitAngle !== null) {
          commands.radarTurnDelta = normalizeAngle180(tank.lastHitAngle - tank.radarAngle);
        } else {
          commands.radarTurnDelta = computeRadarSweepDelta(tank, ang);
        }
      } else if (effectiveMode === 'heading') {
        commands.radarTurnDelta = normalizeAngle180(ang - tank.radarAngle);
      } else {
        commands.radarTurnDelta = ang;
      }
      break;
    }
    case 'act_fire': {
      commands.firePower = resolveFirePower(p.power, tank.blueprint.assembly.mainGun).power;
      break;
    }
    case 'act_sub_weapon': {
      commands.useSubWeapon = true;
      break;
    }
  }
}
