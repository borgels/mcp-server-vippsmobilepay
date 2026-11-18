import { nestedFailureText } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import type { MerchantCurrency } from './values.js';

/**
 * ePayment API: read one payment and its events; capture, refund or cancel it.
 *
 * Before a capture or a refund the payment is read, and the change is
 * refused (nothing is sent) when the currency differs from the payment's or
 * the amount is more than can be captured or refunded. Vipps MobilePay
 * checks this too; checking first gives a clear refusal and keeps a wrong
 * amount from ever being sent.
 */

/** A change refused by this server before anything was sent. */
export class ChangeRefusedError extends Error {
  constructor(message: string) {
    super(message);
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
  const payment = await client.get(path);
  if (input.includeEvents === false) {
    return { payment };
  }
  // A combined read: the payment is returned even when its events cannot be read. The failure is kept as
  // nestedFailureText (the status, or a fixed text), never as the error's own message.
  const events = await client.get(`${path}/events`).then(
    body => body,
    (error: unknown) => ({ error: nestedFailureText(error) }),
  );
  return { payment, events };
}

/** An Amount object's value in minor units, or undefined. */
function amountValue(amount: unknown): number | undefined {
  const value = asRecord(amount).value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface PaymentFigures {
  state: string;
  currency: string;
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
  if (
    !figures.currency ||
    figures.authorized === undefined ||
    figures.captured === undefined ||
    figures.cancelled === undefined ||
    figures.refunded === undefined
  ) {
    throw new ChangeRefusedError('Refused: the payment could not be read in the expected form, so nothing was sent.');
  }
  return figures as PaymentFigures;
}

export interface MoneyChangeInput {
  reference: string;
  amount: number;
  currency: MerchantCurrency;
  idempotencyKey?: string;
}

function checkCurrency(figures: { currency: string }, currency: string): void {
  if (figures.currency !== currency) {
    throw new ChangeRefusedError(
      `Refused: the payment is in ${figures.currency}, not ${currency}. Nothing was sent.`,
    );
  }
}

export async function capturePayment(client: UpstreamClient, input: MoneyChangeInput): Promise<unknown> {
  const figures = await paymentFigures(client, input.reference);
  if (figures.state !== 'AUTHORIZED') {
    throw new ChangeRefusedError('Refused: only an authorized payment can be captured. Nothing was sent.');
  }
  checkCurrency(figures, input.currency);
  const capturable = figures.authorized - figures.captured - figures.cancelled;
  if (input.amount > capturable) {
    throw new ChangeRefusedError(
      `Refused: ${input.amount} is more than the ${Math.max(0, capturable)} (minor units) left to capture. Nothing was sent.`,
    );
  }
  return client.post(
    `${paymentPath(input.reference)}/capture`,
    { modificationAmount: { currency: input.currency, value: input.amount } },
    { idempotencyKey: input.idempotencyKey },
  );
}

export async function refundPayment(client: UpstreamClient, input: MoneyChangeInput): Promise<unknown> {
  const figures = await paymentFigures(client, input.reference);
  checkCurrency(figures, input.currency);
  const refundable = figures.captured - figures.refunded;
  if (input.amount > refundable) {
    throw new ChangeRefusedError(
      `Refused: ${input.amount} is more than the ${Math.max(0, refundable)} (minor units) captured and not yet refunded. Nothing was sent.`,
    );
  }
  return client.post(
    `${paymentPath(input.reference)}/refund`,
    { modificationAmount: { currency: input.currency, value: input.amount } },
    { idempotencyKey: input.idempotencyKey },
  );
}

export async function cancelPayment(
  client: UpstreamClient,
  input: { reference: string; cancelTransactionOnly?: boolean; idempotencyKey?: string },
): Promise<unknown> {
  return client.post(
    `${paymentPath(input.reference)}/cancel`,
    input.cancelTransactionOnly === undefined ? {} : { cancelTransactionOnly: input.cancelTransactionOnly },
    { idempotencyKey: input.idempotencyKey },
  );
}
