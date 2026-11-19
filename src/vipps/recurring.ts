import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { ChangeRefusedError } from './payments.js';
import { TooMuchDataError } from './reports.js';
import { isMerchantCurrency, isMinorUnits, type MerchantCurrency } from './values.js';
import { agreementView } from './views.js';

/**
 * Recurring API (v3): agreements and their charges; refund or cancel one
 * charge. Nothing here changes an agreement (price, interval, status) or
 * creates a charge: those requests are not in the client's allowed list.
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
    charges.push(...response.data);
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
  return client.get(chargePath(input.agreementId, input.chargeId));
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
function hasEarlierEvent(charge: Record<string, unknown>, idempotencyKey: string, event: 'REFUND' | 'CANCEL', amount?: number): boolean {
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
