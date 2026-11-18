export type ChassisId = 'light' | 'standard' | 'heavy' | 'destroyer';
export type MainGunId = 'rapid' | 'standard' | 'cannon';
export type RadarId = 'wide' | 'balanced' | 'long';
export type GridSize = 4 | 6 | 8 | 12;
export const ALLOWED_GRID_SIZES: GridSize[] = [4, 6, 8, 12];
export type CpuId = 'mini_4x4' | 'compact_6x6' | 'standard_8x8' | 'large_12x12';
export type SubWeaponId = 'none' | 'missile' | 'mine' | 'shield' | 'smoke' | 'boost' | 'decoy';

export type CoordinateMode = 'relative' | 'absolute';
export type ObstacleMode = 'none' | 'few' | 'many' | 'maze';

export interface TankAssembly {
  chassis: ChassisId;
  mainGun: MainGunId;
  radar: RadarId;
  cpu: CpuId;
  subWeapon: SubWeaponId;
}

export interface ChassisSpec {
  id: ChassisId;
  name: string;
  description: string;
  weightLimit: number;
  baseWeight: number;
  maxHp: number;
  maxSpeed: number; // px per tick
  accel: number; // px per tick^2
  turnRate: number; // deg per tick at 0 speed
  radius: number; // collision radius
  fixedTurret?: boolean; // turret locked to hull front
  coolingMultiplier?: number; // multiplier applied to main gun coolingRate
}

export type FirePowerTier = 'fast' | 'normal' | 'heavy';

export interface MainGunSpec {
  id: MainGunId;
  name: string;
  description: string;
  weight: number;
  minPower: number;
  maxPower: number;
  powerTiers: Record<FirePowerTier, number>;
  speedBonus: number;
  damageMultiplier: number;
  coolingRate: number; // heat cooled per tick
  turretTurnRate: number; // deg per tick
}

export interface RadarSpec {
  id: RadarId;
  name: string;
  description: string;
  weight: number;
  fovDeg: number; // total cone angle in degrees
  range: number; // px
  turnRate: number; // deg per tick
}

export interface CpuSpec {
  id: CpuId;
  name: string;
  description: string;
  weight: number;
  gridSize: GridSize;
  maxStepsPerTick: number;
}

export interface SubWeaponSpec {
  id: SubWeaponId;
  name: string;
  description: string;
  weight: number;
  maxAmmo: number;
  cooldownTicks: number;
}

export interface GridCoord {
  x: number;
  y: number;
}

export type ChipCategory = 'flow' | 'condition' | 'action' | 'sub';

export type ChipType =
  | 'start'
  | 'wire'
  | 'sub_def'
  | 'sub_call'
  | 'loop_while'
  | 'loop_for'
  | 'counter_op'
  | 'random_op'
  | 'mode_set'
  | 'cond_enemy_detected'
  | 'cond_enemy_dist'
  | 'cond_enemy_sector'
  | 'cond_wall_ahead'
  | 'cond_proximity'
  | 'cond_hit_from'
  | 'cond_gun_ready'
  | 'cond_sub_ready'
  | 'cond_hp_below'
  | 'cond_counter'
  | 'cond_incoming_shell'
  | 'cond_under_lock'
  | 'cond_mode'
  | 'act_move'
  | 'act_turn_body'
  | 'act_turn_turret'
  | 'act_aim_enemy'
  | 'act_turn_radar'
  | 'act_fire'
  | 'act_sub_weapon';

export type DisplayLang = 'en' | 'ja';

export interface ChipParamField {
  key: string;
  label: string;
  labelEn: string;
  type: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string; labelEn?: string }[];
  unit?: string;
}

export interface ChipDefinition {
  type: ChipType;
  category: ChipCategory;
  name: string;
  nameEn: string;
  shortLabel: string;
  shortLabelEn: string;
  description: string;
  pythonSyntax: string;
  conceptTag: string;
  signatureInfo: string;
  learningTip: string;
  isCondition: boolean;
  defaultParams: Record<string, string | number>;
  paramSchema: ChipParamField[];
}

export interface GridCell {
  id: string;
  type: ChipType;
  params: Record<string, string | number>;
  next?: GridCoord | null;
  yes?: GridCoord | null;
  no?: GridCoord | null;
}

export interface ChipProgram {
  gridSize: GridSize;
  coordinateMode: CoordinateMode;
  cells: (GridCell | null)[][];
}

export interface TankBlueprint {
  version: 1;
  id: string;
  name: string;
  author?: string;
  color: string;
  assembly: TankAssembly;
  program: ChipProgram;
}

export interface ExecutionEdge {
  from: GridCoord;
  to: GridCoord;
  branch: 'next' | 'yes' | 'no';
}

export interface ExecutionTrace {
  visited: GridCoord[];
  edges: ExecutionEdge[];
  stepsUsed: number;
  truncated: boolean;
  printOutputs?: string[];
}

export interface DetectedTarget {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  heading: number;
  distance: number;
  bearingFromBody: number; // -180..180
  bearingFromTurret: number; // -180..180
  absoluteBearing: number; // 0..360 (North=0)
  hp: number;
  lastSeenTick: number;
}

export interface TankTickCommands {
  targetSpeedRatio: number; // -1.0 .. 1.0
  bodyTurnDelta: number; // degrees requested this tick
  turretTurnDelta: number; // degrees requested this tick
  radarTurnDelta: number; // degrees requested this tick
  firePower: number | null;
  useSubWeapon: boolean;
}

export interface TankStats {
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  damageTaken: number;
  wallHits: number;
}

export interface TankRuntime {
  id: string;
  team: 'player' | 'enemy';
  blueprint: TankBlueprint;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  bodyAngle: number;
  turretAngle: number;
  radarAngle: number;
  hp: number;
  maxHp: number;
  gunHeat: number;
  subAmmo: number;
  subCooldown: number;
  shieldTicks: number;
  boostTicks: number;
  recoil: number;
  radarLock: boolean;
  radarSweepDir?: 1 | -1;
  underLock?: boolean;
  detectedEnemy: DetectedTarget | null;
  enemyDist: number | null;
  lastHitTick: number;
  lastAttackHitTick: number;
  lastHitAngle: number | null;
  wallHitCooldown: number;
  lastHitZone?: 'front' | 'side' | 'rear';
  killedById?: string | null;
  counters: Record<string, number>;
  loopCounters: Record<string, number>;
  loopStack?: Array<{
    coord: GridCoord;
    callStack?: Array<{
      returnCoord: GridCoord | null;
      callerCoord: GridCoord;
      subKey: string;
    }>;
  }>;
  moveState?: {
    coord: GridCoord;
    speedRatio: number;
    remainingTicks: number;
    callStack?: Array<{
      returnCoord: GridCoord | null;
      callerCoord: GridCoord;
      subKey: string;
    }>;
  } | null;
  sleepState?: {
    coord: GridCoord;
    remainingTicks: number;
    callStack?: Array<{
      returnCoord: GridCoord | null;
      callerCoord: GridCoord;
      subKey: string;
    }>;
  } | null;
  activePrintSpeech?: { lines: string[]; tick: number } | null;
  mode: number;
  trace: ExecutionTrace;
  lastCommands: TankTickCommands;
  stats: TankStats;
}

export interface Projectile {
  id: string;
  ownerId: string;
  kind: 'shell' | 'missile';
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  speed: number;
  power: number;
  damage: number;
  color: string;
  ttl: number;
}

export interface Mine {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  armTicks: number;
  ttl: number;
  damage: number;
  color: string;
}

export interface BattleExplosion {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  age: number;
  maxAge: number;
}

export interface ArenaObstacle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ArenaSizeId = 'tiny' | 'small' | 'medium' | 'large';

export interface ArenaConfig {
  sizeId?: ArenaSizeId;
  width: number;
  height: number;
  maxTicks: number;
  obstacles: ArenaObstacle[];
  teamBattle?: boolean;
}

export interface SmokeCloud {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  radius: number;
  ttl: number;
  maxTtl: number;
}

export interface DecoyEntity {
  id: string;
  ownerId: string;
  team: 'player' | 'enemy';
  x: number;
  y: number;
  radius: number;
  hp: number;
  ttl: number;
  maxTtl: number;
  color: string;
}

export interface BattleState {
  tick: number;
  arena: ArenaConfig;
  tanks: TankRuntime[];
  projectiles: Projectile[];
  mines: Mine[];
  smokes?: SmokeCloud[];
  decoys?: DecoyEntity[];
  explosions: BattleExplosion[];
  status: 'running' | 'finished';
  winnerId: string | null;
  winType?: 'elimination' | 'decision' | 'draw' | 'defeat' | null;
  endReason: string | null;
}

export interface SpawnPoint {
  x: number;
  y: number;
  bodyAngle: number;
  turretAngle?: number;
  radarAngle?: number;
}

export interface TutorialStage {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  description: string;
  goalDescription: string;
  hints: string[];
  arenaSize?: ArenaSizeId;
  obstacles: ArenaObstacle[];
  maxTicks?: number;
  playerSpawn: SpawnPoint;
  enemySpawn: SpawnPoint;
  playerStarter: TankBlueprint;
  enemy: TankBlueprint;
  enemies?: TankBlueprint[];
  enemySpawns?: SpawnPoint[];
  enemyHpScale?: number;
  allowedChips?: ChipType[];
}

export type CameraMode = 'tactical' | 'chase_p1' | 'chase_p2' | 'orbit';

