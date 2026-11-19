/**
 * What the read tools pass on of a payment, its events and an agreement: a
 * deep allow-list with a type for every field, on every level. A field is
 * passed on only when it is named here and its value has the named type; a
 * nested object only through its own list. Vipps MobilePay's ePayment answer
 * can carry the payer's name, phone number, e-mail and address
 * (`userDetails`, `shippingDetails`) and a user id (`profile.sub`); a
 * Recurring agreement can carry the user id and a userinfo address (`sub`,
 * `userinfoUrl`). None of that is passed on, wherever it is placed, and a
 * field Vipps MobilePay adds later is left out until it is added here.
 *
 * An answer that is not the expected object (or list) is refused with a fixed
 * text, never passed on as an empty result.
 */

/** The type of one field: a scalar, or an object with its own allow-list. */
type FieldType = 'string' | 'integer' | 'boolean' | { readonly [field: string]: FieldType };

/** The longest text passed on in one field; longer texts are left out. */
const MAX_TEXT = 500;

/** The value when it has the type; otherwise undefined (left out). */
function typed(value: unknown, type: FieldType): unknown {
  if (type === 'string') return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined;
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [field, fieldType] of Object.entries(type)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const kept = typed(source[field], fieldType);
    if (kept !== undefined) out[field] = kept;
  }
  return out;
}

const AMOUNT = { currency: 'string', value: 'integer' } as const;

const PAYMENT = {
  reference: 'string',
  pspReference: 'string',
  state: 'string',
  amount: AMOUNT,
  aggregate: { authorizedAmount: AMOUNT, cancelledAmount: AMOUNT, capturedAmount: AMOUNT, refundedAmount: AMOUNT },
  paymentMethod: { type: 'string' },
} as const;

const PAYMENT_EVENT = {
  reference: 'string',
  pspReference: 'string',
  name: 'string',
  amount: AMOUNT,
  timestamp: 'string',
  idempotencyKey: 'string',
  success: 'boolean',
} as const;

const PERIOD = { unit: 'string', count: 'integer' } as const;

const AGREEMENT = {
  id: 'string',
  status: 'string',
  productName: 'string',
  productDescription: 'string',
  pricing: { type: 'string', currency: 'string', amount: 'integer', suggestedMaxAmount: 'integer', maxAmount: 'integer' },
  interval: PERIOD,
  created: 'string',
  start: 'string',
  stop: 'string',
  externalId: 'string',
  campaign: { type: 'string', price: 'integer', end: 'string', from: 'string', period: PERIOD },
} as const;

/** The refusal of an answer that is not in the form the API documents. Fixed text: nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor(what: string) {
    super(`Vipps MobilePay answered ${what} in an unexpected form.`);
    this.name = 'UnexpectedAnswerError';
  }
}

/** The fixed text of an events answer that is not a list of events. */
export const UNEXPECTED_EVENTS = 'Vipps MobilePay answered the events in an unexpected form.';

/** A payment through the allow-list. Refused unless it has a reference and a state. */
export function paymentView(payment: unknown): Record<string, unknown> {
  const out = typed(payment, PAYMENT) as Record<string, unknown> | undefined;
  if (!out || typeof out.reference !== 'string' || typeof out.state !== 'string') throw new UnexpectedAnswerError('the payment');
  return out;
}

/** A list of events through the allow-list, or undefined when the answer is not a list of objects. */
export function paymentEventsView(events: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(events)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const kept = typed(event, PAYMENT_EVENT) as Record<string, unknown> | undefined;
    if (!kept) return undefined;
    out.push(kept);
  }
  return out;
}

/** An agreement through the allow-list. Refused unless it is an object with an id. */
export function agreementView(agreement: unknown): Record<string, unknown> {
  const out = typed(agreement, AGREEMENT) as Record<string, unknown> | undefined;
  if (!out || typeof out.id !== 'string') throw new UnexpectedAnswerError('an agreement');
  return out;
}
