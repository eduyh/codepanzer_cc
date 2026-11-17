import React, { useState } from 'react';
import { AlertTriangle, Check, Cpu, Crosshair, Radio, Shield, Truck, X } from 'lucide-react';
import {
  calculateAssemblyWeight,
  CHASSIS_SPECS,
  CPU_SPECS,
  MAIN_GUN_SPECS,
  RADAR_SPECS,
  SUB_WEAPON_SPECS,
} from '../data/parts';
import { createEmptyCells } from '../data/presets';
import {
  ChassisId,
  CpuId,
  MainGunId,
  RadarId,
  SubWeaponId,
  TankAssembly,
  TankBlueprint,
} from '../types/game';

interface AssemblyModalProps {
  blueprint: TankBlueprint;
  onApply: (updated: TankBlueprint) => void;
  onClose: () => void;
}

const COLOR_SWATCHES = ['#06b6d4', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#eab308'];

export const AssemblyModal: React.FC<AssemblyModalProps> = ({
  blueprint,
  onApply,
  onClose,
}) => {
  const [name, setName] = useState(blueprint.name);
  const [color, setColor] = useState(blueprint.color);
  const [assembly, setAssembly] = useState<TankAssembly>({ ...blueprint.assembly });

  const { totalWeight, weightLimit, overweight } = calculateAssemblyWeight(assembly);
  const chassis = CHASSIS_SPECS[assembly.chassis];
  const gun = MAIN_GUN_SPECS[assembly.mainGun];
  const radar = RADAR_SPECS[assembly.radar];
  const cpu = CPU_SPECS[assembly.cpu];

  const handleSave = () => {
    if (overweight) return;
    const targetSize = cpu.gridSize;
    let nextCells = blueprint.program.cells;
    if (blueprint.program.gridSize !== targetSize) {
      const resized = createEmptyCells(targetSize);
      for (let y = 0; y < Math.min(targetSize, blueprint.program.cells.length); y++) {
        for (let x = 0; x < Math.min(targetSize, blueprint.program.cells[y].length); x++) {
          const cell = blueprint.program.cells[y][x];
          if (!cell) continue;
          resized[y][x] = {
            ...cell,
            next:
              cell.next && cell.next.x < targetSize && cell.next.y < targetSize
                ? cell.next
                : null,
            yes:
              cell.yes && cell.yes.x < targetSize && cell.yes.y < targetSize ? cell.yes : null,
            no: cell.no && cell.no.x < targetSize && cell.no.y < targetSize ? cell.no : null,
          };
        }
      }
      nextCells = resized;
    }

    onApply({
      ...blueprint,
      name: name.trim() || 'カスタム戦車',
      color,
      assembly,
      program: {
        ...blueprint.program,
        gridSize: targetSize,
        cells: nextCells,
      },
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>機体アセンブル (ハードウェア構成)</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-content assembly-layout">
          {/* Identity & Stats Summary */}
          <div className="assembly-summary">
            <div className="form-row">
              <label>
                機体名
                <input
                  type="text"
                  value={name}
                  maxLength={32}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div>
                <span className="field-label">カラー</span>
                <div className="swatch-row">
                  {COLOR_SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`swatch ${color === c ? 'active' : ''}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className={`weight-box ${overweight ? 'overweight' : ''}`}>
              <div className="weight-header">
                <span>総重量 / 積載上限</span>
                <strong>
                  {totalWeight} / {weightLimit} t
                </strong>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${Math.min(100, (totalWeight / weightLimit) * 100)}%`,
                    backgroundColor: overweight ? '#f43f5e' : '#06b6d4',
                  }}
                />
              </div>
              {overweight && (
                <div className="weight-warn">
                  <AlertTriangle size={14} /> 重量オーバーです。パーツを軽量化するかシャシーを変更してください。
                </div>
              )}
            </div>

            <div className="stats-grid">
              <div className="stat-item">
                <span>最大HP</span>
                <strong>{chassis.maxHp}</strong>
              </div>
              <div className="stat-item">
                <span>最高速度</span>
                <strong>{(chassis.maxSpeed * 60).toFixed(0)} px/s</strong>
              </div>
              <div className="stat-item">
                <span>旋回速度</span>
                <strong>{chassis.turnRate}°/tick</strong>
              </div>
              <div className="stat-item">
                <span>主砲範囲</span>
                <strong>
                  P {gun.minPower}~{gun.maxPower}
                </strong>
              </div>
              <div className="stat-item">
                <span>レーダー</span>
                <strong>
                  {radar.fovDeg}° / {radar.range}px
                </strong>
              </div>
              <div className="stat-item">
                <span>CPU性能</span>
                <strong>
                  {cpu.gridSize}×{cpu.gridSize} ({cpu.maxStepsPerTick}step)
                </strong>
              </div>
            </div>
          </div>

          {/* Part Selectors */}
          <div className="parts-columns">
            <div className="part-group">
              <h4>
                <Truck size={15} /> シャシー (車体)
              </h4>
              {Object.values(CHASSIS_SPECS).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`part-card ${assembly.chassis === item.id ? 'selected' : ''}`}
                  onClick={() => setAssembly({ ...assembly, chassis: item.id as ChassisId })}
                >
                  <div className="part-top">
                    <strong>{item.name}</strong>
                    <span>
                      基本{item.baseWeight}t / 上限{item.weightLimit}t
                    </span>
                  </div>
                  <p>{item.description}</p>
                </button>
              ))}
            </div>

            <div className="part-group">
              <h4>
                <Crosshair size={15} /> 主砲 (Main Gun)
              </h4>
              {Object.values(MAIN_GUN_SPECS).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`part-card ${assembly.mainGun === item.id ? 'selected' : ''}`}
                  onClick={() => setAssembly({ ...assembly, mainGun: item.id as MainGunId })}
                >
                  <div className="part-top">
                    <strong>{item.name}</strong>
                    <span>{item.weight}t</span>
                  </div>
                  <p>{item.description}</p>
                </button>
              ))}
            </div>

            <div className="part-group">
              <h4>
                <Radio size={15} /> レーダー (Radar)
              </h4>
              {Object.values(RADAR_SPECS).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`part-card ${assembly.radar === item.id ? 'selected' : ''}`}
                  onClick={() => setAssembly({ ...assembly, radar: item.id as RadarId })}
                >
                  <div className="part-top">
                    <strong>{item.name}</strong>
                    <span>{item.weight}t</span>
                  </div>
                  <p>{item.description}</p>
                </button>
              ))}
            </div>

            <div className="part-group">
              <h4>
                <Cpu size={15} /> CPUボード
              </h4>
              {Object.values(CPU_SPECS).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`part-card ${assembly.cpu === item.id ? 'selected' : ''}`}
                  onClick={() => setAssembly({ ...assembly, cpu: item.id as CpuId })}
                >
                  <div className="part-top">
                    <strong>{item.name}</strong>
                    <span>{item.weight}t</span>
                  </div>
                  <p>{item.description}</p>
                </button>
              ))}
            </div>

            <div className="part-group part-group-full">
              <h4>
                <Shield size={15} /> 副兵装 (Sub Weapon)
              </h4>
              <div className="sub-grid">
                {Object.values(SUB_WEAPON_SPECS).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`part-card ${assembly.subWeapon === item.id ? 'selected' : ''}`}
                    onClick={() => setAssembly({ ...assembly, subWeapon: item.id as SubWeaponId })}
                  >
                    <div className="part-top">
                      <strong>{item.name}</strong>
                      <span>{item.weight}t</span>
                    </div>
                    <p>{item.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={overweight}
            onClick={handleSave}
          >
            <Check size={16} /> この構成で決定
          </button>
        </div>
      </div>
    </div>
  );
};

