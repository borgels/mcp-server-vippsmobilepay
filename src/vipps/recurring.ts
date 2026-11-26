import { randomBytes } from 'node:crypto';
import { VippsHttpError, withNote } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { ChangeRefusedError } from './payments.js';
import { TooMuchDataError } from './reports.js';
import {
  derivedIdempotencyKey,
  isDerivedIdempotencyKey,
  isMerchantCurrency,
  isMinorUnits,
  RECURRING_ID_PATTERN,
  type DerivedKeyKind,
  type MerchantCurrency,
} from './values.js';
import { agreementView, chargeView } from './views.js';

/**
 * Recurring API (v3): agreements and their charges. Changes: refund or
 * cancel one charge (the caller chooses the Idempotency-Key), and create a
 * charge, capture a reserved one, change an agreement or stop it (the server
 * derives the key from the request's content; see the end of this file).
 * Nothing here creates an agreement.
 */

/** Page size used when listing agreements (the API allows 1-2000; 500 is its default). */
export const AGREEMENT_PAGE_SIZE = 500;
/** Pages of agreements read in one call; more is refused, not cut short. */
export const MAX_AGREEMENT_PAGES = 10;
/** Pages of charges (Continuation-Token) read in one call. */
export const MAX_CHARGE_PAGES = 20;

export const AGREEMENT_STATUSES = ['PENDING', 'ACTIVE', 'STOPPED', 'EXPIRED'] as const;
export const CHARGE_STATUSES = [
  'PENDING',
  'DUE',
  'RESERVED',
  'CHARGED',
  'PARTIALLY_CAPTURED',
  'FAILED',
  'CANCELLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'PROCESSING',
] as const;
/** Charges Vipps MobilePay lets a merchant cancel. */
const CANCELLABLE_CHARGE_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'DUE', 'RESERVED', 'PARTIALLY_CAPTURED']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function agreementPath(agreementId: string): string {
  return `/recurring/v3/agreements/${encodePathParam(agreementId, 'agreementId')}`;
}

function chargePath(agreementId: string, chargeId: string): string {
  return `${agreementPath(agreementId)}/charges/${encodePathParam(chargeId, 'chargeId')}`;
}

/**
 * A charge as read, with the Idempotency-Key left out of every event of its history that has the form of a key this
 * server makes from a request's content (create_charge, capture_charge): such a key is not the caller's, and is never
 * passed on. A key the caller chose stays. Nothing else is changed.
 */
function withoutDerivedKeys(charge: unknown): unknown {
  const record = asRecord(charge);
  if (!Array.isArray(record.history)) return charge;
  return {
    ...record,
    history: record.history.map(entry => {
      const event = asRecord(entry);
      if (!isDerivedIdempotencyKey(event.idempotencyKey)) return entry;
      const { idempotencyKey: _derived, ...rest } = event;
      return rest;
    }),
  };
}

export async function listAgreements(
  client: UpstreamClient,
  input: { status?: (typeof AGREEMENT_STATUSES)[number]; createdAfter?: string },
): Promise<unknown> {
  const createdAfter = input.createdAfter ? Date.parse(`${input.createdAfter}T00:00:00Z`) : undefined;
  const agreements: unknown[] = [];
  const seen = new Set<string>();
  const read = async (pageNumber: number): Promise<unknown[]> => {
    const body = await client.get('/recurring/v3/agreements', {
      status: input.status,
      createdAfter,
      pageNumber,
      pageSize: AGREEMENT_PAGE_SIZE,
    });
    if (!Array.isArray(body)) throw new Error('Vipps MobilePay answered the agreement list in an unexpected form.');
    return body;
  };
  const add = (page: unknown[]) => {
    for (const agreement of page) {
      const id = asRecord(agreement).id;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      // Through the allow-list in views.ts: never the user's id or userinfo address.
      agreements.push(agreementView(agreement));
    }
  };
  for (let pageNumber = 1; pageNumber <= MAX_AGREEMENT_PAGES; pageNumber += 1) {
    const page = await read(pageNumber);
    add(page);
    if (page.length < AGREEMENT_PAGE_SIZE || page.length > AGREEMENT_PAGE_SIZE) {
      // A short page is the last one; a longer one means the API ignored the paging and sent everything.
      return { status: input.status ?? 'ACTIVE', count: agreements.length, agreements };
    }
  }
  // Every page was full: one more read tells whether the list ends here.
  if ((await read(MAX_AGREEMENT_PAGES + 1)).length > 0) {
    throw new TooMuchDataError(
      `There are more than ${MAX_AGREEMENT_PAGES * AGREEMENT_PAGE_SIZE} agreements with this status; use createdAfter to narrow the list. Refused rather than returned incomplete.`,
    );
  }
  return { status: input.status ?? 'ACTIVE', count: agreements.length, agreements };
}

export async function getAgreement(client: UpstreamClient, input: { agreementId: string }): Promise<unknown> {
  return agreementView(await client.get(agreementPath(input.agreementId)));
}

export async function listCharges(
  client: UpstreamClient,
  input: { agreementId: string; status?: (typeof CHARGE_STATUSES)[number] },
): Promise<unknown> {
  const charges: unknown[] = [];
  let token: string | undefined;
  for (let page = 1; page <= MAX_CHARGE_PAGES; page += 1) {
    const response = await client.getPage<unknown>(
      `${agreementPath(input.agreementId)}/charges`,
      { status: input.status },
      token ? { 'Continuation-Token': token } : undefined,
    );
    if (!Array.isArray(response.data)) throw new Error('Vipps MobilePay answered the charge list in an unexpected form.');
    charges.push(...response.data.map(withoutDerivedKeys));
    const next = response.headers['continuation-token'];
    if (!next) {
      return { agreementId: input.agreementId, count: charges.length, charges };
    }
    if (!/^[A-Za-z0-9-]{1,100}$/.test(next) || next === token) {
      throw new Error('Vipps MobilePay answered the charge list with an unusable continuation token.');
    }
    token = next;
  }
  throw new TooMuchDataError(
    `The agreement has more than ${MAX_CHARGE_PAGES} pages of charges; filter by status. Refused rather than returned incomplete.`,
  );
}

export async function getCharge(client: UpstreamClient, input: { agreementId: string; chargeId: string }): Promise<unknown> {
  return withoutDerivedKeys(await client.get(chargePath(input.agreementId, input.chargeId)));
}

/** The refusal when Vipps MobilePay answers that the id is the id of more than one charge (HTTP 409, `ambiguous-charge-id`). */
const AMBIGUOUS_CHARGE =
  'Refused: more than one charge has this id, so Vipps MobilePay does not say which is meant. get_charge reads the charge of a known agreement (agreementId and chargeId).';

/**
 * One charge by its own id, when the agreement is not known (`GET /recurring/v3/charges/{chargeId}`). Vipps MobilePay
 * documents it for looking into one charge, e.g. a customer's question, not for reading many. The charge passes the
 * allow-list in views.ts.
 */
export async function findCharge(client: UpstreamClient, input: { chargeId: string }): Promise<unknown> {
  let answer: unknown;
  try {
    answer = await client.get(`/recurring/v3/charges/${encodePathParam(input.chargeId, 'chargeId')}`);
  } catch (error) {
    // The text is ours and says what a 409 means here; the HTTP error is the cause, for the failure metadata.
    if (error instanceof VippsHttpError && !error.tokenRequest && error.status === 409) throw new Error(AMBIGUOUS_CHARGE, { cause: error });
    throw error;
  }
  return chargeView(answer);
}

export interface ChargeRefundInput {
  agreementId: string;
  chargeId: string;
  amount: number;
  currency: MerchantCurrency;
  description: string;
  /** Chosen by the caller, logged before the call, and reused when the same change is repeated. */
  idempotencyKey: string;
}

/**
 * Whether the charge's history holds a successful event of this very change:
 * the same Idempotency-Key, the expected event and, for a refund, the same
 * amount. Used only when the check before a change would refuse it, so a
 * retry whose first answer was lost learns that it was done.
 */
function hasEarlierEvent(charge: Record<string, unknown>, idempotencyKey: string, event: 'REFUND' | 'CANCEL' | 'CAPTURE', amount?: number): boolean {
  const history = Array.isArray(charge.history) ? charge.history : [];
  return history.some(entry => {
    const item = asRecord(entry);
    return (
      item.idempotencyKey === idempotencyKey &&
      item.event === event &&
      item.success === true &&
      (amount === undefined || item.amount === amount)
    );
  });
}

export async function refundCharge(client: UpstreamClient, input: ChargeRefundInput): Promise<unknown> {
  const charge = asRecord(await client.get(chargePath(input.agreementId, input.chargeId)));
  const summary = asRecord(charge.summary);
  const captured = summary.captured;
  const refunded = summary.refunded;
  if (!isMerchantCurrency(charge.currency) || !isMinorUnits(captured) || !isMinorUnits(refunded) || refunded > captured) {
    throw new ChangeRefusedError('Refused: the charge could not be read in the expected form, so nothing was sent.');
  }
  if (charge.currency !== input.currency) {
    throw new ChangeRefusedError(`Refused: the charge is in ${charge.currency}, not ${input.currency}. Nothing was sent.`);
  }
  const refundable = captured - refunded;
  if (input.amount > refundable) {
    if (hasEarlierEvent(charge, input.idempotencyKey, 'REFUND', input.amount)) {
      return {
        refundRequested: true,
        alreadyDone: true,
        idempotencyKey: input.idempotencyKey,
        agreementId: input.agreementId,
        chargeId: input.chargeId,
        amount: input.amount,
        currency: input.currency,
      };
    }
    throw new ChangeRefusedError(
      `Refused: ${input.amount} is more than the ${Math.max(0, refundable)} (minor units) charged and not yet refunded. Nothing was sent.`,
    );
  }
  await client.post(
    `${chargePath(input.agreementId, input.chargeId)}/refund`,
    { amount: input.amount, description: input.description },
    { idempotencyKey: input.idempotencyKey },
  );
  return {
    refundRequested: true,
    idempotencyKey: input.idempotencyKey,
    agreementId: input.agreementId,
    chargeId: input.chargeId,
    amount: input.amount,
    currency: input.currency,
  };
}

export async function cancelCharge(
  client: UpstreamClient,
  input: { agreementId: string; chargeId: string; idempotencyKey: string },
): Promise<unknown> {
  const charge = asRecord(await client.get(chargePath(input.agreementId, input.chargeId)));
  const status = typeof charge.status === 'string' ? charge.status : '';
  if (!CANCELLABLE_CHARGE_STATUSES.has(status)) {
    if (hasEarlierEvent(charge, input.idempotencyKey, 'CANCEL')) {
      return {
        cancelRequested: true,
        alreadyDone: true,
        idempotencyKey: input.idempotencyKey,
        agreementId: input.agreementId,
        chargeId: input.chargeId,
      };
    }
    throw new ChangeRefusedError(
      'Refused: only a pending, due, reserved or partially captured charge can be cancelled. Nothing was sent.',
    );
  }
  await client.delete(chargePath(input.agreementId, input.chargeId), { idempotencyKey: input.idempotencyKey });
  return {
    cancelRequested: true,
    idempotencyKey: input.idempotencyKey,
    agreementId: input.agreementId,
    chargeId: input.chargeId,
    previousStatus: status,
  };
}

/*
 * Three of the Recurring changes below make their Idempotency-Key from the request's content (derivedIdempotencyKey in
 * values.ts): the sales unit, the agreement and what the request says. The same request is always the same key, so a
 * call repeated after a failure or a lost answer is carried out by Vipps MobilePay at most once, and the caller cannot
 * repeat it under a new key. That key changes when the client secret is replaced, so each also has a second guard that
 * does not: a new charge has the business's orderId, which Vipps MobilePay takes once; a capture is checked against
 * what the charge shows as captured; a stop against the agreement's status. A change of an agreement gets a new key
 * for every request instead (see updateAgreement). Each reads the agreement or the charge first and refuses, without sending anything, what
 * Vipps MobilePay documents it would refuse; and a repeat finds a change that is already made, and says so.
 *
 * The texts are ours: what a status means for this request, and what to do. Nothing of the vendor's answer is read
 * out (see errors.ts).
 */

const REPEAT_SAME_INPUT =
  'Call again with exactly the same input: the server sends the same Idempotency-Key, so the change is made at most once.';
/** For a change of an agreement, whose key is new for every request: a repeat is safe because the agreement is read first. */
const REPEAT_UPDATE =
  'Call again with exactly the same input: the agreement is read first, and what it already has is not sent again.';

/** What a change says when it was not made, and when it is not known whether it was. */
interface ChangeTexts {
  none: string;
  unknown: string;
  /** What a repeat of the same input does. Default: the same Idempotency-Key is sent. */
  repeat?: string;
  /** Our explanation of HTTP 400 for this change. */
  badRequest: string;
  /** Our explanation of HTTP 409 for this change. */
  conflict?: string;
}

const NOT_FOUND = 'Vipps MobilePay does not know the agreement or the charge for these keys.';

/** The error of a failed change request, with our own note. Never anything of the vendor's answer or of the input. */
function changeFailure(error: unknown, texts: ChangeTexts): unknown {
  const repeat = texts.repeat ?? REPEAT_SAME_INPUT;
  if (!(error instanceof VippsHttpError)) {
    // A timeout, a lost connection, a redirect or an answer that could not be read: the request may have arrived. Our
    // own refusals (nothing sent) pass as they are.
    if (error instanceof Error && !error.message.startsWith('Refused:')) {
      return new Error(`${error.message} ${texts.unknown} ${repeat}`, { cause: error });
    }
    return error;
  }
  // The Access Token API refused or failed: the change was never sent.
  if (error.tokenRequest) return withNote(error, texts.none);
  if (error.status === 429 || error.status === 423) return withNote(error, `${texts.none} After the wait: ${repeat}`);
  if (error.status === 408 || error.status >= 500) return withNote(error, `${texts.unknown} ${repeat}`);
  const why = error.status === 400 ? texts.badRequest : error.status === 404 ? NOT_FOUND : error.status === 409 ? texts.conflict : undefined;
  return withNote(error, why === undefined ? texts.none : `${texts.none} ${why}`);
}

/** The sales unit, the agreement and the request: what a derived key is made of. */
function changeKey(client: UpstreamClient, kind: DerivedKeyKind, agreementId: string, request: unknown): string {
  return derivedIdempotencyKey(kind, (purpose, text) => client.keyedHash(purpose, text), {
    merchantSerialNumber: client.merchantSerialNumber ?? null,
    agreementId,
    request,
  });
}

/**
 * A key for one request only: `kind`, a dash and 32 random hex characters, in the form of the keys made from a
 * request's content, so it is never passed on either (isDerivedIdempotencyKey).
 */
function oneTimeKey(kind: DerivedKeyKind): string {
  return `${kind}-${randomBytes(16).toString('hex')}`;
}

/** The smallest and the largest amount of a charge or a price, in minor units (the Recurring guide's payment amounts). */
export const CHARGE_LIMITS: Readonly<Record<MerchantCurrency, { min: number; max: number }>> = {
  NOK: { min: 100, max: 2_000_000 },
  DKK: { min: 1, max: 30_000_000 },
  EUR: { min: 1, max: 200_000 },
};

/** An amount in minor units as a text, with the thousands apart: never a long run of digits in a text. */
function inUnits(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole}.${String(minor % 100).padStart(2, '0')} ${currency}`;
}

/** The status of an agreement as a text we can repeat: one of the documented ones, or none. */
function agreementStatus(agreement: Record<string, unknown>): (typeof AGREEMENT_STATUSES)[number] | undefined {
  return AGREEMENT_STATUSES.find(status => status === agreement.status);
}

const UNREADABLE_AGREEMENT = 'Refused: the agreement could not be read in the expected form, so nothing was sent.';
const UNKNOWN_STATUS = 'in a status this server does not know';

interface Pricing {
  type: string;
  currency: MerchantCurrency;
  suggestedMaxAmount?: number;
  maxAmount?: number;
}

/** The pricing of an agreement, when it can be read: its type, its currency and its maximums. */
function pricingOf(agreement: Record<string, unknown>): Pricing {
  const pricing = asRecord(agreement.pricing);
  if (typeof pricing.type !== 'string' || !isMerchantCurrency(pricing.currency)) throw new ChangeRefusedError(UNREADABLE_AGREEMENT);
  const minor = (value: unknown) => (isMinorUnits(value) ? value : undefined);
  return {
    type: pricing.type,
    currency: pricing.currency,
    suggestedMaxAmount: minor(pricing.suggestedMaxAmount),
    maxAmount: minor(pricing.maxAmount),
  };
}

function checkLimits(amount: number, currency: MerchantCurrency, what: string): void {
  const { min, max } = CHARGE_LIMITS[currency];
  if (amount < min || amount > max) {
    throw new ChangeRefusedError(`Refused: ${what} in ${currency} must be from ${inUnits(min, currency)} to ${inUnits(max, currency)}. Nothing was sent.`);
  }
}

/* ---- create_charge ---- */

export const CHARGE_TRANSACTION_TYPES = ['DIRECT_CAPTURE', 'RESERVE_CAPTURE'] as const;
export const PROCESSING_MODES = ['MULTIPLE_ATTEMPTS', 'SINGLE_ATTEMPT'] as const;
/** The most days Vipps MobilePay retries a charge after its due date. */
export const MAX_RETRY_DAYS = 14;
/**
 * The business's own number for a charge, which then becomes the charge's id (the API's orderId). Required: Vipps
 * MobilePay takes an orderId once per sales unit, so it is what keeps a charge from being created twice when the
 * Idempotency-Key no longer helps (after the client secret is replaced, or after Vipps MobilePay forgets the key).
 */
export const ORDER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface CreateChargeInput {
  agreementId: string;
  amount: number;
  currency: MerchantCurrency;
  /** Shown to the customer in the app. */
  description: string;
  /** YYYY-MM-DD: at least one day and at most two years ahead (Vipps MobilePay decides). */
  due: string;
  retryDays: number;
  transactionType: (typeof CHARGE_TRANSACTION_TYPES)[number];
  processingMode?: (typeof PROCESSING_MODES)[number];
  orderId: string;
}

/** What the fields must be together, which the schema cannot say. Nothing here reads the clock. */
export function checkCreateCharge(input: Record<string, unknown>): string | undefined {
  if (input.processingMode === 'SINGLE_ATTEMPT' && input.retryDays !== 0) return 'processingMode SINGLE_ATTEMPT needs retryDays 0.';
  return undefined;
}

/** What the create request says, in the API's own names. The key is made of this. Always a scheduled charge. */
function chargeContent(input: CreateChargeInput): Record<string, unknown> {
  return {
    amount: input.amount,
    transactionType: input.transactionType,
    description: input.description,
    type: 'RECURRING',
    due: input.due,
    retryDays: input.retryDays,
    ...(input.processingMode === undefined ? {} : { processingMode: input.processingMode }),
    orderId: input.orderId,
  };
}

const CHARGE_TEXTS: ChangeTexts = {
  none: 'Nothing was created.',
  unknown: 'It is not known whether the charge was created.',
  badRequest:
    'A charge is refused when the due date is not at least one day and at most two years ahead, when the amount is more than the agreement allows (for a fixed price up to five times the price within an interval, for a variable price up to the higher of the suggested and the customer’s own maximum), or when the orderId is used.',
  conflict: 'Another charge has this orderId, or Vipps MobilePay refused the repeat of a request it has seen.',
};

const CHARGE_EXISTS = 'This charge already exists, so nothing new was created.';
const ORDER_ID_USED =
  'Refused: a charge with this orderId exists and cannot be shown to be this request: another request, or this one made before the client secret was replaced. Nothing was created. An orderId is used once per sales unit: get_charge shows the charge that has it.';

/** Whether a charge was created by a request with this key: its history has a CREATE with the key. */
function createdWith(charge: Record<string, unknown>, idempotencyKey: string): boolean {
  const history = Array.isArray(charge.history) ? charge.history : [];
  return history.some(entry => {
    const item = asRecord(entry);
    return item.event === 'CREATE' && item.idempotencyKey === idempotencyKey && item.success !== false;
  });
}

type FoundCharge = { kind: 'ours'; charge: Record<string, unknown> } | { kind: 'other' } | { kind: 'none' } | { kind: 'unread' };

/**
 * After a refusal: the charge with the request's orderId, and whether this very request created it. Only a charge
 * whose history holds this request's key is taken for it.
 */
async function findOwnCharge(client: UpstreamClient, input: CreateChargeInput, idempotencyKey: string): Promise<FoundCharge> {
  let charge: Record<string, unknown>;
  try {
    charge = asRecord(await client.get(chargePath(input.agreementId, input.orderId)));
  } catch (error) {
    if (error instanceof VippsHttpError && !error.tokenRequest && error.status === 404) return { kind: 'none' };
    return { kind: 'unread' };
  }
  return createdWith(charge, idempotencyKey) ? { kind: 'ours', charge } : { kind: 'other' };
}

/** The status of a charge as a text we can repeat: one of the documented ones, or none. */
function chargeStatus(charge: Record<string, unknown>): (typeof CHARGE_STATUSES)[number] | undefined {
  return CHARGE_STATUSES.find(status => status === charge.status);
}

/** The charge id of an answer or a charge, when it has the form of one. */
function chargeIdOf(value: unknown): string | null {
  return typeof value === 'string' && RECURRING_ID_PATTERN.test(value) ? value : null;
}

/** The answer of create_charge, in one form however the charge came to exist. Only our own fields and the status. */
function chargeAnswer(input: CreateChargeInput, outcome: { created: boolean; chargeId: string | null; status?: string }): Record<string, unknown> {
  const notes: string[] = [outcome.created ? 'Vipps MobilePay accepted the charge.' : CHARGE_EXISTS];
  if (outcome.chargeId === null) notes.push('Vipps MobilePay answered without a usable charge id; list_charges shows the charge.');
  else if (outcome.status === undefined) notes.push('Its status could not be read back; get_charge shows it.');
  notes.push(
    input.transactionType === 'RESERVE_CAPTURE'
      ? 'The amount is reserved on the due date, and capture_charge draws it once the product or service is delivered.'
      : 'The customer is charged on the due date, and Vipps MobilePay tries again for retryDays days if that fails.',
  );
  notes.push('A charge is PENDING until 30 days before the due date, then DUE; cancel_charge cancels it.');
  return {
    created: outcome.created,
    alreadyExists: !outcome.created,
    agreementId: input.agreementId,
    chargeId: outcome.chargeId,
    amount: input.amount,
    currency: input.currency,
    transactionType: input.transactionType,
    due: input.due,
    status: outcome.status ?? null,
    note: notes.join(' '),
  };
}

export async function createCharge(client: UpstreamClient, input: CreateChargeInput): Promise<unknown> {
  const agreement = asRecord(await client.get(agreementPath(input.agreementId)));
  const status = agreementStatus(agreement);
  if (status !== 'ACTIVE') {
    throw new ChangeRefusedError(`Refused: a charge can be created only on an ACTIVE agreement, and this one is ${status ?? UNKNOWN_STATUS}. Nothing was sent.`);
  }
  const pricing = pricingOf(agreement);
  if (pricing.currency !== input.currency) {
    throw new ChangeRefusedError(`Refused: the agreement is in ${pricing.currency}, not ${input.currency}. Nothing was sent.`);
  }
  checkLimits(input.amount, input.currency, 'a charge');
  if (pricing.type === 'VARIABLE') {
    const limit = Math.max(pricing.suggestedMaxAmount ?? 0, pricing.maxAmount ?? 0);
    if (input.amount > limit) {
      throw new ChangeRefusedError(
        `Refused: the agreement has a variable price, and a charge may be at most ${inUnits(limit, input.currency)}, the higher of the suggested and the customer’s own maximum. Nothing was sent.`,
      );
    }
  }

  const content = chargeContent(input);
  const idempotencyKey = changeKey(client, 'charge', input.agreementId, content);
  let accepted: unknown;
  try {
    accepted = await client.post(`${agreementPath(input.agreementId)}/charges`, content, { idempotencyKey });
  } catch (error) {
    // A refusal because the request was seen before, or because its orderId is used: read the charge with it.
    if (error instanceof VippsHttpError && !error.tokenRequest && error.status === 409) {
      const found = await findOwnCharge(client, input, idempotencyKey);
      if (found.kind === 'ours') {
        return chargeAnswer(input, { created: false, chargeId: chargeIdOf(found.charge.id), status: chargeStatus(found.charge) });
      }
      if (found.kind === 'other') throw new ChangeRefusedError(ORDER_ID_USED, { cause: error });
    }
    throw changeFailure(error, CHARGE_TEXTS);
  }
  const chargeId = chargeIdOf(asRecord(accepted).chargeId);
  if (chargeId === null) return chargeAnswer(input, { created: true, chargeId: null });
  // The status, read back. Taken only from a charge that says what the request said: amount, text and type.
  let chargeState: string | undefined;
  try {
    const charge = asRecord(await client.get(chargePath(input.agreementId, chargeId)));
    const same =
      charge.amount === input.amount &&
      charge.description === input.description &&
      (charge.transactionType === undefined || charge.transactionType === input.transactionType);
    chargeState = same ? chargeStatus(charge) : undefined;
  } catch {
    // The charge is created; only its status is not known.
  }
  return chargeAnswer(input, { created: true, chargeId, status: chargeState });
}

/* ---- capture_charge ---- */

export interface CaptureChargeInput {
  agreementId: string;
  chargeId: string;
  amount: number;
  currency: MerchantCurrency;
  /** How much of the charge is captured before this capture, as get_charge shows it (summary.captured). */
  alreadyCaptured: number;
}

const CAPTURE_TEXTS: ChangeTexts = {
  none: 'Nothing was captured.',
  unknown: 'It is not known whether the amount was captured.',
  badRequest:
    'A capture is refused when the charge is not reserved, when it was not created as RESERVE_CAPTURE, when the amount is more than is reserved and not captured, or when partial capture is not enabled for the sales unit.',
  conflict: 'The charge changed while the capture was sent; get_charge shows it.',
};

/** Charges Vipps MobilePay lets a merchant capture. */
const CAPTURABLE_CHARGE_STATUSES: ReadonlySet<string> = new Set(['RESERVED', 'PARTIALLY_CAPTURED']);

export async function captureCharge(client: UpstreamClient, input: CaptureChargeInput): Promise<unknown> {
  const charge = asRecord(await client.get(chargePath(input.agreementId, input.chargeId)));
  const summary = asRecord(charge.summary);
  const { amount, currency } = charge;
  const captured = summary.captured;
  const cancelled = summary.cancelled ?? 0;
  if (!isMerchantCurrency(currency) || !isMinorUnits(amount) || !isMinorUnits(captured) || !isMinorUnits(cancelled)) {
    throw new ChangeRefusedError('Refused: the charge could not be read in the expected form, so nothing was sent.');
  }
  if (currency !== input.currency) {
    throw new ChangeRefusedError(`Refused: the charge is in ${currency}, not ${input.currency}. Nothing was sent.`);
  }
  // The key is made of the capture and of what was captured before it: two captures of the same amount are two
  // requests, and the same capture repeated is one.
  const idempotencyKey = changeKey(client, 'capture', input.agreementId, {
    chargeId: input.chargeId,
    amount: input.amount,
    currency: input.currency,
    alreadyCaptured: input.alreadyCaptured,
  });
  const done = { captureRequested: true, agreementId: input.agreementId, chargeId: input.chargeId, amount: input.amount, currency: input.currency };
  if (captured !== input.alreadyCaptured) {
    // A repeat of a capture whose answer was lost: its event, with this key and amount, is in the history.
    if (hasEarlierEvent(charge, idempotencyKey, 'CAPTURE', input.amount)) {
      return { ...done, alreadyDone: true, note: 'This capture was already made, so nothing was sent again.' };
    }
    throw new ChangeRefusedError(
      `Refused: ${captured} (minor units) of the charge is captured, not ${input.alreadyCaptured} as alreadyCaptured says. Nothing was sent. get_charge shows the charge; give what it shows.`,
    );
  }
  if (charge.transactionType !== undefined && charge.transactionType !== 'RESERVE_CAPTURE') {
    throw new ChangeRefusedError('Refused: only a charge created as RESERVE_CAPTURE can be captured, and this one is charged directly. Nothing was sent.');
  }
  if (!CAPTURABLE_CHARGE_STATUSES.has(typeof charge.status === 'string' ? charge.status : '')) {
    throw new ChangeRefusedError('Refused: only a reserved or partially captured charge can be captured. Nothing was sent.');
  }
  const left = amount - captured - cancelled;
  if (input.amount > left) {
    throw new ChangeRefusedError(`Refused: ${input.amount} is more than the ${Math.max(0, left)} (minor units) reserved and not captured. Nothing was sent.`);
  }
  try {
    await client.post(`${chargePath(input.agreementId, input.chargeId)}/capture`, { amount: input.amount }, { idempotencyKey });
  } catch (error) {
    throw changeFailure(error, CAPTURE_TEXTS);
  }
  return { ...done, alreadyDone: false, note: 'get_charge shows the charge after the capture.' };
}

/* ---- update_agreement and stop_agreement ---- */

export const INTERVAL_UNITS = ['YEAR', 'MONTH', 'WEEK', 'DAY'] as const;

export interface UpdateAgreementInput {
  agreementId: string;
  productName?: string;
  productDescription?: string;
  merchantAgreementUrl?: string;
  /** A fixed (LEGACY) price, in minor units. */
  price?: number;
  /** A variable price's suggested maximum, in minor units. */
  suggestedMaxAmount?: number;
  currency?: MerchantCurrency;
  /**
   * A fixed interval: every `count` `unit`s. A flexible interval (type FLEXIBLE) is not offered: the agreement shows its
   * interval only as a unit and a count, so a repeat could not see that the change was made and would send it again.
   */
  interval?: { unit: (typeof INTERVAL_UNITS)[number]; count: number };
}

const UPDATE_FIELDS = ['productName', 'productDescription', 'merchantAgreementUrl', 'price', 'suggestedMaxAmount', 'interval'] as const;

/** What the fields must be together, which the schema cannot say. */
export function checkUpdateAgreement(input: Record<string, unknown>): string | undefined {
  if (!UPDATE_FIELDS.some(field => input[field] !== undefined)) return 'Give at least one thing to change.';
  if (input.price !== undefined && input.suggestedMaxAmount !== undefined) {
    return 'Give price (a fixed price) or suggestedMaxAmount (a variable price), not both: an agreement has one kind of price.';
  }
  const priced = input.price !== undefined || input.suggestedMaxAmount !== undefined;
  if (priced && input.currency === undefined) return 'A price needs currency.';
  if (!priced && input.currency !== undefined) return 'currency is only for price or suggestedMaxAmount.';
  return undefined;
}

const UPDATE_TEXTS: ChangeTexts = {
  none: 'Nothing was changed.',
  unknown: 'It is not known whether the agreement was changed.',
  repeat: REPEAT_UPDATE,
  badRequest:
    'A change is refused when the agreement is stopped, when the price does not fit its kind of price (price only for a fixed price, suggestedMaxAmount only for a variable one) or the limits of the currency, or when the address is not https.',
};

const STOP_TEXTS: ChangeTexts = {
  none: 'The agreement was not stopped.',
  unknown: 'It is not known whether the agreement was stopped.',
  badRequest: 'Vipps MobilePay refused to stop the agreement; get_agreement shows its status.',
};

/** The request body of a change of an agreement, in the API's own names. */
function updateBody(input: UpdateAgreementInput): Record<string, unknown> {
  const { interval } = input;
  return {
    ...(input.productName === undefined ? {} : { productName: input.productName }),
    ...(input.productDescription === undefined ? {} : { productDescription: input.productDescription }),
    ...(input.merchantAgreementUrl === undefined ? {} : { merchantAgreementUrl: input.merchantAgreementUrl }),
    ...(input.price === undefined ? {} : { pricing: { amount: input.price } }),
    ...(input.suggestedMaxAmount === undefined ? {} : { pricing: { suggestedMaxAmount: input.suggestedMaxAmount } }),
    ...(interval === undefined ? {} : { interval: { type: 'RECURRING', period: { unit: interval.unit, count: interval.count } } }),
  };
}

/**
 * Whether the agreement already has what a field of the body asks for. What cannot be read is never the same. Every
 * field the tool can send can be read back here (the specification requires each in an agreement), so a repeat after a
 * lost answer sends nothing.
 */
function alreadyHas(agreement: Record<string, unknown>, field: string, value: unknown): boolean {
  const asked = asRecord(value);
  switch (field) {
    case 'productName':
    case 'productDescription':
    case 'merchantAgreementUrl':
      return agreement[field] === value;
    case 'pricing': {
      const pricing = asRecord(agreement.pricing);
      return asked.amount !== undefined ? pricing.amount === asked.amount : pricing.suggestedMaxAmount === asked.suggestedMaxAmount;
    }
    case 'interval': {
      const now = asRecord(agreement.interval);
      const period = asRecord(asked.period);
      return now.unit === period.unit && now.count === period.count;
    }
    default:
      return false;
  }
}

export async function updateAgreement(client: UpstreamClient, input: UpdateAgreementInput): Promise<unknown> {
  const agreement = asRecord(await client.get(agreementPath(input.agreementId)));
  const status = agreementStatus(agreement);
  if (status !== 'ACTIVE' && status !== 'PENDING') {
    throw new ChangeRefusedError(`Refused: only a pending or active agreement can be changed, and this one is ${status ?? UNKNOWN_STATUS}. Nothing was sent.`);
  }
  const price = input.price ?? input.suggestedMaxAmount;
  if (price !== undefined) {
    const pricing = pricingOf(agreement);
    if (pricing.currency !== input.currency) {
      throw new ChangeRefusedError(`Refused: the agreement is in ${pricing.currency}, not ${String(input.currency)}. Nothing was sent.`);
    }
    if (input.price !== undefined && pricing.type !== 'LEGACY') {
      throw new ChangeRefusedError('Refused: price changes a fixed price, and this agreement does not have one. Nothing was sent.');
    }
    if (input.suggestedMaxAmount !== undefined && pricing.type !== 'VARIABLE') {
      throw new ChangeRefusedError('Refused: suggestedMaxAmount changes a variable price, and this agreement does not have one. Nothing was sent.');
    }
    checkLimits(price, pricing.currency, 'the price');
  }
  const body = updateBody(input);
  const fields = Object.keys(body);
  const changed = fields.filter(field => !alreadyHas(agreement, field, body[field]));
  const answer = { agreementId: input.agreementId, changed, alreadyAsAsked: fields.filter(field => !changed.includes(field)) };
  if (changed.length === 0) {
    return { ...answer, updateRequested: false, note: 'The agreement already has what was asked, so nothing was sent.' };
  }
  const request = Object.fromEntries(changed.map(field => [field, body[field]]));
  // A new key for every change that is sent. A key made from the change would be the same for A to B now and A to B
  // again after B to A, and Vipps MobilePay answers a key it has seen with its first answer without changing the
  // agreement. A repeat after a lost answer needs no key to be safe: it reads the agreement first and sends nothing
  // when the agreement already has what is asked, and setting the same values twice changes nothing.
  const idempotencyKey = oneTimeKey('update');
  try {
    await client.patch(agreementPath(input.agreementId), request, { idempotencyKey });
  } catch (error) {
    throw changeFailure(error, UPDATE_TEXTS);
  }
  const notes = ['get_agreement shows the agreement after the change.'];
  if (request.pricing !== undefined) notes.push('Vipps MobilePay does not tell the customer of a new price: the business tells the customer itself.');
  return { ...answer, updateRequested: true, note: notes.join(' ') };
}

export async function stopAgreement(client: UpstreamClient, input: { agreementId: string }): Promise<unknown> {
  const agreement = asRecord(await client.get(agreementPath(input.agreementId)));
  const status = agreementStatus(agreement);
  if (status === 'STOPPED') {
    return { stopped: true, alreadyStopped: true, agreementId: input.agreementId, note: 'The agreement was already stopped, so nothing was sent.' };
  }
  if (status !== 'ACTIVE' && status !== 'PENDING') {
    throw new ChangeRefusedError(`Refused: only a pending or active agreement can be stopped, and this one is ${status ?? UNKNOWN_STATUS}. Nothing was sent.`);
  }
  // Stopping is for good, so the key is the agreement's alone: every stop of it is the same request.
  const request = { status: 'STOPPED' };
  const idempotencyKey = changeKey(client, 'stop', input.agreementId, request);
  try {
    await client.patch(agreementPath(input.agreementId), request, { idempotencyKey });
  } catch (error) {
    throw changeFailure(error, STOP_TEXTS);
  }
  return {
    stopped: true,
    alreadyStopped: false,
    agreementId: input.agreementId,
    previousStatus: status,
    note: 'The agreement is stopped for good and cannot be started again. Vipps MobilePay cancels its pending, due and reserved charges, and no new charge can be created on it.',
  };
}
