# Changelog

## 0.1.0 (unreleased)

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
