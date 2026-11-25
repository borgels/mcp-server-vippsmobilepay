import { CustomerLink } from '../errors.js';
import { isDerivedIdempotencyKey, stateText } from './values.js';

/**
 * What the read tools pass on of a payment, its events, an agreement, a
 * charge read by its id, the order details of a payment, a sales unit and a
 * QR code: a deep allow-list with a type for every field, on every level. A
 * field is passed on only when it is named here and its value has the named
 * type; a nested object only through its own list. Vipps MobilePay's
 * ePayment answer can carry the payer's name, phone number, e-mail and
 * address (`userDetails`, `shippingDetails`) and a user id (`profile.sub`);
 * a Recurring agreement can carry the user id and a userinfo address (`sub`,
 * `userinfoUrl`). None of that is passed on, wherever it is placed, and a
 * field Vipps MobilePay adds later is left out until it is added here.
 *
 * An answer that is not the expected object (or list) is refused with a fixed
 * text, never passed on as an empty result.
 *
 * Two ways of reading an answer through a list:
 *
 *   - lenient (a payment, its events, an agreement, the answer to a change):
 *     a named field whose value has another type is left out;
 *   - strict (a charge read by its id, order details, sales units, QR codes):
 *     only a field that is not named is left out. A named field whose value
 *     has another type refuses the whole answer, and so does an object
 *     without the fields it needs (REQUIRED), on every level and for every
 *     item of a list. Nothing that was in the answer under a known name then
 *     disappears from a result, and no item of a list is ever an empty
 *     object. `null` is no value: a named field that is null is absent.
 */

/** The fields an object must have, in a strict read: an allow-list names them under this key. */
const REQUIRED = Symbol('required');

/** An object with its own allow-list, and the fields it needs. */
interface ObjectType {
  readonly [field: string]: FieldType;
  readonly [REQUIRED]?: readonly string[];
}

/**
 * The type of one field: a scalar, a list of one type (written as a list with that type), or an object with its own
 * allow-list. `longString` is a text that can be an address.
 */
type FieldType = 'string' | 'longString' | 'integer' | 'boolean' | readonly [FieldType] | ObjectType;

/** The longest text passed on in one field. */
const MAX_TEXT = 500;
/** The longest text passed on in a field that can hold an address (the length a CustomerLink takes). */
const MAX_LONG_TEXT = 4096;
/** The longest list passed on in one field. A longer one is refused, never cut short. */
export const MAX_LIST_ITEMS = 1000;

const isListType = (type: FieldType): type is readonly [FieldType] => Array.isArray(type);

/** A value in a strict read that does not have the form its allow-list names. Never leaves this file. */
class Mismatch extends Error {}

/**
 * The value when it has the type. Otherwise: undefined in a lenient read
 * (the field is left out), and a Mismatch in a strict one (the answer is
 * refused). Lists are read strictly only.
 */
function typed(value: unknown, type: FieldType, strict = false): unknown {
  const no = (): undefined => {
    if (strict) throw new Mismatch();
    return undefined;
  };
  if (type === 'string') return typeof value === 'string' && value.length <= MAX_TEXT ? value : no();
  if (type === 'longString') return typeof value === 'string' && value.length <= MAX_LONG_TEXT ? value : no();
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) ? value : no();
  if (type === 'boolean') return typeof value === 'boolean' ? value : no();
  if (isListType(type)) {
    // A list is whole or the answer is refused: a part of it is never taken for all of it.
    if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Mismatch();
    return value.map(item => typed(item, type[0], true));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return no();
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [field, fieldType] of Object.entries(type)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    // null is no value: the field is absent.
    if (strict && source[field] === null) continue;
    const kept = typed(source[field], fieldType, strict);
    if (kept !== undefined) out[field] = kept;
  }
  if (strict) {
    for (const field of type[REQUIRED] ?? []) {
      if (out[field] === undefined) throw new Mismatch();
    }
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

/**
 * The fields an object needs are those the specification requires and does
 * not allow to be null. Two exceptions. The top level of a charge needs only
 * its id, status, amount and currency: the specification's own list also
 * names fields it documents as optional (externalId). A callback QR code
 * needs its id: the specification requires nothing of it.
 */

/** A Recurring charge, as `GET /recurring/v3/charges/{chargeId}` documents it (ChargeResponseV3). */
const CHARGE = {
  [REQUIRED]: ['id', 'status', 'amount', 'currency'],
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
  summary: { [REQUIRED]: ['captured', 'refunded', 'cancelled'], captured: 'integer', refunded: 'integer', cancelled: 'integer' },
  history: [
    {
      [REQUIRED]: ['occurred', 'event', 'amount', 'success'],
      occurred: 'string',
      event: 'string',
      amount: 'integer',
      idempotencyKey: 'string',
      success: 'boolean',
      transactionId: 'string',
      externalId: 'string',
    },
  ],
} as const;

/** The order details of a payment, as `GET /order-management/v2/{paymentType}/{orderId}` documents them. */
const ORDER_DETAILS = {
  category: { [REQUIRED]: ['orderDetailsUrl'], category: 'string', orderDetailsUrl: 'longString', imageId: 'string' },
  receipt: {
    [REQUIRED]: ['orderLines', 'bottomLine'],
    orderLines: [
      {
        [REQUIRED]: ['name', 'id', 'totalAmount', 'totalAmountExcludingTax', 'totalTaxAmount'],
        name: 'string',
        id: 'string',
        totalAmount: 'integer',
        totalAmountExcludingTax: 'integer',
        totalTaxAmount: 'integer',
        taxPercentage: 'integer',
        taxRate: 'integer',
        unitInfo: { [REQUIRED]: ['quantity'], unitPrice: 'integer', quantity: 'string', quantityUnit: 'string' },
        discount: 'integer',
        productUrl: 'longString',
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
  [REQUIRED]: ['msn', 'name'],
  msn: 'string',
  name: 'string',
  businessIdentifier: { [REQUIRED]: ['scheme', 'id'], scheme: 'string', id: 'string' },
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

/** One sales unit in the list of them (`GET /management/v1/sales-units`). */
const SALES_UNIT_LIST = [{ [REQUIRED]: ['msn', 'name'], msn: 'string', name: 'string' }] as const;

/** The merchant redirect QR codes (`GET /qr/v1/merchant-redirect`, MerchantRedirectQrResponse). `url` is the address of the image. */
const REDIRECT_QR_LIST = [{ [REQUIRED]: ['id', 'url', 'redirectUrl'], id: 'string', url: 'longString', redirectUrl: 'longString', expiresIn: 'integer' }] as const;

/** The merchant callback QR codes (`GET /qr/v1/merchant-callback`, MerchantCallbackQr). */
const CALLBACK_QR_LIST = [
  { [REQUIRED]: ['merchantQrId'], merchantQrId: 'string', locationDescription: 'string', category: 'string', qrContent: 'longString', qrImageUrl: 'longString' },
] as const;

/** The refusal of an answer that is not in the form the API documents. Fixed text: nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor(what: string) {
    super(`Vipps MobilePay answered ${what} in an unexpected form.`);
    this.name = 'UnexpectedAnswerError';
  }
}

/** A strict read: the answer through its allow-list, or the refusal when anything in it has another form. */
function strictly<T>(answer: unknown, type: FieldType, what: string): T {
  try {
    return typed(answer, type, true) as T;
  } catch (error) {
    if (error instanceof Mismatch) throw new UnexpectedAnswerError(what);
    throw error;
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

/**
 * A charge through the allow-list, read strictly: refused unless every known
 * field has its type, it has an id, a status, an amount and a currency, and
 * every event of its history says what happened, when, for what amount and
 * whether it succeeded. An event passes on its `idempotencyKey` unless the
 * key has the form this server makes from a request's content: such a key is
 * not the caller's.
 */
export function chargeView(charge: unknown): Record<string, unknown> {
  const out = strictly<Record<string, unknown>>(charge, CHARGE, 'the charge');
  for (const event of (out.history ?? []) as Array<Record<string, unknown>>) {
    if (isDerivedIdempotencyKey(event.idempotencyKey)) delete event.idempotencyKey;
  }
  return out;
}

/**
 * The order details of a payment through the allow-list, read strictly: the
 * category (with the address the business gave for the order) and the
 * receipt (order lines with VAT, and the bottom line). Either can be
 * missing: `null`. Refused when anything in it has another form: an order
 * line without its name, its id or one of its three amounts, a receipt
 * without its order lines or its bottom line, a category without its
 * address.
 */
export function orderDetailsView(answer: unknown): { category: Record<string, unknown> | null; receipt: Record<string, unknown> | null } {
  const out = strictly<{ category?: Record<string, unknown>; receipt?: Record<string, unknown> }>(answer, ORDER_DETAILS, 'the order details');
  return { category: out.category ?? null, receipt: out.receipt ?? null };
}

/** A sales unit through the allow-list, read strictly. Refused unless it has an MSN and a name. */
export function salesUnitView(unit: unknown): Record<string, unknown> {
  return strictly<Record<string, unknown>>(unit, SALES_UNIT, 'the sales unit');
}

/** A list of sales units, read strictly. Refused unless every one has an MSN and a name. */
export function salesUnitListView(units: unknown): Array<Record<string, unknown>> {
  return strictly<Array<Record<string, unknown>>>(units, SALES_UNIT_LIST, 'the sales units');
}

/**
 * The address of a QR code's image as a link (see CustomerLink), or `null` when the code has none or the text is not an
 * https address in the form of a link. A value that is no text refuses the answer before it comes here.
 */
const imageLink = (value: unknown): CustomerLink | null => CustomerLink.from(value) ?? null;

/**
 * The merchant redirect QR codes (`GET /qr/v1/merchant-redirect`), read
 * strictly: the id the business gave the code, the address it sends the
 * customer to, and the address of its image with the seconds that address
 * works for. Refused unless every code has its id and both addresses.
 */
export function redirectQrListView(codes: unknown): Array<Record<string, unknown>> {
  return strictly<Array<Record<string, unknown>>>(codes, REDIRECT_QR_LIST, 'the QR codes').map(code => ({
    kind: 'redirect',
    id: code.id,
    redirectUrl: code.redirectUrl,
    imageUrl: imageLink(code.url),
    ...(code.expiresIn === undefined ? {} : { imageUrlExpiresInSeconds: code.expiresIn }),
  }));
}

/**
 * The merchant callback QR codes (`GET /qr/v1/merchant-callback`), read
 * strictly: the id the business gave the code, where it stands, its
 * category, the text the code holds and the address of its image. Refused
 * unless every code has its id.
 */
export function callbackQrListView(codes: unknown): Array<Record<string, unknown>> {
  return strictly<Array<Record<string, unknown>>>(codes, CALLBACK_QR_LIST, 'the QR codes').map(code => ({
    kind: 'callback',
    id: code.merchantQrId,
    ...(code.locationDescription === undefined ? {} : { locationDescription: code.locationDescription }),
    ...(code.category === undefined ? {} : { category: code.category }),
    ...(code.qrContent === undefined ? {} : { content: code.qrContent }),
    imageUrl: imageLink(code.qrImageUrl),
  }));
}
