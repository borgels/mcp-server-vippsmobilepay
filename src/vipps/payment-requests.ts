import { CustomerLink, VippsHttpError, withNote } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { ChangeRefusedError } from './payments.js';
import { contentFingerprint, derivedIdempotencyKey, timestampMs, type MerchantCurrency } from './values.js';

/**
 * ePayment API: a new payment request (create_payment).
 *
 * The request moves no money: the customer approves it in the Vipps or
 * MobilePay app, the amount is then reserved, and a capture draws it.
 *
 * The same request twice. A request has a fingerprint: a hash of the sales
 * unit and everything the request says (reference, amount, currency, text,
 * delivery, phone number, return address, deadline, order lines). Two things
 * are made from it, and nothing is kept between calls:
 *
 *   - the Idempotency-Key, so the same request is the same key however often
 *     it is repeated, and the caller cannot repeat it under a new one;
 *   - the request's `metadata.requestFingerprint`, which Vipps MobilePay
 *     stores with the payment and returns when the payment is read (the
 *     specification: metadata "is passed through in the GetPaymentResponse").
 *
 * A payment that is read back is taken for this request only when everything
 * Vipps MobilePay returns of it matches: reference, amount, currency, payment
 * method and that fingerprint (isThisRequest). The fingerprint is what proves
 * the rest: the phone number, the text and the order lines are not returned.
 * A payment that has the reference and cannot be proven to be this request
 * is a conflict, and nothing of it is passed on: not its state and not its
 * link, which would be another customer's.
 *
 * No refusal here depends on the clock. The deadline (expiresAt) is part of
 * the fingerprint, so an identical call made later must still reach Vipps
 * MobilePay, which decides whether the deadline is too near; a refusal of
 * ours would stop the repeat that recovers a lost answer.
 */

/** How the request reaches the customer, and the ePayment userFlow each one is. */
export const PAYMENT_DELIVERIES = ['link', 'qr', 'phone'] as const;
export type PaymentDelivery = (typeof PAYMENT_DELIVERIES)[number];
const USER_FLOWS: Readonly<Record<PaymentDelivery, string>> = { link: 'WEB_REDIRECT', qr: 'QR', phone: 'PUSH_MESSAGE' };

/** The formats Vipps MobilePay gives a QR code in: an image to show, or the address the code holds. */
export const QR_FORMATS = ['IMAGE/PNG', 'IMAGE/SVG+XML', 'TEXT/TARGETURL'] as const;

/** Minutes a customer has to approve a request without expiresAt, from when it is created (Vipps MobilePay's default timeout). */
export const DEFAULT_APPROVAL_MINUTES = 10;
/** The bounds Vipps MobilePay sets for expiresAt: more than 10 minutes and less than 60 days ahead. */
export const MIN_EXPIRY_MS = 10 * 60_000;
export const MAX_EXPIRY_MS = 60 * 86_400_000;
/** The smallest amount per currency, in minor units (NOK: 1 krone). */
const MINIMUM_AMOUNT: Readonly<Record<MerchantCurrency, number>> = { NOK: 100, DKK: 1, EUR: 1 };
/** The most order lines taken in one request (our own limit). */
export const MAX_ORDER_LINES = 100;
/** The metadata field that holds the request's fingerprint. */
export const FINGERPRINT_FIELD = 'requestFingerprint';

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
 * input), or undefined. Nothing here reads the clock: the same input gets
 * the same answer whenever it is given.
 */
export function checkCreatePayment(input: Record<string, unknown>): string | undefined {
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
    if (lines === undefined) return 'A request with expiresAt needs orderLines: Vipps MobilePay requires what is sold to be shown.';
    // Norway (the market of NOK): each line must link to the product.
    if (currency === 'NOK' && lines.some(line => line.productUrl === undefined)) {
      return 'A request in NOK with expiresAt needs productUrl on every order line: Vipps MobilePay requires it in Norway.';
    }
  }
  return undefined;
}

/**
 * The deadline as one text per point in time: UTC, whole seconds. The same
 * moment written with another offset is then the same request.
 */
function deadline(expiresAt: string | undefined): string | undefined {
  const time = timestampMs(expiresAt);
  return time === undefined ? undefined : new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** What the request says, in the API's own names: only fields the input has. The fingerprint is made of this. */
function requestContent(input: CreatePaymentInput): Record<string, unknown> {
  const expiresAt = deadline(input.expiresAt);
  return {
    amount: { currency: input.currency, value: input.amount },
    paymentMethod: { type: 'WALLET' },
    reference: input.reference,
    userFlow: USER_FLOWS[input.delivery],
    paymentDescription: input.description,
    ...(input.phoneNumber === undefined ? {} : { customer: { phoneNumber: input.phoneNumber } }),
    ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
  'A request with expiresAt is refused when the deadline is not more than 10 minutes and less than 60 days ahead, when Vipps MobilePay has not enabled a longer deadline for the sales unit, or when the deadline is longer than the sales unit may use.';
const DEADLINE_TOO_NEAR = 'By the clock of this server the deadline is not more than 10 minutes ahead.';
const DEADLINE_TOO_FAR = 'By the clock of this server the deadline is 60 days or more ahead.';
const CURRENCY_REFUSAL = 'The currency must be the one the sales unit is registered with.';

/** Our own note for an HTTP error of the create request: what the status means here. Never anything of the answer or the input. */
function createNote(status: number, input: CreatePaymentInput, now: number): string {
  if (status === 429 || status === 423) return `${NOTHING_CREATED} After the wait: ${REPEAT_SAME_INPUT}`;
  if (status === 408 || status >= 500) return OUTCOME_UNKNOWN;
  const left = input.expiresAt === undefined ? undefined : (timestampMs(input.expiresAt) ?? now) - now;
  return [
    NOTHING_CREATED,
    status === 400 && input.delivery === 'phone' ? PHONE_REFUSALS : undefined,
    status === 400 && left !== undefined ? EXPIRY_REFUSALS : undefined,
    status === 400 && left !== undefined && left <= MIN_EXPIRY_MS ? DEADLINE_TOO_NEAR : undefined,
    status === 400 && left !== undefined && left >= MAX_EXPIRY_MS ? DEADLINE_TOO_FAR : undefined,
    status === 400 ? CURRENCY_REFUSAL : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

const PAYMENT_STATES = ['CREATED', 'ABORTED', 'EXPIRED', 'AUTHORIZED', 'TERMINATED'] as const;
type PaymentState = (typeof PAYMENT_STATES)[number];

/** What is known of the request at Vipps MobilePay after a call. */
interface Outcome {
  /** Vipps MobilePay answered the create request of this call with success. */
  accepted: boolean;
  /** The state of the payment, when it was read back and proven to be this request. */
  state?: PaymentState;
  /** The address for the customer: the link, or the address of the QR code. */
  address?: CustomerLink;
}

/**
 * Whether a payment read from Vipps MobilePay is this request: every field
 * that is returned and that the request sets must be the request's own, the
 * fingerprint among them. Returns its state, or undefined when it cannot be
 * proven (another request, or an answer that does not hold the fingerprint).
 */
function stateOfThisRequest(payment: Record<string, unknown>, input: CreatePaymentInput, fingerprint: string): PaymentState | undefined {
  const amount = asRecord(payment.amount);
  const proven =
    payment.reference === input.reference &&
    amount.value === input.amount &&
    amount.currency === input.currency &&
    asRecord(payment.paymentMethod).type === 'WALLET' &&
    asRecord(payment.metadata)[FINGERPRINT_FIELD] === fingerprint;
  return proven ? PAYMENT_STATES.find(state => state === payment.state) : undefined;
}

const WAITING = 'The request waits for the customer to approve it. get_payment shows the state.';
const STATE_NOT_READ = 'Vipps MobilePay accepted the request. Its state could not be read back; get_payment shows it.';
const EXISTS = 'This request already exists, so nothing new was created.';
const NO_ADDRESS = 'Vipps MobilePay answered without a usable address for the customer.';
const QR_ONLY_ONCE =
  'Vipps MobilePay gives the address of a QR code only when the request is created. For a new code, cancel this request with cancel_payment and create one with another reference.';

/**
 * The answer of the tool, in one form however the request came to exist: by
 * this call, by an earlier call whose answer was lost, or long ago. Only our
 * own fields, the state and the address; nothing else of what was read.
 */
function answer(input: CreatePaymentInput, outcome: Outcome): Record<string, unknown> {
  const { state } = outcome;
  // A request that is no longer CREATED was not created by this call, whatever the answer to it was: Vipps MobilePay
  // answered a repeat of an earlier one.
  const live = state === undefined || state === 'CREATED';
  const created = outcome.accepted && live;
  const expiresAt = deadline(input.expiresAt);
  // The address only while the customer can use it.
  const address = live ? (outcome.address ?? null) : null;
  const notes: string[] = [];
  if (created) notes.push(state === undefined ? STATE_NOT_READ : WAITING);
  else if (state === 'CREATED') notes.push(`${EXISTS} The customer has not approved it yet.`);
  else if (state === 'AUTHORIZED') notes.push(`${EXISTS} The customer has approved it: the amount is reserved, and capture_payment draws it.`);
  else notes.push(`${EXISTS} It can no longer be paid: a new request needs another reference.`);
  if (live && address === null && input.delivery === 'link') notes.push(NO_ADDRESS);
  if (live && address === null && input.delivery === 'qr') notes.push(outcome.accepted ? NO_ADDRESS : QR_ONLY_ONCE);
  return {
    created,
    alreadyExists: !created,
    reference: input.reference,
    delivery: input.delivery,
    amount: { currency: input.currency, value: input.amount },
    state: state ?? null,
    // Where the customer goes: the address to open, or the address of the QR code to scan. None for a phone number:
    // the request is in the customer's app.
    ...(input.delivery === 'link' ? { link: address } : {}),
    ...(input.delivery === 'qr' ? { qrCode: address } : {}),
    ...(expiresAt === undefined ? { approveWithinMinutes: DEFAULT_APPROVAL_MINUTES } : { expiresAt }),
    note: notes.join(' '),
  };
}

const CONFLICT =
  'Refused: the reference is already used by a payment that is not this request, or that cannot be shown to be it. Nothing was created, and nothing of that payment is returned. A reference is used once per sales unit: use the number the business itself has for this request, and get_payment to see the payment that has the reference.';

export async function createPayment(client: UpstreamClient, input: CreatePaymentInput): Promise<unknown> {
  const content = requestContent(input);
  const fingerprint = contentFingerprint({ merchantSerialNumber: client.merchantSerialNumber ?? null, request: content });
  const idempotencyKey = derivedIdempotencyKey('create', fingerprint);
  const body = { ...content, metadata: { [FINGERPRINT_FIELD]: fingerprint } };
  const read = () => client.get(`/epayment/v1/payments/${encodePathParam(input.reference, 'reference')}`).then(asRecord);

  // The access token first (the cached one when there is one): a failure to get it is then known to be before
  // anything was sent.
  await client.verifyCredentials();
  let accepted: unknown;
  try {
    accepted = await client.post('/epayment/v1/payments', body, { idempotencyKey });
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
      // Refused, perhaps because the reference is used: by this request (a repeat of one whose answer was lost, or
      // that Vipps MobilePay no longer remembers the key of), or by another.
      const payment = await read().catch(() => undefined);
      if (payment?.reference === input.reference) {
        const state = stateOfThisRequest(payment, input, fingerprint);
        if (state === undefined) throw new ChangeRefusedError(CONFLICT, { cause: error });
        // The link of a payment page can be read again (the specification: redirectUrl "is the URL to the Vipps
        // MobilePay landing page"); the address of a QR code cannot.
        const address = input.delivery === 'link' ? CustomerLink.from(payment.redirectUrl) : undefined;
        return answer(input, { accepted: false, state, address });
      }
    }
    throw withNote(error, createNote(error.status, input, client.currentTime()));
  }

  // Accepted. The payment is read back for its state: Vipps MobilePay may have answered a repeat of an earlier request
  // with the first answer, and the request may since have been approved, cancelled or expired. A read that fails or
  // proves nothing leaves the state unknown; it is never an error, since the request exists.
  const payment = await read().catch(() => ({}) as Record<string, unknown>);
  const state = stateOfThisRequest(payment, input, fingerprint);
  const address =
    input.delivery === 'phone'
      ? undefined
      : (CustomerLink.from(asRecord(accepted).redirectUrl) ?? (input.delivery === 'link' && state !== undefined ? CustomerLink.from(payment.redirectUrl) : undefined));
  return answer(input, { accepted: true, state, address });
}
