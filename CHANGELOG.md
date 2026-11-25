# Changelog

## Unreleased: reads

- Five new read tools. `find_charge`: one Recurring charge by its own id,
  when the agreement is not known. `get_receipt`: the order lines with VAT,
  the bottom line and the category stored with a payment or a Recurring
  charge (Order Management API). `list_sales_units` and `get_sales_unit`: the
  sales units the keys can read, and what Vipps MobilePay has enabled for the
  one the keys are used for (Management API). `list_qr_codes`: the sales
  unit's fixed QR codes, of both kinds (QR API).
- Seven GET requests are added to the fixed list of requests, and nothing
  else: no request that creates or changes a QR code, a receipt, a category,
  an image, a product order or a sales unit can be sent.
- Gateway catalog: every entry has `environments`. The two sales unit tools
  have `['production']`: Vipps MobilePay has no Management API in the test
  environment, where they are left out of the offered tools and refused
  before anything is sent. `list_sales_units` is for the merchant's own keys
  only; with partner keys it would list the sales units of every merchant of
  the partner.
- Every answer of the new tools passes a typed allow-list. A list in an
  answer is passed on whole or not at all: one order line, event or QR code
  in another form fails the call.
- The address of a QR code's image is passed on whole, as the link of a
  payment request is: it carries a token in the form of a JSON Web Token,
  which the redaction would otherwise mask. A host should treat it as answer
  data and not log it.
- `find_charge` leaves an operation key out of a charge's history when it has
  the form this server makes from a request's content. `get_charge` and
  `list_charges` are unchanged and pass the charge on as it comes.
- Not added: each sale with its lines and VAT. The Sales API takes accounting
  keys only, which this server does not hold (see the README).

## Unreleased: payment requests

- New write tool `create_payment`: ask a customer to pay with an ePayment
  payment request, as a link (`WEB_REDIRECT`), as a QR code (`QR`) or sent to
  the customer's phone number (`PUSH_MESSAGE`, only where Vipps MobilePay has
  approved the sales unit for it), optionally with a deadline of up to 60
  days (`expiresAt`, where Vipps MobilePay has enabled it for the sales unit;
  order lines are then required). Off by default like the other writes, and
  `requiresConfirmation` like them. `POST /epayment/v1/payments` is added to
  the fixed list of requests; nothing else is.
- The request's `Idempotency-Key` is not chosen by the caller: the server
  derives it from the sales unit and the request's own content, so a request
  repeated after a failure or a lost answer is created once and cannot be
  repeated under a new key. A second value from the same content, the
  fingerprint, is sent as `metadata.requestFingerprint`. Both are keyed
  hashes (HMAC-SHA-256) with keys derived from the client secret, so neither
  can be made or tested against a guess of the content without it; after the
  client secret is replaced, a request made before is no longer recognised
  and is answered as a conflict. Neither value is in an answer, an error or
  the audit.
- A payment read back is taken for the request, and its state or link passed
  on, only when it is proven to be the same request: reference, amount,
  currency, payment method and fingerprint. A payment that is read and not
  proven is a refusal with nothing of it, whether Vipps MobilePay accepted or
  refused the create request. When the payment cannot be read at all after an
  accepted request, the answer has no state and the address of the
  acceptance. The README has the tables of every branch and of what a second
  call is answered with.
- `get_payment`: an event passes on its `idempotencyKey` only when it is a
  capture, a refund or a cancellation, whose key the caller chose. The key of
  the request that created the payment is not passed on.
- `capture_payment`, `refund_payment` and `cancel_payment`: what Vipps
  MobilePay answers the change with passes the same allow-list as a payment
  that is read (reference, pspReference, state, amount, aggregate, payment
  method). The specification's answer holds nothing else; a field outside the
  list was passed on before and is now left out.
- No refusal depends on the clock: whether a deadline is too near or too far
  is for Vipps MobilePay to refuse, so an identical call made later is still
  sent. In NOK a request with a deadline needs `productUrl` on every order
  line.
- Gateway catalog: `change.action` can be `create`, `change.movesMoney` is a
  boolean (false for `create_payment`, true for the others as before), and
  there is a log field type `delivery` (`link`, `qr` or `phone`, in clear).
  A host that has typed `movesMoney` as `true` must widen it.
- The customer's link in a result is passed on whole. It carries a token in
  the form of a JSON Web Token, which the redaction would otherwise mask; the
  check that withholds a result holding a piece of the instance's keys still
  applies to it.
- The audit logs the description of a payment request as `descriptionHmac`,
  a keyed hash that cannot be tested against a guess without the client
  secret. A refund's description is still logged as `descriptionSha256`.
- The state of a payment is read as a text, as the specification types it and
  as the test environment answers. A list with exactly one documented state,
  as the specification's example writes it, is read as that state; any other
  form is no state. This holds for `get_payment`, for the check before a
  capture, for the answer to a capture, a refund and a cancellation, and for
  `create_payment`.
- The input and the operation of the capture, refund and cancel tools are
  unchanged, their caller-chosen `idempotencyKey` included. Their answers are
  filtered, as said above.

## 0.5.0

The answers of `list_transactions` and `get_funds_summary` change shape, which
is why this is 0.5.0: a consumer that reads `openDates` or `period` must be
updated. `openDates` no longer holds dates that were not read (they are in
`futureDates`), and `period` is `null` when no date was read. The details are
in the second entry.

- `list_transactions` and `get_funds_summary` read every page of a ledger date
  that Vipps MobilePay has not closed yet. A page that said `tryLater` used to
  end the date, also when it said `hasMore`, so an open date with more than
  one page of entries came back with only the first page. The date is still
  named in `openDates`, and `complete` is still `false`.
- `list_transactions` and `get_funds_summary` no longer fail for a period that
  reaches past today, such as the current month. Vipps MobilePay answers HTTP
  400 for a ledger date more than 24 hours ahead, which made the whole call
  fail. A date is requested only when it has begun in the market furthest
  ahead (Finland's time zone), so no request is ever more than two hours
  early for any sales unit, and a sales unit's own day is read from its own
  midnight. A refusal of a date that was requested is an error, as is every
  failure to get access. The days that have been are returned, and the answer
  says that it is cut:
  - `futureDates` lists the dates that were not requested because they have
    not begun. They are no longer mixed into `openDates`, which holds only
    dates that were read and are not closed.
  - `readFrom` and `readTo` are the first and last date actually read (`null`
    when none was); `fromDate` and `toDate` are still the period asked for.
  - `complete` is `false` when any date is open or was not read.
  - `note` says in words what the answer lacks and why, and the gateway's
    result text carries the same sentence, so a reader of the text alone
    cannot take a part of the period for the whole.
  - A period that lies entirely in the future makes no request and says that
    the period has not begun. `get_funds_summary` then returns `period: null`
    and no days instead of sums of zero, and its `days` never holds a date
    that was not read.

## 0.4.0

- The write tools (capture, refund and cancel of payments and charges) are no
  longer annotated `destructiveHint: true`, and their `riskLevel` in the
  gateway catalog is `write` (was `destructive`): each adds an operation to a
  payment or charge and deletes or overwrites nothing. They still move or
  release money and cannot be undone, which `requiresConfirmation` and
  `change.movesMoney` say: a host should have a person confirm each call
  outside the chat. Writes stay off by default. Nothing else changes.

## 0.3.1

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.3.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error, the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`: the common request-id headers), kept only
  when it is a hex id of 8 to 64 characters (one run of hex digits,
  or groups of four or more joined by single hyphens, as in a UUID) and does not hold the
  shape of a personal number. It is checked again after redaction, so an id
  that shared a piece with the key is dropped. Never the body, the vendor's
  error code or message. The shared helpers are in `src/errors.ts`
  (`vendorRequestId`, `requestIdFrom`, `failureMetadata`). An HTTP error
  from the Access Token API counts too, and so does a failed read of the
  events when a capture or refund is then refused (the HTTP error is the
  refusal's cause; nothing is sent).

- The audit writes the caller only as a pseudonym (`hmac:` and 16 hex characters, random key per process) and never the host's request id: every call gets the server's own.
- A rejected call (unknown tool or invalid input) logs nothing the caller wrote as text: an unknown tool is `unknown_tool`, the reason is fixed (`unsupported tool`, `invalid input`), and of the input only the field names in the tool's schema are kept, with a count of the others.
- Keys are also redacted in their base64 and base64url forms, alone and as the start of a Basic credential. `bearer` and `basic` values in any case (8 or more token characters) and JSON Web Tokens are masked in every text, as in `mcp-server-pleo`. Such a value is replaced whole, `=` and `==` padding included (only the scheme word is kept); it is never split at a separator. Credential-shaped text is masked before the known keys, and again after, until nothing changes, so a known key inside a Basic value, a Bearer token or a JWT cannot leave the rest of the value behind. A scheme word before a value that holds the marker is masked with the whole value, whatever the length of the tail.
- README: results pass on no known personal field of the payer or the subscriber, but texts the merchant chose (a reference, a product name) can still hold personal data. The 0.1.2 entry below said "no personal data"; that holds for the fields named there, not for such texts.
- Tests for agreement answers that are not agreements (single and list) and for events answers in every malformed form.

## 0.1.2

- No personal data of the payer or the subscriber: `get_payment` passes on only the payment's references, state, amounts and the payment method's type, and each event's references, name, amount, time, key and outcome. `userDetails` (name, phone, e-mail), `shippingDetails` (address), `profile.sub` and the card number prefix are left out. `get_agreement` and `list_agreements` pass on only the agreement's terms and state, never `sub`, `userinfoUrl` or a phone number. A deep allow-list with a type for every field on every level (src/vipps/views.ts): a nested object passes only through its own list, so personal data placed inside an allowed field (`amount.userDetails`, `pricing.userDetails`, `campaign.userinfoUrl`) is left out too, and a field Vipps MobilePay adds later is left out until it is added there. A payment answer without a reference and a state, or an agreement without an id, is refused with a fixed text instead of returned empty. An events answer that is not a list of events becomes a fixed error text; an `error` text in Vipps MobilePay's own answer is never passed on.

## 0.1.1

- A retry with the same `idempotencyKey` after a lost answer is no longer refused by our own check. When a capture or refund (ePayment) or a charge refund or cancellation (Recurring) would be refused because the amount or status no longer allows it, the payment's events or the charge's history are looked up: a successful event with the same key (and, for money, the same amount and currency) is returned with `alreadyDone: true`, and nothing is sent. Otherwise the change is refused as before. When the events cannot be read, it is refused as before.

## 0.1.0

First version, built from the MCP server template.

- Authentication with the Access Token API (`POST /accesstoken/get`): `client_id`, `client_secret`, `Ocp-Apim-Subscription-Key`, `Merchant-Serial-Number` and the `Vipps-System-*` headers. The token is cached until five minutes before it expires, shared by concurrent calls, and renewed once on a 401.
- Test (`apitest.vipps.no`) and production (`api.vipps.no`) environments; the keys are sent to no other host.
- Merchant keys and partner keys (production only, with the merchant's MSN; without the Report API tools).
- Read tools: `check_connection`, `list_ledgers`, `get_funds_summary`, `list_transactions` (Report API), `get_payment` with events (ePayment), `list_agreements`, `get_agreement`, `list_charges`, `get_charge` (Recurring). Lists are read to their end or refused at a fixed cap, never cut short; open ledger dates are named.
- Write tools, off by default, `destructive`, needing a person's confirmation: `capture_payment`, `refund_payment`, `cancel_payment`, `refund_charge`, `cancel_charge`. Capture and refund check the currency and the amount left against the payment or charge before anything is sent.
- A fixed list of allowed requests in the client: nothing can change an agreement, merchant or sales unit settings, or create a payment or a charge.
- Every write needs an operation key (`idempotencyKey`), chosen and logged by the caller and reused on a retry; it is sent as `Idempotency-Key` and returned in the result. The server never makes one up.
- Identifiers the caller chooses (reference, agreement and charge id, idempotency key) appear in change values and audit records only as pseudonyms (`hmac:` with the host's key, or `sha256:`).
- MCP results get the same redaction and final leak check as gateway results.
- Upstream amounts and currency are validated (safe, non-negative integers that add up; NOK, DKK or EUR) before a capture or refund, with fixed refusal texts.
- The fixed request list is checked on the final URL as well; dot segments and encoded separators are refused.
- `./gateway`: `createVippsMobilePayGateway` with explicit keys per merchant, host policy (`enableWrites`, `disabledTools`, `allowedTools`, `audit`), `vippsToolCatalog` with `keyTypes`, `requiresConfirmation` and `change` (`action`, `record`, `movesMoney`, typed `logFields`), and `resolveVippsChange`.
