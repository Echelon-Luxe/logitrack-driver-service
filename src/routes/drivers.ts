import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { createDriver, getDriver, listDrivers, setAvailability } from '../domain/drivers.js';

const IdParam = z.object({ id: z.string().uuid() });

export async function driverRoutes(app: FastifyInstance): Promise<void> {
  app.post('/drivers', async (req, reply) => {
    const body = z.object({
      userId: z.string().min(1),
      name: z.string().min(1).max(120),
      vehicleType: z.string().min(1).max(60),
    }).parse(req.body);
    return reply.code(201).send(await createDriver(prisma, body));
  });

  app.get('/drivers', async (req) => {
    const q = z.object({
      available: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }).parse(req.query);
    return listDrivers(prisma, {
      ...(q.available !== undefined ? { available: q.available } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
  });

  app.get('/drivers/:id', async (req) => {
    const { id } = IdParam.parse(req.params);
    return getDriver(prisma, id);
  });

  app.post('/drivers/:id/availability', async (req) => {
    const { id } = IdParam.parse(req.params);
    const { availability } = z.object({
      availability: z.enum(['ONLINE', 'OFFLINE']),
    }).parse(req.body);
    return setAvailability(prisma, id, availability);
  });
}
