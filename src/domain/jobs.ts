import type { PrismaClient } from '@prisma/client';
import type { EventEnvelope, ShipmentEventPayload } from '../events/envelope.js';
import { jobEffect } from './parse.js';

export interface ApplyResult {
  applied: boolean;
  duplicate: boolean;
  reason?: string;
}

// Unlike tracking/notification there is no per-event row to dedup on - the
// consumer mutates an existing driver. A ProcessedEvent ledger written in the
// same transaction as the mutation gives the same guarantee: the insert fails
// on redelivery, so the mutation rolls back with it.
export async function applyJobEvent(
  db: PrismaClient,
  env: EventEnvelope<ShipmentEventPayload>,
): Promise<ApplyResult> {
  const effect = jobEffect(env.eventType);
  if (effect === 'IGNORE') return { applied: false, duplicate: false, reason: 'not a job event' };

  const driverId = env.payload.driverId;
  if (!driverId) return { applied: false, duplicate: false, reason: 'no driver on event' };

  try {
    return await db.$transaction(async (tx) => {
      await tx.processedEvent.create({
        data: { eventId: env.eventId, eventType: env.eventType },
      });

      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) return { applied: false, duplicate: false, reason: 'unknown driver' };

      if (effect === 'ASSIGN') {
        await tx.driver.update({
          where: { id: driverId },
          data: { currentShipmentId: env.payload.shipmentId },
        });
      } else {
        // Clear only if it is still this shipment. Out-of-order delivery of an
        // old RELEASE must not free a driver from their current job.
        await tx.driver.updateMany({
          where: { id: driverId, currentShipmentId: env.payload.shipmentId },
          data: { currentShipmentId: null },
        });
      }
      return { applied: true, duplicate: false };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { applied: false, duplicate: true };
    throw err;
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
