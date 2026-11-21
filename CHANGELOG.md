# Changelog

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
