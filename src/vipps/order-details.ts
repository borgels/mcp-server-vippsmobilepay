import { VippsHttpError, withNote } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { orderDetailsView } from './views.js';

/**
 * Order Management API (v2): the order lines and the category stored with a
 * payment or a Recurring charge. Read only: nothing here adds or changes a
 * receipt, a category or an image; those requests are not in the client's
 * allowed list.
 *
 * `GET /order-management/v2/{paymentType}/{orderId}`: `ECOM` with the
 * reference of an ePayment payment, `RECURRING` with the id of a charge. The
 * ePayment API itself has no request that returns the order lines sent when
 * a payment was created; Vipps MobilePay documents this one as the way to
 * read them back.
 */

/** The refusal when no sales unit is configured: the Order Management API requires Merchant-Serial-Number. */
export const NEEDS_SALES_UNIT =
  'Refused: this needs the sales unit. Set VIPPS_MERCHANT_SERIAL_NUMBER (a gateway instance always has it). Nothing was sent.';

const NO_ORDER_DETAILS =
  'No order lines or category are stored with it, or it does not exist. A payment has them only when the business or its system sent them.';

/** Exactly one of the two: the reference of a payment, or the id of a charge. */
export function checkReceipt(input: Record<string, unknown>): string | undefined {
  const given = [input.reference, input.chargeId].filter(value => value !== undefined).length;
  return given === 1 ? undefined : 'Give exactly one of reference (an ePayment payment) and chargeId (a Recurring charge).';
}

export async function getReceipt(client: UpstreamClient, input: { reference?: string; chargeId?: string }): Promise<unknown> {
  if (client.merchantSerialNumber === undefined) throw new Error(NEEDS_SALES_UNIT);
  const path =
    input.reference !== undefined
      ? `/order-management/v2/ECOM/${encodePathParam(input.reference, 'reference')}`
      : `/order-management/v2/RECURRING/${encodePathParam(input.chargeId, 'chargeId')}`;
  let answer: unknown;
  try {
    answer = await client.get(path);
  } catch (error) {
    if (error instanceof VippsHttpError && !error.tokenRequest && error.status === 404) throw withNote(error, NO_ORDER_DETAILS);
    throw error;
  }
  const details = orderDetailsView(answer);
  return input.reference !== undefined ? { reference: input.reference, ...details } : { chargeId: input.chargeId, ...details };
}
