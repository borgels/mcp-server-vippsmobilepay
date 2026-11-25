import { encodePathParam } from '../path-params.js';
import { VippsHttpError } from '../errors.js';
import type { UpstreamClient } from './client.js';
import { datesBetween } from './values.js';

/**
 * Report API: ledgers, and the funds and fees ledgers per ledger date.
 *
 * Every list is read to its end or refused: when a cap below is reached, the
 * call fails with our own text and returns nothing, rather than a list that
 * looks complete but is not. A ledger date that Vipps MobilePay has not closed
 * yet (`tryLater`) is named in the result, which then says it is incomplete;
 * every page it has so far is still read. A date that has not come yet is
 * not requested, because Vipps MobilePay answers HTTP 400 for a ledger date
 * more than 24 hours ahead and the whole period would fail with it. It is named
 * apart from the open dates (`futureDates`), the dates actually read are given
 * (`readFrom`, `readTo`), and `note` says in words what the answer lacks.
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

/** A refusal because a list is longer than this server reads in one call. */
export class TooMuchDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooMuchDataError';
  }
}

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

export async function listLedgers(client: UpstreamClient): Promise<unknown> {
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
    const body = asRecord(await client.get(path, cursor ? { cursor } : undefined));
    if (!Array.isArray(body.items)) throw unexpected('a report');
    items.push(...body.items.map(asRecord));
    if (body.tryLater === true) open = true;
    if (body.hasMore !== true) {
      return { ledgerDate, open, items };
    }
    const next = typeof body.cursor === 'string' ? body.cursor : '';
    if (!next || next === cursor) throw unexpected('a report (more pages without a new cursor)');
    cursor = next;
  }
}

/**
 * The last ledger date worth asking for: tomorrow in UTC.
 *
 * What Vipps MobilePay documents: "a ledger date lasts from midnight to midnight in the timezone of the merchant"
 * (it can be configured to another cutoff), and a `ledgerDate` "more than 24 hours in the future" is answered with
 * HTTP 400. It does not document from which moment or in which time zone the 24 hours are counted. Its markets are
 * ahead of UTC, so late in the evening UTC the sales unit's own day is already tomorrow's date in UTC and has
 * entries: tomorrow in UTC must be asked for. A date after that starts 24 hours or more from now by every clock,
 * and is not asked for. Because the limit's clock is not documented, a refusal (HTTP 400) of a date after today in
 * UTC is taken as "not come yet" as well, see readPeriod.
 */
export function lastAskableLedgerDate(now: number): string {
  return new Date(now + 86_400_000).toISOString().slice(0, 10);
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
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
  /** Dates not read because they have not come yet. They are never among the dates read. */
  futureDates: string[];
}

/**
 * Every date of the period that has come, in order. A date that has not come yet is not asked for, and neither are
 * the dates after it. `onDate` runs after each date read, so a caller can refuse a period that is too large early.
 */
async function readPeriod(
  client: UpstreamClient,
  input: PeriodInput,
  topic: ReportTopic,
  onDate?: (report: DateReport) => void,
): Promise<PeriodReading> {
  const budget = { pages: 0 };
  const now = client.currentTime();
  const today = utcDate(now);
  const lastAskable = lastAskableLedgerDate(now);
  const reading: PeriodReading = { reports: [], openDates: [], futureDates: [] };
  let ahead = false;
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    if (ahead || date > lastAskable) {
      ahead = true;
      reading.futureDates.push(date);
      continue;
    }
    let report: DateReport;
    const pagesBefore = budget.pages;
    try {
      report = await readLedgerDate(client, input.ledgerId, topic, date, budget);
    } catch (error) {
      // Tomorrow's date in UTC, its first page refused as a bad request: Vipps MobilePay counts it as too far ahead.
      // Of what it documents as answered with HTTP 400, only the date is left: the ledger id is digits by the input
      // check, the topic is one of two fixed words, the date is a real date, and no cursor was sent.
      if (error instanceof VippsHttpError && error.status === 400 && date > today && budget.pages === pagesBefore + 1) {
        ahead = true;
        reading.futureDates.push(date);
        continue;
      }
      throw error;
    }
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
