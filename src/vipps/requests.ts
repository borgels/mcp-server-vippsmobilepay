// The fixed list of requests this server can send, each with the template it is logged by. Its own module, with no
// imports, so the error helpers (src/errors.ts) can check a template against the list without importing the client.

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Every API request this server can make, by method. A path is checked
 * against this list before anything is sent, whichever tool asks: nothing
 * outside it (a new agreement, merchant or sales unit settings) can be sent,
 * whatever the policy says. Path segments arrive
 * already encoded by encodePathParam. A Recurring agreement can be changed
 * and stopped (PATCH) and get a new charge, but never created or force
 * accepted.
 */
const SEGMENT = '[^/?#]+';
export const ALLOWED_REQUESTS: Readonly<Record<HttpMethod, ReadonlyArray<readonly [RegExp, string]>>> = {
  GET: [
    [/^\/settlement\/v1\/ledgers$/, '/settlement/v1/ledgers'],
    [/^\/report\/v2\/ledgers\/\d{1,20}\/funds\/dates\/\d{4}-\d{2}-\d{2}$/, '/report/v2/ledgers/{ledgerId}/funds/dates/{date}'],
    [/^\/report\/v2\/ledgers\/\d{1,20}\/fees\/dates\/\d{4}-\d{2}-\d{2}$/, '/report/v2/ledgers/{ledgerId}/fees/dates/{date}'],
    [new RegExp(`^/epayment/v1/payments/${SEGMENT}$`), '/epayment/v1/payments/{reference}'],
    [new RegExp(`^/epayment/v1/payments/${SEGMENT}/events$`), '/epayment/v1/payments/{reference}/events'],
    [/^\/recurring\/v3\/agreements$/, '/recurring/v3/agreements'],
    [new RegExp(`^/recurring/v3/agreements/${SEGMENT}$`), '/recurring/v3/agreements/{agreementId}'],
    [new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges$`), '/recurring/v3/agreements/{agreementId}/charges'],
    [
      new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}$`),
      '/recurring/v3/agreements/{agreementId}/charges/{chargeId}',
    ],
    // A charge by its own id, when the agreement is not known (find_charge).
    [new RegExp(`^/recurring/v3/charges/${SEGMENT}$`), '/recurring/v3/charges/{chargeId}'],
    // The order lines and category stored with a payment or a charge (get_receipt).
    [new RegExp(`^/order-management/v2/ECOM/${SEGMENT}$`), '/order-management/v2/ECOM/{orderId}'],
    [new RegExp(`^/order-management/v2/RECURRING/${SEGMENT}$`), '/order-management/v2/RECURRING/{orderId}'],
    // The sales units the keys can read, and one of them (list_sales_units, get_sales_unit). Production only.
    [/^\/management\/v1\/sales-units$/, '/management/v1/sales-units'],
    [/^\/management\/v1\/sales-units\/\d{4,10}$/, '/management/v1/sales-units/{msn}'],
    // The sales unit's fixed QR codes (list_qr_codes).
    [/^\/qr\/v1\/merchant-redirect$/, '/qr/v1/merchant-redirect'],
    [/^\/qr\/v1\/merchant-callback$/, '/qr/v1/merchant-callback'],
    // The host's registrations for events (listWebhooks, src/vipps/webhooks.ts). Never a tool.
    [/^\/webhooks\/v1\/webhooks$/, '/webhooks/v1/webhooks'],
  ],
  POST: [
    // A new payment request (create_payment). The customer approves it in the app before any money moves.
    [/^\/epayment\/v1\/payments$/, '/epayment/v1/payments'],
    [new RegExp(`^/epayment/v1/payments/${SEGMENT}/capture$`), '/epayment/v1/payments/{reference}/capture'],
    [new RegExp(`^/epayment/v1/payments/${SEGMENT}/refund$`), '/epayment/v1/payments/{reference}/refund'],
    [new RegExp(`^/epayment/v1/payments/${SEGMENT}/cancel$`), '/epayment/v1/payments/{reference}/cancel'],
    [
      new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}/refund$`),
      '/recurring/v3/agreements/{agreementId}/charges/{chargeId}/refund',
    ],
    // A new charge on an agreement (create_charge), and the capture of a reserved one (capture_charge).
    [new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges$`), '/recurring/v3/agreements/{agreementId}/charges'],
    [
      new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}/capture$`),
      '/recurring/v3/agreements/{agreementId}/charges/{chargeId}/capture',
    ],
    // The host registers its own address for a sales unit's ePayment events (registerPaymentEvents). Never a tool.
    [/^\/webhooks\/v1\/webhooks$/, '/webhooks/v1/webhooks'],
  ],
  // One PATCH: an agreement's product, price or interval (update_agreement), or its status STOPPED (stop_agreement).
  PATCH: [[new RegExp(`^/recurring/v3/agreements/${SEGMENT}$`), '/recurring/v3/agreements/{agreementId}']],
  // Two DELETEs, nothing else. Vipps MobilePay cancels a Recurring charge with
  // DELETE on the charge, the only DELETE a tool can send, and it deletes no
  // record: the charge stays. A pending, due or reserved charge ends as CANCELLED; a partially
  // captured one ends as CHARGED, with the rest released to the customer.
  DELETE: [
    [
      new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}$`),
      '/recurring/v3/agreements/{agreementId}/charges/{chargeId}',
    ],
    // The other: the host removes a registration of its own address for events (removeWebhook). Never a tool, and
    // nothing of a payment, charge or agreement.
    [/^\/webhooks\/v1\/webhooks\/[A-Za-z0-9-]{8,64}$/, '/webhooks/v1/webhooks/{id}'],
  ],
};

/**
 * Every API request a client with accounting keys can make: the ledger list,
 * the funds and fees ledgers of a ledger date, and the sales of a ledger (by
 * ledger date, by the business's reference, by Vipps MobilePay's
 * reference). All are GET. Nothing else of ALLOWED_REQUESTS is among them, and
 * the sales paths are in no other list: the Sales API takes accounting keys
 * only. The feed of a ledger is not here: it is for keeping a copy, and this
 * server keeps none.
 */
export const ACCOUNTING_REQUESTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/settlement\/v1\/ledgers$/, '/settlement/v1/ledgers'],
  [/^\/report\/v2\/ledgers\/\d{1,20}\/funds\/dates\/\d{4}-\d{2}-\d{2}$/, '/report/v2/ledgers/{ledgerId}/funds/dates/{date}'],
  [/^\/report\/v2\/ledgers\/\d{1,20}\/fees\/dates\/\d{4}-\d{2}-\d{2}$/, '/report/v2/ledgers/{ledgerId}/fees/dates/{date}'],
  [/^\/sales\/report\/v1\/ledgers\/\d{1,20}\/dates\/\d{4}-\d{2}-\d{2}$/, '/sales/report/v1/ledgers/{ledgerId}/dates/{date}'],
  [new RegExp(`^/sales/report/v1/ledgers/\\d{1,20}/references/${SEGMENT}$`), '/sales/report/v1/ledgers/{ledgerId}/references/{reference}'],
  [
    new RegExp(`^/sales/report/v1/ledgers/\\d{1,20}/psp-references/${SEGMENT}$`),
    '/sales/report/v1/ledgers/{ledgerId}/psp-references/{pspReference}',
  ],
];

/** The path of the access token request, which is not in ALLOWED_REQUESTS. */
export const TOKEN_PATH = '/accesstoken/get';

/** The path of the access token request with accounting keys (HTTP Basic, no subscription key). */
export const ACCOUNTING_TOKEN_PATH = '/miami/v1/token';

/** Every template a failure may name: those of ALLOWED_REQUESTS, ACCOUNTING_REQUESTS and the two token requests. */
export const REQUEST_TEMPLATES: ReadonlySet<string> = new Set([
  TOKEN_PATH,
  ACCOUNTING_TOKEN_PATH,
  ...Object.values(ALLOWED_REQUESTS).flatMap(entries => entries.map(([, template]) => template)),
  ...ACCOUNTING_REQUESTS.map(([, template]) => template),
]);
