import { describe, it, expect } from 'vitest';
import { effectiveStatus, isAssignable, type DriverState } from '../src/domain/status.js';

const d = (availability: 'ONLINE' | 'OFFLINE', currentShipmentId: string | null): DriverState =>
  ({ availability, currentShipmentId });

describe('effectiveStatus', () => {
  it.each([
    ['OFFLINE', null, 'OFFLINE'],
    ['OFFLINE', 'ship-1', 'OFFLINE'],
    ['ONLINE', null, 'AVAILABLE'],
    ['ONLINE', 'ship-1', 'ON_JOB'],
  ] as const)('%s + shipment=%s -> %s', (a, s, expected) => {
    expect(effectiveStatus(d(a, s))).toBe(expected);
  });

  // Status is derived from two independently-owned fields, so it is always
  // consistent with both. There is no stored status column to drift.
  it('is a pure function of its two inputs', () => {
    const state = d('ONLINE', 'ship-1');
    expect(effectiveStatus(state)).toBe(effectiveStatus({ ...state }));
  });
});

describe('isAssignable', () => {
  it('only an online driver with no shipment can be assigned', () => {
    expect(isAssignable(d('ONLINE', null))).toBe(true);
  });

  it('refuses a driver already on a job', () => {
    expect(isAssignable(d('ONLINE', 'ship-1'))).toBe(false);
  });

  it('refuses an offline driver', () => {
    expect(isAssignable(d('OFFLINE', null))).toBe(false);
  });

  // The double-booking guard: an offline driver mid-job must never look free.
  it('refuses a driver who went offline while still holding a shipment', () => {
    expect(isAssignable(d('OFFLINE', 'ship-1'))).toBe(false);
  });
});
