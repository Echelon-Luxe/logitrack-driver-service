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

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export async function createDriver(
  db: PrismaClient,
  input: { userId: string; name: string; vehicleType: string; plateNumber?: string; phone?: string },
): Promise<DriverView> {
  // One profile per user. Checked up front for a readable error; the unique
  // index on userId still guards the race.
  if (await db.driver.findUnique({ where: { userId: input.userId } })) {
    throw new ConflictError('A driver profile already exists for this account');
  }
  return withStatus(await db.driver.create({ data: input }));
}

export async function getDriverByUser(db: PrismaClient, userId: string): Promise<DriverView | null> {
  const d = await db.driver.findUnique({ where: { userId } });
  return d ? withStatus(d) : null;
}

export async function approveDriver(
  db: PrismaClient,
  id: string,
  approved: boolean,
  by: string,
): Promise<DriverView> {
  const d = await db.driver.findUnique({ where: { id } });
  if (!d) throw new NotFoundError(id);
  if (!approved && d.currentShipmentId) {
    throw new ConflictError('Driver is on a job; reassign or finish it before revoking approval');
  }
  return withStatus(await db.driver.update({
    where: { id },
    data: approved
      ? { approvedAt: d.approvedAt ?? new Date(), approvedBy: d.approvedBy ?? by }
      // Revoking also takes them offline, so they drop out of the assignable pool at once.
      : { approvedAt: null, approvedBy: null, availability: 'OFFLINE' },
  }));
}

export async function updateDriver(
  db: PrismaClient,
  id: string,
  patch: { name?: string; vehicleType?: string; plateNumber?: string | null; phone?: string | null },
): Promise<DriverView> {
  const d = await db.driver.findUnique({ where: { id } });
  if (!d) throw new NotFoundError(id);
  return withStatus(await db.driver.update({ where: { id }, data: patch }));
}

export async function getDriver(db: PrismaClient, id: string): Promise<DriverView> {
  const d = await db.driver.findUnique({ where: { id } });
  if (!d) throw new NotFoundError(id);
  return withStatus(d);
}

export async function listDrivers(
  db: PrismaClient,
  filter: { available?: boolean; pending?: boolean; q?: string; limit?: number },
): Promise<DriverView[]> {
  const rows = await db.driver.findMany({
    where: {
      // Assignable = approved, online and idle.
      ...(filter.available === true ? { availability: 'ONLINE' as const, currentShipmentId: null, approvedAt: { not: null } } : {}),
      ...(filter.pending === true ? { approvedAt: null } : {}),
      ...(filter.q
        ? {
            OR: [
              { name: { contains: filter.q, mode: 'insensitive' as const } },
              { plateNumber: { contains: filter.q, mode: 'insensitive' as const } },
              { vehicleType: { contains: filter.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
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

  if (availability === 'ONLINE' && !d.approvedAt) {
    throw new ForbiddenError('Your driver profile is awaiting approval from dispatch');
  }

  // Going offline mid-job would strand the shipment with nobody tracking it.
  if (availability === 'OFFLINE' && d.currentShipmentId) {
    throw new ConflictError(
      `Driver is on shipment ${d.currentShipmentId}; complete or cancel it before going offline`,
    );
  }
  return withStatus(await db.driver.update({ where: { id }, data: { availability } }));
}
