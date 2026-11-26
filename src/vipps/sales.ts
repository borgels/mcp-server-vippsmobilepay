import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { NotOwnLedgerError } from './owner-binding.js';
import { lastBegunLedgerDate } from './reports.js';
import { salesPageView, TooMuchDataError, UnexpectedAnswerError } from './views.js';

/**
 * Sales API: each sale of a ledger as a capture or a refund, with its
 * amounts, its order lines and their VAT. Vipps MobilePay documents it for
 * accounting keys only, in production only, and for sales paid to a
 * Vippsnummer or MobilePay number and in mPOS; an ePayment payment is not
 * among them.
 *
 * Every function here needs a client bound to one organisation
 * (owner-binding.ts) and refuses without one: the ledger asked for must be
 * one of that organisation's before any sales request is sent. Every answer
 * is read strictly through an allow-list (views.ts), which names nothing
 * about the customer. A list is read to its end or refused.
 */

/** Pages of sales read for one ledger date. */
export const MAX_SALES_PAGES = 100;
/** Sales list_sales returns in one call; more is refused, not cut short. */
export const MAX_SALES = 5_000;

/** The organisation's ledger, or the refusal: also when the client is not bound to an organisation at all. */
async function ownLedgerOnly(client: UpstreamClient, ledgerId: string): Promise<void> {
  if (!client.ownLedgers) {
    throw new Error('Refused: the sales of a ledger are read with accounting keys only, for the organisation of the call.');
  }
  if (!(await client.ownLedgers()).ids.has(ledgerId)) throw new NotOwnLedgerError();
}

const salesPath = (ledgerId: string): string => `/sales/report/v1/ledgers/${encodePathParam(ledgerId, 'ledgerId')}`;

/** The day before a date written YYYY-MM-DD. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export interface SalesDateInput {
  ledgerId: string;
  ledgerDate: string;
}

/**
 * Every sale of one ledger date. A date that has not begun is refused before anything is asked for. The Sales API
 * does not say whether a ledger date is closed, and a ledger date can end later than midnight, so for the newest
 * two dates the answer says that more sales can come.
 */
export async function listSales(client: UpstreamClient, input: SalesDateInput): Promise<unknown> {
  await ownLedgerOnly(client, input.ledgerId);
  const lastBegun = lastBegunLedgerDate(client.currentTime());
  if (input.ledgerDate > lastBegun) {
    throw new Error('Refused: that ledger date has not begun. Nothing was asked for.');
  }
  const path = `${salesPath(input.ledgerId)}/dates/${encodePathParam(input.ledgerDate, 'ledgerDate')}`;
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_SALES_PAGES; page += 1) {
    const answer = salesPageView(await client.get(path, cursor ? { cursor } : undefined));
    items.push(...answer.items);
    if (items.length > MAX_SALES) {
      throw new TooMuchDataError(
        `The ledger date holds more than ${MAX_SALES} sales entries. Refused rather than returned incomplete.`,
      );
    }
    if (!answer.hasMore) {
      const open = input.ledgerDate >= dayBefore(lastBegun);
      return {
        ledgerId: input.ledgerId,
        ledgerDate: input.ledgerDate,
        complete: !open,
        ...(open
          ? { note: 'This ledger date may not be over: more sales can come for it. The Sales API does not say when a date is closed.' }
          : {}),
        amountsInMinorUnits: true,
        count: items.length,
        items,
      };
    }
    if (!answer.cursor || answer.cursor === cursor) throw new UnexpectedAnswerError('the sales (more pages without a new cursor)');
    cursor = answer.cursor;
  }
  throw new TooMuchDataError(
    `The ledger date needs more than ${MAX_SALES_PAGES} pages of sales. Refused rather than returned incomplete.`,
  );
}

export interface SaleInput {
  ledgerId: string;
  /** The business's own reference of the sale: every capture and refund of it. */
  reference?: string;
  /** Vipps MobilePay's reference of one capture or refund. */
  pspReference?: string;
}

/**
 * The captures and refunds of one sale, by the business's reference, or one of them by Vipps MobilePay's reference.
 * Refused when the answer holds an entry with another reference than the one asked for, or says there are more
 * entries than it holds (the two requests take no cursor).
 */
export async function getSale(client: UpstreamClient, input: SaleInput): Promise<unknown> {
  await ownLedgerOnly(client, input.ledgerId);
  const by = input.reference !== undefined ? 'reference' : 'pspReference';
  const value = (by === 'reference' ? input.reference : input.pspReference) as string;
  const segment = by === 'reference' ? 'references' : 'psp-references';
  const answer = salesPageView(await client.get(`${salesPath(input.ledgerId)}/${segment}/${encodePathParam(value, by)}`));
  if (answer.hasMore) {
    throw new TooMuchDataError('The sale has more entries than one answer holds. Refused rather than returned incomplete.');
  }
  if (answer.items.some(item => item[by] !== value)) throw new UnexpectedAnswerError('the sale (an entry with another reference)');
  return { ledgerId: input.ledgerId, [by]: value, amountsInMinorUnits: true, count: answer.items.length, items: answer.items };
}
