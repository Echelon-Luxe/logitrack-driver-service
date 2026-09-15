import { Registry, collectDefaultMetrics, Counter, Gauge } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'logitrack-driver-service' });
collectDefaultMetrics({ register: registry });

export const jobEventsApplied = new Counter({
  name: 'driver_job_events_applied_total',
  help: 'Shipment events that changed a driver job state',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

export const jobEventsDuplicate = new Counter({
  name: 'driver_job_events_duplicate_total',
  help: 'Events skipped because the eventId was already applied',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

export const jobEventsSkipped = new Counter({
  name: 'driver_job_events_skipped_total',
  help: 'Events consumed but not applicable to a driver',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const eventsDeadLettered = new Counter({
  name: 'driver_events_dead_lettered_total',
  help: 'Events parked in the dead-letter table',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const consumerLag = new Gauge({
  name: 'driver_consumer_lag_seconds',
  help: 'Seconds between event occurrence and processing',
  labelNames: ['topic'] as const,
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});
