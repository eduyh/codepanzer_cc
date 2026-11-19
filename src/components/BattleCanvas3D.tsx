import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CHASSIS_SPECS, RADAR_SPECS } from '../data/parts';
import { angleToVector, degToRad } from '../engine/math';
import { ArenaTile, BattleState, CameraMode, OuterWallMode, TankRuntime } from '../types/game';

function resolveTileColors(tile: ArenaTile): { fill: number; border: number; hex: string; label?: string } {
  if (tile.kind === 'goal') {
    return { fill: 0x06b6d4, border: 0x67e8f9, hex: '#06b6d4', label: 'GOAL' };
  }
  if (tile.kind === 'checkpoint') {
    return tile.visited
      ? { fill: 0x334155, border: 0x4ade80, hex: '#475569', label: 'OK' }
      : { fill: 0xf59e0b, border: 0xfde047, hex: '#f59e0b', label: tile.order ? `CP${tile.order}` : 'CP' };
  }
  if (tile.kind === 'hazard') {
    return { fill: 0xdc2626, border: 0xf97316, hex: '#ef4444', label: '!' };
  }
  if (tile.kind === 'slow') {
    return { fill: 0xb45309, border: 0xfbbf24, hex: '#b45309', label: 'SLOW' };
  }
  if (tile.kind === 'no_weapon') {
    return { fill: 0x6d28d9, border: 0xc084fc, hex: '#7c3aed', label: 'NO FIRE' };
  }
  switch (tile.color) {
    case 'blue':
      return { fill: 0x1d4ed8, border: 0x60a5fa, hex: '#1d4ed8' };
    case 'green':
      return { fill: 0x22c55e, border: 0x4ade80, hex: '#22c55e' };
    case 'yellow':
      return { fill: 0xeab308, border: 0xfacc15, hex: '#eab308' };
    default:
      return { fill: 0xef4444, border: 0xf87171, hex: '#ef4444' };
  }
}

/** Build a diagonal-striped zone texture with a bold center label for special Battlefield tiles. */
function createZoneTileTexture(
  label: string,
  bgRgba: string,
  stripeRgba: string,
  borderRgba: string
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = bgRgba;
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  ctx.strokeStyle = stripeRgba;
  ctx.lineWidth = 14;
  for (let offset = -size; offset < size * 2; offset += 36) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + size, size);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = borderRgba;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, size - 8, size - 8);

  ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
  ctx.fillRect(36, 98, size - 72, 60);
  ctx.strokeStyle = borderRgba;
  ctx.lineWidth = 3;
  ctx.strokeRect(36, 98, size - 72, 60);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 34px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Build a high-contrast cyan & white checkerboard GOAL texture for colorblind-safe visibility. */
function createGoalTileTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = 'rgba(6, 182, 212, 0.56)';
  ctx.fillRect(0, 0, size, size);

  // Outer checkerboard frame along edges
  const cell = 32;
  const count = size / cell;
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      const isBorder = row === 0 || row === count - 1 || col === 0 || col === count - 1;
      if (!isBorder) continue;
      ctx.fillStyle = (row + col) % 2 === 0 ? 'rgba(248, 250, 252, 0.92)' : 'rgba(8, 145, 178, 0.88)';
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
  }

  // Center pill badge + GOAL label
  ctx.fillStyle = 'rgba(8, 51, 68, 0.78)';
  ctx.fillRect(46, 94, size - 92, 68);
  ctx.strokeStyle = 'rgba(103, 232, 249, 0.95)';
  ctx.lineWidth = 4;
  ctx.strokeRect(46, 94, size - 92, 68);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 42px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GOAL', size / 2, size / 2 + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface BattleCanvas3DProps {
  battleState: BattleState;
  cameraMode: CameraMode;
  showDebugOverlay: boolean;
  zoomLevel?: number;
  onChangeZoom?: (next: number) => void;
  focusTankId?: string | null;
}

interface TankVisual {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  turretGroup: THREE.Group;
  barrelGroup: THREE.Group;
  radarGroup: THREE.Group;
  radarConeMesh: THREE.Mesh;
  radarConeMat: THREE.MeshBasicMaterial;
  aimLine: THREE.Line;
  shieldMesh: THREE.Mesh;
  speechSprite: THREE.Sprite;
  speechCanvas: HTMLCanvasElement;
  speechTexture: THREE.CanvasTexture;
  lastSpeechKey: string;
  chassisId: string;
  mainGunId: string;
  radarId: string;
  color: string;
}

function lerpAngleRad(current: number, target: number, alpha: number): number {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * alpha;
}

function makeCompassLabelSprite(text: string, colorHex: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(12, 12, 232, 72, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colorHex;
    ctx.font = 'bold 34px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 49);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(95, 36, 1);
  return sprite;
}

function updateSpeechBubbleCanvas(
  canvas: HTMLCanvasElement,
  lines: string[],
  accentHex: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const displayLines = lines.slice(0, 3);
  if (displayLines.length === 0) return;

  const lineH = 34;
  const padY = 18;
  const boxH = Math.min(h - 24, displayLines.length * lineH + padY);
  const boxY = h - 22 - boxH;
  const boxW = w - 24;
  const boxX = 12;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.strokeStyle = accentHex || '#38bdf8';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 16);
  ctx.fill();
  ctx.stroke();

  // Speech pointer triangle at bottom center
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 14, boxY + boxH - 1);
  ctx.lineTo(w / 2 + 14, boxY + boxH - 1);
  ctx.lineTo(w / 2, h - 4);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = accentHex || '#38bdf8';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 14, boxY + boxH);
  ctx.lineTo(w / 2, h - 4);
  ctx.lineTo(w / 2 + 14, boxY + boxH);
  ctx.stroke();

  ctx.fillStyle = '#fef08a';
  ctx.font = 'bold 25px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  displayLines.forEach((line, idx) => {
    const trimmed = line.length > 32 ? `${line.slice(0, 30)}..` : line;
    const cy = boxY + padY / 2 + lineH * (idx + 0.5);
    ctx.fillText(trimmed, w / 2, cy);
  });
}

function buildRadarSectorGeometry(fovDeg: number, range: number): THREE.BufferGeometry {
  const segments = 28;
  const halfRad = degToRad(fovDeg / 2);
  const positions: number[] = [];

  for (let i = 0; i < segments; i++) {
    const a1 = -halfRad + (i / segments) * (2 * halfRad);
    const a2 = -halfRad + ((i + 1) / segments) * (2 * halfRad);
    // Triangle fan centered at origin, pointing along -Z (angle 0)
    positions.push(0, 0, 0);
    positions.push(Math.sin(a1) * range, 0, -Math.cos(a1) * range);
    positions.push(Math.sin(a2) * range, 0, -Math.cos(a2) * range);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildTankVisual(tank: TankRuntime): TankVisual {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  const turretGroup = new THREE.Group();
  const barrelGroup = new THREE.Group();
  const radarGroup = new THREE.Group();

  const baseColor = new THREE.Color(tank.blueprint.color || '#06b6d4');
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.65,
    metalness: 0.45,
  });
  const armorMat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.42,
    metalness: 0.35,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: 0.45,
    roughness: 0.3,
  });

  const chassisId = tank.blueprint.assembly.chassis;
  const scaleW =
    chassisId === 'light' ? 0.85 : chassisId === 'heavy' ? 1.2 : chassisId === 'destroyer' ? 1.28 : 1.0;
  const scaleL =
    chassisId === 'light' ? 0.92 : chassisId === 'heavy' ? 1.18 : chassisId === 'destroyer' ? 1.25 : 1.0;

  // Treads (left & right)
  const treadGeo = new THREE.BoxGeometry(8 * scaleW, 8, 38 * scaleL);
  const leftTread = new THREE.Mesh(treadGeo, darkMetal);
  leftTread.position.set(-14 * scaleW, 4, 0);
  leftTread.castShadow = true;
  const rightTread = new THREE.Mesh(treadGeo, darkMetal);
  rightTread.position.set(14 * scaleW, 4, 0);
  rightTread.castShadow = true;
  bodyGroup.add(leftTread, rightTread);

  // Main Hull
  const hullGeo = new THREE.BoxGeometry(22 * scaleW, 10, 34 * scaleL);
  const hullMesh = new THREE.Mesh(hullGeo, armorMat);
  hullMesh.position.set(0, 7, 0);
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  bodyGroup.add(hullMesh);

  // Front direction visor indicator (-Z is front)
  const visorGeo = new THREE.BoxGeometry(14 * scaleW, 3, 4);
  const visorMesh = new THREE.Mesh(visorGeo, accentMat);
  visorMesh.position.set(0, 10, -16 * scaleL);
  bodyGroup.add(visorMesh);

  // Turret head
  const turretBaseGeo = new THREE.CylinderGeometry(10 * scaleW, 12 * scaleW, 8, 8);
  const turretMesh = new THREE.Mesh(turretBaseGeo, armorMat);
  turretMesh.position.set(0, 16, 0);
  turretMesh.castShadow = true;
  turretGroup.add(turretMesh);

  // Gun Barrel (points along -Z)
  const mainGunId = tank.blueprint.assembly.mainGun;
  const barrelRadius = mainGunId === 'rapid' ? 1.8 : mainGunId === 'cannon' ? 3.3 : 2.4;
  const barrelLen = mainGunId === 'rapid' ? 22 : mainGunId === 'cannon' ? 30 : 26;
  const barrelGeo = new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.15, barrelLen, 10);
  barrelGeo.rotateX(Math.PI / 2);

  if (mainGunId === 'rapid') {
    const b1 = new THREE.Mesh(barrelGeo, darkMetal);
    b1.position.set(-2.5, 16.5, -barrelLen / 2 - 6);
    const b2 = new THREE.Mesh(barrelGeo, darkMetal);
    b2.position.set(2.5, 16.5, -barrelLen / 2 - 6);
    barrelGroup.add(b1, b2);
  } else {
    const b = new THREE.Mesh(barrelGeo, darkMetal);
    b.position.set(0, 16.5, -barrelLen / 2 - 7);
    b.castShadow = true;
    barrelGroup.add(b);
  }
  turretGroup.add(barrelGroup);

  // Aim line for debug overlay
  const aimPts = [new THREE.Vector3(0, 16.5, -10), new THREE.Vector3(0, 16.5, -700)];
  const aimGeo = new THREE.BufferGeometry().setFromPoints(aimPts);
  const aimMat = new THREE.LineBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.45,
  });
  const aimLine = new THREE.Line(aimGeo, aimMat);
  turretGroup.add(aimLine);

  // Radar Dish (on top of turret pivot height, independent rotation)
  const mastGeo = new THREE.CylinderGeometry(1.6, 2.2, 6, 8);
  const mastMesh = new THREE.Mesh(mastGeo, darkMetal);
  mastMesh.position.set(0, 22, 0);
  const dishGeo = new THREE.BoxGeometry(10, 4, 2.5);
  const dishMesh = new THREE.Mesh(dishGeo, accentMat);
  dishMesh.position.set(0, 25, -2);
  radarGroup.add(mastMesh, dishMesh);

  // Ground-projected Radar Cone
  const radarId = tank.blueprint.assembly.radar;
  const radarSpec = RADAR_SPECS[radarId];
  const radarConeGeo = buildRadarSectorGeometry(radarSpec.fovDeg, radarSpec.range);
  const radarConeMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const radarConeMesh = new THREE.Mesh(radarConeGeo, radarConeMat);
  radarConeMesh.position.set(0, 1.2, 0);
  radarGroup.add(radarConeMesh);

  // Energy Shield bubble
  const radius = CHASSIS_SPECS[chassisId].radius;
  const shieldGeo = new THREE.SphereGeometry(radius + 9, 20, 16);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.28,
    wireframe: true,
  });
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.position.set(0, 10, 0);
  shieldMesh.visible = false;

  // Debug print() speech bubble sprite above radar
  const speechCanvas = document.createElement('canvas');
  speechCanvas.width = 512;
  speechCanvas.height = 176;
  const speechTexture = new THREE.CanvasTexture(speechCanvas);
  const speechMat = new THREE.SpriteMaterial({
    map: speechTexture,
    transparent: true,
    depthTest: false,
  });
  const speechSprite = new THREE.Sprite(speechMat);
  speechSprite.center.set(0.5, 0);
  speechSprite.position.set(0, 32, 0);
  speechSprite.scale.set(145, 50, 1);
  speechSprite.renderOrder = 25;
  speechSprite.visible = false;

  root.add(bodyGroup, turretGroup, radarGroup, shieldMesh, speechSprite);

  return {
    root,
    bodyGroup,
    turretGroup,
    barrelGroup,
    radarGroup,
    radarConeMesh,
    radarConeMat,
    aimLine,
    shieldMesh,
    speechSprite,
    speechCanvas,
    speechTexture,
    lastSpeechKey: '',
    chassisId,
    mainGunId,
    radarId,
    color: tank.blueprint.color,
  };
}

export const BattleCanvas3D: React.FC<BattleCanvas3DProps> = ({
  battleState,
  cameraMode,
  showDebugOverlay,
  zoomLevel = 1.0,
  onChangeZoom,
  focusTankId = null,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<BattleState>(battleState);
  const cameraModeRef = useRef<CameraMode>(cameraMode);
  const debugRef = useRef<boolean>(showDebugOverlay);
  const zoomRef = useRef<number>(zoomLevel);
  const onChangeZoomRef = useRef(onChangeZoom);
  const focusTankIdRef = useRef<string | null>(focusTankId);
  const [webglError, setWebglError] = useState(false);

  stateRef.current = battleState;
  cameraModeRef.current = cameraMode;
  debugRef.current = showDebugOverlay;
  zoomRef.current = zoomLevel;
  onChangeZoomRef.current = onChangeZoom;
  focusTankIdRef.current = focusTankId;

  useEffect(() => {
    const domEl = containerRef.current?.querySelector('canvas');
    if (domEl instanceof HTMLElement) {
      domEl.style.touchAction = cameraMode === 'orbit' ? 'none' : 'pan-y';
    }
  }, [cameraMode]);

  // Orbit camera state
  const orbitRef = useRef({ theta: 0, phi: 0.78, distance: 920 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setWebglError(true);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth || 640, container.clientHeight || 480);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060b16);
    scene.fog = new THREE.FogExp2(0x060b16, 0.00018);

    const camera = new THREE.PerspectiveCamera(
      48,
      (container.clientWidth || 640) / (container.clientHeight || 480),
      5,
      6000
    );

    // Lighting
    const ambient = new THREE.AmbientLight(0xcbd5e1, 0.75);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
    dirLight.position.set(280, 620, 240);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 50;
    dirLight.shadow.camera.far = 2400;
    const d = 880;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
    rimLight.position.set(-400, 220, -350);
    scene.add(rimLight);

    // Arena Stage (Floor, Grid, Perimeter Walls, Compass Labels) rebuilt dynamically on arena size changes
    const arenaStageGroup = new THREE.Group();
    scene.add(arenaStageGroup);
    let lastArenaDimsKey = '';

    const rebuildArenaStage = (
      W: number,
      H: number,
      outerWallMode: OuterWallMode = 'normal'
    ) => {
      const disposedGeos = new Set<THREE.BufferGeometry>();
      const disposedMats = new Set<THREE.Material>();
      while (arenaStageGroup.children.length > 0) {
        const child = arenaStageGroup.children[0];
        arenaStageGroup.remove(child);
        child.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.geometry && !disposedGeos.has(mesh.geometry)) {
            disposedGeos.add(mesh.geometry);
            mesh.geometry.dispose();
          }
          const rawMat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
          const mats = Array.isArray(rawMat) ? rawMat : rawMat ? [rawMat] : [];
          for (const m of mats) {
            if (!disposedMats.has(m)) {
              disposedMats.add(m);
              const spriteMat = m as THREE.SpriteMaterial;
              if (spriteMat.map) spriteMat.map.dispose();
              m.dispose();
            }
          }
        });
      }

      // Arena Floor & Grid (centered at origin: X in [-W/2, W/2], Z in [-H/2, H/2])
      const floorGeo = new THREE.PlaneGeometry(W, H);
      floorGeo.rotateX(-Math.PI / 2);
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.85,
        metalness: 0.15,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.receiveShadow = true;
      arenaStageGroup.add(floorMesh);

      // Custom grid lines on floor
      const gridMat = new THREE.LineBasicMaterial({ color: 0x1e293b });
      const gridPoints: THREE.Vector3[] = [];
      for (let x = -W / 2; x <= W / 2; x += 50) {
        gridPoints.push(new THREE.Vector3(x, 0.4, -H / 2), new THREE.Vector3(x, 0.4, H / 2));
      }
      for (let z = -H / 2; z <= H / 2; z += 50) {
        gridPoints.push(new THREE.Vector3(-W / 2, 0.4, z), new THREE.Vector3(W / 2, 0.4, z));
      }
      const gridGeo = new THREE.BufferGeometry().setFromPoints(gridPoints);
      arenaStageGroup.add(new THREE.LineSegments(gridGeo, gridMat));

      // Arena Perimeter Walls
      const wallPalette: Record<OuterWallMode, { wall: number; trim: number }> = {
        normal: { wall: 0x1e293b, trim: 0x0ea5e9 },
        bounce: { wall: 0x292524, trim: 0xfacc15 },
        damage: { wall: 0x3b1219, trim: 0xef4444 },
        damage_bounce: { wall: 0x431407, trim: 0xf97316 },
      };
      const palette = wallPalette[outerWallMode] ?? wallPalette.normal;
      const wallMat = new THREE.MeshStandardMaterial({
        color: palette.wall,
        roughness: 0.5,
        metalness: 0.5,
      });
      const wallTrimMat = new THREE.MeshBasicMaterial({ color: palette.trim });
      const wallThick = 16;
      const wallHeight = 28;

      const wallsData = [
        { w: W + wallThick * 2, d: wallThick, x: 0, z: -H / 2 - wallThick / 2 },
        { w: W + wallThick * 2, d: wallThick, x: 0, z: H / 2 + wallThick / 2 },
        { w: wallThick, d: H, x: -W / 2 - wallThick / 2, z: 0 },
        { w: wallThick, d: H, x: W / 2 + wallThick / 2, z: 0 },
      ];
      for (const wd of wallsData) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(wd.w, wallHeight, wd.d), wallMat);
        mesh.position.set(wd.x, wallHeight / 2, wd.z);
        mesh.receiveShadow = true;
        arenaStageGroup.add(mesh);

        const trim = new THREE.Mesh(new THREE.BoxGeometry(wd.w, 2, wd.d), wallTrimMat);
        trim.position.set(wd.x, wallHeight + 1, wd.z);
        arenaStageGroup.add(trim);
      }

      // Compass Labels (N=0, E=90, S=180, W=270)
      const northSprite = makeCompassLabelSprite('N 0°', '#38bdf8');
      northSprite.position.set(0, 42, -H / 2 - 22);
      const eastSprite = makeCompassLabelSprite('E 90°', '#94a3b8');
      eastSprite.position.set(W / 2 + 28, 42, 0);
      const southSprite = makeCompassLabelSprite('S 180°', '#94a3b8');
      southSprite.position.set(0, 42, H / 2 + 22);
      const westSprite = makeCompassLabelSprite('W 270°', '#94a3b8');
      westSprite.position.set(-W / 2 - 28, 42, 0);
      arenaStageGroup.add(northSprite, eastSprite, southSprite, westSprite);
    };

    const initOuterMode = stateRef.current.arena.outerWallMode ?? 'normal';
    lastArenaDimsKey = `${stateRef.current.arena.width}x${stateRef.current.arena.height}:${initOuterMode}`;
    rebuildArenaStage(stateRef.current.arena.width, stateRef.current.arena.height, initOuterMode);

    // Dynamic entity pools
    const tileGroup = new THREE.Group();
    scene.add(tileGroup);
    let lastTileSignature = '';

    const obstacleGroup = new THREE.Group();
    scene.add(obstacleGroup);
    let lastObstacleSignature = '';

    const tankVisuals = new Map<string, TankVisual>();
    const targetGroups = new Map<string, { group: THREE.Group; sphere: THREE.Mesh; baseY: number; phase: number }>();
    const projectileMeshes = new Map<string, THREE.Mesh>();
    const mineMeshes = new Map<string, THREE.Mesh>();
    const smokeMeshes = new Map<string, THREE.Mesh>();
    const decoyMeshes = new Map<string, THREE.Mesh>();
    const explosionMeshes = new Map<string, THREE.Mesh>();

    const shellGeo = new THREE.SphereGeometry(4.2, 10, 10);
    const missileGeo = new THREE.ConeGeometry(4.2, 14, 8);
    missileGeo.rotateX(-Math.PI / 2);
    const mineGeo = new THREE.CylinderGeometry(9, 10, 4, 12);
    const expGeo = new THREE.SphereGeometry(1, 14, 12);

    // Lightweight Territory Grid Overlay (1 single CanvasTexture mesh)
    const territoryCanvas = document.createElement('canvas');
    territoryCanvas.width = 512;
    territoryCanvas.height = 384;
    const territoryCtx = territoryCanvas.getContext('2d');
    const territoryTexture = new THREE.CanvasTexture(territoryCanvas);
    const territoryGeo = new THREE.PlaneGeometry(1, 1);
    territoryGeo.rotateX(-Math.PI / 2);
    const territoryMat = new THREE.MeshBasicMaterial({
      map: territoryTexture,
      transparent: true,
      depthWrite: false,
    });
    const territoryMesh = new THREE.Mesh(territoryGeo, territoryMat);
    territoryMesh.position.set(0, 0.55, 0);
    territoryMesh.visible = false;
    scene.add(territoryMesh);
    let lastTerritoryKey = '';

    // Combat Football Mesh & Endzone Strips
    const footballGroup = new THREE.Group();
    const ballGroup = new THREE.Group();
    const ballSphereGeo = new THREE.SphereGeometry(20, 20, 16);
    const ballSphereMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.35,
      metalness: 0.08,
    });
    const ballSphere = new THREE.Mesh(ballSphereGeo, ballSphereMat);
    ballSphere.position.y = 20;
    ballSphere.castShadow = true;
    const ballBandGeo = new THREE.TorusGeometry(19.4, 2.2, 8, 24);
    const ballBandMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const ballBandA = new THREE.Mesh(ballBandGeo, ballBandMat);
    ballBandA.position.y = 20;
    const ballBandB = new THREE.Mesh(ballBandGeo, ballBandMat);
    ballBandB.position.y = 20;
    ballBandB.rotation.y = Math.PI / 2;
    ballGroup.add(ballSphere, ballBandA, ballBandB);
    const ballShadowGeo = new THREE.RingGeometry(15, 22, 24);
    ballShadowGeo.rotateX(-Math.PI / 2);
    const ballShadowMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ballShadow = new THREE.Mesh(ballShadowGeo, ballShadowMat);
    ballShadow.position.y = 1.05;
    footballGroup.add(ballGroup, ballShadow);

    const endzoneGeo = new THREE.PlaneGeometry(24, 1);
    endzoneGeo.rotateX(-Math.PI / 2);
    const westEndzoneMat = new THREE.MeshBasicMaterial({
      color: 0x56b4e9,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const eastEndzoneMat = new THREE.MeshBasicMaterial({
      color: 0xe69f00,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const westEndzoneMesh = new THREE.Mesh(endzoneGeo, westEndzoneMat);
    const eastEndzoneMesh = new THREE.Mesh(endzoneGeo, eastEndzoneMat);
    westEndzoneMesh.position.y = 0.7;
    eastEndzoneMesh.position.y = 0.7;
    const midfieldGeo = new THREE.PlaneGeometry(4, 1);
    midfieldGeo.rotateX(-Math.PI / 2);
    const midfieldMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const midfieldMesh = new THREE.Mesh(midfieldGeo, midfieldMat);
    midfieldMesh.position.set(0, 0.65, 0);

    const fieldMarkersGroup = new THREE.Group();
    fieldMarkersGroup.add(westEndzoneMesh, eastEndzoneMesh, midfieldMesh);
    fieldMarkersGroup.visible = false;
    footballGroup.visible = false;
    scene.add(fieldMarkersGroup);
    scene.add(footballGroup);

    // Mouse & touch interaction for Orbit camera (1-finger rotate, 2-finger pinch zoom)
    const activePointers = new Map<number, { x: number; y: number }>();
    let prevPinchDist: number | null = null;

    const getPinchDistance = (): number | null => {
      if (activePointers.size !== 2) return null;
      const pts = Array.from(activePointers.values());
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (cameraModeRef.current !== 'orbit') return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      prevPinchDist = getPinchDistance();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (cameraModeRef.current !== 'orbit' || !activePointers.has(e.pointerId)) return;
      const prev = activePointers.get(e.pointerId)!;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1) {
        orbitRef.current.theta -= dx * 0.007;
        orbitRef.current.phi = Math.max(0.18, Math.min(1.48, orbitRef.current.phi - dy * 0.007));
      } else if (activePointers.size === 2) {
        const nextDist = getPinchDistance();
        if (nextDist !== null && prevPinchDist !== null) {
          const delta = prevPinchDist - nextDist;
          orbitRef.current.distance = Math.max(
            260,
            Math.min(2600, orbitRef.current.distance + delta * 3.2)
          );
        }
        prevPinchDist = nextDist;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      prevPinchDist = getPinchDistance();
    };
    const onWheel = (e: WheelEvent) => {
      if (cameraModeRef.current === 'orbit') {
        e.preventDefault();
        orbitRef.current.distance = Math.max(
          260,
          Math.min(2600, orbitRef.current.distance + e.deltaY * 0.6)
        );
      } else if (cameraModeRef.current === 'tactical') {
        e.preventDefault();
        const nextZoom = Math.max(
          0.55,
          Math.min(2.2, Number((zoomRef.current - e.deltaY * 0.0012).toFixed(2)))
        );
        zoomRef.current = nextZoom;
        if (onChangeZoomRef.current) {
          onChangeZoomRef.current(nextZoom);
        }
      }
    };

    const domEl = renderer.domElement;
    domEl.style.touchAction = cameraModeRef.current === 'orbit' ? 'none' : 'pan-y';
    domEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    domEl.addEventListener('wheel', onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 640;
      const h = container.clientHeight || 480;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    const smoothCamPos = new THREE.Vector3(0, 820, 460);
    const smoothLookAt = new THREE.Vector3(0, 0, 0);
    const goalTileTexture = createGoalTileTexture();
    const slowTileTexture = createZoneTileTexture(
      'SLOW',
      'rgba(180, 83, 9, 0.34)',
      'rgba(251, 191, 36, 0.25)',
      'rgba(251, 191, 36, 0.92)'
    );
    const noWeaponTileTexture = createZoneTileTexture(
      'NO FIRE',
      'rgba(109, 40, 217, 0.34)',
      'rgba(192, 132, 252, 0.26)',
      'rgba(192, 132, 252, 0.92)'
    );

    let animFrameId = 0;
    const renderLoop = () => {
      animFrameId = requestAnimationFrame(renderLoop);
      const st = stateRef.current;
      const arenaW = st.arena.width;
      const arenaH = st.arena.height;
      const outerWallMode = st.arena.outerWallMode ?? 'normal';
      const dimsKey = `${arenaW}x${arenaH}:${outerWallMode}`;
      if (dimsKey !== lastArenaDimsKey) {
        lastArenaDimsKey = dimsKey;
        rebuildArenaStage(arenaW, arenaH, outerWallMode);
      }
      const halfW = arenaW / 2;
      const halfH = arenaH / 2;

      // Sync Territory Grid CanvasTexture (Domination Mode)
      if (st.territoryGrid && territoryCtx) {
        const tg = st.territoryGrid;
        territoryMesh.visible = true;
        territoryMesh.scale.set(arenaW, 1, arenaH);
        const tKey = `${tg.cols}x${tg.rows}:${tg.version}:${arenaW}x${arenaH}`;
        if (tKey !== lastTerritoryKey) {
          lastTerritoryKey = tKey;
          const cw = territoryCanvas.width / tg.cols;
          const ch = territoryCanvas.height / tg.rows;
          territoryCtx.clearRect(0, 0, territoryCanvas.width, territoryCanvas.height);
          for (let r = 0; r < tg.rows; r++) {
            for (let c = 0; c < tg.cols; c++) {
              const idx = r * tg.cols + c;
              const px = c * cw;
              const py = r * ch;
              if (tg.blocked[idx]) {
                territoryCtx.fillStyle = 'rgba(15, 23, 42, 0.55)';
                territoryCtx.fillRect(px, py, cw, ch);
              } else {
                const owner = tg.owners[idx];
                if (owner && tg.teamColors[owner]) {
                  territoryCtx.save();
                  territoryCtx.globalAlpha = 0.44;
                  territoryCtx.fillStyle = tg.teamColors[owner];
                  territoryCtx.fillRect(px + 1, py + 1, cw - 2, ch - 2);
                  territoryCtx.globalAlpha = 0.85;
                  territoryCtx.strokeStyle = tg.teamColors[owner];
                  territoryCtx.lineWidth = 2;
                  territoryCtx.strokeRect(px + 1.5, py + 1.5, cw - 3, ch - 3);
                  territoryCtx.restore();
                } else {
                  territoryCtx.fillStyle = 'rgba(30, 41, 59, 0.14)';
                  territoryCtx.fillRect(px + 1, py + 1, cw - 2, ch - 2);
                }
              }
              territoryCtx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
              territoryCtx.lineWidth = 1;
              territoryCtx.strokeRect(px, py, cw, ch);
            }
          }
          territoryTexture.needsUpdate = true;
        }
      } else {
        territoryMesh.visible = false;
        lastTerritoryKey = '';
      }

      // Sync Combat Football Ball & Endzones
      if (st.football) {
        const fb = st.football;
        footballGroup.visible = true;
        fieldMarkersGroup.visible = true;
        westEndzoneMat.color.set(fb.westTeamColor || '#56b4e9');
        eastEndzoneMat.color.set(fb.eastTeamColor || '#e69f00');
        westEndzoneMesh.position.set(-halfW + 12, 0.7, 0);
        eastEndzoneMesh.position.set(halfW - 12, 0.7, 0);
        westEndzoneMesh.scale.set(1, 1, arenaH);
        eastEndzoneMesh.scale.set(1, 1, arenaH);
        midfieldMesh.scale.set(1, 1, arenaH);

        const targetBallX = fb.x - halfW;
        const targetBallZ = fb.y - halfH;
        const bdx = targetBallX - footballGroup.position.x;
        const bdz = targetBallZ - footballGroup.position.z;
        if (fb.kickoffFreezeTicks > 0 || st.tick <= 1 || bdx * bdx + bdz * bdz > 120 * 120) {
          footballGroup.position.set(targetBallX, 0, targetBallZ);
        } else {
          footballGroup.position.x += bdx * 0.45;
          footballGroup.position.z += bdz * 0.45;
        }
        ballGroup.rotation.z -= fb.vx * 0.04;
        ballGroup.rotation.x += fb.vy * 0.04;
      } else {
        footballGroup.visible = false;
        fieldMarkersGroup.visible = false;
      }

      // Sync Floor Tiles (goal, checkpoint, color, hazard, slow, no_weapon)
      const tiles = st.arena.tiles ?? [];
      const tileSig = `${dimsKey}:${JSON.stringify(
        tiles.map((t) => [t.id, t.kind, t.color, t.visited, t.x, t.y, t.width, t.height])
      )}`;
      if (tileSig !== lastTileSignature) {
        lastTileSignature = tileSig;
        while (tileGroup.children.length > 0) {
          const child = tileGroup.children[0];
          tileGroup.remove(child);
          child.traverse((obj) => {
            if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
              obj.geometry.dispose();
              const mat = obj.material;
              if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
              else mat.dispose();
            }
          });
        }
        for (const tile of tiles) {
          const { fill, border } = resolveTileColors(tile);
          const padGeo = new THREE.PlaneGeometry(tile.width, tile.height);
          padGeo.rotateX(-Math.PI / 2);
          const isGoal = tile.kind === 'goal';
          const zoneTex =
            tile.kind === 'slow'
              ? slowTileTexture
              : tile.kind === 'no_weapon'
                ? noWeaponTileTexture
                : null;
          const padMat = isGoal && goalTileTexture
            ? new THREE.MeshBasicMaterial({
                map: goalTileTexture,
                transparent: true,
                opacity: 0.92,
                depthWrite: false,
              })
            : zoneTex
              ? new THREE.MeshBasicMaterial({
                  map: zoneTex,
                  transparent: true,
                  opacity: 0.88,
                  depthWrite: false,
                })
              : new THREE.MeshBasicMaterial({
                  color: fill,
                  transparent: true,
                  opacity: tile.kind === 'checkpoint' && tile.visited ? 0.22 : 0.44,
                  depthWrite: false,
                });
          const pad = new THREE.Mesh(padGeo, padMat);
          pad.position.set(
            tile.x + tile.width / 2 - halfW,
            isGoal ? 0.85 : 0.7,
            tile.y + tile.height / 2 - halfH
          );
          tileGroup.add(pad);

          const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(tile.width, isGoal ? 2.2 : 1.5, tile.height));
          const frameMat = new THREE.LineBasicMaterial({ color: border });
          const frame = new THREE.LineSegments(frameGeo, frameMat);
          frame.position.set(
            tile.x + tile.width / 2 - halfW,
            isGoal ? 1.15 : 0.9,
            tile.y + tile.height / 2 - halfH
          );
          tileGroup.add(frame);

          if (isGoal) {
            const outerR = Math.min(tile.width, tile.height) * 0.4;
            const ringGeo = new THREE.RingGeometry(outerR * 0.8, outerR, 32);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
              color: 0xe0f2fe,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.9,
              depthWrite: false,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.set(
              tile.x + tile.width / 2 - halfW,
              1.1,
              tile.y + tile.height / 2 - halfH
            );
            tileGroup.add(ring);

            // 4 corner goal beacon pylons so GOAL stands out clearly in 3D view
            const inset = 6;
            const cx = tile.x + tile.width / 2 - halfW;
            const cz = tile.y + tile.height / 2 - halfH;
            const hx = Math.max(8, tile.width / 2 - inset);
            const hz = Math.max(8, tile.height / 2 - inset);
            const corners: Array<[number, number]> = [
              [cx - hx, cz - hz],
              [cx + hx, cz - hz],
              [cx - hx, cz + hz],
              [cx + hx, cz + hz],
            ];
            for (const [px, pz] of corners) {
              const postGeo = new THREE.CylinderGeometry(2.8, 3.6, 14, 10);
              const postMat = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
              const post = new THREE.Mesh(postGeo, postMat);
              post.position.set(px, 7, pz);
              tileGroup.add(post);
            }
          } else if (tile.kind === 'checkpoint') {
            const ringR = Math.min(tile.width, tile.height) * 0.3;
            const ringGeo = new THREE.RingGeometry(ringR * 0.72, ringR, 28);
            ringGeo.rotateX(-Math.PI / 2);
            const ringMat = new THREE.MeshBasicMaterial({
              color: border,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: tile.visited ? 0.3 : 0.85,
              depthWrite: false,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.position.set(
              tile.x + tile.width / 2 - halfW,
              1.05,
              tile.y + tile.height / 2 - halfH
            );
            tileGroup.add(ring);
          }
        }
      }

      // Sync Obstacles if changed
      const obsSig = JSON.stringify(st.arena.obstacles);
      if (obsSig !== lastObstacleSignature) {
        lastObstacleSignature = obsSig;
        while (obstacleGroup.children.length > 0) {
          const child = obstacleGroup.children[0] as THREE.Mesh;
          obstacleGroup.remove(child);
          child.geometry.dispose();
        }
        const obsMat = new THREE.MeshStandardMaterial({
          color: 0x334155,
          roughness: 0.6,
          metalness: 0.3,
        });
        const obsTopMat = new THREE.MeshBasicMaterial({ color: 0x475569 });
        for (const obs of st.arena.obstacles) {
          const h = 44;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(obs.width, h, obs.height), obsMat);
          mesh.position.set(
            obs.x + obs.width / 2 - halfW,
            h / 2,
            obs.y + obs.height / 2 - halfH
          );
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          obstacleGroup.add(mesh);

          const cap = new THREE.Mesh(new THREE.BoxGeometry(obs.width, 2, obs.height), obsTopMat);
          cap.position.set(obs.x + obs.width / 2 - halfW, h + 1, obs.y + obs.height / 2 - halfH);
          obstacleGroup.add(cap);
        }
      }

      // Sync Tanks (with smooth 60fps interpolation between simulation ticks)
      const tankLerpAlpha = 0.35;
      const activeTankIds = new Set<string>();
      for (const tank of st.tanks) {
        activeTankIds.add(tank.id);
        let vis = tankVisuals.get(tank.id);
        let justCreated = false;
        if (
          !vis ||
          vis.chassisId !== tank.blueprint.assembly.chassis ||
          vis.mainGunId !== tank.blueprint.assembly.mainGun ||
          vis.radarId !== tank.blueprint.assembly.radar ||
          vis.color !== tank.blueprint.color
        ) {
          if (vis) {
            scene.remove(vis.root);
            vis.speechTexture.dispose();
            (vis.speechSprite.material as THREE.Material).dispose();
          }
          vis = buildTankVisual(tank);
          tankVisuals.set(tank.id, vis);
          scene.add(vis.root);
          justCreated = true;
        }

        vis.root.visible = tank.hp > 0;
        const targetX = tank.x - halfW;
        const targetZ = tank.y - halfH;
        const targetBodyRot = -degToRad(tank.bodyAngle);
        const targetTurretRot = -degToRad(tank.turretAngle);
        const targetRadarRot = -degToRad(tank.radarAngle);
        const targetRecoilZ = tank.recoil * 5.5;

        const dx = targetX - vis.root.position.x;
        const dz = targetZ - vis.root.position.z;
        const snap = justCreated || st.tick === 0 || dx * dx + dz * dz > 120 * 120;

        if (snap) {
          vis.root.position.set(targetX, 0, targetZ);
          vis.bodyGroup.rotation.y = targetBodyRot;
          vis.turretGroup.rotation.y = targetTurretRot;
          vis.radarGroup.rotation.y = targetRadarRot;
          vis.barrelGroup.position.z = targetRecoilZ;
        } else {
          vis.root.position.x += dx * tankLerpAlpha;
          vis.root.position.z += dz * tankLerpAlpha;
          vis.bodyGroup.rotation.y = lerpAngleRad(
            vis.bodyGroup.rotation.y,
            targetBodyRot,
            tankLerpAlpha
          );
          vis.turretGroup.rotation.y = lerpAngleRad(
            vis.turretGroup.rotation.y,
            targetTurretRot,
            tankLerpAlpha
          );
          vis.radarGroup.rotation.y = lerpAngleRad(
            vis.radarGroup.rotation.y,
            targetRadarRot,
            tankLerpAlpha
          );
          vis.barrelGroup.position.z += (targetRecoilZ - vis.barrelGroup.position.z) * 0.45;
        }

        const radarRangeMult = Math.max(0.2, Math.min(1.0, st.arena.radarRangeMult ?? 1.0));
        vis.radarConeMesh.visible = debugRef.current;
        vis.radarConeMesh.scale.set(radarRangeMult, 1, radarRangeMult);
        vis.aimLine.visible = debugRef.current;
        vis.radarConeMat.color.set(tank.blueprint.color || '#56b4e9');
        vis.radarConeMat.opacity = tank.radarLock ? 0.15 : 0.07;

        vis.shieldMesh.visible = tank.shieldTicks > 0;
        if (tank.shieldTicks > 0) {
          vis.shieldMesh.rotation.y += 0.04;
        }

        const speechLines = tank.activePrintSpeech?.lines ?? [];
        const speechKey = speechLines.join('\n');
        if (speechLines.length > 0 && tank.hp > 0) {
          vis.speechSprite.visible = true;
          if (speechKey !== vis.lastSpeechKey) {
            updateSpeechBubbleCanvas(vis.speechCanvas, speechLines, tank.blueprint.color);
            vis.speechTexture.needsUpdate = true;
            vis.lastSpeechKey = speechKey;
          }
        } else {
          vis.speechSprite.visible = false;
          vis.lastSpeechKey = '';
        }
      }
      for (const [id, vis] of tankVisuals.entries()) {
        if (!activeTankIds.has(id)) {
          scene.remove(vis.root);
          vis.speechTexture.dispose();
          (vis.speechSprite.material as THREE.Material).dispose();
          tankVisuals.delete(id);
        }
      }

      // Sync Projectiles (with smooth 60fps interpolation)
      const projLerpAlpha = 0.45;
      const activeProjIds = new Set<string>();
      for (const proj of st.projectiles) {
        activeProjIds.add(proj.id);
        let mesh = projectileMeshes.get(proj.id);
        const px = proj.x - halfW;
        const pz = proj.y - halfH;
        if (!mesh) {
          const mat = new THREE.MeshBasicMaterial({
            color: proj.kind === 'missile' ? 0xf97316 : new THREE.Color(proj.color),
          });
          mesh = new THREE.Mesh(proj.kind === 'missile' ? missileGeo : shellGeo, mat);
          mesh.position.set(px, 16, pz);
          if (proj.kind === 'missile') {
            mesh.rotation.y = -degToRad(proj.angle);
          }
          projectileMeshes.set(proj.id, mesh);
          scene.add(mesh);
        } else {
          mesh.position.x += (px - mesh.position.x) * projLerpAlpha;
          mesh.position.z += (pz - mesh.position.z) * projLerpAlpha;
          if (proj.kind === 'missile') {
            mesh.rotation.y = lerpAngleRad(
              mesh.rotation.y,
              -degToRad(proj.angle),
              projLerpAlpha
            );
          }
        }
      }
      for (const [id, mesh] of projectileMeshes.entries()) {
        if (!activeProjIds.has(id)) {
          scene.remove(mesh);
          (mesh.material as THREE.Material).dispose();
          projectileMeshes.delete(id);
        }
      }

      // Sync Mines
      const activeMineIds = new Set<string>();
      for (const mine of st.mines) {
        activeMineIds.add(mine.id);
        let mesh = mineMeshes.get(mine.id);
        if (!mesh) {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xef4444,
            emissive: 0xef4444,
            emissiveIntensity: 0.6,
          });
          mesh = new THREE.Mesh(mineGeo, mat);
          mineMeshes.set(mine.id, mesh);
          scene.add(mesh);
        }
        mesh.position.set(mine.x - halfW, 2, mine.y - halfH);
      }
      for (const [id, mesh] of mineMeshes.entries()) {
        if (!activeMineIds.has(id)) {
          scene.remove(mesh);
          (mesh.material as THREE.Material).dispose();
          mineMeshes.delete(id);
        }
      }

      // Sync Explosions
      const activeExpIds = new Set<string>();
      for (const exp of st.explosions) {
        activeExpIds.add(exp.id);
        let mesh = explosionMeshes.get(exp.id);
        if (!mesh) {
          const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(exp.color),
            transparent: true,
            opacity: 0.85,
          });
          mesh = new THREE.Mesh(expGeo, mat);
          explosionMeshes.set(exp.id, mesh);
          scene.add(mesh);
        }
        const t = exp.age / exp.maxAge;
        const scale = exp.radius * (0.4 + t * 0.9);
        mesh.position.set(exp.x - halfW, 14, exp.y - halfH);
        mesh.scale.setScalar(scale);
        (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - t));
      }
      for (const [id, mesh] of explosionMeshes.entries()) {
        if (!activeExpIds.has(id)) {
          scene.remove(mesh);
          (mesh.material as THREE.Material).dispose();
          explosionMeshes.delete(id);
        }
      }

      // Sync Smokes
      const activeSmokeIds = new Set<string>();
      for (const smoke of st.smokes ?? []) {
        activeSmokeIds.add(smoke.id);
        let mesh = smokeMeshes.get(smoke.id);
        if (!mesh) {
          const mat = new THREE.MeshBasicMaterial({
            color: 0x94a3b8,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
          });
          mesh = new THREE.Mesh(expGeo, mat);
          smokeMeshes.set(smoke.id, mesh);
          scene.add(mesh);
        }
        const fade = Math.min(1, smoke.ttl / 25);
        mesh.position.set(smoke.x - halfW, 18, smoke.y - halfH);
        mesh.scale.set(smoke.radius, 36, smoke.radius);
        (mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * fade;
      }
      for (const [id, mesh] of smokeMeshes.entries()) {
        if (!activeSmokeIds.has(id)) {
          scene.remove(mesh);
          (mesh.material as THREE.Material).dispose();
          smokeMeshes.delete(id);
        }
      }

      // Sync Decoys
      const activeDecoyIds = new Set<string>();
      for (const decoy of st.decoys ?? []) {
        activeDecoyIds.add(decoy.id);
        let mesh = decoyMeshes.get(decoy.id);
        if (!mesh) {
          const geo = new THREE.BoxGeometry(28, 16, 36);
          const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(decoy.color),
            wireframe: true,
            transparent: true,
            opacity: 0.75,
          });
          mesh = new THREE.Mesh(geo, mat);
          decoyMeshes.set(decoy.id, mesh);
          scene.add(mesh);
        }
        mesh.position.set(decoy.x - halfW, 10, decoy.y - halfH);
        mesh.rotation.y += 0.03;
      }
      for (const [id, mesh] of decoyMeshes.entries()) {
        if (!activeDecoyIds.has(id)) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
          decoyMeshes.delete(id);
        }
      }

      // Sync Learning Mode Targets / Balloons
      const nowBob = performance.now() * 0.004;
      const activeTargetIds = new Set<string>();
      for (const tgt of st.arena.targets ?? []) {
        if (tgt.popped) continue;
        activeTargetIds.add(tgt.id);
        let vis = targetGroups.get(tgt.id);
        if (!vis) {
          const group = new THREE.Group();
          const col = new THREE.Color(tgt.color ?? (tgt.kind === 'ram_balloon' ? '#ec4899' : '#f43f5e'));
          const baseRingGeo = new THREE.RingGeometry(tgt.radius * 0.65, tgt.radius * 0.98, 24);
          baseRingGeo.rotateX(-Math.PI / 2);
          const baseRingMat = new THREE.MeshBasicMaterial({
            color: col,
            transparent: true,
            opacity: tgt.kind === 'ram_balloon' ? 0.75 : 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const baseRing = new THREE.Mesh(baseRingGeo, baseRingMat);
          baseRing.position.y = 0.95;
          group.add(baseRing);

          const baseY = tgt.kind === 'ram_balloon' ? tgt.radius * 0.95 + 4 : 28;
          const stringGeo = new THREE.CylinderGeometry(0.9, 0.9, baseY, 6);
          const stringMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
          const stringMesh = new THREE.Mesh(stringGeo, stringMat);
          stringMesh.position.y = baseY / 2;
          group.add(stringMesh);

          const sphereGeo = new THREE.SphereGeometry(tgt.radius * 0.85, 18, 14);
          const sphereMat = new THREE.MeshStandardMaterial({
            color: col,
            emissive: col,
            emissiveIntensity: 0.25,
            roughness: 0.28,
            metalness: 0.08,
          });
          const sphere = new THREE.Mesh(sphereGeo, sphereMat);
          sphere.position.y = baseY;
          sphere.castShadow = true;
          group.add(sphere);

          scene.add(group);
          vis = { group, sphere, baseY, phase: (tgt.x + tgt.y) * 0.02 };
          targetGroups.set(tgt.id, vis);
        }
        vis.group.position.set(tgt.x - halfW, 0, tgt.y - halfH);
        vis.sphere.position.y = vis.baseY + Math.sin(nowBob + vis.phase) * 2.5;
      }
      for (const [id, vis] of targetGroups.entries()) {
        if (!activeTargetIds.has(id)) {
          scene.remove(vis.group);
          vis.group.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              (obj.material as THREE.Material).dispose();
            }
          });
          targetGroups.delete(id);
        }
      }

      // Camera Modes
      const mode = cameraModeRef.current;
      const targetPos = new THREE.Vector3();
      const targetLook = new THREE.Vector3();

      if (mode === 'tactical') {
        const aspect = camera.aspect || 1.2;
        const vFovRad = degToRad(camera.fov);
        const tanHalfV = Math.tan(vFovRad / 2);
        const tanHalfH = tanHalfV * aspect;
        const margin = Math.min(180, Math.max(96, Math.min(arenaW, arenaH) * 0.16));
        const distForWidth = (arenaW + margin) / 2 / Math.max(0.25, tanHalfH);
        const distForHeight = (arenaH + margin) / 2 / tanHalfV;
        const baseDist =
          (Math.max(distForWidth, distForHeight) * 1.06) / Math.max(0.5, zoomRef.current);
        targetPos.set(0, baseDist * 0.92, baseDist * 0.42);
        targetLook.set(0, 0, 10);
      } else if (mode === 'orbit') {
        const { theta, phi, distance } = orbitRef.current;
        targetPos.set(
          distance * Math.sin(phi) * Math.sin(theta),
          distance * Math.cos(phi),
          distance * Math.sin(phi) * Math.cos(theta)
        );
        targetLook.set(0, 0, 0);
      } else {
        const focusId = focusTankIdRef.current;
        const targetTank =
          (focusId ? st.tanks.find((t) => t.id === focusId) : null) ??
          (mode === 'chase_p1'
            ? st.tanks.find((t) => t.team === 'player')
            : st.tanks.find((t) => t.team === 'enemy'));
        if (targetTank) {
          const tx = targetTank.x - halfW;
          const tz = targetTank.y - halfH;
          const fwd = angleToVector(targetTank.turretAngle);
          targetPos.set(tx - fwd.dx * 155, 85, tz - fwd.dy * 155);
          targetLook.set(tx + fwd.dx * 120, 14, tz + fwd.dy * 120);
        } else {
          targetPos.set(0, 860, 420);
          targetLook.set(0, 0, 0);
        }
      }

      smoothCamPos.lerp(targetPos, 0.14);
      smoothLookAt.lerp(targetLook, 0.14);
      camera.position.copy(smoothCamPos);
      camera.lookAt(smoothLookAt);

      renderer.render(scene, camera);
    };

    renderLoop();

    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      domEl.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      domEl.removeEventListener('wheel', onWheel);
      goalTileTexture?.dispose();
      slowTileTexture?.dispose();
      noWeaponTileTexture?.dispose();
      territoryTexture.dispose();
      territoryGeo.dispose();
      territoryMat.dispose();
      ballSphereGeo.dispose();
      ballSphereMat.dispose();
      ballBandGeo.dispose();
      ballBandMat.dispose();
      ballShadowGeo.dispose();
      ballShadowMat.dispose();
      endzoneGeo.dispose();
      westEndzoneMat.dispose();
      eastEndzoneMat.dispose();
      midfieldGeo.dispose();
      midfieldMat.dispose();
      renderer.dispose();
    };
  }, []);

  if (webglError) {
    return (
      <BattleCanvas2DFallback
        battleState={battleState}
        showDebugOverlay={showDebugOverlay}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="battle-canvas-3d"
      style={{ touchAction: cameraMode === 'orbit' ? 'none' : 'pan-y' }}
    >
      {/* Three.js mounts here */}
    </div>
  );
};

const BattleCanvas2DFallback: React.FC<{
  battleState: BattleState;
  showDebugOverlay: boolean;
}> = ({ battleState, showDebugOverlay }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = battleState.arena.width;
    const h = battleState.arena.height;
    ctx.fillStyle = '#060b16';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Domination Territory Grid (2D fallback)
    if (battleState.territoryGrid) {
      const tg = battleState.territoryGrid;
      const cw = w / tg.cols;
      const ch = h / tg.rows;
      for (let r = 0; r < tg.rows; r++) {
        for (let c = 0; c < tg.cols; c++) {
          const idx = r * tg.cols + c;
          if (tg.blocked[idx]) continue;
          const owner = tg.owners[idx];
          if (owner && tg.teamColors[owner]) {
            ctx.save();
            ctx.globalAlpha = 0.36;
            ctx.fillStyle = tg.teamColors[owner];
            ctx.fillRect(c * cw + 1, r * ch + 1, cw - 2, ch - 2);
            ctx.restore();
          }
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
          ctx.strokeRect(c * cw, r * ch, cw, ch);
        }
      }
    }

    // Combat Football Endzones (2D fallback)
    if (battleState.football) {
      const fb = battleState.football;
      ctx.save();
      ctx.globalAlpha = 0.38;
      ctx.fillStyle = fb.westTeamColor || '#56b4e9';
      ctx.fillRect(0, 0, 22, h);
      ctx.fillStyle = fb.eastTeamColor || '#e69f00';
      ctx.fillRect(w - 22, 0, 22, h);
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.restore();
    }

    // Outer Perimeter Gimmick Border
    const outerMode = battleState.arena.outerWallMode ?? 'normal';
    if (outerMode !== 'normal') {
      ctx.save();
      ctx.strokeStyle =
        outerMode === 'bounce'
          ? '#facc15'
          : outerMode === 'damage'
            ? '#ef4444'
            : '#f97316';
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.restore();
    }

    // Floor Tiles
    for (const tile of battleState.arena.tiles ?? []) {
      const { hex, label } = resolveTileColors(tile);
      ctx.save();
      ctx.globalAlpha = tile.kind === 'checkpoint' && tile.visited ? 0.22 : tile.kind === 'goal' ? 0.52 : 0.44;
      ctx.fillStyle = hex;
      ctx.fillRect(tile.x, tile.y, tile.width, tile.height);
      if (tile.kind === 'goal') {
        const checkerSize = 16;
        ctx.globalAlpha = 0.78;
        for (let sx = tile.x; sx < tile.x + tile.width - 1; sx += checkerSize) {
          for (let sy = tile.y; sy < tile.y + tile.height - 1; sy += checkerSize) {
            const onEdge =
              sx === tile.x ||
              sy === tile.y ||
              sx + checkerSize >= tile.x + tile.width ||
              sy + checkerSize >= tile.y + tile.height;
            if (!onEdge) continue;
            const ix = Math.floor((sx - tile.x) / checkerSize);
            const iy = Math.floor((sy - tile.y) / checkerSize);
            if ((ix + iy) % 2 === 0) {
              ctx.fillStyle = '#f8fafc';
              ctx.fillRect(
                sx,
                sy,
                Math.min(checkerSize, tile.x + tile.width - sx),
                Math.min(checkerSize, tile.y + tile.height - sy)
              );
            }
          }
        }
      }
      ctx.globalAlpha = 0.92;
      ctx.strokeStyle = tile.kind === 'goal' ? '#67e8f9' : hex;
      ctx.lineWidth = tile.kind === 'goal' ? 3 : 2.5;
      ctx.strokeRect(tile.x, tile.y, tile.width, tile.height);
      if (label) {
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tile.x + tile.width / 2, tile.y + tile.height / 2);
      }
      ctx.restore();
    }

    // Obstacles
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#64748b';
    for (const obs of battleState.arena.obstacles) {
      ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
      ctx.strokeRect(obs.x, obs.y, obs.width, obs.height);
    }

    // Mines
    for (const mine of battleState.mines) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(mine.x, mine.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Target Balloons
    for (const tgt of battleState.arena.targets ?? []) {
      if (tgt.popped) continue;
      ctx.save();
      ctx.fillStyle = tgt.color ?? (tgt.kind === 'ram_balloon' ? '#ec4899' : '#f43f5e');
      ctx.beginPath();
      ctx.arc(tgt.x, tgt.y, tgt.radius * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = (tgt.points ?? 1) > 1 ? '#fef08a' : '#ffffff';
      ctx.lineWidth = (tgt.points ?? 1) > 1 ? 3 : 2;
      ctx.stroke();
      ctx.restore();
    }

    // Combat Football (2D fallback)
    if (battleState.football) {
      const fb = battleState.football;
      ctx.save();
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(fb.x, fb.y, fb.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Tanks
    for (const tank of battleState.tanks) {
      if (tank.hp <= 0) continue;
      if (showDebugOverlay) {
        const radar = RADAR_SPECS[tank.blueprint.assembly.radar];
        const radarRangeMult = Math.max(0.2, Math.min(1.0, battleState.arena.radarRangeMult ?? 1.0));
        const startRad = degToRad(tank.radarAngle - 90 - radar.fovDeg / 2);
        const endRad = degToRad(tank.radarAngle - 90 + radar.fovDeg / 2);
        ctx.save();
        ctx.globalAlpha = tank.radarLock ? 0.15 : 0.07;
        ctx.fillStyle = tank.blueprint.color || '#56b4e9';
        ctx.beginPath();
        ctx.moveTo(tank.x, tank.y);
        ctx.arc(tank.x, tank.y, radar.range * radarRangeMult, startRad, endRad);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(tank.x, tank.y);
      ctx.rotate(degToRad(tank.bodyAngle));
      ctx.fillStyle = tank.blueprint.color;
      ctx.fillRect(-14, -18, 28, 36);
      ctx.restore();

      ctx.save();
      ctx.translate(tank.x, tank.y);
      ctx.rotate(degToRad(tank.turretAngle));
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(-3, -28, 6, 26);
      ctx.restore();

      const fallbackSpeech = tank.activePrintSpeech?.lines ?? [];
      if (fallbackSpeech.length > 0) {
        const label = fallbackSpeech[0];
        ctx.font = 'bold 12px ui-monospace, monospace';
        const tw = Math.max(80, ctx.measureText(label).width + 14);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.strokeStyle = tank.blueprint.color;
        ctx.fillRect(tank.x - tw / 2, tank.y - 52, tw, 20);
        ctx.strokeRect(tank.x - tw / 2, tank.y - 52, tw, 20);
        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'center';
        ctx.fillText(label, tank.x, tank.y - 38);
      }
    }

    // Projectiles & Explosions
    for (const proj of battleState.projectiles) {
      ctx.fillStyle = proj.color;
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const exp of battleState.explosions) {
      ctx.strokeStyle = exp.color;
      ctx.beginPath();
      ctx.arc(exp.x, exp.y, exp.radius * (exp.age / exp.maxAge), 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [battleState, showDebugOverlay]);

  return (
    <div className="battle-canvas-3d flex-center">
      <canvas
        ref={canvasRef}
        width={battleState.arena.width}
        height={battleState.arena.height}
        className="fallback-2d-canvas"
      />
    </div>
  );
};
