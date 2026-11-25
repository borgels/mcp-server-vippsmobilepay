import { VippsHttpError, withNote } from '../errors.js';
import type { UpstreamClient } from './client.js';
import { NEEDS_SALES_UNIT } from './order-details.js';
import { TooMuchDataError } from './reports.js';
import { MAX_LIST_ITEMS, salesUnitListView, salesUnitView, UnexpectedAnswerError } from './views.js';

/**
 * Management API (v1): the sales units the keys can read, and what Vipps
 * MobilePay has enabled for the one the keys are used for. Read only: nothing
 * here orders a product, changes a sales unit or reads another merchant;
 * those requests are not in the client's allowed list.
 *
 * Vipps MobilePay has no Management API in the test environment, so the two
 * tools are offered in production only (`environments` in the tool table).
 * With partner keys `GET /management/v1/sales-units` lists the sales units of
 * every merchant of the partner, so the list is for the merchant's own keys
 * only, and the one sales unit read is always the configured one.
 */

/** Sales units read in one call; more is refused, not cut short. */
export const MAX_SALES_UNITS = MAX_LIST_ITEMS;

const MANAGEMENT_REFUSED = 'The refusal came from the Management API (sales units), not from a payment API.';

async function read(client: UpstreamClient, path: string): Promise<unknown> {
  try {
    return await client.get(path);
  } catch (error) {
    if (error instanceof VippsHttpError && !error.tokenRequest && (error.status === 401 || error.status === 403)) {
      throw withNote(error, MANAGEMENT_REFUSED);
    }
    throw error;
  }
}

export async function listSalesUnits(client: UpstreamClient): Promise<unknown> {
  const answer = await read(client, '/management/v1/sales-units');
  if (Array.isArray(answer) && answer.length > MAX_SALES_UNITS) {
    throw new TooMuchDataError(`The keys can read more than ${MAX_SALES_UNITS} sales units. Refused rather than returned incomplete.`);
  }
  const salesUnits = salesUnitListView(answer);
  return { count: salesUnits.length, salesUnits };
}

export async function getSalesUnit(client: UpstreamClient): Promise<unknown> {
  const msn = client.merchantSerialNumber;
  if (msn === undefined) throw new Error(NEEDS_SALES_UNIT);
  const unit = salesUnitView(await read(client, `/management/v1/sales-units/${msn}`));
  // The one that was asked for, or nothing: another sales unit's settings are never taken for this one's.
  if (unit.msn !== msn) throw new UnexpectedAnswerError('the sales unit');
  return unit;
}
