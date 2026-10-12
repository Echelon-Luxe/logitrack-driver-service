import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  createDriver, getDriver, getDriverByUser, listDrivers, setAvailability, approveDriver, updateDriver, NotFoundError,
} from '../domain/drivers.js';
import { identity, requireRole, hasRole, isStaff, ForbiddenError, OPERATORS, STAFF, type Identity } from '../authz.js';

const IdParam = z.object({ id: z.string().uuid() });
const Phone = z.string().trim().min(5).max(32);

// Query strings are text: z.coerce.boolean() turns "false" into true, which
// made ?available=false return only available drivers.
const Bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const defined = <T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;

// A driver acts on their own profile; operators act on anyone's.
async function loadForWrite(id: Identity, driverId: string) {
  const d = await getDriver(prisma, driverId);
  if (hasRole(id, OPERATORS)) return d;
  if (id.role === 'DRIVER' && d.userId === id.userId) return d;
  // Others get 404 so ids cannot be probed.
  if (!isStaff(id)) throw new NotFoundError(driverId);
  throw new ForbiddenError('Support is read-only');
}

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  // Drivers onboard themselves; the profile is bound to the caller's own user
  // id, so nobody can create a profile for someone else's account. Operators
  // may create one on a driver's behalf.
  app.post('/drivers', async (req, reply) => {
    const id = identity(req);
    const body = z.object({
      userId: z.string().min(1).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      vehicleType: z.string().trim().min(1).max(60),
      plateNumber: z.string().trim().max(20).optional(),
      phone: Phone.optional(),
    }).parse(req.body);

    let userId: string;
    if (id.role === 'DRIVER') userId = id.userId;
    else if (hasRole(id, OPERATORS) && body.userId) userId = body.userId;
    else throw new ForbiddenError('Only drivers can create a driver profile');

    const name = body.name ?? (id.role === 'DRIVER' ? id.name : '');
    if (!name) throw new ForbiddenError('A name is required');
    const driver = await createDriver(prisma, defined({
      userId, name, vehicleType: body.vehicleType, plateNumber: body.plateNumber, phone: body.phone,
    }));
    return reply.code(201).send(driver);
  });

  app.get('/drivers', async (req) => {
    requireRole(identity(req), STAFF);
    const q = z.object({
      available: Bool.optional(),
      pending: Bool.optional(),
      q: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }).parse(req.query);
    return listDrivers(prisma, defined(q));
  });

  app.get('/drivers/me', async (req, reply) => {
    const id = identity(req);
    const d = await getDriverByUser(prisma, id.userId);
    // 404 is the onboarding signal for the UI, not an error.
    if (!d) return reply.code(404).send({ error: 'NotFound', message: 'No driver profile yet' });
    return d;
  });

  app.get('/drivers/:id', async (req) => {
    const id = identity(req);
    const { id: driverId } = IdParam.parse(req.params);
    const d = await getDriver(prisma, driverId);
    if (isStaff(id) || (id.role === 'DRIVER' && d.userId === id.userId)) return d;
    throw new NotFoundError(driverId);
  });

  app.patch('/drivers/:id', async (req) => {
    const id = identity(req);
    const { id: driverId } = IdParam.parse(req.params);
    await loadForWrite(id, driverId);
    const body = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      vehicleType: z.string().trim().min(1).max(60).optional(),
      plateNumber: z.string().trim().max(20).nullable().optional(),
      phone: Phone.nullable().optional(),
    }).strict().parse(req.body);
    return updateDriver(prisma, driverId, defined(body));
  });

  app.post('/drivers/:id/approve', async (req) => {
    const id = identity(req);
    requireRole(id, OPERATORS);
    const { id: driverId } = IdParam.parse(req.params);
    const { approved } = z.object({ approved: z.boolean().default(true) }).parse(req.body ?? {});
    return approveDriver(prisma, driverId, approved, id.userId);
  });

  app.post('/drivers/:id/availability', async (req) => {
    const id = identity(req);
    const { id: driverId } = IdParam.parse(req.params);
    await loadForWrite(id, driverId);
    const { availability } = z.object({
      availability: z.enum(['ONLINE', 'OFFLINE']),
    }).parse(req.body);
    return setAvailability(prisma, driverId, availability);
  });
}
