import { ArenaObstacle } from '../types/game';

/**
 * Angle convention across 2D simulation and 3D Three.js scene:
 * 0 deg   = North (2D: -Y, 3D: -Z)
 * 90 deg  = East  (2D: +X, 3D: +X)
 * 180 deg = South (2D: +Y, 3D: +Z)
 * 270 deg = West  (2D: -X, 3D: -X)
 */

export function normalizeAngle360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function normalizeAngle180(deg: number): number {
  let a = normalizeAngle360(deg);
  if (a > 180) a -= 360;
  return a;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function angleToVector(deg: number): { dx: number; dy: number } {
  const rad = degToRad(deg);
  return {
    dx: Math.sin(rad),
    dy: -Math.cos(rad),
  };
}

export function vectorToAngle(dx: number, dy: number): number {
  // 0° = (0, -1), 90° = (1, 0)
  return normalizeAngle360(radToDeg(Math.atan2(dx, -dy)));
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function distanceBetween(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Compute predictive lead angle for a projectile of speed `bulletSpeed`
 * fired from (sx, sy) toward target at (tx, ty) moving with (tvx, tvy).
 */
export function calculateLeadAngle(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  tvx: number,
  tvy: number,
  bulletSpeed: number
): number {
  const dx = tx - sx;
  const dy = ty - sy;
  const a = tvx * tvx + tvy * tvy - bulletSpeed * bulletSpeed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;

  let t = 0;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) {
      t = Math.max(0, -c / b);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtD = Math.sqrt(disc);
      const t1 = (-b - sqrtD) / (2 * a);
      const t2 = (-b + sqrtD) / (2 * a);
      const positives = [t1, t2].filter((v) => v > 0);
      if (positives.length > 0) {
        t = Math.min(...positives);
      }
    }
  }

  if (t <= 0) {
    t = Math.hypot(dx, dy) / Math.max(1, bulletSpeed);
  }
  // Clamp lead time to reasonable horizon
  t = Math.min(t, 120);
  const predX = tx + tvx * t;
  const predY = ty + tvy * t;
  return vectorToAngle(predX - sx, predY - sy);
}

/**
 * Ray-AABB intersection test for segment from (x1, y1) to (x2, y2).
 */
export function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: ArenaObstacle
): boolean {
  const minX = rect.x;
  const maxX = rect.x + rect.width;
  const minY = rect.y;
  const maxY = rect.y + rect.height;

  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;

  const p = [-dx, dx, -dy, dy];
  const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-8) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

export function segmentIntersectsCircle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  radius: number
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) {
    return (cx - x1) ** 2 + (cy - y1) ** 2 <= radius * radius;
  }
  const t = clamp(((cx - x1) * dx + (cy - y1) * dy) / lenSq, 0, 1);
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return (cx - px) ** 2 + (cy - py) ** 2 <= radius * radius;
}

export function hasLineOfSight(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles: ArenaObstacle[],
  smokes: Array<{ x: number; y: number; radius: number }> = []
): boolean {
  for (const obs of obstacles) {
    if (segmentIntersectsRect(x1, y1, x2, y2, obs)) {
      return false;
    }
  }
  for (const smoke of smokes) {
    if (segmentIntersectsCircle(x1, y1, x2, y2, smoke.x, smoke.y, smoke.radius)) {
      return false;
    }
  }
  return true;
}

/**
 * Raycast distance from (ox, oy) along angle `angleDeg` up to `maxDist`
 * against arena walls and obstacles.
 */
export function raycastWallDistance(
  ox: number,
  oy: number,
  angleDeg: number,
  maxDist: number,
  arenaWidth: number,
  arenaHeight: number,
  obstacles: ArenaObstacle[]
): number {
  const { dx, dy } = angleToVector(angleDeg);
  let best = maxDist;

  // Arena bounds
  if (dx > 1e-6) best = Math.min(best, (arenaWidth - ox) / dx);
  else if (dx < -1e-6) best = Math.min(best, (0 - ox) / dx);

  if (dy > 1e-6) best = Math.min(best, (arenaHeight - oy) / dy);
  else if (dy < -1e-6) best = Math.min(best, (0 - oy) / dy);

  // Obstacles (slab method)
  for (const obs of obstacles) {
    const minX = obs.x;
    const maxX = obs.x + obs.width;
    const minY = obs.y;
    const maxY = obs.y + obs.height;

    let tmin = 0;
    let tmax = best;

    if (Math.abs(dx) < 1e-8) {
      if (ox < minX || ox > maxX) continue;
    } else {
      let tx1 = (minX - ox) / dx;
      let tx2 = (maxX - ox) / dx;
      if (tx1 > tx2) [tx1, tx2] = [tx2, tx1];
      tmin = Math.max(tmin, tx1);
      tmax = Math.min(tmax, tx2);
      if (tmin > tmax) continue;
    }

    if (Math.abs(dy) < 1e-8) {
      if (oy < minY || oy > maxY) continue;
    } else {
      let ty1 = (minY - oy) / dy;
      let ty2 = (maxY - oy) / dy;
      if (ty1 > ty2) [ty1, ty2] = [ty2, ty1];
      tmin = Math.max(tmin, ty1);
      tmax = Math.min(tmax, ty2);
      if (tmin > tmax) continue;
    }

    if (tmin >= 0 && tmin < best) {
      best = tmin;
    }
  }

  return Math.max(0, best);
}

export function circleIntersectsRect(
  cx: number,
  cy: number,
  radius: number,
  rect: ArenaObstacle
): boolean {
  const closestX = clamp(cx, rect.x, rect.x + rect.width);
  const closestY = clamp(cy, rect.y, rect.y + rect.height);
  const distSq = (cx - closestX) ** 2 + (cy - closestY) ** 2;
  return distSq < radius * radius;
}

export type ProximityTarget = 'all' | 'walls' | 'tanks';

export interface ProximityScanResult {
  nearestDist: number;
  nearestPoint: { x: number; y: number } | null;
}

/**
 * 360-degree proximity scan around a circular tank against arena bounds,
 * rectangular obstacles, and other active tanks.
 * Returns surface-to-surface clearance distance (>= 0) and nearest point.
 */
export function scanProximity(
  tank: { id: string; x: number; y: number; radius: number },
  arenaWidth: number,
  arenaHeight: number,
  obstacles: ArenaObstacle[],
  otherTanks: Array<{ id: string; x: number; y: number; radius: number; hp: number }>,
  target: ProximityTarget = 'all',
  approachingDir?: { dx: number; dy: number; minDot?: number }
): ProximityScanResult {
  let nearestDist = Infinity;
  let nearestPoint: { x: number; y: number } | null = null;
  const minDot = approachingDir?.minDot ?? 0.72;

  const considerPoint = (px: number, py: number, clearance: number) => {
    const c = Math.max(0, clearance);
    if (approachingDir) {
      const tx = px - tank.x;
      const ty = py - tank.y;
      const tLen = Math.hypot(tx, ty);
      if (tLen > 1e-6) {
        const dot = (approachingDir.dx * tx + approachingDir.dy * ty) / tLen;
        if (dot <= minDot) return;
      }
    }
    if (c < nearestDist) {
      nearestDist = c;
      nearestPoint = { x: px, y: py };
    }
  };

  if (target !== 'tanks') {
    // Arena outer walls
    considerPoint(0, tank.y, tank.x - tank.radius);
    considerPoint(arenaWidth, tank.y, arenaWidth - tank.x - tank.radius);
    considerPoint(tank.x, 0, tank.y - tank.radius);
    considerPoint(tank.x, arenaHeight, arenaHeight - tank.y - tank.radius);

    // Rectangular obstacles
    for (const obs of obstacles) {
      const cx = clamp(tank.x, obs.x, obs.x + obs.width);
      const cy = clamp(tank.y, obs.y, obs.y + obs.height);
      const d = Math.hypot(tank.x - cx, tank.y - cy);
      considerPoint(cx, cy, d - tank.radius);
    }
  }

  if (target !== 'walls') {
    for (const other of otherTanks) {
      if (other.id === tank.id || other.hp <= 0) continue;
      const d = Math.hypot(other.x - tank.x, other.y - tank.y);
      considerPoint(other.x, other.y, d - (tank.radius + other.radius));
    }
  }

  return { nearestDist, nearestPoint };
}

