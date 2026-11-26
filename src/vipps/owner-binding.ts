import type { OwnLedgers, QueryValue, UpstreamClient } from './client.js';
import { ledgerOwnerOf, ledgerPageView, ownLedgerView, TooMuchDataError, UnexpectedAnswerError, type Organisation } from './views.js';

/**
 * The owner binding: what a call with accounting keys may read.
 *
 * Accounting keys are an accounting partner's. Their token reads the ledgers
 * of every business that has given the partner access in the Vipps MobilePay
 * portal, so the token says nothing about whose data a call may see. The
 * embedding host does: it names one organisation for each call (a scheme and
 * an id, such as `business:DK:CVR` and the company's number), and the call
 * is bound to it here:
 *
 *   1. The ledger list is read, every page of it, before anything is decided.
 *      It is paged with a cursor, and a list that does not end within
 *      MAX_OWNER_LEDGER_PAGES pages refuses the call: a part of the list is
 *      never taken for the organisation's ledgers.
 *   2. A ledger is the organisation's only when its `owner` has exactly that
 *      scheme and exactly that id. Nothing is trimmed, folded or padded: two
 *      organisations with the same number under different schemes are two
 *      organisations.
 *   3. A ledger that cannot be attributed to one organisation is nobody's:
 *      it is left out, and counted so the answer can say that the list may
 *      lack something. That is a ledger whose owner cannot be read, and a
 *      ledger with a sales unit that names another organisation than the
 *      owner (Vipps MobilePay documents that they are the same today).
 *   4. Every other request of the call names a ledger in its path. It is sent
 *      only when that ledger is in the set from step 2; any other ledger is
 *      refused with one fixed text, whether it exists or not, before a
 *      request for it is made.
 *
 * Nothing is kept between calls. The set is read anew for every call and
 * lives in the client view made for that call (ownerBoundClient), which no
 * other call can reach: the client itself, with the token, is shared by all
 * callers and never learns an owner or a ledger. So a ledger that stops
 * being the organisation's stops being readable at the next call, and a
 * ledger id is never proof of anything: not the caller's, not one the host
 * remembers, not one from an earlier answer. Within one call the set is read
 * once, before the first request that needs it.
 *
 * A call without an organisation is refused before anything is sent, the
 * token request included (src/tools/vipps.ts).
 */

/** The organisation a call may see, as the host names it. */
export type LedgerOwner = Organisation;

/** A scheme as the Report API writes one: `business:`, a country and a register (`business:DK:CVR`, `business:FI:Y-tunnus`). */
const OWNER_SCHEME_PATTERN = /^business:[A-Z]{2}:[A-Za-z0-9-]{1,20}$/;
/** An organisation's number in its register: letters, digits and dashes. */
const OWNER_ID_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/**
 * The organisation a host names for a call, or undefined when it names none in the form of one. The two texts are
 * taken exactly as given: a value with a space, in another case or of another type is no organisation.
 */
export function ledgerOwnerFrom(value: unknown): LedgerOwner | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { scheme, id } = value as { scheme?: unknown; id?: unknown };
  if (typeof scheme !== 'string' || !OWNER_SCHEME_PATTERN.test(scheme)) return undefined;
  if (typeof id !== 'string' || !OWNER_ID_PATTERN.test(id)) return undefined;
  return Object.freeze({ scheme, id });
}

/** A call with accounting keys that names no organisation. Nothing was sent. */
export class OwnerMissingError extends Error {
  constructor() {
    super(
      'Refused: accounting keys answer only for the organisation the host names for the call, and this call names none. Nothing was sent.',
    );
    this.name = 'OwnerMissingError';
  }
}

/**
 * A ledger that is not among the organisation's. One text for a ledger of another organisation, a ledger that
 * cannot be attributed and a ledger that does not exist: the refusal never says which.
 */
export class NotOwnLedgerError extends Error {
  constructor() {
    super('Refused: that ledger is not one of this organisation’s ledgers. Nothing was asked for it.');
    this.name = 'NotOwnLedgerError';
  }
}

/** The connection check found no ledger owned by the organisation. Not a failure of the keys or of Vipps MobilePay. */
export class NoLedgerForOwnerError extends Error {
  constructor(notAttributed: number) {
    super(
      'No ledger of this organisation is visible yet: the business has not given the accounting partner access in the Vipps MobilePay portal, or has given it for another organisation.' +
        (notAttributed > 0
          ? ` ${notAttributed} ${notAttributed === 1 ? 'ledger names' : 'ledgers name'} no single organisation as owner and ${notAttributed === 1 ? 'was' : 'were'} left out.`
          : ''),
    );
    this.name = 'NoLedgerForOwnerError';
  }
}

/** Pages of the ledger list read for one call with accounting keys. A longer list is refused, never cut short. */
export const MAX_OWNER_LEDGER_PAGES = 200;

const LEDGERS_PATH = '/settlement/v1/ledgers';
/** The ledger a report or sales request names. */
const LEDGER_OF_PATH = /^\/(?:report\/v2|sales\/report\/v1)\/ledgers\/([^/]+)\//;

const same = (a: Organisation, b: Organisation): boolean => a.scheme === b.scheme && a.id === b.id;

/** How a ledger of the list stands to the organisation: its own, another's, or nobody's (not attributed). */
type Standing = 'own' | 'other' | 'none';

/**
 * The ledgers of one organisation: the whole ledger list read, and each ledger kept only when its owner is exactly
 * the organisation. Refused as a whole when a page is not in the documented form, when a ledger of the organisation
 * is not, when a ledger id is named twice with another standing (or twice as the organisation's), or when the list
 * is longer than MAX_OWNER_LEDGER_PAGES pages.
 */
export async function readOwnLedgers(client: Pick<UpstreamClient, 'get'>, owner: LedgerOwner): Promise<OwnLedgers> {
  const ledgers: Array<Record<string, unknown>> = [];
  const ids = new Set<string>();
  const seen = new Map<string, Standing>();
  let notAttributed = 0;
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_OWNER_LEDGER_PAGES; page += 1) {
    const answer = ledgerPageView(await client.get(LEDGERS_PATH, cursor ? { cursor } : undefined));
    for (const item of answer.items) {
      const named = ledgerOwnerOf(item);
      let standing: Standing = named === undefined ? 'none' : same(named, owner) ? 'own' : 'other';
      let view: Record<string, unknown> | undefined;
      if (standing === 'own') {
        // The organisation's own ledger is read strictly: anything in another form refuses the whole list.
        const read = ownLedgerView(item);
        if (read.organisations.every(organisation => same(organisation, owner))) view = read.ledger;
        else standing = 'none';
      }
      const id = typeof item.ledgerId === 'string' ? item.ledgerId : undefined;
      if (id !== undefined) {
        const before = seen.get(id);
        // One id under two standings, or twice as the organisation's: it is not known whose the ledger is.
        if (before !== undefined && (before !== standing || standing === 'own')) {
          throw new UnexpectedAnswerError('the ledger list (a ledger named twice)');
        }
        seen.set(id, standing);
      }
      if (standing === 'none') notAttributed += 1;
      if (view !== undefined) {
        ledgers.push(view);
        ids.add(view.ledgerId as string);
      }
    }
    // The end of the list. Vipps MobilePay documents the empty cursor as the end. A page with no ledgers that
    // gives back the cursor it was asked with is taken as the end too: asking again would ask the same and get the
    // same, so there is nothing more to read. (Seen in production: the answer has a cursor also when the list is
    // empty.) Any other page with a cursor is followed, also an empty one.
    if (answer.cursor === '' || (answer.cursor === cursor && answer.items.length === 0)) {
      return Object.freeze({ ledgers: Object.freeze(ledgers), ids, notAttributed });
    }
    // Ledgers under a cursor that does not move would come again and again: the list cannot be read to its end.
    if (answer.cursor === cursor) throw new UnexpectedAnswerError('the ledger list (a cursor that does not move)');
    cursor = answer.cursor;
  }
  // The cap is reached with pages still to read. What was read is a part, and no answer is made from a part.
  throw new TooMuchDataError(
    `The ledger list did not end within ${MAX_OWNER_LEDGER_PAGES} pages; refused rather than read in part.`,
  );
}

/**
 * A view of the client for one call, bound to one organisation. It answers `ownLedgers` with the organisation's
 * ledgers, and sends a request only when its path names one of them; the ledger list itself, a path without a
 * ledger, and every change are refused. The set is read once, when first needed, and dies with the view.
 */
export function ownerBoundClient(client: UpstreamClient, owner: LedgerOwner): UpstreamClient {
  let reading: Promise<OwnLedgers> | undefined;
  const ownLedgers = (): Promise<OwnLedgers> => (reading ??= readOwnLedgers(client, owner));
  const admit = async (path: string): Promise<void> => {
    const ledgerId = LEDGER_OF_PATH.exec(path)?.[1];
    if (ledgerId === undefined) {
      throw new Error('Refused: with accounting keys a request must name a ledger of the organisation. Nothing was sent.');
    }
    if (!(await ownLedgers()).ids.has(ledgerId)) throw new NotOwnLedgerError();
  };
  const refuse = (method: string) => async (): Promise<never> => {
    throw new Error(`Refused: accounting keys only read; no ${method} request is sent with them.`);
  };
  return {
    get: async <T>(path: string, query?: Record<string, QueryValue>) => {
      await admit(path);
      return client.get<T>(path, query);
    },
    getPage: async <T>(path: string, query?: Record<string, QueryValue>, headers?: Record<string, string>) => {
      await admit(path);
      return client.getPage<T>(path, query, headers);
    },
    post: refuse('POST'),
    patch: refuse('PATCH'),
    delete: refuse('DELETE'),
    verifyCredentials: () => client.verifyCredentials(),
    ownLedgers,
    currentTime: () => client.currentTime(),
    keyedHash: (purpose, text) => client.keyedHash(purpose, text),
  };
}

/**
 * With a client bound to an organisation: the refusal unless the ledger is one of the organisation's. A client that
 * is not bound (the merchant's own keys) passes: those keys read only their own sales unit's ledgers.
 */
export async function requireOwnLedger(client: UpstreamClient, ledgerId: string): Promise<void> {
  if (!client.ownLedgers) return;
  if (!(await client.ownLedgers()).ids.has(ledgerId)) throw new NotOwnLedgerError();
}
