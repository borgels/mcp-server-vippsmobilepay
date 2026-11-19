/**
 * What the read tools pass on of a payment, its events and an agreement: an
 * allow-list of the fields that describe the money and the state, never the
 * customer. Vipps MobilePay's ePayment answer can carry the payer's name,
 * phone number, e-mail and address (`userDetails`, `shippingDetails`) and a
 * user id (`profile.sub`); a Recurring agreement can carry the user id and a
 * userinfo address (`sub`, `userinfoUrl`). None of that is passed on, and a
 * field Vipps MobilePay adds later is left out until it is added here.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

/** The payment's own fields: references, state and amounts. The payment method only by its type. */
export const PAYMENT_FIELDS = ['reference', 'pspReference', 'state', 'amount', 'aggregate'] as const;

/** An event of a payment: what happened, when and for how much. */
export const PAYMENT_EVENT_FIELDS = ['reference', 'pspReference', 'name', 'amount', 'timestamp', 'idempotencyKey', 'success'] as const;

/** An agreement's terms and state. */
export const AGREEMENT_FIELDS = [
  'id',
  'status',
  'productName',
  'productDescription',
  'pricing',
  'interval',
  'created',
  'start',
  'stop',
  'externalId',
  'campaign',
] as const;

export function paymentView(payment: unknown): Record<string, unknown> {
  const source = asRecord(payment);
  const out = pick(source, PAYMENT_FIELDS);
  const type = asRecord(source.paymentMethod).type;
  if (typeof type === 'string') out.paymentMethod = { type };
  return out;
}

/** A list of events, each reduced to PAYMENT_EVENT_FIELDS; a read failure (`{ error }`) as it is. */
export function paymentEventsView(events: unknown): unknown {
  if (Array.isArray(events)) return events.map(event => pick(asRecord(event), PAYMENT_EVENT_FIELDS));
  const record = asRecord(events);
  return typeof record.error === 'string' ? { error: record.error } : [];
}

export function agreementView(agreement: unknown): Record<string, unknown> {
  return pick(asRecord(agreement), AGREEMENT_FIELDS);
}
