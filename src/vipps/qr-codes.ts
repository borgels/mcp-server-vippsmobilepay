import type { UpstreamClient } from './client.js';
import { NEEDS_SALES_UNIT } from './order-details.js';
import { TooMuchDataError } from './reports.js';
import { callbackQrListView, MAX_LIST_ITEMS, redirectQrListView } from './views.js';

/**
 * QR API (v1): the sales unit's fixed QR codes. Read only: nothing here
 * creates, changes or deletes a code; those requests are not in the client's
 * allowed list.
 *
 *   redirect  a code that sends the customer to a web address of the business
 *             (`GET /qr/v1/merchant-redirect`)
 *   callback  a code that tells the business that a customer has scanned it,
 *             e.g. at a till or a vending machine (`GET /qr/v1/merchant-callback`)
 *
 * The list of redirect codes requires an `Accept` header that names an image
 * format (or `text/targetUrl`); the answer itself is JSON either way, and
 * `application/json` is refused with HTTP 400 (observed in the test
 * environment, 25 November 2026). The codes are asked for as SVG, which is
 * also the default of the callback list.
 */

export const QR_KINDS = ['redirect', 'callback'] as const;
/** Codes of one kind read in one call; more is refused, not cut short. */
export const MAX_QR_CODES = MAX_LIST_ITEMS;

function refuseTooMany(answer: unknown): void {
  if (Array.isArray(answer) && answer.length > MAX_QR_CODES) {
    throw new TooMuchDataError(`The sales unit has more than ${MAX_QR_CODES} QR codes of one kind. Refused rather than returned incomplete.`);
  }
}

export async function listQrCodes(client: UpstreamClient, input: { kind?: (typeof QR_KINDS)[number] }): Promise<unknown> {
  if (client.merchantSerialNumber === undefined) throw new Error(NEEDS_SALES_UNIT);
  const codes: Array<Record<string, unknown>> = [];
  // Both kinds, or the call fails: a list of one kind is never taken for all the codes.
  if (input.kind !== 'callback') {
    const answer = (await client.getPage<unknown>('/qr/v1/merchant-redirect', undefined, { Accept: 'image/svg+xml' })).data;
    refuseTooMany(answer);
    codes.push(...redirectQrListView(answer));
  }
  if (input.kind !== 'redirect') {
    const answer = await client.get<unknown>('/qr/v1/merchant-callback');
    refuseTooMany(answer);
    codes.push(...callbackQrListView(answer));
  }
  return { count: codes.length, codes };
}
