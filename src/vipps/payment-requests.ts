import { CustomerLink, VippsHttpError, withNote } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { ChangeRefusedError } from './payments.js';
import { derivedIdempotencyKey, requestFingerprint, timestampMs, type KeyedHashPurpose, type MerchantCurrency } from './values.js';

/**
 * ePayment API: a new payment request (create_payment).
 *
 * The request moves no money: the customer approves it in the Vipps or
 * MobilePay app, the amount is then reserved, and a capture draws it.
 *
 * The same request twice. Two values are made from the sales unit and
 * everything the request says (reference, amount, currency, text, delivery,
 * phone number, return address, deadline, order lines), each a keyed hash
 * with its own key, derived in the client from the client secret. Nothing is
 * kept between calls:
 *
 *   - the Idempotency-Key, so the same request is the same key however often
 *     it is repeated, and the caller cannot repeat it under a new one;
 *   - the fingerprint, sent as the request's `metadata.requestFingerprint`,
 *     which Vipps MobilePay stores with the payment and returns when the
 *     payment is read (the specification: metadata "is passed through in the
 *     GetPaymentResponse").
 *
 * Both go to Vipps MobilePay in the create request and nowhere else: not
 * into an answer, an error or the audit. Without the client secret neither
 * can be made or tested against a guess of the content, and the key, which
 * Vipps MobilePay may show in the payment's events, does not give the
 * fingerprint. After the client secret is replaced the same input gives new
 * values: a request made before is then no longer recognised and is answered
 * as a conflict (the reference still keeps it from being created twice).
 *
 * The rule for what is passed on. A payment that is read is taken for this
 * request only when everything Vipps MobilePay returns of it matches:
 * reference, amount, currency, payment method and the fingerprint
 * (readBack). The fingerprint proves the rest: the phone number, the text
 * and the order lines are not returned. Every branch of createPayment that
 * answers holds to it:
 *
 *   - read and proven: its state, and its link when the customer can use it;
 *   - read and not proven (another request, or no fingerprint): a refusal,
 *     and nothing of the payment, whatever Vipps MobilePay answered the
 *     create request with;
 *   - not read at all, after Vipps MobilePay accepted the create request:
 *     no state, and the address from that acceptance, which answers this
 *     request's own key;
 *   - not read at all, after Vipps MobilePay refused the create request: the
 *     refusal, and nothing else.
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
  /** The state of the payment, when it was read back, proven to be this request and in a state this server knows. */
  state?: PaymentState;
  /** The address for the customer: the link, or the address of the QR code. */
  address?: CustomerLink;
}

/** A payment read after the create request. */
type ReadBack =
  /** No answer to the read, or an HTTP error. `absent`: Vipps MobilePay answered that no payment has the reference. */
  | { kind: 'unread'; absent: boolean }
  /** An answer that is not proven to be this request: another request, or a payment without this fingerprint. */
  | { kind: 'other' }
  /** This request. The state when it is one this server knows; the landing page address when there is a usable one. */
  | { kind: 'ours'; state?: PaymentState; landingPage?: CustomerLink };

/**
 * Reads the payment that has the reference and says whether it is this
 * request. Every answer to the read must prove it: each field that is
 * returned and that the request sets must be the request's own, the
 * fingerprint among them. An answer that proves nothing (an empty one, one
 * without metadata) is another payment, never an unread one.
 */
async function readBack(client: UpstreamClient, input: CreatePaymentInput, fingerprint: string): Promise<ReadBack> {
  let payment: Record<string, unknown>;
  try {
    payment = asRecord(await client.get(`/epayment/v1/payments/${encodePathParam(input.reference, 'reference')}`));
  } catch (error) {
    return { kind: 'unread', absent: error instanceof VippsHttpError && !error.tokenRequest && error.status === 404 };
  }
  const amount = asRecord(payment.amount);
  const proven =
    payment.reference === input.reference &&
    amount.value === input.amount &&
    amount.currency === input.currency &&
    asRecord(payment.paymentMethod).type === 'WALLET' &&
    asRecord(payment.metadata)[FINGERPRINT_FIELD] === fingerprint;
  if (!proven) return { kind: 'other' };
  return { kind: 'ours', state: PAYMENT_STATES.find(state => state === payment.state), landingPage: CustomerLink.from(payment.redirectUrl) };
}

const WAITING = 'The request waits for the customer to approve it. get_payment shows the state.';
const STATE_NOT_READ = 'Vipps MobilePay accepted the request. Its state could not be read back; get_payment shows it.';
const EXISTS = 'This request already exists, so nothing new was created.';
const STATE_UNKNOWN = 'Its state is not one this server knows; get_payment shows it.';
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
  // The customer can use the request while it is CREATED. A request Vipps MobilePay accepted in this call and whose
  // state is not known counts as such; one that is no longer CREATED was not created by this call, whatever the
  // answer to it was: Vipps MobilePay answered a repeat of an earlier one.
  const live = state === 'CREATED' || (outcome.accepted && state === undefined);
  const created = outcome.accepted && live;
  const expiresAt = deadline(input.expiresAt);
  // The address only while the customer can use it.
  const address = live ? (outcome.address ?? null) : null;
  const notes: string[] = [];
  if (created) notes.push(state === undefined ? STATE_NOT_READ : WAITING);
  else if (state === 'CREATED') notes.push(`${EXISTS} The customer has not approved it yet.`);
  else if (state === 'AUTHORIZED') notes.push(`${EXISTS} The customer has approved it: the amount is reserved, and capture_payment draws it.`);
  else if (state === undefined) notes.push(`${EXISTS} ${STATE_UNKNOWN}`);
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
const ACCEPTED_NOT_PROVEN =
  'Vipps MobilePay answered that the request was accepted, but the payment that has the reference cannot be shown to be this request, so nothing of it is returned: no state and no link. Do not call again with another reference. get_payment shows the payment that has the reference, and cancel_payment cancels it when it should not stand.';
const REFERENCE_NOT_READ = 'Whether a payment already has the reference could not be read; get_payment shows it.';

/**
 * Vipps MobilePay accepted the create request, and the payment read back is
 * not proven to be it. A request may exist; nothing of what was read is
 * passed on. The text is ours.
 */
export class RequestNotProvenError extends Error {
  constructor() {
    super(ACCEPTED_NOT_PROVEN);
    this.name = 'RequestNotProvenError';
  }
}

export async function createPayment(client: UpstreamClient, input: CreatePaymentInput): Promise<unknown> {
  const content = requestContent(input);
  // The sales unit and everything the request says. The two values made from it are keyed: see the top of the file.
  const identity = { merchantSerialNumber: client.merchantSerialNumber ?? null, request: content };
  const keyedHash = (purpose: KeyedHashPurpose, text: string) => client.keyedHash(purpose, text);
  const fingerprint = requestFingerprint(keyedHash, identity);
  const idempotencyKey = derivedIdempotencyKey('create', keyedHash, identity);
  const body = { ...content, metadata: { [FINGERPRINT_FIELD]: fingerprint } };

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
    const note = createNote(error.status, input, client.currentTime());
    if (error.status !== 400 && error.status !== 409) throw withNote(error, note);
    // Refused, perhaps because the reference is used: by this request (a repeat of one whose answer was lost, or
    // that Vipps MobilePay no longer remembers the key of), or by another.
    const found = await readBack(client, input, fingerprint);
    if (found.kind === 'other') throw new ChangeRefusedError(CONFLICT, { cause: error });
    // Nothing read: the refusal stands as it is. When no payment has the reference, the refusal is about the request.
    if (found.kind === 'unread') throw withNote(error, found.absent ? note : `${note} ${REFERENCE_NOT_READ}`);
    // The link of a payment page can be read again (the specification: redirectUrl "is the URL to the Vipps
    // MobilePay landing page"); the address of a QR code cannot.
    return answer(input, { accepted: false, state: found.state, address: input.delivery === 'link' ? found.landingPage : undefined });
  }

  // Accepted. The payment is read back: Vipps MobilePay may have answered a repeat of an earlier request with the
  // first answer, and the request may since have been approved, cancelled or expired.
  const found = await readBack(client, input, fingerprint);
  // Read, and not proven to be this request: nothing of it is passed on, and neither is the address of the
  // acceptance, which is then not known to be this request's either.
  if (found.kind === 'other') throw new RequestNotProvenError();
  // The address in the acceptance answers this request's own key. It is all there is when the read failed, and for a
  // QR code, whose address is given only here.
  const own = input.delivery === 'phone' ? undefined : CustomerLink.from(asRecord(accepted).redirectUrl);
  if (found.kind === 'unread') return answer(input, { accepted: true, address: own });
  return answer(input, { accepted: true, state: found.state, address: own ?? (input.delivery === 'link' ? found.landingPage : undefined) });
}
