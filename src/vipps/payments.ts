import { nestedFailureText, VippsHttpError } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { isMerchantCurrency, isMinorUnits, type MerchantCurrency } from './values.js';
import { modificationView, paymentEventsView, paymentView, UNEXPECTED_EVENTS } from './views.js';

/**
 * ePayment API: read one payment and its events; capture, refund or cancel it.
 *
 * Before a capture or a refund the payment is read, and the change is
 * refused (nothing is sent) when the currency differs from the payment's or
 * the amount is more than can be captured or refunded. Vipps MobilePay
 * checks this too; checking first gives a clear refusal and keeps a wrong
 * amount from ever being sent.
 */

/**
 * A change refused by this server before anything was sent. When a read from Vipps MobilePay failed on the way, its
 * HTTP error is the cause (the gateway gives its status and request id as failure metadata; the text is ours).
 */
export class ChangeRefusedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChangeRefusedError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function paymentPath(reference: string): string {
  return `/epayment/v1/payments/${encodePathParam(reference, 'reference')}`;
}

export async function getPayment(client: UpstreamClient, input: { reference: string; includeEvents?: boolean }): Promise<unknown> {
  const path = paymentPath(input.reference);
  // The payment and its events through the allow-lists in views.ts: never the payer's name, phone, e-mail or address.
  const payment = paymentView(await client.get(path));
  if (input.includeEvents === false) {
    return { payment };
  }
  // A combined read: the payment is returned even when its events cannot be read. Our own failure text is built
  // here and kept apart from Vipps MobilePay's answer: a failed read gives nestedFailureText (the status, or a fixed
  // text), an answer that is not a list of events gives a fixed text, and nothing of the answer is passed on then.
  const read = await client.get(`${path}/events`).then(
    body => ({ ok: true as const, body }),
    (error: unknown) => ({ ok: false as const, failure: nestedFailureText(error) }),
  );
  if (!read.ok) return { payment, events: { error: read.failure } };
  const events = paymentEventsView(read.body);
  return { payment, events: events ?? { error: UNEXPECTED_EVENTS } };
}

/** An Amount object's value in minor units, or undefined. */
function amountValue(amount: unknown): number | undefined {
  const value = asRecord(amount).value;
  return isMinorUnits(value) ? value : undefined;
}

interface PaymentFigures {
  state: string;
  currency: MerchantCurrency;
  authorized: number;
  captured: number;
  cancelled: number;
  refunded: number;
}

async function paymentFigures(client: UpstreamClient, reference: string): Promise<PaymentFigures> {
  const payment = asRecord(await client.get(paymentPath(reference)));
  const aggregate = asRecord(payment.aggregate);
  const currency = asRecord(payment.amount).currency;
  const figures = {
    state: typeof payment.state === 'string' ? payment.state : '',
    currency: typeof currency === 'string' ? currency : '',
    authorized: amountValue(aggregate.authorizedAmount),
    captured: amountValue(aggregate.capturedAmount),
    cancelled: amountValue(aggregate.cancelledAmount),
    refunded: amountValue(aggregate.refundedAmount),
  };
  const { authorized, captured, cancelled, refunded } = figures;
  if (
    !isMerchantCurrency(figures.currency) ||
    authorized === undefined ||
    captured === undefined ||
    cancelled === undefined ||
    refunded === undefined ||
    // The sums must hold together: nothing captured or cancelled beyond what was authorized, nothing refunded
    // beyond what was captured.
    captured + cancelled > authorized ||
    refunded > captured
  ) {
    throw new ChangeRefusedError('Refused: the payment could not be read in the expected form, so nothing was sent.');
  }
  return figures as PaymentFigures;
}

export interface MoneyChangeInput {
  reference: string;
  amount: number;
  currency: MerchantCurrency;
  /** Chosen by the caller, logged before the call, and reused when the same change is repeated. */
  idempotencyKey: string;
}

function checkCurrency(figures: { currency: MerchantCurrency }, currency: MerchantCurrency): void {
  if (figures.currency !== currency) {
    // Fixed text, our own enum values only.
    throw new ChangeRefusedError(`Refused: the payment is in ${figures.currency}, not ${currency}. Nothing was sent.`);
  }
}

/**
 * The earlier, successful event of this very change, when one exists: an
 * event of the payment with the same Idempotency-Key, the expected name, the
 * same amount and currency, and success true. Used only when the amount check
 * would refuse a call: a retry of a change that was carried out, whose answer
 * was lost, then learns that it was done instead of being refused.
 */
async function earlierEvent(
  client: UpstreamClient,
  input: MoneyChangeInput,
  name: 'CAPTURED' | 'REFUNDED',
): Promise<{
  done?: { name: string; amount: { currency: MerchantCurrency; value: number }; timestamp: string | null };
  readError?: VippsHttpError;
}> {
  // When the events cannot be read, the change is refused as before: nothing is sent either way. An HTTP error of
  // that read is kept, so the refusal can carry it as its cause.
  let readError: VippsHttpError | undefined;
  const events = await client.get(`${paymentPath(input.reference)}/events`).catch((error: unknown) => {
    if (error instanceof VippsHttpError) readError = error;
    return undefined;
  });
  if (!Array.isArray(events)) return { readError };
  for (const entry of events) {
    const event = asRecord(entry);
    const amount = asRecord(event.amount);
    if (
      event.idempotencyKey === input.idempotencyKey &&
      event.name === name &&
      event.success === true &&
      amount.value === input.amount &&
      amount.currency === input.currency
    ) {
      const timestamp = typeof event.timestamp === 'string' && /^[\dT:.+Z-]{10,40}$/.test(event.timestamp) ? event.timestamp : null;
      return { done: { name, amount: { currency: input.currency, value: input.amount }, timestamp } };
    }
  }
  return {};
}

export async function capturePayment(client: UpstreamClient, input: MoneyChangeInput): Promise<unknown> {
  const figures = await paymentFigures(client, input.reference);
  if (figures.state !== 'AUTHORIZED') {
    throw new ChangeRefusedError('Refused: only an authorized payment can be captured. Nothing was sent.');
  }
  checkCurrency(figures, input.currency);
  const capturable = figures.authorized - figures.captured - figures.cancelled;
  if (input.amount > capturable) {
    const { done, readError } = await earlierEvent(client, input, 'CAPTURED');
    if (done) return { idempotencyKey: input.idempotencyKey, alreadyDone: true, event: done };
    throw new ChangeRefusedError(
      `Refused: ${input.amount} is more than the ${Math.max(0, capturable)} (minor units) left to capture. Nothing was sent.`,
      readError ? { cause: readError } : undefined,
    );
  }
  const payment = await client.post(
    `${paymentPath(input.reference)}/capture`,
    { modificationAmount: { currency: input.currency, value: input.amount } },
    { idempotencyKey: input.idempotencyKey },
  );
  // Through the allow-list, like a payment that is read: never the metadata of the request that created the payment.
  return { idempotencyKey: input.idempotencyKey, payment: modificationView(payment) };
}

export async function refundPayment(client: UpstreamClient, input: MoneyChangeInput): Promise<unknown> {
  const figures = await paymentFigures(client, input.reference);
  checkCurrency(figures, input.currency);
  const refundable = figures.captured - figures.refunded;
  if (input.amount > refundable) {
    const { done, readError } = await earlierEvent(client, input, 'REFUNDED');
    if (done) return { idempotencyKey: input.idempotencyKey, alreadyDone: true, event: done };
    throw new ChangeRefusedError(
      `Refused: ${input.amount} is more than the ${Math.max(0, refundable)} (minor units) captured and not yet refunded. Nothing was sent.`,
      readError ? { cause: readError } : undefined,
    );
  }
  const payment = await client.post(
    `${paymentPath(input.reference)}/refund`,
    { modificationAmount: { currency: input.currency, value: input.amount } },
    { idempotencyKey: input.idempotencyKey },
  );
  // Through the allow-list, like a payment that is read: never the metadata of the request that created the payment.
  return { idempotencyKey: input.idempotencyKey, payment: modificationView(payment) };
}

export async function cancelPayment(
  client: UpstreamClient,
  input: { reference: string; cancelTransactionOnly?: boolean; idempotencyKey: string },
): Promise<unknown> {
  const payment = await client.post(
    `${paymentPath(input.reference)}/cancel`,
    input.cancelTransactionOnly === undefined ? {} : { cancelTransactionOnly: input.cancelTransactionOnly },
    { idempotencyKey: input.idempotencyKey },
  );
  // Through the allow-list, like a payment that is read: never the metadata of the request that created the payment.
  return { idempotencyKey: input.idempotencyKey, payment: modificationView(payment) };
}
