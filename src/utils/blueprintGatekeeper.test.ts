import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER_BLUEPRINT } from '../data/presets';
import { TankBlueprint } from '../types/game';
import { validateAndRepairBlueprint } from './blueprintGatekeeper';

describe('blueprintGatekeeper', () => {
  it('accepts DEFAULT_PLAYER_BLUEPRINT without any repairs', () => {
    const res = validateAndRepairBlueprint(DEFAULT_PLAYER_BLUEPRINT);
    expect(res.isValid).toBe(true);
    expect(res.fixes).toEqual([]);
  });

  it('clamps out-of-range numeric params, respects gun power limits, and repairs invalid select options', () => {
    const bp: TankBlueprint = JSON.parse(JSON.stringify(DEFAULT_PLAYER_BLUEPRINT));
    bp.assembly.mainGun = 'rapid'; // maxPower = 2.2
    // Replace (1,2) cond_proximity with out-of-range params
    bp.program.cells[2][1] = {
      id: 'test_prox',
      type: 'cond_proximity',
      params: { mode: 'bogus_mode', target: 'all', dist: 999 },
      yes: null,
      no: null,
    };
    // Replace (5,3) act_fire with out-of-range power for rapid gun
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
    expect(res.blueprint.program.cells[3][5]?.params.power).toBe(2.2);
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
});
