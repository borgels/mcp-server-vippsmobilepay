# Changelog

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
