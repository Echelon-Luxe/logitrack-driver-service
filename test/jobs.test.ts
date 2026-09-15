import { describe, it, expect, vi } from 'vitest';
import { applyJobEvent } from '../src/domain/jobs.js';
import { jobEffect } from '../src/domain/parse.js';
import type { EventEnvelope, ShipmentEventPayload } from '../src/events/envelope.js';

const env = (eventType: string, over: Partial<ShipmentEventPayload> = {}, eventId = 'evt-1') => ({
  eventId, eventType, eventVersion: 1,
  occurredAt: '2026-09-15T10:00:00.000Z', traceId: 't', producer: 'p',
  payload: {
    shipmentId: 'ship-1', reference: 'LT-ABC', status: 'ASSIGNED',
    customerId: 'cust-1', driverId: 'drv-1', origin: 'A', destination: 'B',
    ...over,
  },
}) as EventEnvelope<ShipmentEventPayload>;

const makeDb = (opts: {
  driver?: { id: string; currentShipmentId: string | null } | null;
  ledgerThrows?: unknown;
} = {}) => {
  const create = vi.fn(async () => {
    if (opts.ledgerThrows) throw opts.ledgerThrows;
    return {};
  });
  const update = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  // `in`, not `??`: an explicitly-null driver means "not found", which `??` would
  // silently replace with the default.
  const findUnique = vi.fn(async () =>
    'driver' in opts ? opts.driver : { id: 'drv-1', currentShipmentId: null });
  const tx = {
    processedEvent: { create },
    driver: { findUnique, update, updateMany },
  };
  const db = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never;
  return { db, create, update, updateMany, findUnique };
};

describe('jobEffect', () => {
  it.each([
    ['shipment.assigned', 'ASSIGN'],
    ['shipment.delivered', 'RELEASE'],
    ['shipment.cancelled', 'RELEASE'],
    ['shipment.created', 'IGNORE'],
    ['shipment.picked_up', 'IGNORE'],
    ['shipment.in_transit', 'IGNORE'],
    ['shipment.out_for_delivery', 'IGNORE'],
  ] as const)('%s -> %s', (t, e) => expect(jobEffect(t)).toBe(e));
});

describe('applyJobEvent', () => {
  it('sets currentShipmentId on assignment', async () => {
    const { db, update } = makeDb();
    const r = await applyJobEvent(db, env('shipment.assigned'));
    expect(r.applied).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentShipmentId: 'ship-1' },
    }));
  });

  it('ignores events that do not change job state', async () => {
    const { db, update } = makeDb();
    const r = await applyJobEvent(db, env('shipment.in_transit'));
    expect(r).toMatchObject({ applied: false, reason: 'not a job event' });
    expect(update).not.toHaveBeenCalled();
  });

  it('skips an event with no driver attached', async () => {
    const { db } = makeDb();
    const r = await applyJobEvent(db, env('shipment.assigned', { driverId: null }));
    expect(r).toMatchObject({ applied: false, reason: 'no driver on event' });
  });

  it('skips an event for a driver it does not know', async () => {
    const { db } = makeDb({ driver: null });
    const r = await applyJobEvent(db, env('shipment.assigned'));
    expect(r).toMatchObject({ applied: false, reason: 'unknown driver' });
  });

  /**
   * The out-of-order guard. A delayed RELEASE for an OLD shipment must not free
   * a driver from the job they are currently on. updateMany with the shipment
   * id in the WHERE clause makes the stale event a no-op instead.
   */
  it('releases only when the shipment still matches', async () => {
    const { db, updateMany } = makeDb();
    await applyJobEvent(db, env('shipment.delivered'));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'drv-1', currentShipmentId: 'ship-1' },
      data: { currentShipmentId: null },
    }));
  });

  // Idempotency: the ledger insert and the mutation share one transaction, so
  // a redelivery rolls both back together.
  it('treats a redelivered event as a duplicate', async () => {
    const { db, update } = makeDb({ ledgerThrows: { code: 'P2002' } });
    const r = await applyJobEvent(db, env('shipment.assigned'));
    expect(r).toEqual({ applied: false, duplicate: true });
    expect(update).not.toHaveBeenCalled();
  });

  it('propagates non-duplicate database errors so kafkajs retries', async () => {
    const { db } = makeDb({ ledgerThrows: new Error('connection terminated') });
    let thrown: unknown;
    try { await applyJobEvent(db, env('shipment.assigned')); } catch (e) { thrown = e; }
    expect((thrown as Error).message).toBe('connection terminated');
  });

  it('writes the ledger before mutating, inside one transaction', async () => {
    const { db, create, update } = makeDb();
    await applyJobEvent(db, env('shipment.assigned'));
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(update.mock.invocationCallOrder[0]!);
  });
});
