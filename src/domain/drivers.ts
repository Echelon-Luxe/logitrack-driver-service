import type { PrismaClient, Driver } from '@prisma/client';
import { effectiveStatus, type DriverStatus } from './status.js';

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Driver ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export type DriverView = Driver & { status: DriverStatus };

export const withStatus = (d: Driver): DriverView => ({ ...d, status: effectiveStatus(d) });

export async function createDriver(
  db: PrismaClient,
  input: { userId: string; name: string; vehicleType: string },
): Promise<DriverView> {
  return withStatus(await db.driver.create({ data: input }));
}

export async function getDriver(db: PrismaClient, id: string): Promise<DriverView> {
  const d = await db.driver.findUnique({ where: { id } });
  if (!d) throw new NotFoundError(id);
  return withStatus(d);
}

export async function listDrivers(
  db: PrismaClient,
  filter: { available?: boolean; limit?: number },
): Promise<DriverView[]> {
  const rows = await db.driver.findMany({
    where: filter.available
      ? { availability: 'ONLINE', currentShipmentId: null }
      : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 50, 200),
  });
  return rows.map(withStatus);
}

// Driver-controlled. Deliberately does not touch currentShipmentId.
export async function setAvailability(
  db: PrismaClient,
  id: string,
  availability: 'ONLINE' | 'OFFLINE',
): Promise<DriverView> {
  const d = await db.driver.findUnique({ where: { id } });
  if (!d) throw new NotFoundError(id);

  // Going offline mid-job would strand the shipment with nobody tracking it.
  if (availability === 'OFFLINE' && d.currentShipmentId) {
    throw new ConflictError(
      `Driver is on shipment ${d.currentShipmentId}; complete or cancel it before going offline`,
    );
  }
  return withStatus(await db.driver.update({ where: { id }, data: { availability } }));
}
