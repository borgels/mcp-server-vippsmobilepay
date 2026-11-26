import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../vipps/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../vipps/audit.js';
import { IDEMPOTENCY_KEY_PATTERN, readOnlyClient, type UpstreamClient, type VippsEnvironment, type VippsKeyType } from '../vipps/client.js';
import { ConfigError } from '../config-env.js';
import { formatUnknownError, redactDeep, VippsHttpError, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import {
  checkCreatePayment,
  createPayment,
  DEFAULT_APPROVAL_MINUTES,
  MAX_ORDER_LINES,
  PAYMENT_DELIVERIES,
  QR_FORMATS,
} from '../vipps/payment-requests.js';
import { checkReceipt, getReceipt } from '../vipps/order-details.js';
import { ledgerOwnerFrom, NoLedgerForOwnerError, ownerBoundClient, OwnerMissingError, type LedgerOwner } from '../vipps/owner-binding.js';
import { cancelPayment, capturePayment, getPayment, refundPayment } from '../vipps/payments.js';
import { listQrCodes, MAX_QR_CODES, QR_KINDS } from '../vipps/qr-codes.js';
import {
  AGREEMENT_STATUSES,
  cancelCharge,
  captureCharge,
  CHARGE_STATUSES,
  CHARGE_TRANSACTION_TYPES,
  checkCreateCharge,
  checkUpdateAgreement,
  createCharge,
  findCharge,
  getAgreement,
  getCharge,
  INTERVAL_UNITS,
  listAgreements,
  listCharges,
  MAX_RETRY_DAYS,
  ORDER_ID_PATTERN,
  PROCESSING_MODES,
  refundCharge,
  stopAgreement,
  updateAgreement,
} from '../vipps/recurring.js';
import { fundsSummary, listLedgers, listTransactions, MAX_REPORT_DAYS, MAX_TRANSACTIONS, periodNoteOf } from '../vipps/reports.js';
import { getSale, listSales, MAX_SALES } from '../vipps/sales.js';
import { getSalesUnit, listSalesUnits } from '../vipps/sales-units.js';
import {
  checkInputPolicy,
  checkToolPolicy,
  isToolDisabled,
  redactInScope,
  runInCallScope,
  validatePolicyConfig,
} from '../vipps/policy.js';
import {
  daysBetween,
  isAmountMinor,
  isHttpsUrl,
  isIsoDate,
  isMerchantCurrency,
  LEDGER_ID_PATTERN,
  MAX_AMOUNT_MINOR,
  MERCHANT_CURRENCIES,
  PHONE_NUMBER_PATTERN,
  pseudonym,
  RECURRING_ID_PATTERN,
  REFERENCE_PATTERN,
  SALE_REFERENCE_PATTERN,
  timestampMs,
} from '../vipps/values.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog; a test
 * checks it against the requests each tool makes.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
}

/** A client that carries the redactor of its instance, what kind of keys it holds and the environment it calls. */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
  readonly keyType: VippsKeyType;
  readonly environment: VippsEnvironment;
}

/**
 * What a write tool does: to money (capture, refund, cancel), `create` for a
 * new payment request or a new Recurring charge, `update` for a change of a
 * Recurring agreement and `stop` for stopping one.
 */
export type VippsChangeAction = 'capture' | 'refund' | 'cancel' | 'create' | 'update' | 'stop';

/** The kind of thing a change touches: an ePayment payment, a Recurring charge or a Recurring agreement. */
export type VippsChangeRecord = 'payment' | 'charge' | 'agreement';

/**
 * The type a logged value must have; anything else is left out of the values.
 *   amountMinor  a whole number of minor units, 1 to 65 000 000, in clear
 *   currency     one of NOK, DKK, EUR, in clear
 *   flag         true or false, in clear
 *   pseudonym    an identifier the caller chose (payment reference, agreement
 *                or charge id, idempotency key). It can be any text of the
 *                allowed characters, a name among them, so it is never logged
 *                in clear: the value is "sha256:" and 16 hex characters of its
 *                SHA-256, or "hmac:" and 16 hex characters of its HMAC-SHA-256
 *                when the host gives a key (see pseudonym()).
 *   delivery     how a payment request reaches the customer: link, qr or
 *                phone, in clear. Never the phone number itself.
 */
export type VippsLogFieldType = 'amountMinor' | 'currency' | 'flag' | 'pseudonym' | 'delivery';

export interface VippsLogField {
  readonly name: string;
  readonly type: VippsLogFieldType;
}

/**
 * Write tools only: what the change does, for a host that logs a change
 * before it is sent and asks a person to confirm it. `logFields` are the input fields that identify the change, each with the
 * one type its value must have; never a name, a phone number or a free text
 * (a description is not among them).
 */
export interface VippsChangeSpec {
  readonly action: VippsChangeAction;
  /** The kind of thing the change touches: 'payment' (ePayment), 'charge' or 'agreement' (Recurring). */
  readonly record: VippsChangeRecord;
  /**
   * True when the call itself moves or releases money (capture, refund,
   * cancel, and a new Recurring charge, which charges or reserves on its due
   * date without the customer approving it again). False for a new payment
   * request (the customer approves it in the app, and only a capture draws
   * it) and for a change or stop of an agreement. A host should have a
   * person confirm either kind.
   */
  readonly movesMoney: boolean;
  readonly logFields: readonly VippsLogField[];
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`vipps_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** What a result lacks and why, in this server's own words, added to the gateway result text; undefined when nothing. */
  resultNote?: (result: unknown) => string | undefined;
  /** Every upstream request the handler may make (the access token request is not listed). */
  upstream: readonly UpstreamOperation[];
  /** True when the tool can read more than its name says. None of these tools does. */
  broad?: boolean;
  /**
   * Key types the tool works with. The Report API does not accept partner keys; accounting keys work with the
   * Report and Sales tools only, and the Sales tools with no other keys.
   */
  keyTypes: readonly VippsKeyType[];
  /** Why the tool does not work with partner keys, for the refusal. Default: the Report API's reason. */
  keyTypeReason?: string;
  /** The environments the tool works in. Default: both. Vipps MobilePay has no Management API in the test environment. */
  environments?: readonly VippsEnvironment[];
  /** Write tools: what the change does. */
  change?: VippsChangeSpec;
  /** Cross-field checks the schema shape cannot express. Returns a refusal or undefined. */
  check?: (input: Record<string, unknown>) => string | undefined;
  /** The audit logs a free text of this tool (description) as a keyed hash, not as a hash anyone can test a guess against. */
  keyedAuditText?: boolean;
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const change = (
  action: VippsChangeAction,
  record: VippsChangeRecord,
  logFields: Record<string, VippsLogFieldType>,
  // A new payment request moves nothing until the customer approves it and it is captured; a new Recurring charge is
  // drawn on its due date without that. A change or stop of an agreement moves nothing by itself.
  movesMoney = record === 'payment' ? action !== 'create' : record === 'charge',
): VippsChangeSpec => ({
  action,
  record,
  movesMoney,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

const ALL_KEYS = ['merchant', 'partner'] as const;
const MERCHANT_KEYS = ['merchant'] as const;
/** The Report tools: the merchant's own keys, or an accounting partner's for the organisation of the call. */
const REPORT_KEYS = ['merchant', 'accounting'] as const;
/** The Sales tools: Vipps MobilePay documents the Sales API for accounting keys only. */
const ACCOUNTING_KEYS = ['accounting'] as const;
const EVERY_KEY = ['merchant', 'partner', 'accounting'] as const;
const PRODUCTION_ONLY = ['production'] as const;

/** The ledger list: read for every call with accounting keys, to bind the call to its organisation. */
const LEDGER_LIST: UpstreamOperation = { access: 'read', method: 'GET', path: '/settlement/v1/ledgers' };

const ACCOUNTING_NOTE =
  'With accounting keys: only for a ledger owned by the organisation of the call; any other ledger is refused.';

const referenceSchema = z.string().trim().regex(REFERENCE_PATTERN).describe('The ePayment reference (8-64 letters, digits or dashes).');
const agreementIdSchema = z.string().trim().regex(RECURRING_ID_PATTERN).describe('The Recurring agreement id, e.g. agr_5kSeqz.');
const chargeIdSchema = z.string().trim().regex(RECURRING_ID_PATTERN).describe('The Recurring charge id, e.g. chr-Kq7wZp.');
const ledgerIdSchema = z.string().trim().regex(LEDGER_ID_PATTERN).describe('The ledger id, from list_ledgers.');
const saleReferenceSchema = z.string().trim().regex(SALE_REFERENCE_PATTERN);
const dateSchema = z.string().trim().refine(isIsoDate, 'must be a date written YYYY-MM-DD');
const amountSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_AMOUNT_MINOR)
  .describe('Amount in minor units (øre, cent): 125.50 kr is 12550.');
const currencySchema = z.enum(MERCHANT_CURRENCIES).describe('ISO 4217 currency code of the payment.');
const idempotencyKeySchema = z
  .string()
  .regex(IDEMPOTENCY_KEY_PATTERN)
  .describe(
    'Required operation key (8-40 letters, digits or dashes), sent as Idempotency-Key. Choose a new one for each new change, record it before the call, and send the same key when repeating that change after a failure or a lost answer: Vipps MobilePay then carries it out only once.',
  );

const periodShape = {
  ledgerId: ledgerIdSchema,
  fromDate: dateSchema.describe('First ledger date, YYYY-MM-DD.'),
  toDate: dateSchema.describe(`Last ledger date, YYYY-MM-DD. At most ${MAX_REPORT_DAYS} days counting both ends.`),
};

function checkPeriod(input: Record<string, unknown>): string | undefined {
  const from = String(input.fromDate);
  const to = String(input.toDate);
  if (to < from) return 'toDate is before fromDate.';
  if (daysBetween(from, to) > MAX_REPORT_DAYS) return `The period is longer than ${MAX_REPORT_DAYS} days.`;
  return undefined;
}

const WRITE_NOTE =
  'Moves or releases money and cannot be undone. Disabled by default (VIPPS_ENABLE_WRITES, or the gateway host policy enableWrites); a person should confirm every call.';

const httpsUrlSchema = z.string().refine(value => isHttpsUrl(value, 500), 'must be an https:// address of at most 500 characters');
const orderLineSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).describe('What is sold, as the customer sees it.'),
  id: z.string().trim().min(1).max(64).describe('The product or line number the business uses.'),
  totalAmount: z.number().int().min(0).max(MAX_AMOUNT_MINOR).describe('The line with VAT, in minor units.'),
  totalAmountExcludingTax: z.number().int().min(0).max(MAX_AMOUNT_MINOR).describe('The line without VAT, in minor units.'),
  totalTaxAmount: z.number().int().min(0).max(MAX_AMOUNT_MINOR).describe('The VAT of the line, in minor units.'),
  taxRate: z.number().int().min(0).max(10_000).describe('VAT rate in hundredths of a percent: 25 % is 2500.'),
  productUrl: httpsUrlSchema.optional().describe('An https address of the product at the business. Required on every line in NOK with expiresAt.'),
});

export const VIPPS_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'vipps_check_connection',
    title: 'Check Vipps MobilePay connection',
    description:
      'Check that the keys work, by requesting an access token. Returns only whether the connection works. With accounting keys the connection works only when at least one ledger owned by the organisation of the call is visible; the answer then gives their number.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Checked the connection.',
    // Accounting keys only: the ledger list is read. The other keys ask for an access token and nothing else.
    upstream: [LEDGER_LIST],
    keyTypes: EVERY_KEY,
    handler: async client => {
      if (client.ownLedgers) {
        // A token is not enough with accounting keys: it says nothing of whether this organisation has given access.
        const own = await client.ownLedgers();
        if (own.ledgers.length === 0) throw new NoLedgerForOwnerError(own.notAttributed);
        return {
          connected: true,
          outcome: 'connected',
          ledgers: own.ledgers.length,
          ...(own.notAttributed > 0 ? { ledgersNotAttributed: own.notAttributed } : {}),
        };
      }
      await client.verifyCredentials();
      return { connected: true };
    },
  }),
  defineTool({
    name: 'vipps_list_ledgers',
    title: 'List settlement ledgers (Vipps MobilePay)',
    description:
      'List the ledgers (settlement accounts) the keys can read, with their currency and the sales units they settle for. With the merchant’s own keys the payout bank account is shown only as its last four characters. With accounting keys only the ledgers owned by the organisation of the call are listed, and nothing of the payout bank account is shown. Not with partner keys (the Report API does not accept them).',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed ledgers.',
    resultNote: periodNoteOf,
    upstream: [LEDGER_LIST],
    keyTypes: REPORT_KEYS,
    handler: async client => listLedgers(client),
  }),
  defineTool({
    name: 'vipps_get_funds_summary',
    title: 'Settlement and funds summary (Vipps MobilePay)',
    description:
      'Totals of the funds ledger for a period, per ledger date and in all: sales (capture), refunds, fees retained, payouts (payout-scheduled) and the balance before and after. Amounts are in minor units. Reads every entry of the period and returns only the sums; refuses rather than returns a partial sum. Dates Vipps MobilePay has not closed yet are listed in openDates; dates that have not come yet are not read and are listed in futureDates. readFrom and readTo are the dates actually read, complete says whether that is the whole period, note says in words what is missing, and period is null when no date was read. Not with partner keys. ' +
      ACCOUNTING_NOTE,
    inputShape: periodShape,
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Summarised the funds ledger.',
    resultNote: periodNoteOf,
    upstream: [{ access: 'read', method: 'GET', path: '/report/v2/ledgers/{ledgerId}/funds/dates/{ledgerDate}' }, LEDGER_LIST],
    keyTypes: REPORT_KEYS,
    check: checkPeriod,
    handler: async (client, input) => fundsSummary(client, input),
  }),
  defineTool({
    name: 'vipps_list_transactions',
    title: 'Ledger entries for a period (Vipps MobilePay)',
    description: `Every entry of the funds ledger (sales, refunds, payouts, fees retained) or the fees ledger for a period, with amounts in minor units. Refuses, rather than truncates, a period with more than ${MAX_TRANSACTIONS} entries. Dates not closed yet are listed in openDates; dates that have not come yet are not read and are listed in futureDates. readFrom and readTo are the dates actually read, complete says whether that is the whole period, and note says in words what is missing. Customer names and messages are not requested. Not with partner keys. ${ACCOUNTING_NOTE}`,
    inputShape: {
      ...periodShape,
      topic: z.enum(['funds', 'fees']).optional().describe('funds (default) or fees.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed ledger entries.',
    resultNote: periodNoteOf,
    upstream: [
      { access: 'read', method: 'GET', path: '/report/v2/ledgers/{ledgerId}/funds/dates/{ledgerDate}' },
      { access: 'read', method: 'GET', path: '/report/v2/ledgers/{ledgerId}/fees/dates/{ledgerDate}' },
      LEDGER_LIST,
    ],
    keyTypes: REPORT_KEYS,
    check: checkPeriod,
    handler: async (client, input) => listTransactions(client, input),
  }),
  defineTool({
    name: 'vipps_list_sales',
    title: 'Sales of a ledger date (Vipps MobilePay)',
    description: `Every sale of one ledger date for a ledger owned by the organisation of the call: each capture and refund with its gross, net and VAT amounts (minor units), its order lines with quantity, prices, VAT rate (hundredths of a percent) and VAT amount, the kind of payment and the sales category. Covers sales paid to a Vippsnummer or MobilePay number and in mPOS, not ePayment payments. Nothing about the customer is returned. Refuses, rather than truncates, a date with more than ${MAX_SALES} entries, and a date that has not begun. complete is false, and note says so, when more sales can still come for the date. Accounting keys only, and production only.`,
    inputShape: {
      ledgerId: ledgerIdSchema,
      ledgerDate: dateSchema.describe('The ledger date, YYYY-MM-DD.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed sales.',
    resultNote: periodNoteOf,
    upstream: [{ access: 'read', method: 'GET', path: '/sales/report/v1/ledgers/{ledgerId}/dates/{ledgerDate}' }, LEDGER_LIST],
    keyTypes: ACCOUNTING_KEYS,
    environments: PRODUCTION_ONLY,
    handler: async (client, input) => listSales(client, input),
  }),
  defineTool({
    name: 'vipps_get_sale',
    title: 'Get a sale (Vipps MobilePay)',
    description:
      'One sale in a ledger owned by the organisation of the call, with its order lines and VAT: by reference (the business’s own reference of the sale: every capture and refund of it) or by pspReference (Vipps MobilePay’s reference of one capture or refund, as in the ledger entries). Give exactly one of the two. Amounts are in minor units, VAT rates in hundredths of a percent. Covers sales paid to a Vippsnummer or MobilePay number and in mPOS, not ePayment payments: count 0 means the Sales API has no such sale in this ledger. Nothing about the customer is returned. Accounting keys only, and production only.',
    inputShape: {
      ledgerId: ledgerIdSchema,
      reference: saleReferenceSchema.optional().describe('The business’s own reference of the sale (1-64 letters, digits, dashes or underscores).'),
      pspReference: saleReferenceSchema.optional().describe('Vipps MobilePay’s reference of one capture or refund.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched sale.',
    upstream: [
      { access: 'read', method: 'GET', path: '/sales/report/v1/ledgers/{ledgerId}/references/{reference}' },
      { access: 'read', method: 'GET', path: '/sales/report/v1/ledgers/{ledgerId}/psp-references/{pspReference}' },
      LEDGER_LIST,
    ],
    keyTypes: ACCOUNTING_KEYS,
    environments: PRODUCTION_ONLY,
    check: input =>
      (input.reference === undefined) === (input.pspReference === undefined) ? 'Give exactly one of reference and pspReference.' : undefined,
    handler: async (client, input) => getSale(client, input),
  }),
  defineTool({
    name: 'vipps_get_payment',
    title: 'Get ePayment payment (Vipps MobilePay)',
    description:
      'One ePayment payment by its reference: state, amounts authorized, captured, cancelled and refunded (minor units), and its events. An event of a capture, a refund or a cancellation has the operation key it was made with. A failed event read is reported in the result.',
    inputShape: {
      reference: referenceSchema,
      includeEvents: z.boolean().optional().describe('Also read the events (default true).'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched payment.',
    upstream: [
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}' },
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}/events' },
    ],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => getPayment(client, input),
  }),
  defineTool({
    name: 'vipps_list_agreements',
    title: 'List Recurring agreements (Vipps MobilePay)',
    description:
      'Recurring agreements with one status (default ACTIVE; the API cannot list all statuses at once). Reads every page; refuses rather than truncates more than 5000.',
    inputShape: {
      status: z.enum(AGREEMENT_STATUSES).optional().describe('PENDING, ACTIVE (default), STOPPED or EXPIRED.'),
      createdAfter: dateSchema.optional().describe('Only agreements created after this date, YYYY-MM-DD.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed agreements.',
    upstream: [{ access: 'read', method: 'GET', path: '/recurring/v3/agreements' }],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => listAgreements(client, input),
  }),
  defineTool({
    name: 'vipps_get_agreement',
    title: 'Get Recurring agreement (Vipps MobilePay)',
    description: 'One Recurring agreement by id: status, pricing, interval and product.',
    inputShape: { agreementId: agreementIdSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched agreement.',
    upstream: [{ access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' }],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => getAgreement(client, input),
  }),
  defineTool({
    name: 'vipps_list_charges',
    title: 'List Recurring charges (Vipps MobilePay)',
    description: 'The charges of one Recurring agreement, optionally with one status. Reads every page; refuses rather than truncates.',
    inputShape: {
      agreementId: agreementIdSchema,
      status: z.enum(CHARGE_STATUSES).optional().describe('Only charges with this status.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed charges.',
    upstream: [{ access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges' }],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => listCharges(client, input),
  }),
  defineTool({
    name: 'vipps_get_charge',
    title: 'Get Recurring charge (Vipps MobilePay)',
    description: 'One charge of a Recurring agreement: amount, status, due date and how much is captured, refunded and cancelled.',
    inputShape: { agreementId: agreementIdSchema, chargeId: chargeIdSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched charge.',
    upstream: [{ access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' }],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => getCharge(client, input),
  }),
  defineTool({
    name: 'vipps_find_charge',
    title: 'Find Recurring charge by its id (Vipps MobilePay)',
    description:
      "One Recurring charge by its own id, when the agreement is not known, e.g. from a customer's question about a charge: the agreement it belongs to, amount, status, due date, how much is captured, refunded and cancelled, and its history. For looking one charge up, not for reading many: list_charges and get_charge read the charges of a known agreement. Refused when more than one charge has the id.",
    inputShape: { chargeId: chargeIdSchema },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Found charge.',
    upstream: [{ access: 'read', method: 'GET', path: '/recurring/v3/charges/{chargeId}' }],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => findCharge(client, input),
  }),
  defineTool({
    name: 'vipps_get_receipt',
    title: 'Get order lines of a payment (Vipps MobilePay)',
    description:
      'The order details stored with an ePayment payment (reference) or a Recurring charge (chargeId): the order lines with amounts and VAT in minor units (taxRate is in hundredths of a percent: 2500 is 25 %), the bottom line, and the category with the address the business gave for the order. Give exactly one of reference and chargeId. Only what the business or its system sent with the payment is stored; a payment without it is answered as not found.',
    inputShape: {
      reference: referenceSchema.optional(),
      chargeId: chargeIdSchema.optional(),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched order details.',
    upstream: [
      { access: 'read', method: 'GET', path: '/order-management/v2/ECOM/{reference}' },
      { access: 'read', method: 'GET', path: '/order-management/v2/RECURRING/{chargeId}' },
    ],
    keyTypes: ALL_KEYS,
    check: checkReceipt,
    handler: async (client, input) => getReceipt(client, input),
  }),
  defineTool({
    name: 'vipps_list_sales_units',
    title: 'List sales units (Vipps MobilePay)',
    description:
      'The sales units the keys can read, each with its MSN and name. Merchant keys only, and production only (Vipps MobilePay has no Management API in the test environment).',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed sales units.',
    upstream: [{ access: 'read', method: 'GET', path: '/management/v1/sales-units' }],
    keyTypes: MERCHANT_KEYS,
    keyTypeReason: 'with partner keys the list would hold the sales units of every merchant of the partner',
    environments: PRODUCTION_ONLY,
    handler: async client => listSalesUnits(client),
  }),
  defineTool({
    name: 'vipps_get_sales_unit',
    title: 'Get the sales unit (Vipps MobilePay)',
    description:
      'The sales unit the keys are used for: its name, the business it belongs to, and what Vipps MobilePay has enabled for it: payments, the capture type (reserve and capture, or direct capture), partial and late capture, Recurring, card payments, payment requests the customer can pay later (longLivingPaymentAllowed, needed for expiresAt in create_payment) and requests without the landing page (skipLandingPageAllowed, needed for delivery phone in create_payment). Production only (Vipps MobilePay has no Management API in the test environment).',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched sales unit.',
    upstream: [{ access: 'read', method: 'GET', path: '/management/v1/sales-units/{msn}' }],
    keyTypes: ALL_KEYS,
    environments: PRODUCTION_ONLY,
    handler: async client => getSalesUnit(client),
  }),
  defineTool({
    name: 'vipps_list_qr_codes',
    title: 'List fixed QR codes (Vipps MobilePay)',
    description: `The sales unit's fixed QR codes, e.g. on a sticker, a sign or a till. kind redirect: a code that sends the customer to a web address of the business, with its id, that address and the address of its image. kind callback: a code that tells the business that a customer has scanned it, with its id, where it stands, its category and the address of its image. Both kinds unless kind is given. The address of an image works for a while only; a new call gives a new one. Refuses rather than truncates more than ${MAX_QR_CODES} codes of a kind.`,
    inputShape: {
      kind: z.enum(QR_KINDS).optional().describe('redirect or callback. Both when left out.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed QR codes.',
    upstream: [
      { access: 'read', method: 'GET', path: '/qr/v1/merchant-redirect' },
      { access: 'read', method: 'GET', path: '/qr/v1/merchant-callback' },
    ],
    keyTypes: ALL_KEYS,
    handler: async (client, input) => listQrCodes(client, input),
  }),
  defineTool({
    name: 'vipps_create_payment',
    title: 'Create payment request (Vipps MobilePay)',
    description:
      `Ask a customer to pay an amount: creates an ePayment payment request that the customer approves in the Vipps or MobilePay app. delivery says how it reaches the customer: link returns an address the customer opens (the app on a phone, otherwise the Vipps MobilePay landing page), qr returns the address of a QR code the customer scans, and phone sends the request to the app of the customer with that phone number. phone works only when Vipps MobilePay has approved the sales unit for it and the business has the number from the customer, with consent to be asked this way; otherwise use link or qr. The customer has ${DEFAULT_APPROVAL_MINUTES} minutes to approve. With expiresAt the customer can pay later, at most 60 days ahead; Vipps MobilePay enables that for each sales unit and sets its limit, and orderLines are then required (in NOK with productUrl on every line). ` +
      'Moves no money by itself: approval reserves the amount and capture_payment draws it, get_payment shows the state, and cancel_payment cancels the request. ' +
      'The reference is the order or invoice number the business itself uses; it is shown to the customer and can be used once. After a failure or a lost answer, call again with exactly the same input: the server makes the Idempotency-Key from the input, so the same request is created only once, and the answer says whether it was created now or exists already (alreadyExists) and its state. Never change the reference to try again. A reference that another request has is refused, whatever the amount. ' +
      'A request the customer has seen cannot be taken back, only cancelled. Disabled by default (VIPPS_ENABLE_WRITES, or the gateway host policy enableWrites); a person should confirm every call.',
    inputShape: {
      reference: z
        .string()
        .trim()
        .regex(REFERENCE_PATTERN)
        .describe('The order or invoice number the business itself uses for this request (8-64 letters, digits or dashes). Shown to the customer; used once per sales unit.'),
      amount: amountSchema,
      currency: currencySchema.describe('ISO 4217 currency code. Must be the currency of the sales unit.'),
      description: z.string().trim().min(3).max(100).describe('What the customer is asked to pay for (3-100 characters), shown on the payment screen.'),
      delivery: z.enum(PAYMENT_DELIVERIES).describe('link, qr or phone.'),
      phoneNumber: z
        .string()
        .regex(PHONE_NUMBER_PATTERN)
        .optional()
        .describe('Only with delivery phone: the number of the customer as digits with country code and no plus sign or spaces: 45 followed by the 8-digit number for Denmark.'),
      returnUrl: httpsUrlSchema
        .optional()
        .describe('Required with delivery link: the https address the customer is sent to after the payment page, e.g. the website of the business.'),
      expiresAt: z
        .string()
        .refine(value => timestampMs(value) !== undefined, 'must be a time with a time zone in the form YYYY-MM-DDThh:mm:ss+01:00 (or ending in Z)')
        .optional()
        .describe('Only for a request the customer can pay later: the deadline, more than 10 minutes and less than 60 days ahead, in the form YYYY-MM-DDThh:mm:ss+01:00 (or ending in Z).'),
      orderLines: z
        .array(orderLineSchema)
        .min(1)
        .max(MAX_ORDER_LINES)
        .optional()
        .describe('What is sold, shown to the customer in the app. Required with expiresAt. The lines must add up to the amount.'),
      receiptNumber: z.string().trim().min(1).max(64).optional().describe('The receipt or invoice number the business uses, shown with the order lines.'),
      customerPresent: z.boolean().optional().describe('True when the customer is at the point of sale, e.g. a QR code shown on a screen in the shop.'),
      qrFormat: z.enum(QR_FORMATS).optional().describe('Only with delivery qr: an image (default IMAGE/SVG+XML) or TEXT/TARGETURL for the address the code holds.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created payment request.',
    upstream: [
      { access: 'write', method: 'POST', path: '/epayment/v1/payments' },
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}' },
    ],
    keyTypes: ALL_KEYS,
    change: change('create', 'payment', {
      reference: 'pseudonym',
      amount: 'amountMinor',
      currency: 'currency',
      delivery: 'delivery',
    }),
    check: input => checkCreatePayment(input),
    keyedAuditText: true,
    handler: async (client, input) => createPayment(client, input),
  }),
  defineTool({
    name: 'vipps_capture_payment',
    title: 'Capture ePayment payment (Vipps MobilePay)',
    description: `Capture (draw) all or part of an authorized ePayment payment. Reads the payment first and refuses, without sending anything, when the currency differs or the amount is more than is left to capture. ${WRITE_NOTE}`,
    inputShape: { reference: referenceSchema, amount: amountSchema, currency: currencySchema, idempotencyKey: idempotencyKeySchema },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Captured payment.',
    upstream: [
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}' },
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}/events' },
      { access: 'write', method: 'POST', path: '/epayment/v1/payments/{reference}/capture' },
    ],
    keyTypes: ALL_KEYS,
    change: change('capture', 'payment', {
      reference: 'pseudonym',
      amount: 'amountMinor',
      currency: 'currency',
      idempotencyKey: 'pseudonym',
    }),
    handler: async (client, input) => capturePayment(client, input),
  }),
  defineTool({
    name: 'vipps_refund_payment',
    title: 'Refund ePayment payment (Vipps MobilePay)',
    description: `Refund all or part of the captured amount of an ePayment payment to the customer. Reads the payment first and refuses, without sending anything, when the currency differs or the amount is more than is captured and not yet refunded. ${WRITE_NOTE}`,
    inputShape: { reference: referenceSchema, amount: amountSchema, currency: currencySchema, idempotencyKey: idempotencyKeySchema },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Refunded payment.',
    upstream: [
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}' },
      { access: 'read', method: 'GET', path: '/epayment/v1/payments/{reference}/events' },
      { access: 'write', method: 'POST', path: '/epayment/v1/payments/{reference}/refund' },
    ],
    keyTypes: ALL_KEYS,
    change: change('refund', 'payment', {
      reference: 'pseudonym',
      amount: 'amountMinor',
      currency: 'currency',
      idempotencyKey: 'pseudonym',
    }),
    handler: async (client, input) => refundPayment(client, input),
  }),
  defineTool({
    name: 'vipps_cancel_payment',
    title: 'Cancel ePayment payment (Vipps MobilePay)',
    description: `Cancel an ePayment payment: the amount reserved and not captured is released to the customer. With cancelTransactionOnly, only a payment not yet authorized is cancelled. ${WRITE_NOTE}`,
    inputShape: {
      reference: referenceSchema,
      cancelTransactionOnly: z.boolean().optional().describe('Cancel only if the payment is not yet authorized.'),
      idempotencyKey: idempotencyKeySchema,
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Cancelled payment.',
    upstream: [{ access: 'write', method: 'POST', path: '/epayment/v1/payments/{reference}/cancel' }],
    keyTypes: ALL_KEYS,
    change: change('cancel', 'payment', {
      reference: 'pseudonym',
      cancelTransactionOnly: 'flag',
      idempotencyKey: 'pseudonym',
    }),
    handler: async (client, input) => cancelPayment(client, input),
  }),
  defineTool({
    name: 'vipps_refund_charge',
    title: 'Refund Recurring charge (Vipps MobilePay)',
    description: `Refund all or part of a charged Recurring charge to the customer. Reads the charge first and refuses, without sending anything, when the currency differs or the amount is more than is charged and not yet refunded. The description is sent to Vipps MobilePay and is not logged. ${WRITE_NOTE}`,
    inputShape: {
      agreementId: agreementIdSchema,
      chargeId: chargeIdSchema,
      amount: amountSchema,
      currency: currencySchema,
      description: z.string().trim().min(1).max(100).describe('Why the charge is refunded (1-100 characters), as Vipps MobilePay requires.'),
      idempotencyKey: idempotencyKeySchema,
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Refund of the charge requested.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
      { access: 'write', method: 'POST', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}/refund' },
    ],
    keyTypes: ALL_KEYS,
    change: change('refund', 'charge', {
      agreementId: 'pseudonym',
      chargeId: 'pseudonym',
      amount: 'amountMinor',
      currency: 'currency',
      idempotencyKey: 'pseudonym',
    }),
    handler: async (client, input) => refundCharge(client, input),
  }),
  defineTool({
    name: 'vipps_cancel_charge',
    title: 'Cancel Recurring charge (Vipps MobilePay)',
    description: `Cancel a pending, due, reserved or partially captured Recurring charge; money reserved and not captured is released to the customer. A pending, due or reserved charge ends as CANCELLED, a partially captured one as CHARGED. Reads the charge first and refuses any other status. The agreement itself is not changed. ${WRITE_NOTE}`,
    inputShape: { agreementId: agreementIdSchema, chargeId: chargeIdSchema, idempotencyKey: idempotencyKeySchema },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Cancellation of the charge requested.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
      { access: 'write', method: 'DELETE', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
    ],
    keyTypes: ALL_KEYS,
    change: change('cancel', 'charge', {
      agreementId: 'pseudonym',
      chargeId: 'pseudonym',
      idempotencyKey: 'pseudonym',
    }),
    handler: async (client, input) => cancelCharge(client, input),
  }),
  defineTool({
    name: 'vipps_create_charge',
    title: 'Create Recurring charge (Vipps MobilePay)',
    description:
      'Create a charge on an active Recurring agreement: Vipps MobilePay draws the amount from the customer on the due date, without the customer approving it again, and tries again for retryDays days if that fails. ' +
      'transactionType DIRECT_CAPTURE charges on the due date; RESERVE_CAPTURE reserves the amount on the due date, and capture_charge draws it once the product or service is delivered. ' +
      'The due date must be at least one day and at most two years ahead. Reads the agreement first and refuses, without sending anything, when it is not active, when the currency differs, or when the amount is outside the limits of the currency or above the maximum of a variable price. ' +
      'orderId is the business’s own number for the charge and is required; it becomes the charge’s id and can be used once per sales unit. After a failure or a lost answer, call again with exactly the same input: the server makes the Idempotency-Key from the input, and the orderId keeps the charge from being created twice, so the answer says whether it was created now or exists already (alreadyExists). Never change the orderId to try again. ' +
      'cancel_charge cancels a charge before it is drawn. Disabled by default (VIPPS_ENABLE_WRITES, or the gateway host policy enableWrites); a person should confirm every call.',
    inputShape: {
      agreementId: agreementIdSchema,
      amount: amountSchema,
      currency: currencySchema.describe('ISO 4217 currency code. Must be the currency of the agreement.'),
      description: z.string().trim().min(1).max(100).describe('What the customer is charged for (1-100 characters), shown in the app, e.g. the month.'),
      due: dateSchema.describe('The due date, YYYY-MM-DD: at least one day and at most two years ahead.'),
      retryDays: z.number().int().min(0).max(MAX_RETRY_DAYS).describe(`Days Vipps MobilePay tries again after the due date if the charge fails, 0-${MAX_RETRY_DAYS}. Vipps MobilePay recommends at least 2.`),
      transactionType: z.enum(CHARGE_TRANSACTION_TYPES).describe('DIRECT_CAPTURE (charged on the due date) or RESERVE_CAPTURE (reserved on the due date and drawn with capture_charge).'),
      processingMode: z.enum(PROCESSING_MODES).optional().describe('MULTIPLE_ATTEMPTS (default) or SINGLE_ATTEMPT: one try only, and then retryDays must be 0.'),
      orderId: z
        .string()
        .trim()
        .regex(ORDER_ID_PATTERN)
        .describe('The business’s own number for this charge (1-64 letters, digits or dashes), e.g. its invoice or subscription period number. It becomes the charge’s id and can be used once per sales unit, so the same charge is never created twice. Never change it to try again.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Created charge.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
      { access: 'write', method: 'POST', path: '/recurring/v3/agreements/{agreementId}/charges' },
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
    ],
    keyTypes: ALL_KEYS,
    change: change(
      'create',
      'charge',
      { agreementId: 'pseudonym', orderId: 'pseudonym', amount: 'amountMinor', currency: 'currency' },
      true,
    ),
    check: input => checkCreateCharge(input),
    keyedAuditText: true,
    handler: async (client, input) => createCharge(client, input),
  }),
  defineTool({
    name: 'vipps_capture_charge',
    title: 'Capture Recurring charge (Vipps MobilePay)',
    description:
      'Capture (draw) all or part of a reserved Recurring charge, one created as RESERVE_CAPTURE. Capture only once the product or service is delivered. ' +
      'alreadyCaptured is how much of the charge is captured before this capture, as get_charge shows it (summary.captured): 0 for the first capture. Reads the charge first and refuses, without sending anything, when alreadyCaptured is not what the charge shows, when the currency differs, when the charge is not reserved or partially captured, or when the amount is more than is reserved and not captured. ' +
      'After a failure or a lost answer, call again with exactly the same input: the server makes the Idempotency-Key from the input, so the capture is made only once, and the answer says when it was already made (alreadyDone). ' +
      `${WRITE_NOTE}`,
    inputShape: {
      agreementId: agreementIdSchema,
      chargeId: chargeIdSchema,
      amount: amountSchema,
      currency: currencySchema,
      alreadyCaptured: z
        .number()
        .int()
        .min(0)
        .max(MAX_AMOUNT_MINOR)
        .describe('How much of the charge is captured before this capture, in minor units, as get_charge shows it (summary.captured). 0 for the first capture.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Capture of the charge requested.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
      { access: 'write', method: 'POST', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}/capture' },
    ],
    keyTypes: ALL_KEYS,
    change: change(
      'capture',
      'charge',
      { agreementId: 'pseudonym', chargeId: 'pseudonym', amount: 'amountMinor', currency: 'currency' },
      true,
    ),
    handler: async (client, input) => captureCharge(client, input),
  }),
  defineTool({
    name: 'vipps_update_agreement',
    title: 'Change Recurring agreement (Vipps MobilePay)',
    description:
      'Change a pending or active Recurring agreement: the product name and description the customer sees, the address where the customer manages the agreement, the price, or the interval. Give only what changes. ' +
      'price changes a fixed price (pricing type LEGACY) and suggestedMaxAmount the suggested maximum of a variable price (VARIABLE), each with currency; the kind of price cannot be changed. Vipps MobilePay does not tell the customer of a new price: the business tells the customer itself, as its terms say. ' +
      'Reads the agreement first and refuses, without sending anything, when it is stopped or expired, when the price does not fit its kind of price, or when the currency differs; what the agreement already has is not sent again. Moves no money. To stop an agreement, use stop_agreement. ' +
      'After a failure or a lost answer, call again with exactly the same input: the agreement is read first, and what it already has is not sent again. Disabled by default (VIPPS_ENABLE_WRITES, or the gateway host policy enableWrites); a person should confirm every call.',
    inputShape: {
      agreementId: agreementIdSchema,
      productName: z.string().trim().min(1).max(45).optional().describe('The product name the customer sees (1-45 characters).'),
      productDescription: z.string().trim().min(1).max(100).optional().describe('The longer product description (1-100 characters).'),
      merchantAgreementUrl: z
        .string()
        .refine(value => isHttpsUrl(value, 1024), 'must be an https:// address of at most 1024 characters')
        .optional()
        .describe('The https address where the customer can see and manage the agreement, e.g. a “my page” of the business.'),
      price: z.number().int().min(1).max(MAX_AMOUNT_MINOR).optional().describe('A new fixed price in minor units (pricing type LEGACY only). Needs currency.'),
      suggestedMaxAmount: z
        .number()
        .int()
        .min(1)
        .max(MAX_AMOUNT_MINOR)
        .optional()
        .describe('A new suggested maximum in minor units (pricing type VARIABLE only). Needs currency.'),
      currency: currencySchema.optional().describe('With price or suggestedMaxAmount: the currency of the agreement.'),
      interval: z
        .strictObject({
          unit: z.enum(INTERVAL_UNITS).describe('YEAR, MONTH, WEEK or DAY.'),
          count: z.number().int().min(1).max(31).describe('How many units, 1-31: every 2 WEEK is every second week.'),
        })
        .optional()
        .describe('A new fixed interval: every count units. A flexible interval cannot be set here.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Change of the agreement requested.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
      { access: 'write', method: 'PATCH', path: '/recurring/v3/agreements/{agreementId}' },
    ],
    keyTypes: ALL_KEYS,
    change: change(
      'update',
      'agreement',
      { agreementId: 'pseudonym', price: 'amountMinor', suggestedMaxAmount: 'amountMinor', currency: 'currency' },
      false,
    ),
    check: input => checkUpdateAgreement(input),
    keyedAuditText: true,
    handler: async (client, input) => updateAgreement(client, input),
  }),
  defineTool({
    name: 'vipps_stop_agreement',
    title: 'Stop Recurring agreement (Vipps MobilePay)',
    description:
      'Stop a pending or active Recurring agreement. This cannot be undone: a stopped agreement can never be started again, and the customer must agree to a new one. Ask the person first, and say so. ' +
      'Vipps MobilePay cancels the pending, due and reserved charges of the agreement (capture a reserved charge with capture_charge first if it should be drawn), and no new charge can be created on it. Charges already drawn stay as they are. ' +
      'To pause an agreement, leave it active and create no charges. Reads the agreement first: one that is already stopped is answered as such, without sending anything. Moves no money itself. ' +
      'Disabled by default (VIPPS_ENABLE_WRITES, or the gateway host policy enableWrites); a person should confirm every call.',
    inputShape: { agreementId: agreementIdSchema },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Stop of the agreement requested.',
    upstream: [
      { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
      { access: 'write', method: 'PATCH', path: '/recurring/v3/agreements/{agreementId}' },
    ],
    keyTypes: ALL_KEYS,
    change: change('stop', 'agreement', { agreementId: 'pseudonym' }, false),
    handler: async (client, input) => stopAgreement(client, input),
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return VIPPS_TOOLS.find(tool => tool.name === name);
}

/**
 * The value of one log field when it has exactly the field's type; otherwise
 * undefined. Identifiers come back only as pseudonyms, never in clear.
 */
export function logFieldValue(
  type: VippsLogFieldType,
  value: unknown,
  pseudonymKey?: string | Uint8Array,
): string | number | boolean | undefined {
  switch (type) {
    case 'amountMinor':
      return isAmountMinor(value) ? value : undefined;
    case 'currency':
      return isMerchantCurrency(value) ? value : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'pseudonym':
      return typeof value === 'string' && value.length > 0 && value.length <= 100 ? pseudonym(value, pseudonymKey) : undefined;
    case 'delivery':
      return typeof value === 'string' && (PAYMENT_DELIVERIES as readonly string[]).includes(value) ? value : undefined;
    default:
      return undefined;
  }
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(VIPPS_TOOLS.map(tool => tool.name));
}

/** Startup checks for entry points (transports, gateway): tool policy plus a writable audit log. */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Whether a tool works with this kind of keys. */
export function toolSupportsKeyType(tool: ToolDefinition, keyType: VippsKeyType): boolean {
  return tool.keyTypes.includes(keyType);
}

/** Whether a tool works in this environment. */
export function toolSupportsEnvironment(tool: ToolDefinition, environment: VippsEnvironment): boolean {
  return tool.environments === undefined || tool.environments.includes(environment);
}

/** Tools enabled on this instance: not disabled, and usable with its keys in its environment. */
export function enabledTools(keyType: VippsKeyType, environment: VippsEnvironment): ToolDefinition[] {
  return VIPPS_TOOLS.filter(tool => !isToolDisabled(tool.name) && toolSupportsKeyType(tool, keyType) && toolSupportsEnvironment(tool, environment));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  if (client.keyType === 'accounting') {
    // A call over MCP names no organisation, and with these keys nothing may be read without one.
    throw new ConfigError(
      'Accounting keys are served through the gateway entry point only, where the host names the organisation of every call.',
    );
  }
  for (const tool of enabledTools(client.keyType, client.environment)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        let result: { content: Array<{ type: 'text'; text: string }>; isError?: true };
        try {
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // Upstream data can echo a key or the token, in values or in object keys: redacted as data before it
          // is serialised (a serialised key is escaped and no longer matches).
          result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: formatUnknownError(error, client.redactor) }] };
        }
        // The gateway's last check: a result that still holds a piece of a key is withheld whole.
        return leaksSecret(result, client.redactor) ? withheldResult() : result;
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity. The audit stores it only as a pseudonym (`hmac:` and 16 hex characters, per process). */
  caller?: string;
  /**
   * The host's request id. Accepted for compatibility and not written: the audit's request id is the server's own,
   * one per call, so no text of the host reaches the record through it.
   */
  requestId?: string;
  /**
   * Accounting keys only, and required with them: the organisation the caller may see, as the Report API names an
   * owner (`{ scheme: 'business:DK:CVR', id: '<the number>' }`). The call reads only ledgers with exactly this
   * owner. A call without it, or with a value in another form, is refused before anything is sent. It is not
   * written to the audit. With other keys it is not read.
   */
  owner?: { scheme: string; id: string };
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Normalise a host-supplied context; malformed values are ignored. The request id is always the server's own. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: newRequestId(),
    caller: contextString(value.caller, 320),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input, tool.keyedAuditText ? text => client.keyedHash('audit-text', text) : undefined);
  const { redactor } = client;

  let policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  if (policy.allowed && !toolSupportsKeyType(tool, client.keyType)) {
    policy = { allowed: false, reason: keyTypeRefusal(tool, client.keyType) };
  }
  if (policy.allowed && !toolSupportsEnvironment(tool, client.environment)) {
    policy = {
      allowed: false,
      reason: `${tool.name} does not work in the ${client.environment} environment (Vipps MobilePay has no Management API there).`,
    };
  }
  // Accounting keys: the call must name its organisation. Without one nothing is sent, the token request included.
  const owner: LedgerOwner | undefined =
    client.keyType === 'accounting' ? ledgerOwnerFrom((context as { owner?: unknown } | undefined)?.owner) : undefined;
  const ownerMissing = policy.allowed && client.keyType === 'accounting' && owner === undefined ? new OwnerMissingError() : undefined;
  if (ownerMissing) policy = { allowed: false, reason: ownerMissing.message };
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  const refusal = inputPolicy.allowed ? tool.check?.(input) : undefined;
  if (!inputPolicy.allowed || refusal) {
    const reason = inputPolicy.allowed ? (refusal as string) : inputPolicy.reason;
    await writeAuditEvent({ requestId, tool: tool.name, caller, action: 'policy_denied', target, reason }, { redactor });
    throw ownerMissing ?? new Error(reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    // Accounting keys: the handler gets a view bound to the call's organisation, made for this call and no other.
    const callClient: UpstreamClient = owner === undefined ? client : ownerBoundClient(client, owner);
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(callClient, tool.name) : callClient;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent(
      {
        requestId,
        tool: tool.name,
        caller,
        action: 'finish',
        target,
        status: 'ok',
        durationMs: Math.round(performance.now() - startedAt),
      },
      { redactor },
    );
    return result;
  } catch (error) {
    await writeAuditEvent(
      {
        requestId,
        tool: tool.name,
        caller,
        action: 'error',
        target,
        status: 'error',
        durationMs: Math.round(performance.now() - startedAt),
        error,
      },
      { redactor },
    );
    throw error;
  }
}

/** Why a tool does not work with the keys of the instance. */
function keyTypeRefusal(tool: ToolDefinition, keyType: VippsKeyType): string {
  if (keyType === 'accounting') {
    return `${tool.name} does not work with accounting keys (they give access to settlements and sales only).`;
  }
  if (tool.keyTypes.every(type => type === 'accounting')) {
    return `${tool.name} does not work with ${keyType} keys (Vipps MobilePay gives the sales with order lines to accounting keys only).`;
  }
  return `${tool.name} does not work with ${keyType} keys (${tool.keyTypeReason ?? "the Report API needs the merchant's own keys"}).`;
}

/**
 * What a connection check with accounting keys ended in when the connection does not work, for a host that shows
 * the person what to do next:
 *   owner_missing        the call named no organisation (the host's own error);
 *   no_ledger_for_owner  the keys work, and no ledger owned by the organisation is visible: the business has not
 *                        given the accounting partner access, or has given it for another organisation;
 *   keys_refused         Vipps MobilePay refused the keys (the token request answered 400, 401 or 403, or the
 *                        ledger list 401 or 403);
 *   unavailable          anything else: throttling, a server error, a network error, an answer in another form.
 */
export type ConnectionFailureOutcome = 'owner_missing' | 'no_ledger_for_owner' | 'keys_refused' | 'unavailable';

/** The outcome of a failed connection check with accounting keys, from its error. */
export function connectionFailureOutcome(error: unknown): ConnectionFailureOutcome {
  if (error instanceof OwnerMissingError) return 'owner_missing';
  if (error instanceof NoLedgerForOwnerError) return 'no_ledger_for_owner';
  if (error instanceof VippsHttpError) {
    const refused = error.tokenRequest ? [400, 401, 403] : [401, 403];
    if (refused.includes(error.status)) return 'keys_refused';
  }
  return 'unavailable';
}

/** The tool name in the audit record of a call to a tool this server does not have. */
export const UNKNOWN_TOOL = 'unknown_tool';

/** Why a call was rejected before it ran: a fixed text, never the caller's. */
export type RejectedReason = 'unsupported tool' | 'invalid input';

/**
 * Audit a call rejected before execution. Nothing the caller wrote is logged as text: an unknown tool is recorded
 * as UNKNOWN_TOOL, and of the input only the field names the tool's own schema has, plus how many others there were.
 */
export async function auditRejectedCall(
  tool: ToolDefinition | undefined,
  input: unknown,
  reason: RejectedReason,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const known = new Set(tool ? Object.keys(tool.inputSchema.shape) : []);
  const fields = keys.filter(key => known.has(key)).sort();
  const unknownFields = keys.length - fields.length;
  await writeAuditEvent({
    requestId,
    tool: tool ? tool.name : UNKNOWN_TOOL,
    caller,
    action: 'rejected',
    target: unknownFields > 0 ? { fields, unknownFields } : { fields },
    reason,
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
