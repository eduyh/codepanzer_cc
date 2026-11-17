import { CHIP_DEFINITIONS } from '../data/chips';
import { CHASSIS_SPECS, CPU_SPECS, MAIN_GUN_SPECS, RADAR_MEMORY_TICKS, RADAR_SPECS } from '../data/parts';
import {
  ArenaConfig,
  ExecutionEdge,
  ExecutionTrace,
  GridCell,
  GridCoord,
  Projectile,
  TankRuntime,
  TankTickCommands,
} from '../types/game';
import {
  calculateLeadAngle,
  clamp,
  distanceBetween,
  normalizeAngle180,
  raycastWallDistance,
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
  projectiles: Projectile[]
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

  if (!startCoord) {
    return {
      commands,
      trace: { visited, edges, stepsUsed: 0, truncated: false },
    };
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

  // Resume active time.sleep() if still waiting across ticks
  if (tank.sleepState) {
    const sleepCoord = tank.sleepState.coord;
    const sleepCell = program.cells[sleepCoord.y]?.[sleepCoord.x];
    if (!sleepCell || sleepCell.type !== 'wire') {
      tank.sleepState = null;
    } else {
      visited.push({ x: sleepCoord.x, y: sleepCoord.y });
      steps += 1;
      tank.sleepState.remainingTicks -= 1;
      if (tank.sleepState.remainingTicks > 0) {
        return {
          commands,
          trace: { visited, edges, stepsUsed: steps, truncated: false },
        };
      }
      if (tank.sleepState.callStack && tank.sleepState.callStack.length > 0) {
        callStack = tank.sleepState.callStack.map((f) => ({
          returnCoord: f.returnCoord ? { ...f.returnCoord } : null,
          callerCoord: { ...f.callerCoord },
          subKey: f.subKey,
        }));
      }
      tank.sleepState = null;
      const resumeNext = sleepCell.next ?? null;
      if (isValidOrthoTransition(sleepCoord, resumeNext, program.cells)) {
        edges.push({
          from: { x: sleepCoord.x, y: sleepCoord.y },
          to: { x: resumeNext.x, y: resumeNext.y },
          branch: 'next',
        });
        current = resumeNext;
      } else {
        current = unwindCallStack();
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
      const result = evaluateCondition(cell, coordKey, tank, tick, arena, projectiles);
      if (Number(cell.params._print ?? 0) === 1 && cell.type !== 'start') {
        pushPrintOutput(formatChipDebugPrint(cell, tank, result, coordKey));
      }
      branch = result ? 'yes' : 'no';
      nextCoord = result ? cell.yes ?? null : cell.no ?? null;

      if (cell.type === 'loop_while' && String(cell.params.cond ?? '') === 'var_a_lt') {
        activeInTickLoopCoord = result ? { x: current.x, y: current.y } : null;
      }
    } else if (cell.type === 'sub_call') {
      if (Number(cell.params._print ?? 0) === 1) {
        pushPrintOutput(formatChipDebugPrint(cell, tank));
      }
      const subKey = String(cell.params.sub ?? 'A').trim().toUpperCase();
      const rawNext = cell.next ?? null;
      const returnCoord = isValidOrthoTransition(current, rawNext, program.cells)
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
            ...(callStack.length > 0
              ? {
                  callStack: callStack.map((f) => ({
                    returnCoord: f.returnCoord ? { ...f.returnCoord } : null,
                    callerCoord: { ...f.callerCoord },
                    subKey: f.subKey,
                  })),
                }
              : {}),
          };
          if (Number(cell.params._print ?? 0) === 1) {
            pushPrintOutput(formatChipDebugPrint(cell, tank));
          }
          break;
        }
      }
      executeActionCell(
        cell,
        tank,
        tick,
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
    case 'act_move':
      return `move(${p.speedPercent ?? 80}%)`;
    case 'act_turn_body':
      if (p.mode === 'turret_rel') return `turn_body(砲塔${p.angle ?? 0}°)`;
      return p.mode === 'enemy_rel'
        ? `turn_body(敵${p.angle ?? 0}°)`
        : `turn_body(${p.angle ?? 4}°)`;
    case 'act_turn_turret':
      if (p.mode === 'body_rel') return `turn_turret(車体${p.angle ?? 0}°)`;
      return `turn_turret(${p.angle ?? 6}°)`;
    case 'act_aim_enemy':
      return `aim(${p.lead ?? 'direct'})`;
    case 'act_turn_radar':
      if (p.mode === 'lock_enemy') return 'radar(lock)';
      if (p.mode === 'sweep') return `radar(±${p.angle ?? 60}°)`;
      return `radar(${p.angle ?? 14}°)`;
    case 'act_fire':
      return `fire_main(${p.power ?? 2.0})`;
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
  projectiles: Projectile[]
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
        const absBearing = vectorToAngle(
          tank.detectedEnemy.x - tank.x,
          tank.detectedEnemy.y - tank.y
        );
        return Math.abs(normalizeAngle180(absBearing - tank.turretAngle)) > val;
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
    case 'cond_wall_ahead': {
      const direction = String(p.direction ?? 'front');
      const distCheck = Number(p.dist ?? 110);
      if (direction === 'left_closer') {
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

      let worldAngle = tank.bodyAngle;
      if (direction === 'front_left') worldAngle = tank.bodyAngle - 45;
      else if (direction === 'front_right') worldAngle = tank.bodyAngle + 45;
      else if (direction === 'back') worldAngle = tank.bodyAngle + 180;
      else if (direction === 'left') worldAngle = tank.bodyAngle - 90;
      else if (direction === 'right') worldAngle = tank.bodyAngle + 90;
      else if (direction === 'angle') {
        const ang = Number(p.angle ?? 0);
        worldAngle = coordMode === 'absolute' ? ang : tank.bodyAngle + ang;
      }

      const rayDist = raycastWallDistance(
        tank.x,
        tank.y,
        worldAngle,
        distCheck + chassis.radius + 5,
        arena.width,
        arena.height,
        arena.obstacles
      );
      return rayDist <= distCheck + chassis.radius;
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
    default:
      return false;
  }
}

function executeActionCell(
  cell: GridCell,
  tank: TankRuntime,
  tick: number,
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
          commands.bodyTurnDelta = normalizeAngle180(absBearing + ang - tank.bodyAngle);
        }
      } else if (effectiveMode === 'turret_rel') {
        commands.bodyTurnDelta = normalizeAngle180(tank.turretAngle + ang - tank.bodyAngle);
      } else if (effectiveMode === 'heading') {
        commands.bodyTurnDelta = normalizeAngle180(ang - tank.bodyAngle);
      } else {
        commands.bodyTurnDelta = ang;
      }
      break;
    }
    case 'act_turn_turret': {
      const rawMode = String(p.mode ?? 'auto');
      const effectiveMode =
        rawMode === 'auto' ? (coordMode === 'absolute' ? 'heading' : 'delta') : rawMode;
      const ang = Number(p.angle ?? 0);
      if (effectiveMode === 'body_rel') {
        commands.turretTurnDelta = normalizeAngle180(tank.bodyAngle + ang - tank.turretAngle);
      } else if (effectiveMode === 'heading') {
        commands.turretTurnDelta = normalizeAngle180(ang - tank.turretAngle);
      } else {
        commands.turretTurnDelta = ang;
      }
      break;
    }
    case 'act_aim_enemy': {
      if (tank.detectedEnemy && tick - tank.detectedEnemy.lastSeenTick <= RADAR_MEMORY_TICKS) {
        const enemy = tank.detectedEnemy;
        const offset = Number(p.offset ?? 0);
        let desiredAbsAngle: number;
        if (String(p.lead ?? 'direct') === 'lead') {
          const nominalPower = commands.firePower ?? 2.0;
          const bulletSpeed = Math.max(4.5, (14.5 - 1.8 * nominalPower + gunSpeedBonus) * 0.65);
          desiredAbsAngle = calculateLeadAngle(
            tank.x,
            tank.y,
            enemy.x,
            enemy.y,
            enemy.vx,
            enemy.vy,
            bulletSpeed
          );
        } else {
          desiredAbsAngle = vectorToAngle(enemy.x - tank.x, enemy.y - tank.y);
        }
        commands.turretTurnDelta = normalizeAngle180(desiredAbsAngle + offset - tank.turretAngle);
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
      } else if (effectiveMode === 'heading') {
        commands.radarTurnDelta = normalizeAngle180(ang - tank.radarAngle);
      } else {
        commands.radarTurnDelta = ang;
      }
      break;
    }
    case 'act_fire': {
      commands.firePower = Number(p.power ?? 2.0);
      break;
    }
    case 'act_sub_weapon': {
      commands.useSubWeapon = true;
      break;
    }
  }
}
