import { z } from 'zod';

/**
 * The event envelope every RoofOps workflow boundary validates (architecture.md §5).
 * Phase 1 defines the contract and its fixtures; Phase 2 enforces it at the webhook.
 */
export const EventEnvelope = z.object({
  event_id: z.string().min(1),
  correlation_id: z.string().min(1),
  causation_id: z.string().min(1).nullable().optional(),
  event_type: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/, 'event_type must look like "entity.action"'),
  entity_type: z.enum(['quote', 'project', 'purchase_order', 'invoice', 'customer', 'supplier_quote']),
  entity_id: z.string().min(1),
  actor_type: z.enum(['USER', 'SYSTEM', 'AI', 'INTEGRATION', 'WORKFLOW']),
  actor_id: z.string().min(1),
  source: z.string().min(1),
  workflow_version: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** quote.accepted payload: the business fact that drives Quote -> Project (Module 1). */
export const QuoteAcceptedPayload = z.object({
  quote_id: z.string().regex(/^Q-\d{4}-\d{4}$/),
  accepted_version: z.number().int().positive(),
  accepted_on: z.iso.date(),
  airtable_record_id: z.string().optional(),
}).strict();

export const QuoteAcceptedEvent = EventEnvelope.extend({
  event_type: z.literal('quote.accepted'),
  entity_type: z.literal('quote'),
  payload: QuoteAcceptedPayload,
});

/** Idempotency key for quote.accepted: the business fact, not the delivery (ADR-002). */
export function quoteAcceptedIdempotencyKey(e: z.infer<typeof QuoteAcceptedEvent>): string {
  return `quote.accepted:${e.payload.quote_id}:v${e.payload.accepted_version}`;
}
