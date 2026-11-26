# Changelog

## 0.10.0

### Accounting keys

- A third key type, `keyType: 'accounting'`, for an accounting partner
  approved by Vipps MobilePay: a client id and a client secret only, in
  production only, and through the gateway only (the stdio and HTTP servers
  refuse them, and `VIPPS_KEY_TYPE` cannot name them). The token comes from
  `POST /miami/v1/token` with Basic credentials and
  `grant_type=client_credentials`; no subscription key and no MSN is sent.
- Two new read tools for the Sales API, with accounting keys only:
  `list_sales` (every sale of a ledger date) and `get_sale` (one sale by
  `reference` or `pspReference`), each with order lines and VAT. The Report
  tools work with accounting keys too; every other tool is left out of
  `tools` and refused before anything is sent.
- The owner binding: every call with accounting keys must carry
  `context.owner` (a scheme such as `business:DK:CVR` and a number). The
  whole ledger list is read for each call, only ledgers whose `owner`
  matches exactly are kept, and any other ledger id is refused before a
  report or sales request is sent. Nothing about an organisation is kept
  between calls; the token is shared.
- `payoutBankAccount` is never passed on with accounting keys, and the
  customer fields of the Sales API are left out. Every answer read with
  accounting keys passes a strict allow-list.
- `ledgerOwners()`, a host function for the host's operator (never a tool):
  which organisations have given access, as `{ scheme, id, ledgers,
  salesUnits }` per owner and a count of ledgers that name none. Nothing else
  of a ledger is returned. Accounting keys only.
- `check_connection` with accounting keys is connected only when a ledger of
  the call's organisation is visible; otherwise its result carries `outcome`:
  `no_ledger_for_owner`, `keys_refused`, `unavailable` or `owner_missing`.
- The envelope of every page of a funds or fees ledger date is read strictly,
  with every kind of keys: `items` a list, `tryLater` and `hasMore` present
  as booleans, and a non-empty `cursor` when `hasMore` is true. A page that
  lacks one of them, or has one in another type, refuses the report, where
  it used to be read as the last page of a closed date.

### Recurring changes

- Four new Recurring write tools, off by default like every write and
  confirmed (`requiresConfirmation`):
  - `create_charge` creates a charge on an `ACTIVE` agreement
    (`POST /recurring/v3/agreements/{agreementId}/charges`), `DIRECT_CAPTURE`
    or `RESERVE_CAPTURE`, with `due`, `retryDays`, an optional
    `processingMode` and a required `orderId`, the business's own number for
    the charge, which becomes its id and which Vipps MobilePay takes once.
    `change.action` `create`, `record` `charge`, `movesMoney` true.
  - `capture_charge` captures all or part of a reserved charge
    (`POST .../charges/{chargeId}/capture`). It takes `alreadyCaptured`, what
    the charge shows as captured before this capture. `action` `capture`,
    `movesMoney` true.
  - `update_agreement` changes an agreement's product name and description,
    its address for the customer, its fixed price (`price`) or a variable
    price's suggested maximum, or its fixed interval (a unit and a count)
    (`PATCH /recurring/v3/agreements/{agreementId}`), and sends only what
    differs from the agreement. It never sends `status`, and it does not set a
    flexible interval, which cannot be read back from the agreement, so a
    repeat could not see that it was set. `action` `update`,
    `record` `agreement`, `movesMoney` false.
  - `stop_agreement` stops an agreement (the same `PATCH`, with `status`
    `STOPPED` alone). Its description says that it cannot be undone and that
    the AI asks the person first. `action` `stop`, `record` `agreement`,
    `movesMoney` false.
- Each reads the agreement or the charge first and refuses, without sending
  anything, what Vipps MobilePay documents it would refuse (status, currency,
  the currency's amount limits, the kind of price, a variable price's maximum).
- None takes an `idempotencyKey`. For `create_charge`, `capture_charge` and
  `stop_agreement` the key is made from the sales unit, the agreement and the
  request's content with a keyed hash, as for `create_payment` (`charge-`,
  `capture-` or `stop-` and 32 hex characters), so a call repeated after a
  failure or a lost answer is the same request. Since that key changes with
  the client secret, the `orderId` of a charge, the captured amount of a
  charge and the status of an agreement guard against a second change too.
  `update_agreement` gets a new random key (`update-`) for every request, so
  A to B, back to A and to B again is carried out each time. A repeat finds a change already made (a charge by the
  `CREATE` event with its key, a capture by its `CAPTURE` event, an agreement
  that already has what is asked or is stopped) and sends nothing again. The
  key is in no answer, error or audit record, and `get_charge` and
  `list_charges` now leave such a key out of a charge's history, as
  `find_charge` already did.
- Error texts are our own for each change: HTTP 429 and 423 say that nothing
  was done and to call again with the same input after the wait, 408, 5xx, a
  timeout and a lost connection that the outcome is not known, and 400, 404
  and 409 what they can mean for that change. For `update_agreement` they say
  that the agreement is read first and what it has is not sent again, since
  its key is new for every request.
- The fixed request list gains `POST .../charges`, `POST .../capture` and one
  `PATCH /recurring/v3/agreements/{agreementId}`; the client gets `patch`,
  which read-only tools cannot use, and `PATCH` is a method in failure
  metadata and in a catalog entry's `upstream`. `VippsChangeAction` gains
  `update` and `stop`, and `record` (`VippsChangeRecord`) gains `agreement`.
  New log fields: `orderId` (pseudonym), `price` and `suggestedMaxAmount`
  (amounts). The audit adds `due`, `retryDays`, `transactionType`,
  `processingMode`, `alreadyCaptured`, `price` and `suggestedMaxAmount` in
  clear, `orderId` as a pseudonym, a product name and description only as a
  keyed hash, and the field names of an interval; never the agreement's
  address.

## 0.9.0

- Webhook registration for an embedding host: `registerPaymentEvents`,
  `listWebhooks` and `removeWebhook` on a gateway instance, and
  `VIPPS_PAYMENT_EVENTS`. The host registers its own https address for the
  sales unit's ePayment events and gets the registration's id and signing
  secret back, once. Host functions only, never tools. The fixed request list
  gains `GET` and `POST /webhooks/v1/webhooks` and
  `DELETE /webhooks/v1/webhooks/{id}`; an answer that cannot be used is never
  quoted, since it may hold the secret. The answer's `secret` is masked by the
  instance the moment the answer arrives, also when the answer is then
  refused; when `secret` is not one text, every text anywhere in the answer is
  masked, without a cap on count or depth, and the answer is refused. If
  that masking cannot finish, the instance withholds every later host value
  and tool result. The secret is given on only when it shares nothing
  with a secret the instance already knows (its keys, access tokens and earlier
  registration secrets, compared piece by piece for every one of them), or is
  exactly an earlier registration's; an id that
  holds a secret is withheld. The address must be https on a public host
  name: IP literals, single labels, non-default ports, fragments and local or
  internal names are refused before anything is sent (by the name's form,
  without a DNS lookup). Every value a host function returns goes through the
  same redaction and leak check as a tool result. The events are sent sorted,
  so the same set always gives the same request and operation key.

## 0.8.0

- All four `Vipps-System-*` headers are sent on every request, as Vipps
  MobilePay requires of partners and plugins. An embedding host can give its
  own solution as `systemName` and `systemVersion`; the host is then sent as
  the system and the server as the plugin (`Vipps-System-Plugin-Name:
  mcp-server-vippsmobilepay` with the package version). On its own the server
  sends itself as both. A host that gives `systemPluginName` keeps the older
  arrangement, with the server as the system.
- `systemName` is given with `systemVersion`. `systemPluginName` without
  `systemPluginVersion` still works, as before, and sends the plugin version
  `0` (`DEFAULT_PLUGIN_VERSION`); `systemPluginVersion` without
  `systemPluginName` is refused at construction.
- A Vipps-System-* value that shares text with the instance's keys is refused
  at construction, without quoting it: the headers are sent in clear.
- Failure metadata for logging errors as Vipps MobilePay's checklist asks,
  without keeping answers: `failure` on an error result, and the audit's
  error record, now carry the request's `method`, its `pathTemplate` (the
  path from the server's fixed list with every reference, id, date and number
  as a `{name}`, never a query), Vipps MobilePay's `errorCode` (digits only,
  such as ePayment's `6080`) and its `traceId` (ePayment's W3C trace context,
  or Recurring's `contextId` as a UUID), next to `httpStatus` and `requestId`.
  In the audit the vendor's request id is `vendorRequestId`; `requestId`
  stays the server's own, shared by a call's start and error records. The error code and trace id
  are the only values read from an error body, only from JSON of at most
  16 KiB and only in their fixed forms; the vendor's message, title, field
  names and reasons are never read out.

## 0.7.1

- Fix: 0.7.0 refused valid keys. A key is refused when it shares six
  characters with one of the server's own texts, and 0.7.0's texts held the
  example phone number `4512345678`, so a client id, subscription key or
  client secret holding `123456`, `234567`, `345678` and so on was refused
  before any request (for example the client id
  `e89f2345-c841-4bc7-a695-234567ab89cd`, which 0.5.0 accepts). The same
  class of run was in other texts too: the example dates
  `2026-12-15T23:59:59+01:00`, the charge id example `chr-123ab`, the word
  "Embedded", the range `0-9a-f` in the host name pattern, and the numbers
  `65000000` (the amount limit) and `9007199254740991` (the integer limit
  zod adds) in the gateway's tool list.
- The texts now hold no run of six or more characters from `[0-9A-Fa-f-]`:
  the phone number and the dates are described in words and by their form,
  the examples are changed, and a numeric bound of six digits or more is left
  out of the gateway's JSON schemas (zod still checks it when the call runs;
  the limits themselves are unchanged).
- A test checks every text a key is compared against (the fixed texts, the
  refusal, the fallbacks and the gateway's tool list) for such runs, and
  realistic made-up GUID, hex and base64 keys are admitted.

## 0.7.0

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
- Every answer of the new tools passes a typed allow-list that is read
  strictly, on every level and for every item of a list: a field that is not
  known is left out, and a known field in another type, or an object without
  a field it needs, refuses the whole answer. No item of a list is ever an
  empty object, and no list is cut short. The README lists what each object
  needs. The older reads are unchanged here.
- The address of a QR code's image is passed on whole, as the link of a
  payment request is: it carries a token in the form of a JSON Web Token,
  which the redaction would otherwise mask. A host should treat it as answer
  data and not log it.
- `find_charge` leaves an operation key out of a charge's history when it has
  the form this server makes from a request's content. `get_charge` and
  `list_charges` are unchanged and pass the charge on as it comes.
- Each sale with its lines and VAT comes from the Sales API, which takes
  accounting keys only: see `list_sales` and `get_sale` under Accounting
  keys above.

## 0.6.0

A new write tool, `create_payment`, and three changes a host must look at
before taking this version in, which is why it is 0.6.0:

- the answers of `capture_payment`, `refund_payment` and `cancel_payment` pass
  an allow-list, so a field outside it is no longer passed on;
- `get_payment` passes on an event's `idempotencyKey` only for a capture, a
  refund and a cancellation;
- in the gateway catalog `change.action` can be `create` and
  `change.movesMoney` is a boolean, so a host that has typed it as `true`
  must widen the type.

The details are in the entries below.

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
