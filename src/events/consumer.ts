import { Kafka, type Consumer, logLevel, type Producer } from 'kafkajs';
import { prisma } from '../db/client.js';
import { parseEvent, UnparseableEventError } from '../domain/parse.js';
import { applyJobEvent } from '../domain/jobs.js';
import { SHIPMENT_EVENTS_TOPIC, SHIPMENT_EVENTS_DLQ, CONSUMER_GROUP } from './envelope.js';
import {
  jobEventsApplied, jobEventsDuplicate, jobEventsSkipped, eventsDeadLettered, consumerLag,
} from '../metrics.js';

const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

const kafka = new Kafka({
  clientId: 'logitrack-driver-service',
  brokers,
  logLevel: logLevel.ERROR,
  retry: { initialRetryTime: 300, retries: 8 },
});

let consumer: Consumer | null = null;
let dlqProducer: Producer | null = null;
let running = false;

export const isConsumerRunning = (): boolean => running;

export async function startConsumer(): Promise<void> {
  consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
  dlqProducer = kafka.producer();

  await Promise.all([consumer.connect(), dlqProducer.connect()]);
  // Replay is safe: applying assignments in order converges on the same state,
  // and the ProcessedEvent ledger makes each one idempotent.
  await consumer.subscribe({ topic: SHIPMENT_EVENTS_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const raw = message.value;

      let env;
      try {
        env = parseEvent(raw);
      } catch (err) {
        // Unparseable never becomes parseable; retrying would block the partition.
        await deadLetter(topic, partition, message.offset, raw, err);
        return;
      }

      const result = await applyJobEvent(prisma, env);
      if (result.duplicate) jobEventsDuplicate.inc({ event_type: env.eventType });
      else if (result.applied) jobEventsApplied.inc({ event_type: env.eventType });
      else jobEventsSkipped.inc({ reason: result.reason ?? 'unknown' });

      const lagMs = Date.now() - new Date(env.occurredAt).getTime();
      consumerLag.set({ topic }, Math.max(0, lagMs) / 1000);
    },
  });
  running = true;
}

async function deadLetter(
  topic: string,
  partition: number,
  offset: string,
  raw: Buffer | null,
  err: unknown,
): Promise<void> {
  const reason = err instanceof UnparseableEventError ? err.reason : String(err);
  const payload = raw ? raw.toString('utf8').slice(0, 10_000) : '';

  await prisma.deadLetter.create({ data: { topic, partition, offset, payload, error: reason } });
  await dlqProducer?.send({
    topic: SHIPMENT_EVENTS_DLQ,
    messages: [{ value: payload, headers: { error: reason } }],
  });
  eventsDeadLettered.inc({ reason: err instanceof UnparseableEventError ? 'unparseable' : 'unknown' });
}

export async function stopConsumer(): Promise<void> {
  running = false;
  await consumer?.disconnect();
  await dlqProducer?.disconnect();
  consumer = null;
  dlqProducer = null;
}
