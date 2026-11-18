import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { datesBetween } from './values.js';

/**
 * Report API: ledgers, and the funds and fees ledgers per ledger date.
 *
 * Every list is read to its end or refused: when a cap below is reached, the
 * call fails with our own text and returns nothing, rather than a list that
 * looks complete but is not. A ledger date that Vipps MobilePay has not closed
 * yet (`tryLater`) is named in the result, which then says it is incomplete.
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

/** Every entry of one ledger date, following the cursor while hasMore is true. */
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
    if (body.tryLater === true) {
      return { ledgerDate, open: true, items };
    }
    if (body.hasMore !== true) {
      return { ledgerDate, open: false, items };
    }
    const next = typeof body.cursor === 'string' ? body.cursor : '';
    if (!next || next === cursor) throw unexpected('a report (more pages without a new cursor)');
    cursor = next;
  }
}

export interface PeriodInput {
  ledgerId: string;
  fromDate: string;
  toDate: string;
}

export async function listTransactions(
  client: UpstreamClient,
  input: PeriodInput & { topic?: ReportTopic },
): Promise<unknown> {
  const topic = input.topic ?? 'funds';
  const budget = { pages: 0 };
  const items: Array<Record<string, unknown>> = [];
  const openDates: string[] = [];
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    const report = await readLedgerDate(client, input.ledgerId, topic, date, budget);
    if (report.open) openDates.push(date);
    items.push(...report.items);
    if (items.length > MAX_TRANSACTIONS) {
      throw new TooMuchDataError(
        `The period holds more than ${MAX_TRANSACTIONS} entries; choose a shorter period. Refused rather than returned incomplete.`,
      );
    }
  }
  return {
    ledgerId: input.ledgerId,
    topic,
    fromDate: input.fromDate,
    toDate: input.toDate,
    complete: openDates.length === 0,
    openDates,
    amountsInMinorUnits: true,
    count: items.length,
    items,
  };
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
 * Reads every entry of the period and returns only the sums.
 */
export async function fundsSummary(client: UpstreamClient, input: PeriodInput): Promise<unknown> {
  const budget = { pages: 0 };
  const days: Array<Totals & { ledgerDate: string; open: boolean }> = [];
  const all: Array<Record<string, unknown>> = [];
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    const report = await readLedgerDate(client, input.ledgerId, 'funds', date, budget);
    days.push({ ledgerDate: date, open: report.open, ...totalsOf(report.items) });
    all.push(...report.items);
  }
  const period = totalsOf(all);
  const openDates = days.filter(day => day.open).map(day => day.ledgerDate);
  return {
    ledgerId: input.ledgerId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    complete: openDates.length === 0,
    openDates,
    amountsInMinorUnits: true,
    period,
    days,
  };
}
