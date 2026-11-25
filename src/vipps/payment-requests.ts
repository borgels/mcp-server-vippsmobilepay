import { CustomerLink, VippsHttpError, withNote } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { ChangeRefusedError } from './payments.js';
import { derivedIdempotencyKey, timestampMs, type MerchantCurrency } from './values.js';

/**
 * ePayment API: a new payment request (create_payment).
 *
 * The request moves no money: the customer approves it in the Vipps or
 * MobilePay app, the amount is then reserved, and a capture draws it.
 *
 * The Idempotency-Key is not the caller's to choose. It is derived from the
 * request's own content (the sales unit and the whole body, the business's
 * own reference among it), so the same request is the same key however often
 * it is repeated, and Vipps MobilePay creates it once. The reference is a
 * second guard: Vipps MobilePay accepts a reference once per sales unit.
 * Nothing is kept between calls.
 */

/** How the request reaches the customer, and the ePayment userFlow each one is. */
export const PAYMENT_DELIVERIES = ['link', 'qr', 'phone'] as const;
export type PaymentDelivery = (typeof PAYMENT_DELIVERIES)[number];
const USER_FLOWS: Readonly<Record<PaymentDelivery, string>> = { link: 'WEB_REDIRECT', qr: 'QR', phone: 'PUSH_MESSAGE' };

/** The formats Vipps MobilePay gives a QR code in: an image to show, or the address the code holds. */
export const QR_FORMATS = ['IMAGE/PNG', 'IMAGE/SVG+XML', 'TEXT/TARGETURL'] as const;

/** Minutes a customer has to approve a request without expiresAt (Vipps MobilePay's default timeout). */
export const DEFAULT_APPROVAL_MINUTES = 10;
/** The bounds of expiresAt: more than 10 minutes and less than 60 days ahead. */
export const MIN_EXPIRY_MS = 10 * 60_000;
export const MAX_EXPIRY_MS = 60 * 86_400_000;
/** The smallest amount per currency, in minor units (NOK: 1 krone). */
const MINIMUM_AMOUNT: Readonly<Record<MerchantCurrency, number>> = { NOK: 100, DKK: 1, EUR: 1 };
/** The most order lines taken in one request (our own limit). */
export const MAX_ORDER_LINES = 100;

export interface OrderLineInput {
  name: string;
  id: string;
  totalAmount: number;
  totalAmountExcludingTax: number;
  totalTaxAmount: number;
  /** VAT rate in hundredths of a percent: 25 % is 2500. */
  taxRate: number;
  productUrl?: string;
}

export interface CreatePaymentInput {
  /** The business's own order or invoice number: the ePayment reference, shown to the customer. */
  reference: string;
  amount: number;
  currency: MerchantCurrency;
  /** Shown to the customer on the payment screen. */
  description: string;
  delivery: PaymentDelivery;
  /** Only with delivery phone. Sent to Vipps MobilePay and nowhere else. */
  phoneNumber?: string;
  returnUrl?: string;
  expiresAt?: string;
  orderLines?: OrderLineInput[];
  receiptNumber?: string;
  customerPresent?: boolean;
  qrFormat?: (typeof QR_FORMATS)[number];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * What the fields of a request must be together, which the input schema
 * cannot say. Returns a refusal in our own words (never a value of the
 * input), or undefined.
 */
export function checkCreatePayment(input: Record<string, unknown>, now: number = Date.now()): string | undefined {
  const { delivery, currency, amount } = input as unknown as CreatePaymentInput;
  if (delivery === 'phone' && input.phoneNumber === undefined) return 'delivery phone needs phoneNumber.';
  if (delivery !== 'phone' && input.phoneNumber !== undefined) return 'phoneNumber is only for delivery phone.';
  if (delivery === 'link' && input.returnUrl === undefined) return 'delivery link needs returnUrl.';
  if (delivery !== 'qr' && input.qrFormat !== undefined) return 'qrFormat is only for delivery qr.';
  if (amount < MINIMUM_AMOUNT[currency]) return `The smallest amount in ${currency} is ${MINIMUM_AMOUNT[currency]} (minor units).`;
  const lines = input.orderLines as OrderLineInput[] | undefined;
  if (input.receiptNumber !== undefined && lines === undefined) return 'receiptNumber needs orderLines.';
  if (lines !== undefined) {
    let sum = 0;
    for (const line of lines) {
      if (line.totalAmount !== line.totalAmountExcludingTax + line.totalTaxAmount) {
        return 'An order line does not add up: totalAmount must be totalAmountExcludingTax plus totalTaxAmount.';
      }
      sum += line.totalAmount;
    }
    if (sum !== amount) return 'The order lines do not add up to the amount.';
  }
  if (input.expiresAt !== undefined) {
    const expires = timestampMs(input.expiresAt);
    if (expires === undefined || expires - now <= MIN_EXPIRY_MS || expires - now >= MAX_EXPIRY_MS) {
      return 'expiresAt must be more than 10 minutes and less than 60 days ahead.';
    }
    if (lines === undefined) return 'A request with expiresAt needs orderLines: Vipps MobilePay requires what is sold to be shown.';
  }
  return undefined;
}

/** The body of the create request: only fields the input has, in the API's own names. */
function createBody(input: CreatePaymentInput): Record<string, unknown> {
  return {
    amount: { currency: input.currency, value: input.amount },
    paymentMethod: { type: 'WALLET' },
    reference: input.reference,
    userFlow: USER_FLOWS[input.delivery],
    paymentDescription: input.description,
    ...(input.phoneNumber === undefined ? {} : { customer: { phoneNumber: input.phoneNumber } }),
    ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.customerPresent === true ? { customerInteraction: 'CUSTOMER_PRESENT' } : {}),
    ...(input.qrFormat === undefined ? {} : { qrFormat: { format: input.qrFormat } }),
    ...(input.orderLines === undefined
      ? {}
      : {
          receipt: {
            orderLines: input.orderLines.map(line => ({
              name: line.name,
              id: line.id,
              totalAmount: line.totalAmount,
              totalAmountExcludingTax: line.totalAmountExcludingTax,
              totalTaxAmount: line.totalTaxAmount,
              taxRate: line.taxRate,
              ...(line.productUrl === undefined ? {} : { productUrl: line.productUrl }),
            })),
            bottomLine: { currency: input.currency, ...(input.receiptNumber === undefined ? {} : { receiptNumber: input.receiptNumber }) },
          },
        }),
  };
}

const NOTHING_CREATED = 'Nothing was created.';
const REPEAT_SAME_INPUT =
  'Call again with exactly the same input: the same Idempotency-Key is sent, so the request is created at most once. Do not change the reference to try again.';
const OUTCOME_UNKNOWN = `It is not known whether the request was created. ${REPEAT_SAME_INPUT}`;
const PHONE_REFUSALS =
  'A request to a phone number is refused when Vipps MobilePay has not approved the sales unit for it, when the number is not written as digits with its country code, or when it belongs to no user who can pay this business. A link or a QR code needs no approval.';
const EXPIRY_REFUSALS =
  'A request with expiresAt is refused when Vipps MobilePay has not enabled a longer deadline for the sales unit, or when the deadline is longer than the sales unit may use.';
const CURRENCY_REFUSAL = 'The currency must be the one the sales unit is registered with.';

/** Our own note for an HTTP error of the create request: what the status means here. Never anything of the answer or the input. */
function createNote(status: number, input: CreatePaymentInput): string {
  if (status === 429 || status === 423) return `${NOTHING_CREATED} After the wait: ${REPEAT_SAME_INPUT}`;
  if (status === 408 || status >= 500) return OUTCOME_UNKNOWN;
  return [
    NOTHING_CREATED,
    status === 400 && input.delivery === 'phone' ? PHONE_REFUSALS : undefined,
    status === 400 && input.expiresAt !== undefined ? EXPIRY_REFUSALS : undefined,
    status === 400 ? CURRENCY_REFUSAL : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

const PAYMENT_STATES: ReadonlySet<string> = new Set(['CREATED', 'ABORTED', 'EXPIRED', 'AUTHORIZED', 'TERMINATED']);

const EXISTING = 'A payment with this reference, amount and currency already exists, so nothing new was created.';
/** What an existing payment's state means for the caller, in our own words. */
const EXISTING_NOTES: Readonly<Record<string, string>> = {
  CREATED: `${EXISTING} The customer has not approved it yet.`,
  AUTHORIZED: `${EXISTING} The customer has approved it: the amount is reserved, and capture_payment draws it.`,
};
const EXISTING_ENDED = `${EXISTING} It can no longer be paid: a new request needs another reference of the business's own.`;

/**
 * The payment that already has the reference, when Vipps MobilePay refused
 * the create request (HTTP 400 or 409) and one exists. Read only then: a
 * repeat of a request that was carried out, whose answer was lost, then gets
 * the payment and its link instead of a refusal that invites a new reference.
 * A payment with another amount or currency is another request: refused.
 */
async function existingPayment(client: UpstreamClient, input: CreatePaymentInput, refusal: VippsHttpError): Promise<unknown> {
  const path = `/epayment/v1/payments/${encodePathParam(input.reference, 'reference')}`;
  const payment = asRecord(await client.get(path).catch(() => undefined));
  const state = typeof payment.state === 'string' && PAYMENT_STATES.has(payment.state) ? payment.state : undefined;
  if (payment.reference !== input.reference || state === undefined) return undefined;
  const amount = asRecord(payment.amount);
  if (amount.value !== input.amount || amount.currency !== input.currency) {
    throw new ChangeRefusedError(
      'Refused: the reference is already used by a payment with another amount or currency. Nothing was created. A reference is used once per sales unit: use the number the business itself has for this request.',
      { cause: refusal },
    );
  }
  // The link only while the customer can still use it.
  const link = state === 'CREATED' && input.delivery !== 'phone' ? CustomerLink.from(payment.redirectUrl) : undefined;
  return {
    created: false,
    alreadyExists: true,
    reference: input.reference,
    state,
    amount: { currency: input.currency, value: input.amount },
    ...(link ? { link } : {}),
    note: EXISTING_NOTES[state] ?? EXISTING_ENDED,
  };
}

export async function createPayment(client: UpstreamClient, input: CreatePaymentInput): Promise<unknown> {
  const body = createBody(input);
  const idempotencyKey = derivedIdempotencyKey('create', { merchantSerialNumber: client.merchantSerialNumber ?? null, body });
  // The access token first (the cached one when there is one): a failure to get it is then known to be before
  // anything was sent.
  await client.verifyCredentials();
  let answer: unknown;
  try {
    answer = await client.post('/epayment/v1/payments', body, { idempotencyKey });
  } catch (error) {
    if (!(error instanceof VippsHttpError)) {
      // A timeout, a lost connection or an answer that could not be read: the request may have arrived. Our own
      // refusals (nothing sent) pass as they are.
      if (error instanceof Error && !error.message.startsWith('Refused:')) {
        throw new Error(`${error.message} ${OUTCOME_UNKNOWN}`, { cause: error });
      }
      throw error;
    }
    // The Access Token API refused or failed: the create request was never sent.
    if (error.tokenRequest) throw withNote(error, NOTHING_CREATED);
    if (error.status === 400 || error.status === 409) {
      const existing = await existingPayment(client, input, error);
      if (existing !== undefined) return existing;
    }
    throw withNote(error, createNote(error.status, input));
  }
  const link = input.delivery === 'phone' ? undefined : CustomerLink.from(asRecord(answer).redirectUrl);
  return {
    created: true,
    reference: input.reference,
    delivery: input.delivery,
    amount: { currency: input.currency, value: input.amount },
    // Where the customer goes: the address to open, or the address of the QR code to scan. None for a phone number:
    // the request is in the customer's app.
    ...(input.delivery === 'link' ? { link: link ?? null } : {}),
    ...(input.delivery === 'qr' ? { qrCode: link ?? null } : {}),
    ...(input.delivery !== 'phone' && !link ? { problem: 'Vipps MobilePay answered without a usable link. get_payment shows the request.' } : {}),
    ...(input.expiresAt === undefined ? { approveWithinMinutes: DEFAULT_APPROVAL_MINUTES } : { expiresAt: input.expiresAt }),
  };
}
