import { describe, it, expect, vi } from 'vitest';
import { setAvailability, listDrivers, withStatus, ConflictError, NotFoundError } from '../src/domain/drivers.js';

const driver = (over: Record<string, unknown> = {}) => ({
  id: 'drv-1', userId: 'u1', name: 'Sam', vehicleType: 'VAN',
  availability: 'ONLINE', currentShipmentId: null, approvedAt: new Date(),
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

const makeDb = (found: unknown) => {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...(found as object), ...data }));
  const findMany = vi.fn(async () => [found]);
  const db = {
    driver: { findUnique: vi.fn(async () => found), update, findMany },
  } as never;
  return { db, update, findMany };
};

describe('withStatus', () => {
  it('derives status rather than reading a stored column', () => {
    expect(withStatus(driver() as never).status).toBe('AVAILABLE');
    expect(withStatus(driver({ currentShipmentId: 'ship-1' }) as never).status).toBe('ON_JOB');
    expect(withStatus(driver({ availability: 'OFFLINE' }) as never).status).toBe('OFFLINE');
  });
});

describe('setAvailability', () => {
  it('lets an idle driver go offline', async () => {
    const { db, update } = makeDb(driver());
    const r = await setAvailability(db, 'drv-1', 'OFFLINE');
    expect(r.status).toBe('OFFLINE');
    expect(update).toHaveBeenCalled();
  });

  it('lets a driver come online', async () => {
    const { db } = makeDb(driver({ availability: 'OFFLINE' }));
    expect((await setAvailability(db, 'drv-1', 'ONLINE')).status).toBe('AVAILABLE');
  });

  // An unvetted driver online would be assignable; approval gates the pool.
  it('refuses to bring an unapproved driver online', async () => {
    const { db, update } = makeDb(driver({ availability: 'OFFLINE', approvedAt: null }));
    await expect(setAvailability(db, 'drv-1', 'ONLINE')).rejects.toMatchObject({ statusCode: 403 });
    expect(update).not.toHaveBeenCalled();
  });

  // Going offline mid-job would strand the shipment with nobody tracking it.
  it('refuses to take a driver offline while they hold a shipment', async () => {
    const { db, update } = makeDb(driver({ currentShipmentId: 'ship-1' }));
    let thrown: unknown;
    try { await setAvailability(db, 'drv-1', 'OFFLINE'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError & { statusCode: number }).statusCode).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  // The API owns availability only; currentShipmentId belongs to the consumer.
  it('never writes currentShipmentId', async () => {
    const { db, update } = makeDb(driver());
    await setAvailability(db, 'drv-1', 'OFFLINE');
    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).not.toHaveProperty('currentShipmentId');
  });

  it('404s for an unknown driver', async () => {
    const { db } = makeDb(null);
    let thrown: unknown;
    try { await setAvailability(db, 'nope', 'ONLINE'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(NotFoundError);
  });
});

describe('listDrivers', () => {
  // Assignable means online, idle AND vetted - an unapproved driver must never
  // appear in dispatch's picker.
  it('filters on availability, job and approval when asking for available drivers', async () => {
    const { db, findMany } = makeDb(driver());
    await listDrivers(db, { available: true });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { availability: 'ONLINE', currentShipmentId: null, approvedAt: { not: null } },
    }));
  });

  it('does not filter when availability is not requested', async () => {
    const { db, findMany } = makeDb(driver());
    await listDrivers(db, {});
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('caps the page size', async () => {
    const { db, findMany } = makeDb(driver());
    await listDrivers(db, { limit: 10_000 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });
});
