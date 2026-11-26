import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { requireOwnLedger } from './owner-binding.js';
import { datesBetween } from './values.js';
import { ledgerEntriesView, TooMuchDataError } from './views.js';

export { TooMuchDataError };

/**
 * Report API: ledgers, and the funds and fees ledgers per ledger date.
 *
 * Every list is read to its end or refused: when a cap below is reached, the
 * call fails with our own text and returns nothing, rather than a list that
 * looks complete but is not. A ledger date that Vipps MobilePay has not closed
 * yet (`tryLater`) is named in the result, which then says it is incomplete;
 * every page it has so far is still read. A date that has not begun is not
 * requested (lastBegunLedgerDate), because Vipps MobilePay answers HTTP 400
 * for a ledger date more than 24 hours ahead and the whole period would fail
 * with it. It is named apart from the open dates (`futureDates`), the dates
 * actually read are given (`readFrom`, `readTo`), and `note` says in words
 * what the answer lacks.
 *
 * With accounting keys the client is bound to one organisation
 * (owner-binding.ts): the ledger list is that organisation's ledgers only,
 * without the payout account, a period is read only for one of them, and
 * every entry is read strictly through an allow-list. Nothing of those
 * answers had been seen when this was written, so nothing is passed on that
 * is not named.
 */

/** Pages of GET /settlement/v1/ledgers read in one call. */
export const MAX_LEDGER_PAGES = 20;
/** Days one report call may span. */
export const MAX_REPORT_DAYS = 31;
/** Pages of the Report API read in one call, across all dates. */
export const MAX_REPORT_PAGES = 200;
/** Entries list_transactions returns in one call; more is refused, not cut short. */
export const MAX_TRANSACTIONS = 5_000;

export type ReportTopic = 'funds' | 'fees';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function unexpected(what: string): Error {
  return new Error(`Vipps MobilePay answered ${what} in an unexpected form.`);
}

/** A ledger with its payout bank account reduced to the scheme and the last four characters. */
function maskLedger(ledger: unknown): unknown {
  const source = asRecord(ledger);
  if (!('payoutBankAccount' in source)) return ledger;
  const account = asRecord(source.payoutBankAccount);
  const id = typeof account.id === 'string' ? account.id : '';
  return {
    ...source,
    payoutBankAccount: {
      scheme: typeof account.scheme === 'string' ? account.scheme : null,
      idLast4: id.length > 4 ? id.slice(-4) : null,
    },
  };
}

/**
 * The ledgers of the organisation an accounting call is bound to. Ledgers that could not be attributed to one
 * organisation are left out and counted, and the answer says so: they may be this organisation's.
 */
async function listOwnLedgers(ownLedgers: NonNullable<UpstreamClient['ownLedgers']>): Promise<unknown> {
  const own = await ownLedgers();
  const left = own.notAttributed;
  return {
    count: own.ledgers.length,
    ledgers: own.ledgers,
    ...(left > 0
      ? {
          ledgersNotAttributed: left,
          note: `${left} ${left === 1 ? 'ledger was' : 'ledgers were'} left out: Vipps MobilePay names no single organisation as ${left === 1 ? 'its' : 'their'} owner, so it is not known whose ${left === 1 ? 'it is' : 'they are'}. The list may lack ledgers of this organisation.`,
        }
      : {}),
  };
}

export async function listLedgers(client: UpstreamClient): Promise<unknown> {
  if (client.ownLedgers) return listOwnLedgers(() => (client.ownLedgers as NonNullable<UpstreamClient['ownLedgers']>)());
  const ledgers: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_LEDGER_PAGES; page += 1) {
    const body = asRecord(await client.get('/settlement/v1/ledgers', cursor ? { cursor } : undefined));
    if (!Array.isArray(body.items)) throw unexpected('the ledger list');
    ledgers.push(...body.items.map(maskLedger));
    const next = typeof body.cursor === 'string' ? body.cursor : '';
    if (!next) {
      return { count: ledgers.length, ledgers };
    }
    if (next === cursor) throw unexpected('the ledger list (a cursor that does not move)');
    cursor = next;
  }
  throw new TooMuchDataError(
    `The ledger list is longer than ${MAX_LEDGER_PAGES} pages; refused rather than returned incomplete.`,
  );
}

interface DateReport {
  ledgerDate: string;
  /** True when Vipps MobilePay has not closed the ledger date yet (tryLater): entries may be missing. */
  open: boolean;
  items: Array<Record<string, unknown>>;
}

/**
 * Every entry of one ledger date, following the cursor while hasMore is true. tryLater says only that the date is
 * still open; it does not end the pages that exist now. Vipps MobilePay: "If hasMore and tryLater are both true,
 * do not wait: keep paging with the returned cursor."
 */
async function readLedgerDate(
  client: UpstreamClient,
  ledgerId: string,
  topic: ReportTopic,
  ledgerDate: string,
  budget: { pages: number },
): Promise<DateReport> {
  const path = `/report/v2/ledgers/${encodePathParam(ledgerId, 'ledgerId')}/${topic}/dates/${encodePathParam(ledgerDate, 'ledgerDate')}`;
  const items: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  let open = false;
  for (;;) {
    budget.pages += 1;
    if (budget.pages > MAX_REPORT_PAGES) {
      throw new TooMuchDataError(
        `The report needs more than ${MAX_REPORT_PAGES} pages; choose a shorter period. Refused rather than returned incomplete.`,
      );
    }
    const page = reportPage(await client.get(path, cursor ? { cursor } : undefined));
    // Accounting keys: the entries read strictly from the start. The merchant's own keys: as they came, as before.
    items.push(...(client.ownLedgers ? ledgerEntriesView(page.items) : page.items.map(asRecord)));
    if (page.tryLater) open = true;
    if (!page.hasMore) {
      return { ledgerDate, open, items };
    }
    if (page.cursor === cursor) throw unexpected('a report (more pages without a new cursor)');
    cursor = page.cursor;
  }
}

/**
 * The envelope of one page of a funds or fees ledger date, read strictly with every kind of keys: `items` a list,
 * `tryLater` and `hasMore` present as booleans (the specification has `hasMore` always present on the dates
 * endpoint), and with `hasMore` a non-empty `cursor`. Anything else refuses the report: a page that does not say
 * positively that the date is closed and that there is no more is never taken for the whole date.
 */
function reportPage(answer: unknown):
  | { items: unknown[]; tryLater: boolean; hasMore: false }
  | { items: unknown[]; tryLater: boolean; hasMore: true; cursor: string } {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw unexpected('a report');
  const { items, tryLater, hasMore, cursor } = answer as Record<string, unknown>;
  if (!Array.isArray(items) || typeof tryLater !== 'boolean' || typeof hasMore !== 'boolean') throw unexpected('a report');
  if (!hasMore) {
    // Absent on the last page by the specification; when it is there, it must still be a text.
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') throw unexpected('a report');
    return { items, tryLater, hasMore };
  }
  if (typeof cursor !== 'string' || cursor === '' || cursor.length > 4096) {
    throw unexpected('a report (more pages without a new cursor)');
  }
  return { items, tryLater, hasMore, cursor };
}

/** The time zone furthest ahead among Vipps MobilePay's markets (Denmark, Finland, Norway and Sweden): Finland's. */
const EARLIEST_MARKET_TIME_ZONE = 'Europe/Helsinki';

const marketDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: EARLIEST_MARKET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The last ledger date that is asked for: the newest calendar date that has begun in any of Vipps MobilePay's
 * markets.
 *
 * What Vipps MobilePay documents: "a ledger date lasts from midnight to midnight in the timezone of the merchant"
 * (it can be configured to another cutoff), and a `ledgerDate` "more than 24 hours in the future" is answered with
 * HTTP 400. It does not say which clock the 24 hours follow, so nothing here depends on that: the server does not
 * know the sales unit's time zone, but a date that has begun in Finland has begun, or begins within two hours, for
 * every sales unit, which is far inside the 24 hours by any clock. No sales unit's own day is left out, also not
 * just after its midnight, in summer or winter time. A later date is not asked for. Every refusal of a date that is
 * asked for is an error; none is taken to mean "not come yet".
 */
export function lastBegunLedgerDate(now: number): string {
  const parts = Object.fromEntries(marketDate.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface PeriodInput {
  ledgerId: string;
  fromDate: string;
  toDate: string;
}

/** What was read of a period, and what was not and why. */
interface PeriodReading {
  /** One report per date that was read, in order. */
  reports: DateReport[];
  /** Dates read that Vipps MobilePay has not closed yet: entries can still be added. */
  openDates: string[];
  /** Dates not asked for because they have not begun. They are never among the dates read. */
  futureDates: string[];
}

/**
 * Every date of the period that has begun, in order. A date that has not begun is not asked for. `onDate` runs after
 * each date read, so a caller can refuse a period that is too large early. An error from any request, the access
 * request included, ends the reading: nothing read so far is returned.
 */
async function readPeriod(
  client: UpstreamClient,
  input: PeriodInput,
  topic: ReportTopic,
  onDate?: (report: DateReport) => void,
): Promise<PeriodReading> {
  // Accounting keys: the ledger must be one of the organisation's, also when no date of the period is asked for.
  await requireOwnLedger(client, input.ledgerId);
  const budget = { pages: 0 };
  const lastBegun = lastBegunLedgerDate(client.currentTime());
  const reading: PeriodReading = { reports: [], openDates: [], futureDates: [] };
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    if (date > lastBegun) {
      reading.futureDates.push(date);
      continue;
    }
    const report = await readLedgerDate(client, input.ledgerId, topic, date, budget);
    reading.reports.push(report);
    if (report.open) reading.openDates.push(date);
    onDate?.(report);
  }
  return reading;
}

function span(dates: readonly string[]): string {
  const first = dates[0] ?? '';
  const last = dates[dates.length - 1] ?? '';
  return first === last ? first : `${first} to ${last}`;
}

/**
 * In words, what of the period the answer does not hold and why; undefined when it holds all of it. An answer that
 * is cut, empty or still open must say so itself: sums of a part must never read as sums of the whole.
 */
function periodNote(reading: PeriodReading): string | undefined {
  const read = reading.reports.map(report => report.ledgerDate);
  const parts: string[] = [];
  if (read.length === 0) {
    parts.push(
      `Nothing was read and nothing is summed: the period has not begun. ${span(reading.futureDates)} is in the future.`,
    );
  } else if (reading.futureDates.length > 0) {
    parts.push(
      `Only ${span(read)} was read. ${span(reading.futureDates)} is in the future and was not asked for, so the answer does not cover the whole period.`,
    );
  }
  if (reading.openDates.length > 0) {
    parts.push(
      `Vipps MobilePay has not closed ${reading.openDates.join(', ')} yet: more entries can come for ${reading.openDates.length === 1 ? 'that date' : 'those dates'}.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** The fields every period answer has: the period asked for, the dates read, and what is missing and why. */
function periodFields(input: PeriodInput, reading: PeriodReading) {
  const read = reading.reports.map(report => report.ledgerDate);
  const note = periodNote(reading);
  return {
    ledgerId: input.ledgerId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    readFrom: read[0] ?? null,
    readTo: read[read.length - 1] ?? null,
    complete: reading.openDates.length === 0 && reading.futureDates.length === 0,
    openDates: reading.openDates,
    futureDates: reading.futureDates,
    ...(note ? { note } : {}),
    amountsInMinorUnits: true,
  };
}

/** The note of a period answer, for the text of a result; undefined for any other value. */
export function periodNoteOf(result: unknown): string | undefined {
  const note = asRecord(result).note;
  return typeof note === 'string' ? note : undefined;
}

export async function listTransactions(
  client: UpstreamClient,
  input: PeriodInput & { topic?: ReportTopic },
): Promise<unknown> {
  const topic = input.topic ?? 'funds';
  const items: Array<Record<string, unknown>> = [];
  const reading = await readPeriod(client, input, topic, report => {
    items.push(...report.items);
    if (items.length > MAX_TRANSACTIONS) {
      throw new TooMuchDataError(
        `The period holds more than ${MAX_TRANSACTIONS} entries; choose a shorter period. Refused rather than returned incomplete.`,
      );
    }
  });
  return { ...periodFields(input, reading), topic, count: items.length, items };
}

interface Totals {
  entries: number;
  currencies: string[];
  totalsByEntryType: Record<string, number>;
  openingBalance: number | null;
  closingBalance: number | null;
}

function totalsOf(items: ReadonlyArray<Record<string, unknown>>): Totals {
  const totals: Record<string, number> = Object.create(null) as Record<string, number>;
  const currencies = new Set<string>();
  let opening: number | null = null;
  let closing: number | null = null;
  for (const item of items) {
    const amount = item.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) throw unexpected('an amount');
    const type = typeof item.entryType === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item.entryType) ? item.entryType : 'other';
    totals[type] = (totals[type] ?? 0) + amount;
    if (typeof item.currency === 'string') currencies.add(item.currency);
    if (opening === null && typeof item.balanceBefore === 'number') opening = item.balanceBefore;
    if (typeof item.balanceAfter === 'number') closing = item.balanceAfter;
  }
  return {
    entries: items.length,
    currencies: [...currencies].sort(),
    totalsByEntryType: { ...totals },
    openingBalance: opening,
    closingBalance: closing,
  };
}

/**
 * Totals of the funds ledger per ledger date and for the period: sales
 * (capture), refunds, retained fees, payouts and the balance before and after.
 * Reads every entry of the dates that have come and returns only the sums.
 * `period` is null when no date was read: an empty sum would read as "nothing
 * happened", which is not known.
 */
export async function fundsSummary(client: UpstreamClient, input: PeriodInput): Promise<unknown> {
  const reading = await readPeriod(client, input, 'funds');
  const days = reading.reports.map(report => ({ ledgerDate: report.ledgerDate, open: report.open, ...totalsOf(report.items) }));
  const period = reading.reports.length === 0 ? null : totalsOf(reading.reports.flatMap(report => report.items));
  return { ...periodFields(input, reading), period, days };
}
