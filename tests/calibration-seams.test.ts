import { describe, it, expect } from 'vitest';

/**
 * Structural guard for the calibration engine split. The public surface is
 * `./calibration.js` (barrel) → `./calibration-analysis.js` (engine barrel) →
 * the three seams below. These assertions pin the split so a future refactor
 * can't silently move a symbol out of its seam (or collapse the barrels) without
 * a failing test.
 */
describe('calibration engine seams', () => {
  it('calibration-engine exposes calibrate', async () => {
    const mod = await import('../src/checks/calibration-engine.js');
    expect(typeof mod.calibrate).toBe('function');
  });

  it('calibration-builder exposes the set builder + classes', async () => {
    const mod = await import('../src/checks/calibration-builder.js');
    expect(typeof mod.buildCalibrationSet).toBe('function');
    expect(typeof mod.CalibrationSetBuilder).toBe('function');
    expect(typeof mod.CalibrationExampleBuilder).toBe('function');
    const built = mod.buildCalibrationSet('s', 'r')
      .example('e').output('o').task('t').scores({ a: 1 }).done()
      .build();
    expect(built.examples).toHaveLength(1);
  });

  it('calibration-drift exposes detectDrift', async () => {
    const mod = await import('../src/checks/calibration-drift.js');
    expect(typeof mod.detectDrift).toBe('function');
  });

  it('calibration-analysis barrel re-exports all three seams', async () => {
    const mod = await import('../src/checks/calibration-analysis.js');
    expect(typeof mod.calibrate).toBe('function');
    expect(typeof mod.buildCalibrationSet).toBe('function');
    expect(typeof mod.CalibrationSetBuilder).toBe('function');
    expect(typeof mod.CalibrationExampleBuilder).toBe('function');
    expect(typeof mod.detectDrift).toBe('function');
  });

  it('public calibration barrel keeps the same surface', async () => {
    const mod = await import('../src/checks/calibration.js');
    expect(typeof mod.calibrate).toBe('function');
    expect(typeof mod.buildCalibrationSet).toBe('function');
    expect(typeof mod.detectDrift).toBe('function');
  });
});
