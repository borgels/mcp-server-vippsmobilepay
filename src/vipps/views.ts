import { CustomerLink } from '../errors.js';
import { isDerivedIdempotencyKey, stateText } from './values.js';

/**
 * What the read tools pass on of a payment, its events, an agreement, a
 * charge read by its id, the order details of a payment, a sales unit and a
 * QR code: a deep allow-list with a type for every field, on every level. A
 * field is passed on only when it is named here and its value has the named
 * type; a nested object only through its own list, and a list only when
 * every item in it has the named type. Vipps MobilePay's ePayment answer
 * can carry the payer's name, phone number, e-mail and address
 * (`userDetails`, `shippingDetails`) and a user id (`profile.sub`); a
 * Recurring agreement can carry the user id and a userinfo address (`sub`,
 * `userinfoUrl`). None of that is passed on, wherever it is placed, and a
 * field Vipps MobilePay adds later is left out until it is added here.
 *
 * An answer that is not the expected object (or list) is refused with a fixed
 * text, never passed on as an empty result.
 */

/** The type of one field: a scalar, a list of one type (written as a list with that type), or an object with its own allow-list. */
type FieldType = 'string' | 'integer' | 'boolean' | readonly [FieldType] | { readonly [field: string]: FieldType };

/** The longest text passed on in one field; longer texts are left out. */
const MAX_TEXT = 500;
/** The longest list passed on in one field. A longer one is left out, never cut short. */
export const MAX_LIST_ITEMS = 1000;

const isListType = (type: FieldType): type is readonly [FieldType] => Array.isArray(type);

/** The value when it has the type; otherwise undefined (left out). */
function typed(value: unknown, type: FieldType): unknown {
  if (type === 'string') return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined;
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (isListType(type)) {
    // A list is whole or it is not there: one item of another form, and the list is left out, so a part of it is
    // never taken for all of it. The views below refuse an answer whose list was left out.
    if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
    const items = value.map(item => typed(item, type[0]));
    return items.some(item => item === undefined) ? undefined : items;
  }
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

/** A Recurring charge, as `GET /recurring/v3/charges/{chargeId}` documents it (ChargeResponseV3). */
const CHARGE = {
  id: 'string',
  agreementId: 'string',
  status: 'string',
  type: 'string',
  transactionType: 'string',
  processingMode: 'string',
  amount: 'integer',
  currency: 'string',
  description: 'string',
  due: 'string',
  retryDays: 'integer',
  externalId: 'string',
  externalAgreementId: 'string',
  transactionId: 'string',
  failureReason: 'string',
  failureDescription: 'string',
  summary: { captured: 'integer', refunded: 'integer', cancelled: 'integer' },
  history: [{ occurred: 'string', event: 'string', amount: 'integer', idempotencyKey: 'string', success: 'boolean', transactionId: 'string', externalId: 'string' }],
} as const;

/** The order details of a payment, as `GET /order-management/v2/{paymentType}/{orderId}` documents them. */
const ORDER_DETAILS = {
  category: { category: 'string', orderDetailsUrl: 'string', imageId: 'string' },
  receipt: {
    orderLines: [
      {
        name: 'string',
        id: 'string',
        totalAmount: 'integer',
        totalAmountExcludingTax: 'integer',
        totalTaxAmount: 'integer',
        taxPercentage: 'integer',
        taxRate: 'integer',
        unitInfo: { unitPrice: 'integer', quantity: 'string', quantityUnit: 'string' },
        discount: 'integer',
        productUrl: 'string',
        isReturn: 'boolean',
        isShipping: 'boolean',
      },
    ],
    bottomLine: {
      currency: 'string',
      tipAmount: 'integer',
      giftCardAmount: 'integer',
      posId: 'string',
      totalAmount: 'integer',
      totalTax: 'integer',
      totalDiscount: 'integer',
      shippingAmount: 'integer',
      shippingInfo: { amount: 'integer', amountExcludingTax: 'integer', taxAmount: 'integer', taxPercentage: 'integer' },
      paymentSources: { giftCard: 'integer', card: 'integer', voucher: 'integer', cash: 'integer' },
      barcode: { format: 'string', data: 'string' },
      receiptNumber: 'string',
      terminalId: 'string',
    },
  },
} as const;

/** A sales unit, as `GET /management/v1/sales-units/{msn}` documents it. */
const SALES_UNIT = {
  msn: 'string',
  name: 'string',
  businessIdentifier: { scheme: 'string', id: 'string' },
  configuration: {
    paymentAllowed: 'boolean',
    captureType: 'string',
    skipLandingPageAllowed: 'boolean',
    recurringAllowed: 'boolean',
    partialCaptureAllowed: 'boolean',
    lateCaptureAllowed: 'boolean',
    landingPagePhoneNumberLocked: 'boolean',
    longLivingPaymentAllowed: 'boolean',
    creditCardPaymentAllowed: 'boolean',
  },
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

/** The answer with its state as a text (stateText), when it holds one in the other documented form. */
function withStateText(answer: unknown): unknown {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const record = answer as Record<string, unknown>;
  return typeof record.state === 'string' ? record : { ...record, state: stateText(record.state) };
}

/** A payment through the allow-list. Refused unless it has a reference and a state. */
export function paymentView(payment: unknown): Record<string, unknown> {
  const out = typed(withStateText(payment), PAYMENT) as Record<string, unknown> | undefined;
  if (!out || typeof out.reference !== 'string' || typeof out.state !== 'string') throw new UnexpectedAnswerError('the payment');
  return out;
}

/**
 * The answer to a capture, a refund or a cancellation through the same
 * allow-list as a payment (the specification's ModificationResponse holds
 * amount, state, aggregate, pspReference and reference). The change has been
 * made when this is read, so an answer in another form is not refused: what
 * is not on the list is left out, and an answer that is no object is empty.
 */
export function modificationView(answer: unknown): Record<string, unknown> {
  return (typed(withStateText(answer), PAYMENT) as Record<string, unknown> | undefined) ?? {};
}

/**
 * The events whose Idempotency-Key the caller chose: a capture, a refund and
 * a cancellation (CANCELLED after the customer approved, TERMINATED before).
 * The key of any other event is not passed on: the key of the request that
 * created the payment is made by this server from the request's content
 * (create_payment), and is not the caller's to see.
 */
const EVENTS_WITH_CALLER_KEY: ReadonlySet<unknown> = new Set(['CAPTURED', 'REFUNDED', 'CANCELLED', 'TERMINATED']);

/** A list of events through the allow-list, or undefined when the answer is not a list of objects. */
export function paymentEventsView(events: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(events)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const event of events) {
    const kept = typed(event, PAYMENT_EVENT) as Record<string, unknown> | undefined;
    if (!kept) return undefined;
    // By the event's name, and once more by the key's own form: a derived key is passed on under no name.
    if (!EVENTS_WITH_CALLER_KEY.has(kept.name) || isDerivedIdempotencyKey(kept.idempotencyKey)) delete kept.idempotencyKey;
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

/** True when the answer holds something under the name: a list that was left out was there, in another form. */
function holds(answer: unknown, field: string): boolean {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const value = (answer as Record<string, unknown>)[field];
  return value !== undefined && value !== null;
}

/**
 * A charge through the allow-list. Refused unless it is an object with an id
 * and a status, and when it has a history that is not a list of events. An
 * event passes on its `idempotencyKey` unless the key has the form this
 * server makes from a request's content: such a key is not the caller's.
 */
export function chargeView(charge: unknown): Record<string, unknown> {
  const out = typed(charge, CHARGE) as Record<string, unknown> | undefined;
  if (!out || typeof out.id !== 'string' || typeof out.status !== 'string') throw new UnexpectedAnswerError('the charge');
  if (holds(charge, 'history') && out.history === undefined) throw new UnexpectedAnswerError('the charge');
  for (const event of (out.history ?? []) as Array<Record<string, unknown>>) {
    if (isDerivedIdempotencyKey(event.idempotencyKey)) delete event.idempotencyKey;
  }
  return out;
}

/**
 * The order details of a payment through the allow-list: the category (with
 * the address the business gave for the order) and the receipt (order lines
 * with VAT, and the bottom line). Either can be missing: `null`. Refused
 * when the answer is no object, and when it has order lines that are not a
 * list of lines.
 */
export function orderDetailsView(answer: unknown): { category: Record<string, unknown> | null; receipt: Record<string, unknown> | null } {
  const out = typed(answer, ORDER_DETAILS) as { category?: Record<string, unknown>; receipt?: Record<string, unknown> } | undefined;
  if (!out) throw new UnexpectedAnswerError('the order details');
  const receipt = (answer as Record<string, unknown>).receipt;
  if (holds(answer, 'receipt') && (out.receipt === undefined || (holds(receipt, 'orderLines') && out.receipt.orderLines === undefined))) {
    throw new UnexpectedAnswerError('the order details');
  }
  if (holds(answer, 'category') && out.category === undefined) throw new UnexpectedAnswerError('the order details');
  return { category: out.category ?? null, receipt: out.receipt ?? null };
}

/** A sales unit through the allow-list. Refused unless it is an object with an MSN. */
export function salesUnitView(unit: unknown): Record<string, unknown> {
  const out = typed(unit, SALES_UNIT) as Record<string, unknown> | undefined;
  if (!out || typeof out.msn !== 'string') throw new UnexpectedAnswerError('the sales unit');
  return out;
}

/** A list of sales units, each with its MSN and name. Refused unless it is a list of objects that each have an MSN. */
export function salesUnitListView(units: unknown): Array<Record<string, unknown>> {
  const out = typed(units, [{ msn: 'string', name: 'string' }]) as Array<Record<string, unknown>> | undefined;
  if (!out || out.some(unit => typeof unit.msn !== 'string')) throw new UnexpectedAnswerError('the sales units');
  return out;
}

/** The address of a QR code's image as a link (see CustomerLink), or `null` when the answer has none in that form. */
const imageLink = (value: unknown): CustomerLink | null => CustomerLink.from(value) ?? null;

/**
 * The merchant redirect QR codes (`GET /qr/v1/merchant-redirect`): the id the
 * business gave the code, the address it sends the customer to, and the
 * address of its image with the seconds that address works for. Refused
 * unless the answer is a list of objects that each have an id.
 */
export function redirectQrListView(codes: unknown): Array<Record<string, unknown>> {
  const out = typed(codes, [{ id: 'string', redirectUrl: 'string', expiresIn: 'integer' }]) as Array<Record<string, unknown>> | undefined;
  if (!out || out.some(code => typeof code.id !== 'string')) throw new UnexpectedAnswerError('the QR codes');
  return out.map((code, index) => ({
    kind: 'redirect',
    id: code.id,
    ...(code.redirectUrl === undefined ? {} : { redirectUrl: code.redirectUrl }),
    imageUrl: imageLink(((codes as unknown[])[index] as Record<string, unknown>).url),
    ...(code.expiresIn === undefined ? {} : { imageUrlExpiresInSeconds: code.expiresIn }),
  }));
}

/**
 * The merchant callback QR codes (`GET /qr/v1/merchant-callback`): the id the
 * business gave the code, where it stands, its category, the text the code
 * holds and the address of its image. Refused unless the answer is a list of
 * objects that each have an id.
 */
export function callbackQrListView(codes: unknown): Array<Record<string, unknown>> {
  const out = typed(codes, [{ merchantQrId: 'string', locationDescription: 'string', category: 'string', qrContent: 'string' }]) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!out || out.some(code => typeof code.merchantQrId !== 'string')) throw new UnexpectedAnswerError('the QR codes');
  return out.map((code, index) => ({
    kind: 'callback',
    id: code.merchantQrId,
    ...(code.locationDescription === undefined ? {} : { locationDescription: code.locationDescription }),
    ...(code.category === undefined ? {} : { category: code.category }),
    ...(code.qrContent === undefined ? {} : { content: code.qrContent }),
    imageUrl: imageLink(((codes as unknown[])[index] as Record<string, unknown>).qrImageUrl),
  }));
}
