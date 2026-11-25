# mcp-server-vippsmobilepay

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Vipps MobilePay APIs. It lets an MCP client (Claude or any other MCP-capable assistant) read a merchant's settlements, ledger entries, ePayment payments with their order lines, Recurring agreements and charges, sales units and fixed QR codes, and, when enabled, ask a customer to pay and capture, refund or cancel payments and charges.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Vipps MobilePay.

- Read-only by default. The six write tools ask a customer to pay, or move or release money; they are off unless enabled per instance, and a host should have a person confirm every call.
- Uses only the official [Access Token](https://developer.vippsmobilepay.com/docs/APIs/access-token-api/), [Report](https://developer.vippsmobilepay.com/docs/APIs/report-api/), [ePayment](https://developer.vippsmobilepay.com/docs/APIs/epayment-api/), [Recurring](https://developer.vippsmobilepay.com/docs/APIs/recurring-api/), [Order Management](https://developer.vippsmobilepay.com/docs/APIs/order-management-api/), [Management](https://developer.vippsmobilepay.com/docs/APIs/management-api/) and [QR](https://developer.vippsmobilepay.com/docs/APIs/qr-api/) APIs. Of the last three it only reads.
- Nothing can change an agreement (price, interval, status), merchant or sales unit settings, a QR code, a receipt or the keys, and nothing creates a charge: every request is checked against a fixed list before it is sent.
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application, with a host policy and typed change descriptions for the host's own log.

## Tools

Amounts are in minor units (øre, cent): 125,50 kr is `12550`.

| Tool | Risk | Purpose |
|---|---|---|
| `vipps_check_connection` | read | Check that the keys work (requests an access token). With accounting keys: connected only when a ledger of the call's organisation is visible. |
| `vipps_list_ledgers` | read | Settlement ledgers with currency and the sales units they settle for. With the merchant's own keys the payout account is shown as its last four characters; with accounting keys only the organisation's ledgers, and nothing of the payout account. Not with partner keys. |
| `vipps_get_funds_summary` | read | Totals of the funds ledger for up to 31 days, per date and in all: sales, refunds, fees retained, payouts, balance before and after. Merchant or accounting keys. |
| `vipps_list_transactions` | read | Every entry of the funds or fees ledger for up to 31 days. Merchant or accounting keys. |
| `vipps_list_sales` | read | Every sale (capture or refund) of one ledger date, with order lines and VAT. Accounting keys only, production only. |
| `vipps_get_sale` | read | One sale by the business's `reference` or by Vipps MobilePay's `pspReference`, with order lines and VAT. Accounting keys only, production only. |
| `vipps_get_payment` | read | One ePayment payment by reference, with its events. |
| `vipps_list_agreements` | read | Recurring agreements with one status (default `ACTIVE`). |
| `vipps_get_agreement` | read | One Recurring agreement. |
| `vipps_list_charges` | read | The charges of one agreement, optionally by status. |
| `vipps_get_charge` | read | One charge of an agreement. |
| `vipps_find_charge` | read | One charge by its own id, when the agreement is not known. For looking one charge up, not for reading many. |
| `vipps_get_receipt` | read | The order details stored with a payment (`reference`) or a Recurring charge (`chargeId`): order lines with VAT, the bottom line and the category. |
| `vipps_list_sales_units` | read | The sales units the keys can read, with MSN and name. Merchant keys only, production only. |
| `vipps_get_sales_unit` | read | The sales unit the keys are used for, and what Vipps MobilePay has enabled for it (capture type, payments the customer can pay later, requests without the landing page and more). Production only. |
| `vipps_list_qr_codes` | read | The sales unit's fixed QR codes: those that send the customer to a web address and those that tell the business that a customer has scanned them. |
| `vipps_create_payment` | write (confirm) | Ask a customer to pay: a payment request as a link, as a QR code or sent to the customer's phone number, optionally with a deadline of up to 60 days. Moves no money by itself. |
| `vipps_capture_payment` | write (confirm) | Capture all or part of an authorized payment. |
| `vipps_refund_payment` | write (confirm) | Refund all or part of a captured payment. |
| `vipps_cancel_payment` | write (confirm) | Cancel a payment; the reserved, uncaptured amount is released. |
| `vipps_refund_charge` | write (confirm) | Refund all or part of a charged Recurring charge. |
| `vipps_cancel_charge` | write (confirm) | Cancel a pending, due, reserved or partially captured charge; what is reserved and not captured is released. |

**Asking a customer to pay.** `create_payment` sends [`POST /epayment/v1/payments`](https://developer.vippsmobilepay.com/docs/APIs/epayment-api/api-guide/operations/create/) with `paymentMethod.type` `WALLET`. The customer approves the request in the Vipps or MobilePay app; that reserves the amount, `capture_payment` draws it, `get_payment` shows the state, and `cancel_payment` cancels the request. `delivery` chooses the ePayment user flow:

| `delivery` | User flow | What comes back | What Vipps MobilePay requires |
|---|---|---|---|
| `link` | `WEB_REDIRECT` | `link`: the address the customer opens (the app on a phone, the landing page elsewhere). `returnUrl` is required. | Nothing more. |
| `qr` | `QR` | `qrCode`: the address of the QR code to show (`qrFormat` chooses an image or the address the code holds). | Nothing more. Set `customerPresent` when the customer is at the point of sale. |
| `phone` | `PUSH_MESSAGE` | No link: the request is in the app of the customer with `phoneNumber`. | The sales unit must be approved for it by Vipps MobilePay ([skip landing page](https://developer.vippsmobilepay.com/docs/knowledge-base/landing-page/#skip-landing-page)), and the business must have the number from the customer, with consent to be asked this way. |

Without `expiresAt` the customer has 10 minutes to approve. With `expiresAt` the customer can pay later; Vipps MobilePay [enables that for each sales unit](https://developer.vippsmobilepay.com/docs/APIs/epayment-api/api-guide/features/long-living-payments/), sets its limit, and requires the deadline to be more than 10 minutes and less than 60 days ahead. `orderLines` are then required, in NOK with `productUrl` on every line (required in Norway). The lines must add up to the amount, each line to its amount without VAT plus its VAT. Amounts are whole minor units with a currency code, which must be the currency of the sales unit; the smallest amount in NOK is 100. Whether a deadline is too near or too far is for Vipps MobilePay to refuse: this server refuses nothing by its own clock, so the same call gets the same treatment whenever it is made.

The result has one form however the request came to exist: `created`, `alreadyExists`, the reference, the delivery, the amount, the `state` of the payment read back (`null` when it could not be read), `link` or `qrCode` (`null` when there is none to give), the deadline, and a `note` that says what the state means. The phone number is sent to Vipps MobilePay and is never in a result, an error or the audit; the reference, which is the order or invoice number the business uses, is shown to the customer.

**Before a write.** Capture and refund read the payment (or charge) first and refuse, without sending anything, when the currency differs from the payment's or the amount is more than can be captured or refunded. Capture needs an `AUTHORIZED` payment; cancelling a charge needs a cancellable status. The payment's or charge's amounts must be whole, non-negative minor units that add up (nothing captured beyond what was authorized, nothing refunded beyond what was captured), and its currency one of NOK, DKK and EUR; otherwise the change is refused with a fixed text.

**A payment request gets its key from its content.** `create_payment` takes no `idempotencyKey`. The server makes two values from the sales unit's number and everything the request says (reference, amount, currency, text, delivery, phone number, return address, deadline, order lines) in a fixed field order; a deadline is the same whichever offset it is written with. Each is 32 hex characters of a keyed hash (HMAC-SHA-256), and each has its own key, derived from the client secret inside the client:

- the `Idempotency-Key`, `create-` and the first value. The same input is always the same key and any other input another, so a caller that repeats a request after a timeout, an error or a lost answer cannot repeat it under a new key;
- the fingerprint, which the request carries as `metadata.requestFingerprint`. Vipps MobilePay stores it and returns it when the payment is read.

Without the client secret neither value can be made, and neither can be tested against a guess of the content: someone who knows everything of a request but the phone number cannot find the number by trying every one. The key does not give the fingerprint. The server itself never sends the request twice (one more time only after HTTP 401, with a new access token and the same key), and nothing is kept between calls.

Where the two values go, and where they do not (`test/create-payment.test.ts`, "the fingerprint and the key leave the server only in the create request"):

| Place | The key and the fingerprint |
|---|---|
| The create request to Vipps MobilePay | The key as `Idempotency-Key`, the fingerprint as `metadata.requestFingerprint`. The only place. |
| Every other request to Vipps MobilePay (the read after the create, `get_payment`, capture, refund, cancel) | Neither. |
| The answer of `create_payment`, also when the request exists already or is refused | Neither. |
| The answer of `get_payment` | Neither. A payment passes an allow-list without `metadata`. An event passes on its `idempotencyKey` only when it is a capture, a refund or a cancellation (`CAPTURED`, `REFUNDED`, `CANCELLED`, `TERMINATED`), whose key the caller chose; a key in the form this server derives is passed on under no event. |
| The answers of `capture_payment`, `refund_payment` and `cancel_payment` | Neither. What Vipps MobilePay answers a change with passes the same allow-list as a payment. |
| Errors | Neither. The texts are this server's own, and the vendor's body is never read. |
| The audit, `resolveVippsChange` and the console | Neither. The audit holds the named input fields; neither value is an input. The description is logged as a third keyed hash (`descriptionHmac`), made with a key of its own. |

**After the client secret is replaced** the same input gives another key and another fingerprint. A request made before is then no longer recognised: the same call is refused as a conflict, and nothing of the payment is returned. It is not created a second time, since the reference is used; `get_payment` shows it. A request made after the replacement is recognised as before.

**A payment that is read back is this request only when that is proven.** Vipps MobilePay returns a payment's reference, amount, currency, payment method, state and metadata, and not its phone number, text or order lines. A payment is taken for this request only when all of the first four are the request's own and the metadata holds this request's fingerprint, which stands for everything that is not returned. Every way `create_payment` can answer holds to it:

| What Vipps MobilePay answered the create request with | The payment that has the reference | Answer |
|---|---|---|
| Accepted | Read, and proven to be this request | Its state, and the address while the customer can use it. `created: true` when it waits, otherwise `alreadyExists: true`. |
| Accepted | Read, and not proven (no metadata, another fingerprint, another amount, currency or payment method, an empty answer) | An error, and nothing of the payment or of the acceptance: no state and no link. A request may exist; `get_payment` shows it and `cancel_payment` cancels it. |
| Accepted | Not read at all (no answer, or an HTTP error) | `created: true`, `state: null` and the address from the acceptance, which answers this request's own key. Nothing of a payment is returned, since none was read. |
| Refused (HTTP 400 or 409) | Read, and proven to be this request | `alreadyExists: true`, its state, and the link while the customer can use it. |
| Refused (HTTP 400 or 409) | Read, and not proven | Refused as a conflict. Nothing of the payment is returned. |
| Refused (HTTP 400 or 409) | Not read at all | The refusal as it is. Nothing is said of a payment, except that it could not be read when that is so. |
| Refused otherwise, or no answer | Not read | The error, with what is known: nothing was created (429, 423, the access token), or it is not known (a timeout, a lost connection, 5xx). |

A payment proven to be this request in a state this server does not know is answered with `state: null`, and with a link only when Vipps MobilePay accepted the request in this call.

What a second call is answered with (`test/create-payment.test.ts` has a test per row, for a vendor that answers a repeated key with the first answer and for one that refuses it):

| The second call | Answer |
|---|---|
| The same input after a lost answer, or after an answer that arrived | One request. `created: true` when Vipps MobilePay answers the repeated key with the first answer, otherwise `alreadyExists: true`; `state: CREATED` and the link either way. |
| The same input much later, the key forgotten, the request still waiting | `alreadyExists: true`, `state: CREATED`, the link. Nothing is created. |
| The same input when the deadline is now near or has passed | Sent as it is: no refusal by our clock. Found as above, or as `EXPIRED`. |
| The same input after the customer has paid | `alreadyExists: true`, `state: AUTHORIZED`, no link; `capture_payment` draws the amount. |
| The same input after the request was cancelled, declined or expired | `alreadyExists: true`, the state (`TERMINATED`, `ABORTED`, `EXPIRED`), no link; a new request needs another reference. |
| The same input, when the payment cannot be read at all | Accepted again (a repeated key answered with the first answer): `created: true`, `state: null`, the link of the acceptance. Refused (a repeated key refused): the refusal, with a note that the payment could not be read. One request either way. |
| The same input, when the payment is read back without the fingerprint | An error or a conflict, and nothing of the payment, whatever the create request was answered with. |
| The same input after the client secret was replaced | Refused as a conflict: the request is no longer recognised. Not created twice, and nothing of the payment is returned. |
| The same reference with anything else changed (amount, phone number, text, delivery, return address, deadline, order lines) | Refused as a conflict. Nothing is created and nothing of the existing payment is returned. |
| The same content with another reference | A second request: a new reference is what makes a request new. |
| The same input after a refusal that created nothing (HTTP 429) | Created, under the same key. |

A QR code's address is given only in the answer to the request that creates it; a payment read back has the landing page address (the specification's `redirectUrl`), which is passed on as the `link` of a link request and never as a `qrCode`. A QR request that is found again therefore has `qrCode: null` and a note saying so.

**Every capture, refund and cancellation needs an operation key.** `idempotencyKey` (8-40 letters, digits or dashes) is required for these five write tools and is sent as `Idempotency-Key`; the server never makes one up, and a call without one is refused before anything is sent. The caller chooses a new key for each new change, records it before the call, and sends the same key when it repeats that change (after a timeout, an error or a lost answer). Vipps MobilePay carries out a key once and answers a repeat with the first result, so a repeated partial refund cannot pay out twice. The key comes back in the result. When a repeat reaches our own check after the change was carried out (a full refund whose answer was lost, say), the check would refuse it; the payment's events or the charge's history are then searched for a successful event with the same key and amount, and if one is found the result says `alreadyDone: true` and nothing is sent.

**Looking things up.** Five reads for what a business asks about a payment or about its own setup:

| Tool | Request | Notes |
|---|---|---|
| `find_charge` | [`GET /recurring/v3/charges/{chargeId}`](https://developer.vippsmobilepay.com/api/recurring/) | Vipps MobilePay documents it for looking into one charge when the agreement is unknown, "not intended for automation". When the id is the id of more than one charge it answers HTTP 409 (`ambiguous-charge-id`), and the tool says so in its own words. |
| `get_receipt` | [`GET /order-management/v2/{paymentType}/{orderId}`](https://developer.vippsmobilepay.com/docs/APIs/order-management-api/order-management-api-guide/#fetching-category-and-order-details) | `ECOM` with the reference of a payment, `RECURRING` with the id of a charge. This is also how the order lines sent with `create_payment` are read back: the ePayment API has no request that returns them. Only what the business or its system sent is stored, so a payment without it is answered as not found. Amounts are in minor units; `taxRate` is in hundredths of a percent. |
| `list_sales_units` | [`GET /management/v1/sales-units`](https://developer.vippsmobilepay.com/docs/APIs/management-api/) | With the merchant's own keys. With partner keys the request lists the sales units of every merchant of the partner, so the tool is not offered with them. |
| `get_sales_unit` | `GET /management/v1/sales-units/{msn}` | Always the configured sales unit; the caller cannot name another. `longLivingPaymentAllowed` says whether `create_payment` can take `expiresAt`, `skipLandingPageAllowed` whether it can deliver to a phone number, and `captureType` whether an approved payment must be captured (`ReserveCapture`) or is drawn at once (`DirectCapture`). |
| `list_qr_codes` | [`GET /qr/v1/merchant-redirect`](https://developer.vippsmobilepay.com/docs/APIs/qr-api/api-guide/merchant-redirect/) and [`GET /qr/v1/merchant-callback`](https://developer.vippsmobilepay.com/docs/APIs/qr-api/api-guide/merchant-callback/) | Both kinds unless `kind` is given, and the call fails when either cannot be read. The address of a code's image carries a token and [stops working after a while](https://developer.vippsmobilepay.com/docs/APIs/qr-api/api-guide/code-formats/); a new call gives a new one. |

Vipps MobilePay [has no Management API in the test environment](https://developer.vippsmobilepay.com/docs/APIs/management-api/management-api-faq/#can-i-use-the-management-api-in-the-test-environment), where its requests are answered with HTTP 401 as if the keys were refused. The two sales unit tools are therefore offered in production only: in the test environment they are left out of the tool list and refused before anything is sent (`environments` in the catalog).

Every answer of these five passes a typed allow-list (`src/vipps/views.ts`) that is read strictly, on every level and for every item of a list:

- a field that is not on the list is left out;
- a field on the list whose value has another type (or a text longer than is taken) refuses the whole answer, so nothing that was in the answer under a known name disappears from a result;
- an object without a field it needs refuses the whole answer, so an item of a list is never an empty object;
- `null` is no value: a field that is null is absent;
- a list of more than 1 000 items refuses the answer; it is never cut short.

The fields an object needs are those the specification requires and does not allow to be null:

| Object | Needs |
|---|---|
| A charge | `id`, `status`, `amount`, `currency` (the specification's own list also names fields it documents as optional) |
| The summary of a charge | `captured`, `refunded`, `cancelled` |
| An event in the history of a charge | `occurred`, `event`, `amount`, `success` |
| The category of an order | `orderDetailsUrl` |
| A receipt | `orderLines`, `bottomLine` |
| An order line | `name`, `id`, `totalAmount`, `totalAmountExcludingTax`, `totalTaxAmount` |
| The unit information of an order line | `quantity` |
| A sales unit, alone or in the list | `msn`, `name` |
| The business identifier of a sales unit | `scheme`, `id` |
| A redirect QR code | `id`, `url` (the image address), `redirectUrl` |
| A callback QR code | `merchantQrId` (the specification requires nothing; this is its id) |

The bottom line of a receipt, its shipping, payment sources and barcode, and the configuration of a sales unit need nothing: every field of theirs can be null. The older reads (a payment, its events, an agreement, a charge of a known agreement) still leave out a known field in another form; they get the same rule with the Recurring changes.

The address of a QR code's image is passed on whole, like the link of a payment request; it is public by Vipps MobilePay's own description and is never logged. A text there that is not an https address in the form of a link is answered as `imageUrl: null`, never passed on.

**Each sale with its lines and VAT needs accounting keys.** Vipps MobilePay's [Sales API](https://developer.vippsmobilepay.com/docs/APIs/sales-api/) gives the order lines and VAT of sales made with a Vippsnummer or MobilePay number and with the point-of-sale product, not of ePayment payments. It is open to accounting partners only, with accounting keys, in production only: `list_sales` and `get_sale` work with those keys and no others (see [Accounting keys](#accounting-keys)). A sales unit that takes payment by number has no API keys of its own. With the merchant's own keys, `get_receipt` gives the order lines of a payment that was created through the API with them.

**Cancelling a charge uses DELETE.** The Recurring API cancels a charge with `DELETE /recurring/v3/agreements/{agreementId}/charges/{chargeId}`. It is the only DELETE this server can send, and it deletes no record: the charge remains. A pending, due or reserved charge ends as `CANCELLED`; a partially captured charge ends as `CHARGED`, with the rest released to the customer.

**Lists are complete or refused.** Every list is read to its end. When a cap is reached the call fails with a refusal and returns nothing, rather than a list that looks complete but is not:

| List | Cap |
|---|---|
| Ledgers | 20 pages |
| Report entries | 31 days and 200 pages per call; `list_transactions` at most 5 000 entries |
| Agreements | 10 pages of 500 |
| Charges of one agreement | 20 pages (`Continuation-Token`) |
| Ledgers, with accounting keys (the owner binding) | 200 pages |
| Sales of one ledger date | 100 pages; at most 5 000 entries |

Every page of a ledger date must carry `items`, `tryLater` and `hasMore` in their documented types, and a cursor when `hasMore` is true; a page without them refuses the report rather than being taken for a closed last page. A ledger date Vipps MobilePay has not closed yet (`tryLater`) is listed in `openDates`, and `complete` is `false`; every page it has so far is still read. A date that has not begun is not requested, since Vipps MobilePay refuses a ledger date more than 24 hours ahead, and is listed in `futureDates`, apart from the open dates. `readFrom` and `readTo` are the first and last date actually read, `complete` is `false` when any date is open or was not read, and `note` says in words what the answer lacks; the gateway's result text carries the same sentence. A period that lies entirely in the future makes no request and says that the period has not begun: `get_funds_summary` then returns `period: null`, not sums of zero.

Vipps MobilePay documents that a ledger date runs from midnight to midnight in the sales unit's time zone, and that a ledger date more than 24 hours in the future is refused; it does not document which clock the 24 hours follow. The server does not know the sales unit's time zone, so it requests a date from the moment it has begun in the market furthest ahead (Finland, `Europe/Helsinki`). For a sales unit in Denmark, Norway or Sweden that is one hour before its own midnight, so its own day is always read and no request is more than two hours early, far inside the 24 hours by any clock. A refusal of a date that was requested is returned as an error; none is taken to mean that the date has not come.

**Data, not instructions.** Results from Vipps MobilePay are labelled as data: references, texts and metadata are written by merchants, integrations and customers. The Report API is called without `includeGDPRSensitiveData`, so customer names, messages and phone numbers are not requested.

**Personal data in results.** The known personal fields of the payer and the subscriber are left out: `userDetails` (name, phone, e-mail), `shippingDetails` (address), `profile.sub`, `userinfoUrl`, phone numbers and the card number prefix. Payments, events, agreements, a charge read by its id, order details, sales units, QR codes and the answers to a capture, a refund and a cancellation pass through a typed allow-list (`src/vipps/views.ts`), so a field Vipps MobilePay adds later is left out until it is listed. This does not make the results free of personal data: a payment reference, a product name or a description is text the merchant or an integration chose, and it can hold a name or another personal detail. Treat results as data that may contain personal data.

## Keys and authentication

The server uses the Access Token API (`POST /accesstoken/get`, standard authentication) with these headers, and sends the token as `Authorization: Bearer` together with the subscription key and MSN on every API call:

- `client_id`, `client_secret`, `Ocp-Apim-Subscription-Key`: from the business portal ([portal.vippsmobilepay.com](https://portal.vippsmobilepay.com/)), *Developer* section, for the sales unit.
- `Merchant-Serial-Number`: the sales unit's MSN.
- `Vipps-System-Name: mcp-server-vippsmobilepay`, `Vipps-System-Version: <package version>`, and, when an embedding host gives them, `Vipps-System-Plugin-Name` and `Vipps-System-Plugin-Version`.

The token is kept until five minutes before it expires (Vipps MobilePay: one hour in test, 24 hours in production) and shared by concurrent calls. A call answered with 401 gets a new token and is sent once more (a write with the same `Idempotency-Key`); a second 401 is reported.

**Environments.** `test` uses `https://apitest.vipps.no` with the test keys; `production` uses `https://api.vipps.no`. The keys are never sent to another host (a loopback URL is allowed for a local mock).

**Partner keys.** Set `VIPPS_KEY_TYPE=partner` (gateway: `keyType: 'partner'`) to use a partner's `client_id`, `client_secret` and subscription key with the merchant's MSN, which is then required. Vipps MobilePay documents partner keys for the main APIs and the Management API, in production only, and not for the Report API; with partner keys the three report tools are not offered, and neither is `list_sales_units`, which would list the sales units of every merchant of the partner. Accounting keys are described below.

## Accounting keys

An accounting partner approved by Vipps MobilePay has one set of accounting keys: a client id and a client secret, nothing else. With them the partner reads the [Report API](https://developer.vippsmobilepay.com/docs/APIs/report-api/) and the [Sales API](https://developer.vippsmobilepay.com/docs/APIs/sales-api/) for every sales unit whose business has given the partner access in the business portal. The keys exist in production only.

```ts
const gateway = createVippsMobilePayGateway({
  clientId: partner.clientId,
  clientSecret: partner.clientSecret,
  keyType: 'accounting',
  environment: 'production',
  policy: { audit: record => log(record) },
});

// Every call names the organisation the caller may see, as the Report API names an owner.
const result = await gateway.callTool('list_sales', { ledgerId: '302321', ledgerDate: '2026-11-03' }, {
  caller: 'user-17',
  owner: { scheme: 'business:DK:CVR', id: company.confirmedCvr },
});
```

- **Only the gateway.** Accounting keys are taken from the host only, never from `VIPPS_*` variables, and the stdio and HTTP servers refuse them: an MCP call names no organisation. A `subscriptionKey` or `merchantSerialNumber` given with them is refused, and so is the test environment.
- **Token.** `POST /miami/v1/token` with `Authorization: Basic base64(clientId:clientSecret)` and the form body `grant_type=client_credentials`. No `Ocp-Apim-Subscription-Key` and no `Merchant-Serial-Number` is sent on any request. The token is the partner's, kept until five minutes before it expires and shared by every call of the instance. The Basic form of the keys is a secret of the instance, like the keys themselves.
- **Tools.** `check_connection`, `list_ledgers`, `get_funds_summary`, `list_transactions`, `list_sales` and `get_sale`. Every other tool is left out of `tools` and refused before anything is sent. The fixed list of requests for these keys holds five GET requests and nothing else: the ledger list, the funds and fees ledgers of a date, and the sales of a ledger by date, by `reference` and by `pspReference`.

**The owner binding.** The token reads every business that has given the partner access, so it says nothing about whose data a call may see. The host does, in `context.owner`: a scheme of the form `business:<country>:<register>` and the number under it, for example the company's confirmed CVR number. The binding (`src/vipps/owner-binding.ts`) works like this:

1. A call without an owner, or with one in another form, is refused before anything is sent, the token request included. The two texts are taken exactly as given: nothing is trimmed or folded.
2. For every call the whole ledger list is read before anything else: every page, ending on an empty cursor, or on an empty page that gives back the cursor it was asked with. A page with ledgers under a cursor that does not move, a page in another form, and a list that does not end within 200 pages refuse the call: a part of the list is never taken for the whole.
3. A ledger is the organisation's only when its `owner` has exactly that scheme and exactly that id. The same number under another scheme is another organisation. A ledger whose owner cannot be read, or whose sales unit names another organisation than its owner, is nobody's: it is left out and counted, and the answer says the list may lack ledgers (`ledgersNotAttributed`). A ledger of the organisation in another form than the specification refuses the whole list.
4. A report or sales request is sent only for a ledger in that set. Any other ledger id is refused with one fixed text, whether it belongs to another organisation or does not exist, and nothing is asked for it. A ledger id, MSN or number from the caller is never proof of anything.
5. Nothing is kept between calls. The set is read anew for each call and lives only in that call's view of the client; the client, with the token, is shared and never learns an owner or a ledger. No answer is cached. A ledger the organisation stops owning is not readable at the next call.

**What is passed on.** Every answer read with accounting keys passes a typed allow-list that is read strictly: an unknown field is left out, and a known field in another type, or a missing field the specification requires, refuses the whole answer; no list item is ever an empty object. `payoutBankAccount` is never passed on, in whole or in part. Ledger entries leave out the payer's name, message and phone number; sales leave out `customer` and `completeness.hasCustomerIdentity`. VAT rates are in hundredths of a percent (2500 is 25 %), amounts in minor units.

**Connection check.** With accounting keys `check_connection` reads the ledger list. It is connected (`{ connected: true, outcome: 'connected', ledgers }`) only when at least one ledger of the call's organisation is visible. Otherwise the error result carries `structuredContent: { connected: false, outcome }`, with `outcome` one of `no_ledger_for_owner` (the keys work, and the business has not given access, or has given it for another organisation), `keys_refused` (the token request answered 400, 401 or 403, or the ledger list 401 or 403), `unavailable` (anything else) and `owner_missing` (the host named no organisation).

**Ledger dates of sales.** `list_sales` refuses a date that has not begun. The Sales API does not say when a ledger date is closed, so for the two newest dates `complete` is `false` and `note` says that more sales can come.

**Observed in production** (25 November 2026, one token request and one read of the ledger list; only statuses, content types, field names, types and lengths were recorded):

- `POST https://api.vipps.no/miami/v1/token` with Basic credentials, the form body `grant_type=client_credentials` and no subscription key or MSN answered HTTP 200 `application/json` with exactly `access_token` (a text in three dot-separated parts, about 640 characters), `expires_in` (the number 900) and `token_type` (`Bearer`).
- `GET https://api.vipps.no/settlement/v1/ledgers` answered HTTP 200 `application/json` with exactly `{"cursor":"","items":[]}`: no business had given access yet.

The test environment has neither. Everything else is from the specifications (Report 2.0, Sales 1.0).

**Not verified:**

- a ledger in the list: the form of `owner`, `salesUnits` and `businessIdentifier`, and whether the owner of a Danish company is written `business:DK:CVR`;
- a list with more than one page, and whether the last page always has an empty cursor;
- any answer of the Report API funds or fees ledgers with accounting keys;
- any answer of the Sales API, its paging (`cursor` and `hasMore`), and whether `customer` is always empty as documented;
- how a request for a ledger the partner may not read is answered;
- a token request refused for wrong keys (400, 401 or 403), and throttling;
- the lifetime of a token beyond the one `expires_in` observed.

## Quick start

Requires Node.js 22 or later and the sales unit's keys.

```bash
npx mcp-server-vippsmobilepay
```

Claude Code:

```bash
claude mcp add vippsmobilepay \
  --env VIPPS_CLIENT_ID=<client_id> --env VIPPS_CLIENT_SECRET=<client_secret> \
  --env VIPPS_SUBSCRIPTION_KEY=<subscription key> --env VIPPS_MERCHANT_SERIAL_NUMBER=<msn> \
  --env VIPPS_ENVIRONMENT=test \
  -- npx -y mcp-server-vippsmobilepay
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "vippsmobilepay": {
      "command": "npx",
      "args": ["-y", "mcp-server-vippsmobilepay"],
      "env": {
        "VIPPS_CLIENT_ID": "<client_id>",
        "VIPPS_CLIENT_SECRET": "<client_secret>",
        "VIPPS_SUBSCRIPTION_KEY": "<subscription key>",
        "VIPPS_MERCHANT_SERIAL_NUMBER": "<msn>",
        "VIPPS_ENVIRONMENT": "test"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-vippsmobilepay`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name vippsmobilepay-mcp -p 127.0.0.1:3000:3000 \
  -e VIPPS_CLIENT_ID=<client_id> -e VIPPS_CLIENT_SECRET=<client_secret> \
  -e VIPPS_SUBSCRIPTION_KEY=<subscription key> -e VIPPS_MERCHANT_SERIAL_NUMBER=<msn> \
  -e VIPPS_ENVIRONMENT=test \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-vippsmobilepay:latest

claude mcp add --transport http vippsmobilepay http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `VIPPS_AUDIT_LOG` into it (e.g. `-v vippsmobilepay-audit:/audit -e VIPPS_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Vipps MobilePay

| Variable | Default | Description |
|---|---|---|
| `VIPPS_CLIENT_ID` | – | **Required.** `client_id`. |
| `VIPPS_CLIENT_SECRET` | – | **Required.** `client_secret`. |
| `VIPPS_SUBSCRIPTION_KEY` | – | **Required.** `Ocp-Apim-Subscription-Key`. |
| `VIPPS_MERCHANT_SERIAL_NUMBER` | – | The sales unit's MSN (4-10 digits). Required with partner keys; recommended always (the Report API needs it with the merchant's own keys). |
| `VIPPS_ENVIRONMENT` | `test` | `test` or `production`. |
| `VIPPS_KEY_TYPE` | `merchant` | `merchant` or `partner` (production only). |
| `VIPPS_BASE_URL` | from the environment | Override for a local mock: a loopback URL, or `api.vipps.no` / `apitest.vipps.no` over https. |
| `VIPPS_ALLOW_CUSTOM_BASE_URL` | `false` | Allow another https host. |
| `VIPPS_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `VIPPS_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `VIPPS_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `VIPPS_ENABLE_WRITES` | `false` | Enable the write tools. |
| `VIPPS_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `vipps_` prefix. |
| `VIPPS_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ledger ids, dates, amounts and currency in clear text, payment references, agreement and charge ids and idempotency keys as `sha256:` pseudonyms, a description hashed (a refund's with SHA-256, a payment request's with a keyed hash that cannot be tested against a guess without the client secret), the delivery and deadline of a payment request in clear text (never its phone number, return address or order lines), duration, status, and the caller passed by an embedding host as a pseudonym only (`hmac:` and 16 hex characters with a random key per process). The request id is the server's own. A call rejected before it runs (an unknown tool or invalid input) is recorded with a fixed reason, the tool as `unknown_tool` when it does not exist, and of the input only the field names the tool's schema has, plus a count of the others. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP, one instance per merchant:

```ts
import { createVippsMobilePayGateway, resolveVippsChange, vippsToolCatalog } from 'mcp-server-vippsmobilepay/gateway';

const gateway = createVippsMobilePayGateway({
  clientId: merchant.clientId,
  clientSecret: merchant.clientSecret,
  subscriptionKey: merchant.subscriptionKey,
  merchantSerialNumber: merchant.msn,
  environment: 'production',
  keyType: 'merchant',
  systemPluginName: 'acme-host',
  policy: { enableWrites: true, allowedTools: ['get_payment', 'refund_payment'], audit: record => log(record) },
});

// The host chooses the operation key, stores it with the pending change, and reuses it on every retry.
const input = { reference: 'acme-order-10042', amount: 12550, currency: 'DKK', idempotencyKey: crypto.randomUUID() };

// Before a write: what it will change, for the host's log and a person's confirmation.
const change = resolveVippsChange('refund_payment', input, { pseudonymKey: hostSecret });
// → { ok: true, change: { tool: 'refund_payment', action: 'refund', record: 'payment', movesMoney: true,
//      values: { reference: 'hmac:3f9c…', amount: 12550, currency: 'DKK', idempotencyKey: 'hmac:81ad…' } } }

const result = await gateway.callTool('refund_payment', input, { caller: 'user-17' });
// result.structuredContent.idempotencyKey === input.idempotencyKey
```

- **Explicit credentials.** `clientId`, `clientSecret`, `subscriptionKey`, `merchantSerialNumber` and `environment` are required (with accounting keys: `clientId`, `clientSecret` and `environment: 'production'` only); a missing value throws when the gateway is created. A gateway never reads `VIPPS_*` credentials from the environment. Each key must be printable ASCII of at least 16 characters (see key admission below).
- **Host policy.** `policy` takes `enableWrites` (default false), `disabledTools`, `allowedTools` (an allow-list: when given, only these tools are offered, reads included; it must name known tools and must not be empty) and `audit`, a function that receives each audit record (a write does not run if the sink throws on its start record). Unknown tool names and malformed values throw at creation. An instance with `policy` reads none of `VIPPS_ENABLE_WRITES`, `VIPPS_DISABLED_TOOLS`, `VIPPS_AUDIT_LOG` or `VIPPS_ALLOW_CUSTOM_BASE_URL`.
- **What no policy turns on.** Requests outside the fixed list in `src/vipps/client.ts`: changing an agreement (price, interval, status), merchant or sales unit settings or keys, creating charges, capturing a Recurring charge, creating, changing or deleting a QR code, adding or changing a receipt, category or image, ordering a product, reading another merchant, and any other DELETE.
- **Tool catalog.** `vippsToolCatalog` is a frozen list of every tool: `name` (without the `vipps_` prefix), `title`, `description`, `riskLevel` (`read` or `write`; no tool is `destructive`, as none deletes or overwrites anything), `enabledByDefault` (false for every write), `inputSchema` (JSON Schema), `upstream` (the API requests the tool may make), `broad` (false for all), `keyTypes`, `environments` (`test` and `production`; the two sales unit tools work in production only), `requiresConfirmation` (true for every write: a host should have a person confirm the call outside the chat) and, for write tools, `change`: `action` (`create`, `capture`, `refund`, `cancel`), `record` (`payment` or `charge`), `movesMoney` (true when the call itself moves or releases money; false for `create_payment`, which only asks the customer to pay) and `logFields`, each with the one type its value must have:

  | Type | Fields | Value |
  |---|---|---|
  | `amountMinor` | `amount` | in clear: a whole number of minor units, 1 to 65 000 000 |
  | `currency` | `currency` | in clear: `NOK`, `DKK` or `EUR` |
  | `flag` | `cancelTransactionOnly` | in clear: true or false |
  | `delivery` | `delivery` | in clear: `link`, `qr` or `phone` (never the phone number) |
  | `pseudonym` | `reference`, `agreementId`, `chargeId`, `idempotencyKey` | never in clear: `hmac:` and 16 hex characters of HMAC-SHA-256 with the host's `pseudonymKey`, or `sha256:` and 16 hex characters of SHA-256 without one |

  The identifiers are pseudonyms because the caller chooses them: a reference may be any text of the allowed characters, a person's name among them. The same identifier always gets the same pseudonym, so log lines can be matched; give a `pseudonymKey` (a secret of the host) so that a guessable reference such as an order number cannot be found from its hash. Names, phone numbers and free text are never log fields (a `description` is sent to Vipps MobilePay and only hashed in the audit log). `resolveVippsChange(tool, input, { pseudonymKey })` validates the input as `callTool` does, the operation key included, and returns the values.
- **For a host that logs and confirms changes.** Create the operation key when the change is drafted, keep it with the draft and in the log before the call, and call the tool with that same key when the person approves it and on every retry. `create_payment` needs no key from the host: repeat it with the same input. Log `resolveVippsChange(...).change.values`, never the raw input. Pass the `link` or `qrCode` of a result on as it is: it holds the customer's token for that one payment, and a host that masks token-shaped text would leave a link that opens nothing.
- **Call context.** `callTool(name, input, { caller, requestId })`: the audit writes `caller` only as a pseudonym (`hmac:` and 16 hex characters, with a key that is random per process, so the same caller can be followed within one process and not across restarts). The host's `requestId` is accepted and not written; each call gets the server's own request id, shared by its start, finish and error records. With accounting keys the context also carries `owner` (see [Accounting keys](#accounting-keys)); it is not written to the audit.
- **Failure metadata.** An error result has only its text, and, when Vipps MobilePay (the API or the Access Token API) answered with an HTTP error, `failure: { httpStatus, requestId? }`: the status, and the vendor's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. A host can count failures from it without reading their text. Never the response body, the vendor's error code or message.
- **Several merchants in one process.** Each instance keeps its own access token and redacts with its own keys; nothing is kept in process-wide state.

## Threat model

**Scope.** The guarantees apply to the embeddable gateway. The standalone MCP server, configured from the environment for one merchant, keeps best-effort redaction.

**Secrets.** `client_id`, `client_secret` and the subscription key are the instance's keys; the access token becomes a secret of the instance when it is issued. The MSN is not secret.

**Guaranteed:**

- **(a) No key reaches anything persisted or shared:** audit sinks and the audit log file, logs, error texts. Everything a gateway instance returns is redacted with the instance's own keys (the keys and every piece of them of 6 characters or more; the access token as a whole) and then checked at the sink: an output that still holds a piece of a key is replaced by a fixed fallback.
- **(b) No vendor-controlled free text in errors.** An error carries our own text, the HTTP status and a parsed Retry-After; never a response body, a vendor message or code, or a redirect's `Location`.
- **(c) Results go only to the merchant whose keys they are.** One gateway instance per merchant; every call runs in a scope of its own. With accounting keys one instance serves many organisations, and a call's results come only from ledgers owned by the organisation the host names for that call (see [Accounting keys](#accounting-keys)).

**The customer's link.** The `link` or `qrCode` of a payment request is the one text of Vipps MobilePay passed on with a token in it: the address the customer opens, which is what the request exists to hand over. It is passed on only as an https address of URL characters (no spaces, so no sentence), without a user name or password and at most 4 096 characters; anything else is left out. The masking of token-shaped text is set aside for it, since the customer's token has that shape; the check at the sink is not, so a link that holds a piece of a key or the access token withholds the whole result.

**Not guaranteed:** a vendor that echoes a key back otherwise transformed (split into pieces shorter than 6 characters, re-encoded). Such data reaches only the merchant whose key it is. The access token is redacted only as a whole, since pieces of a JWT are common in other base64 text such as report cursors.

**Key admission.** A gateway accepts only keys of printable ASCII of at least 16 characters that share no piece of 6 characters with this server's own texts; the refusal never repeats the key.

## Security model

- **One identity per instance.** Every caller acts with the rights of the configured keys. Per-user authorization belongs to the host or a gateway in front of the server.
- **Writes are off by default.** They are not annotated destructive (each adds a payment request, a capture, a refund or a cancellation and deletes nothing), but a capture, refund or cancellation moves or releases money and cannot be undone, and a payment request reaches a customer: `requiresConfirmation` is true for every write, and a host should have a person confirm each call outside the chat. Read-only tools get a client that refuses POST and DELETE. When an audit log or sink is configured, a write does not run unless its start record is written.
- **The keys stay on the Vipps MobilePay hosts.** Redirects are never followed, and the base URL must be `api.vipps.no` or `apitest.vipps.no` over https (or loopback).
- **The HTTP transport fails closed**: token required off loopback, constant-time comparison, throttled failures, `Origin` and `Host` checks, capped bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Verified and not verified against Vipps MobilePay

The client follows the published OpenAPI specifications (Access Token 2.0.0, Report 2.0, ePayment 1.8.5, Recurring 3.2.3, Order Management 2.1, Management 2.0.10, QR 1.0) and is tested against mocked HTTP.

**Observed in the test environment** (25 November 2026, one payment request of 100 minor units in DKK as a link, created with `metadata` and read back; only statuses, field names and yes or no were recorded, never a value):

- `POST /epayment/v1/payments` answered HTTP 201 with `redirectUrl` and `reference`.
- `GET /epayment/v1/payments/{reference}`, at once and three seconds later, answered HTTP 200 with `aggregate`, `amount`, `metadata`, `paymentMethod.type`, `profile` (empty), `pspReference`, `redirectUrl`, `reference` and `state`. The `metadata` given at the creation came back unchanged, which is what the proof in `create_payment` rests on. `state` was a text (`CREATED`), and the payment method `WALLET`.
- The events of the payment were one `CREATED` event, and it held the `Idempotency-Key` of the create request. `get_payment` does not pass that key on.
- The identical request again under the same key was answered with HTTP 201 and the same `redirectUrl`: the first answer again.
- The same reference under another key, with the same content and with another amount, was refused with HTTP 409 (`application/problem+json`).
- A reference that no payment has was answered with HTTP 404.
- The link was an https address with no path and one query parameter, `token`, in the form of a JSON Web Token, 866 characters in all, and the `redirectUrl` read back was the same as the one in the answer to the create request.

**Observed in the test environment for the reads** (25 November 2026, reads only, with nothing stored on the test sales unit; only statuses, content types, field names and counts were recorded):

- `GET /qr/v1/merchant-redirect` answered HTTP 400 with `Accept: application/json`, and HTTP 200 with an empty JSON list for `image/svg+xml`, `image/png`, `image/*` and `text/targetUrl`. `list_qr_codes` asks with `image/svg+xml`.
- `GET /qr/v1/merchant-callback` answered HTTP 200 with an empty JSON list.
- `GET /order-management/v2/ECOM/{orderId}` and `.../RECURRING/{orderId}` answered HTTP 404 (`application/problem+json`) for an id nothing is stored with.
- `GET /recurring/v3/charges/{chargeId}` answered HTTP 404 (`application/problem+json`) for an id no charge has.
- `GET /management/v1/sales-units` and `GET /management/v1/sales-units/{msn}` answered HTTP 401, with keys that the other requests accepted.

**Not tried:**

- an answer with content from any of the five reads: a charge found by its id, stored order details, a sales unit and a QR code were not there to read, so their fields are taken from the specifications;
- the Management API in production, with the merchant's own keys and with partner keys;
- HTTP 409 (`ambiguous-charge-id`) from `GET /recurring/v3/charges/{chargeId}`;

- production, where none of the above has been observed;
- a QR code (`QR`), a request to a phone number (`PUSH_MESSAGE`, on an approved sales unit), and a request with `expiresAt` on a sales unit that has it enabled;
- for how long an `Idempotency-Key` is remembered, and what the same request is answered with after that (`create_payment` handles a refusal with HTTP 400 as well as 409);
- a `state` written as a list. The specification types it as a text and its example shows a list with one state (`["AUTHORIZED"]`); the test environment answered with a text. A list with exactly one documented state is read as that state, and any other form is no state (`test/payment-state.test.ts`);
- the paging of `GET /recurring/v3/agreements` with `pageNumber` and `pageSize`, and `Continuation-Token` on the charge list;
- an `Idempotency-Key` on `POST .../cancel` (the ePayment specification does not list it for cancel);
- partner keys (production only, so they cannot be tried in the test environment);
- the Report API with the merchant's own keys for every kind of sales unit.

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

| Path | Contents |
|---|---|
| `src/tools/vipps.ts` | Shared tool table (MCP and gateway), log field types, policy and audit wrapper. |
| `src/vipps/client.ts` | Access token, headers, retries, the fixed list of allowed requests. |
| `src/vipps/reports.ts`, `payments.ts`, `payment-requests.ts`, `recurring.ts`, `order-details.ts`, `sales-units.ts`, `qr-codes.ts` | API calls and paging. |
| `src/vipps/views.ts` | The typed allow-lists every answer passes. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/transports/` | stdio and HTTP entry points. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` publishes to npm through trusted publishing and `server.json` to the MCP Registry; `publish.yml` pushes the `vX.Y.Z` image. The first version of the package is published by hand (see the header of `.github/workflows/release.yml`).

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.3.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
