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
  | 'act_halt'
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
  | 'cond_floor_tile'
  | 'cond_mission_state'
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
  type: 'number' | 'select' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string | number; label: string; labelEn?: string }[];
  unit?: string;
}

export interface ChipDefinition {
  type: ChipType;
  category: ChipCategory;
  learningOnly?: boolean;
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
  version: number;
  gameVersion?: string;
  id: string;
  name: string;
  author?: string;
  authorUuid?: string;
  color: string;
  assembly: TankAssembly;
  program: ChipProgram;
}

export interface UserProfile {
  userName: string;
  userId: string;
}

export type UiFontScale = 'normal' | 'large' | 'xlarge';

export type ClearUnitId = 'L1' | 'L2' | 'L3' | 'L4' | 'T1' | 'T2' | 'T3' | 'T4';

export interface StageClearTelemetry {
  stageId: string;
  clearedAt: string;
  clearTicks: number;
  blockCount: number;
  usedModelAnswer: boolean;
  programFingerprint: number; // 0..999
}

export interface LearningAttemptRecord {
  missionId: string;
  failedFingerprints: number[];
  openedModelAnswer: boolean;
}

export interface DecodedClearCode {
  valid: boolean;
  rawCode: string;
  uuidHex: string; // 32 uppercase hex chars
  formattedUuid: string; // 8-4-4-4-12 lowercase uuid
  unitCode: number; // 11..14 or 21..24
  unitId: ClearUnitId | null;
  unitLabel: string;
  totalStages: number;
  selfClearedStages: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  gameVersion: string;
  totalClearSeconds: number;
  programFingerprint: number;
}

export interface UserEnvironmentDump {
  version: number;
  gameVersion?: string;
  exportedAt: string;
  userProfile: UserProfile;
  currentBlueprint?: TankBlueprint;
  savedBlueprints: TankBlueprint[];
  learningClears: string[];
  tutorialClears: string[];
  clearTelemetry?: Record<string, StageClearTelemetry>;
  learningAttempts?: Record<string, LearningAttemptRecord>;
  uiSettings?: {
    fontScale?: UiFontScale;
  };
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
  kills?: number;
  eliminatedAtTick?: number | null;
  ruleScore?: number;
}

export interface TankRuntime {
  id: string;
  team: 'player' | 'enemy';
  teamId?: string;
  playerName?: string;
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
  lastAimAngle?: number | null;
  lastAimTick?: number;
  wallHitCooldown: number;
  outerWallBounceCooldown?: number;
  lastTankCollisionTick?: number;
  lastCollidedTankId?: string | null;
  tankCollisionStreak?: number;
  lastCollisionImpactSpeed?: number;
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
  turnState?: {
    coord: GridCoord;
    axis: 'body' | 'turret';
    isDelta: boolean;
    targetAbsAngle: number;
    remainingDelta: number;
    lastAngle: number;
    remainingTicks: number;
    callStack?: Array<{
      returnCoord: GridCoord | null;
      callerCoord: GridCoord;
      subKey: string;
    }>;
  } | null;
  fireState?: {
    coord: GridCoord;
    firePower: number;
    remainingTicks: number;
    callStack?: Array<{
      returnCoord: GridCoord | null;
      callerCoord: GridCoord;
      subKey: string;
    }>;
  } | null;
  halted?: boolean;
  tileEdgeState?: Record<string, string>;
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

export type FloorTileKind = 'goal' | 'checkpoint' | 'color' | 'hazard' | 'slow' | 'no_weapon';
export type FloorTileColor = 'red' | 'blue' | 'green' | 'yellow';
export type OuterWallMode = 'normal' | 'bounce' | 'damage' | 'damage_bounce';

export interface ArenaTile {
  id: string;
  kind: FloorTileKind;
  color?: FloorTileColor;
  x: number;
  y: number;
  width: number;
  height: number;
  visited?: boolean;
  order?: number;
}

export interface ArenaTarget {
  id: string;
  kind: 'shoot_balloon' | 'ram_balloon';
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  radius: number;
  hp: number;
  maxHp: number;
  popped?: boolean;
  color?: string;
  label?: string;
  points?: number;
  patrol?: {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    speed: number;
    dir?: 1 | -1;
  };
}

export interface LearningGoalRule {
  reachGoalTile?: boolean;
  requireStop?: boolean;
  requireAllCheckpoints?: boolean;
  requireAllTargetsPopped?: boolean;
  requireEnemiesDefeated?: boolean;
  maxWallHits?: number;
}

export type ArenaSizeId = 'tiny' | 'small' | 'medium' | 'large';

export interface ArenaConfig {
  sizeId?: ArenaSizeId;
  width: number;
  height: number;
  maxTicks: number;
  obstacles: ArenaObstacle[];
  tiles?: ArenaTile[];
  targets?: ArenaTarget[];
  learningRule?: LearningGoalRule;
  teamBattle?: boolean;
  multiTeamMode?: boolean;
  disableWeapons?: boolean;
  disableSubWeapons?: boolean;
  outerWallMode?: OuterWallMode;
  gravitySpeedMult?: number;
  radarRangeMult?: number;
  ruleId?: string;
  radarTargetMode?: 'default' | 'targets_only' | 'ball_only';
  disableTankDamage?: boolean;
  tankBounceMult?: number;
  allowBalloonRamPop?: boolean;
  continueUntilTimeout?: boolean;
  scoreOnlyVictory?: boolean;
}

export interface TerritoryGridState {
  cols: number;
  rows: number;
  owners: Array<string | null>;
  blocked: boolean[];
  teamColors: Record<string, string>;
  teamLabels: Record<string, string>;
  version: number;
}

export interface FootballState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  lastTouchTankId: string | null;
  lastTouchTeamId: string | null;
  westTeamId: string;
  eastTeamId: string;
  westTeamLabel: string;
  eastTeamLabel: string;
  westTeamColor: string;
  eastTeamColor: string;
  kickoffFreezeTicks: number;
  kickoffSeed: number;
  kickoffCount: number;
  pendingKickoffReset?: boolean;
  kickoffSpawns: Record<string, { x: number; y: number; bodyAngle: number }>;
  lastGoalBanner?: { teamId: string; teamLabel: string; color: string; tick: number } | null;
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
  teamId?: string;
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
  territoryGrid?: TerritoryGridState;
  football?: FootballState;
  ruleTeamScores?: Record<string, number>;
  ruleTeamLabels?: Record<string, string>;
  ruleTeamColors?: Record<string, string>;
  status: 'running' | 'finished';
  winnerId: string | null;
  winType?: 'elimination' | 'decision' | 'draw' | 'defeat' | 'mission' | null;
  endReason: string | null;
}

export interface LearningArenaVariant {
  id: string;
  label: string;
  arenaSize?: ArenaSizeId;
  obstacles: ArenaObstacle[];
  tiles?: ArenaTile[];
  targets?: ArenaTarget[];
  playerSpawn?: SpawnPoint;
  enemies?: TankBlueprint[];
  enemySpawns?: SpawnPoint[];
}

export interface LearningMission {
  id: string;
  lessonNumber: 1 | 2 | 3 | 4;
  missionCode: string;
  title: string;
  subtitle: string;
  description: string;
  goalDescription: string;
  hints: string[];
  arenaSize: ArenaSizeId;
  obstacles: ArenaObstacle[];
  tiles?: ArenaTile[];
  targets?: ArenaTarget[];
  variants?: LearningArenaVariant[];
  maxTicks: number;
  playerSpawn: SpawnPoint;
  playerStarter: TankBlueprint;
  goalRule: LearningGoalRule;
  allowedChips: ChipType[];
  enemies?: TankBlueprint[];
  enemySpawns?: SpawnPoint[];
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
  section?: 1 | 2 | 3 | 4;
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

