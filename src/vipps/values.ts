import { createHash, createHmac } from 'node:crypto';

/**
 * The shapes of the values tools accept, shared by input validation, the
 * change log fields and the API calls. Each is strict: a value that does not
 * match is refused before anything is sent, and never reaches a log.
 */

/** An ePayment reference, as the ePayment API defines it. */
export const REFERENCE_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

/** A Recurring agreement or charge id (agr_5kSeqz, chr-123ab). The API does not publish a pattern; this is ours. */
export const RECURRING_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A Report API ledger id (numeric). */
export const LEDGER_ID_PATTERN = /^\d{1,20}$/;

/** An ISO date (YYYY-MM-DD). Whether it exists is checked by isIsoDate. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Currencies a merchant can use in the ePayment API (SEK, USD and GBP are for payment service providers only). */
export const MERCHANT_CURRENCIES = ['NOK', 'DKK', 'EUR'] as const;
export type MerchantCurrency = (typeof MERCHANT_CURRENCIES)[number];

/** The largest amount the ePayment API accepts, in minor units (650 000.00). */
export const MAX_AMOUNT_MINOR = 65_000_000;

const ISO_4217: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** An ISO 4217 code written in capitals. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && ISO_4217.has(value);
}

/** An amount in minor units: a whole number from 1 to MAX_AMOUNT_MINOR. */
export function isAmountMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT_MINOR;
}

/** An ISO date that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

/** Number of days from `from` to `to`, both included (0 when `to` is before `from`). */
export function daysBetween(from: string, to: string): number {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return Math.max(0, days);
}

/**
 * A pseudonym for an identifier the caller chose (a payment reference, an
 * agreement or charge id, an idempotency key). A reference can be any text of
 * the right characters, a name among them, so it is never logged in clear:
 * `hmac:` and 16 hex characters of HMAC-SHA-256 with the host's key when one
 * is given, otherwise `sha256:` and 16 hex characters of SHA-256. The same
 * identifier always gets the same pseudonym, so a host can match log lines.
 */
export function pseudonym(value: string, key?: string | Uint8Array): string {
  return key === undefined
    ? `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
    : `hmac:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
}

/** Whether a value is a whole number of minor units that can be counted on: a safe integer of 0 or more. */
export function isMinorUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a value is one of the currencies a merchant uses. */
export function isMerchantCurrency(value: unknown): value is MerchantCurrency {
  return typeof value === 'string' && (MERCHANT_CURRENCIES as readonly string[]).includes(value);
}
