# mcp-server-vippsmobilepay

A [Model Context Protocol](https://modelcontextprotocol.io) server for the Vipps MobilePay APIs. It lets an MCP client (Claude or any other MCP-capable assistant) read a merchant's settlements, ledger entries, ePayment payments and Recurring agreements and charges, and, when enabled, ask a customer to pay and capture, refund or cancel payments and charges.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Vipps MobilePay.

- Read-only by default. The six write tools ask a customer to pay, or move or release money; they are off unless enabled per instance, and a host should have a person confirm every call.
- Uses only the official [Access Token](https://developer.vippsmobilepay.com/docs/APIs/access-token-api/), [Report](https://developer.vippsmobilepay.com/docs/APIs/report-api/), [ePayment](https://developer.vippsmobilepay.com/docs/APIs/epayment-api/) and [Recurring](https://developer.vippsmobilepay.com/docs/APIs/recurring-api/) APIs.
- Nothing can change an agreement (price, interval, status), merchant or sales unit settings, or the keys, and nothing creates a charge: every request is checked against a fixed list before it is sent.
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application, with a host policy and typed change descriptions for the host's own log.

## Tools

Amounts are in minor units (øre, cent): 125,50 kr is `12550`.

| Tool | Risk | Purpose |
|---|---|---|
| `vipps_check_connection` | read | Check that the keys work (requests an access token). |
| `vipps_list_ledgers` | read | Settlement ledgers with currency and the sales units they settle for. The payout account is shown as its last four characters. Merchant keys only. |
| `vipps_get_funds_summary` | read | Totals of the funds ledger for up to 31 days, per date and in all: sales, refunds, fees retained, payouts, balance before and after. Merchant keys only. |
| `vipps_list_transactions` | read | Every entry of the funds or fees ledger for up to 31 days. Merchant keys only. |
| `vipps_get_payment` | read | One ePayment payment by reference, with its events. |
| `vipps_list_agreements` | read | Recurring agreements with one status (default `ACTIVE`). |
| `vipps_get_agreement` | read | One Recurring agreement. |
| `vipps_list_charges` | read | The charges of one agreement, optionally by status. |
| `vipps_get_charge` | read | One charge of an agreement. |
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

Without `expiresAt` the customer has 10 minutes to approve. With `expiresAt` (more than 10 minutes and less than 60 days ahead) the customer can pay later; Vipps MobilePay [enables that for each sales unit](https://developer.vippsmobilepay.com/docs/APIs/epayment-api/api-guide/features/long-living-payments/) and sets its limit, and `orderLines` are then required. The lines must add up to the amount, each line to its amount without VAT plus its VAT. Amounts are whole minor units with a currency code, which must be the currency of the sales unit; the smallest amount in NOK is 100.

The result holds our own fields only: `created`, the reference, the delivery, the amount, the link and the deadline. The phone number is sent to Vipps MobilePay and is never in a result, an error or the audit; the reference, which is the order or invoice number the business uses, is shown to the customer.

**Before a write.** Capture and refund read the payment (or charge) first and refuse, without sending anything, when the currency differs from the payment's or the amount is more than can be captured or refunded. Capture needs an `AUTHORIZED` payment; cancelling a charge needs a cancellable status. The payment's or charge's amounts must be whole, non-negative minor units that add up (nothing captured beyond what was authorized, nothing refunded beyond what was captured), and its currency one of NOK, DKK and EUR; otherwise the change is refused with a fixed text.

**A payment request gets its key from its content.** `create_payment` takes no `idempotencyKey`. The server makes the `Idempotency-Key` itself: `create-` and 32 hex characters of the SHA-256 of the sales unit's number and the whole request body in a fixed field order. The same input is therefore always the same key, and any other input another, so a caller that repeats a request after a timeout, an error or a lost answer sends the same request again and cannot repeat it under a new key. The reference is the second guard: Vipps MobilePay accepts a reference once per sales unit. The server itself never sends the request twice (one more time only after HTTP 401, with a new access token and the same key). When Vipps MobilePay refuses a request with HTTP 400 or 409, the payment with that reference is read: if it exists with the same amount and currency, the result says `alreadyExists: true` with its state (and its link while it is `CREATED`) and nothing new is created; if it exists with another amount or currency, the call is refused. The key is sent to Vipps MobilePay only: it is not returned and not logged, since it is made from content that can hold a phone number. Nothing is kept between calls.

**Every capture, refund and cancellation needs an operation key.** `idempotencyKey` (8-40 letters, digits or dashes) is required for these five write tools and is sent as `Idempotency-Key`; the server never makes one up, and a call without one is refused before anything is sent. The caller chooses a new key for each new change, records it before the call, and sends the same key when it repeats that change (after a timeout, an error or a lost answer). Vipps MobilePay carries out a key once and answers a repeat with the first result, so a repeated partial refund cannot pay out twice. The key comes back in the result. When a repeat reaches our own check after the change was carried out (a full refund whose answer was lost, say), the check would refuse it; the payment's events or the charge's history are then searched for a successful event with the same key and amount, and if one is found the result says `alreadyDone: true` and nothing is sent.

**Cancelling a charge uses DELETE.** The Recurring API cancels a charge with `DELETE /recurring/v3/agreements/{agreementId}/charges/{chargeId}`. It is the only DELETE this server can send, and it deletes no record: the charge remains. A pending, due or reserved charge ends as `CANCELLED`; a partially captured charge ends as `CHARGED`, with the rest released to the customer.

**Lists are complete or refused.** Every list is read to its end. When a cap is reached the call fails with a refusal and returns nothing, rather than a list that looks complete but is not:

| List | Cap |
|---|---|
| Ledgers | 20 pages |
| Report entries | 31 days and 200 pages per call; `list_transactions` at most 5 000 entries |
| Agreements | 10 pages of 500 |
| Charges of one agreement | 20 pages (`Continuation-Token`) |

A ledger date Vipps MobilePay has not closed yet (`tryLater`) is listed in `openDates`, and `complete` is `false`; every page it has so far is still read.

**Data, not instructions.** Results from Vipps MobilePay are labelled as data: references, texts and metadata are written by merchants, integrations and customers. The Report API is called without `includeGDPRSensitiveData`, so customer names, messages and phone numbers are not requested.

**Personal data in results.** The known personal fields of the payer and the subscriber are left out: `userDetails` (name, phone, e-mail), `shippingDetails` (address), `profile.sub`, `userinfoUrl`, phone numbers and the card number prefix. Payments, events and agreements pass through a typed allow-list (`src/vipps/views.ts`), so a field Vipps MobilePay adds later is left out until it is listed. This does not make the results free of personal data: a payment reference, a product name or a description is text the merchant or an integration chose, and it can hold a name or another personal detail. Treat results as data that may contain personal data.

## Keys and authentication

The server uses the Access Token API (`POST /accesstoken/get`, standard authentication) with these headers, and sends the token as `Authorization: Bearer` together with the subscription key and MSN on every API call:

- `client_id`, `client_secret`, `Ocp-Apim-Subscription-Key`: from the business portal ([portal.vippsmobilepay.com](https://portal.vippsmobilepay.com/)), *Developer* section, for the sales unit.
- `Merchant-Serial-Number`: the sales unit's MSN.
- `Vipps-System-Name: mcp-server-vippsmobilepay`, `Vipps-System-Version: <package version>`, and, when an embedding host gives them, `Vipps-System-Plugin-Name` and `Vipps-System-Plugin-Version`.

The token is kept until five minutes before it expires (Vipps MobilePay: one hour in test, 24 hours in production) and shared by concurrent calls. A call answered with 401 gets a new token and is sent once more (a write with the same `Idempotency-Key`); a second 401 is reported.

**Environments.** `test` uses `https://apitest.vipps.no` with the test keys; `production` uses `https://api.vipps.no`. The keys are never sent to another host (a loopback URL is allowed for a local mock).

**Partner keys.** Set `VIPPS_KEY_TYPE=partner` (gateway: `keyType: 'partner'`) to use a partner's `client_id`, `client_secret` and subscription key with the merchant's MSN, which is then required. Vipps MobilePay documents partner keys for the ePayment and Recurring APIs, in production only, and not for the Report API; with partner keys the three report tools are not offered. Accounting keys (the Report API for accounting partners, without subscription key and MSN) are not supported yet.

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
| `VIPPS_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with ledger ids, dates, amounts and currency in clear text, payment references, agreement and charge ids and idempotency keys as `sha256:` pseudonyms, a description hashed, the delivery and deadline of a payment request in clear text (never its phone number, return address or order lines), duration, status, and the caller passed by an embedding host as a pseudonym only (`hmac:` and 16 hex characters with a random key per process). The request id is the server's own. A call rejected before it runs (an unknown tool or invalid input) is recorded with a fixed reason, the tool as `unknown_tool` when it does not exist, and of the input only the field names the tool's schema has, plus a count of the others. Write tools refuse to run if the log cannot be written. |

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

- **Explicit credentials.** `clientId`, `clientSecret`, `subscriptionKey`, `merchantSerialNumber` and `environment` are required; a missing value throws when the gateway is created. A gateway never reads `VIPPS_*` credentials from the environment. Each key must be printable ASCII of at least 16 characters (see key admission below).
- **Host policy.** `policy` takes `enableWrites` (default false), `disabledTools`, `allowedTools` (an allow-list: when given, only these tools are offered, reads included; it must name known tools and must not be empty) and `audit`, a function that receives each audit record (a write does not run if the sink throws on its start record). Unknown tool names and malformed values throw at creation. An instance with `policy` reads none of `VIPPS_ENABLE_WRITES`, `VIPPS_DISABLED_TOOLS`, `VIPPS_AUDIT_LOG` or `VIPPS_ALLOW_CUSTOM_BASE_URL`.
- **What no policy turns on.** Requests outside the fixed list in `src/vipps/client.ts`: changing an agreement (price, interval, status), merchant or sales unit settings or keys, creating charges, capturing a Recurring charge, and any other DELETE.
- **Tool catalog.** `vippsToolCatalog` is a frozen list of every tool: `name` (without the `vipps_` prefix), `title`, `description`, `riskLevel` (`read` or `write`; no tool is `destructive`, as none deletes or overwrites anything), `enabledByDefault` (false for every write), `inputSchema` (JSON Schema), `upstream` (the API requests the tool may make), `broad` (false for all), `keyTypes`, `requiresConfirmation` (true for every write: a host should have a person confirm the call outside the chat) and, for write tools, `change`: `action` (`create`, `capture`, `refund`, `cancel`), `record` (`payment` or `charge`), `movesMoney` (true when the call itself moves or releases money; false for `create_payment`, which only asks the customer to pay) and `logFields`, each with the one type its value must have:

  | Type | Fields | Value |
  |---|---|---|
  | `amountMinor` | `amount` | in clear: a whole number of minor units, 1 to 65 000 000 |
  | `currency` | `currency` | in clear: `NOK`, `DKK` or `EUR` |
  | `flag` | `cancelTransactionOnly` | in clear: true or false |
  | `delivery` | `delivery` | in clear: `link`, `qr` or `phone` (never the phone number) |
  | `pseudonym` | `reference`, `agreementId`, `chargeId`, `idempotencyKey` | never in clear: `hmac:` and 16 hex characters of HMAC-SHA-256 with the host's `pseudonymKey`, or `sha256:` and 16 hex characters of SHA-256 without one |

  The identifiers are pseudonyms because the caller chooses them: a reference may be any text of the allowed characters, a person's name among them. The same identifier always gets the same pseudonym, so log lines can be matched; give a `pseudonymKey` (a secret of the host) so that a guessable reference such as an order number cannot be found from its hash. Names, phone numbers and free text are never log fields (a `description` is sent to Vipps MobilePay and only hashed in the audit log). `resolveVippsChange(tool, input, { pseudonymKey })` validates the input as `callTool` does, the operation key included, and returns the values.
- **For a host that logs and confirms changes.** Create the operation key when the change is drafted, keep it with the draft and in the log before the call, and call the tool with that same key when the person approves it and on every retry. `create_payment` needs no key from the host: repeat it with the same input. Log `resolveVippsChange(...).change.values`, never the raw input. Pass the `link` or `qrCode` of a result on as it is: it holds the customer's token for that one payment, and a host that masks token-shaped text would leave a link that opens nothing.
- **Call context.** `callTool(name, input, { caller, requestId })`: the audit writes `caller` only as a pseudonym (`hmac:` and 16 hex characters, with a key that is random per process, so the same caller can be followed within one process and not across restarts). The host's `requestId` is accepted and not written; each call gets the server's own request id, shared by its start, finish and error records.
- **Failure metadata.** An error result has only its text, and, when Vipps MobilePay (the API or the Access Token API) answered with an HTTP error, `failure: { httpStatus, requestId? }`: the status, and the vendor's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. A host can count failures from it without reading their text. Never the response body, the vendor's error code or message.
- **Several merchants in one process.** Each instance keeps its own access token and redacts with its own keys; nothing is kept in process-wide state.

## Threat model

**Scope.** The guarantees apply to the embeddable gateway. The standalone MCP server, configured from the environment for one merchant, keeps best-effort redaction.

**Secrets.** `client_id`, `client_secret` and the subscription key are the instance's keys; the access token becomes a secret of the instance when it is issued. The MSN is not secret.

**Guaranteed:**

- **(a) No key reaches anything persisted or shared:** audit sinks and the audit log file, logs, error texts. Everything a gateway instance returns is redacted with the instance's own keys (the keys and every piece of them of 6 characters or more; the access token as a whole) and then checked at the sink: an output that still holds a piece of a key is replaced by a fixed fallback.
- **(b) No vendor-controlled free text in errors.** An error carries our own text, the HTTP status and a parsed Retry-After; never a response body, a vendor message or code, or a redirect's `Location`.
- **(c) Results go only to the merchant whose keys they are.** One gateway instance per merchant; every call runs in a scope of its own.

**The customer's link.** The `link` or `qrCode` of a payment request is the one text of Vipps MobilePay passed on with a token in it: the address the customer opens, which is what the request exists to hand over. It is passed on only as an https address of URL characters (no spaces, so no sentence), without a user name or password and at most 4 096 characters; anything else is left out. The masking of token-shaped text is set aside for it, since the customer's token has that shape; the check at the sink is not, so a link that holds a piece of a key or the access token withholds the whole result.

**Not guaranteed:** a vendor that echoes a key back otherwise transformed (split into pieces shorter than 6 characters, re-encoded). Such data reaches only the merchant whose key it is. The access token is redacted only as a whole, since pieces of a JWT are common in other base64 text such as report cursors.

**Key admission.** A gateway accepts only keys of printable ASCII of at least 16 characters that share no piece of 6 characters with this server's own texts; the refusal never repeats the key.

## Security model

- **One identity per instance.** Every caller acts with the rights of the configured keys. Per-user authorization belongs to the host or a gateway in front of the server.
- **Writes are off by default.** They are not annotated destructive (each adds a payment request, a capture, a refund or a cancellation and deletes nothing), but a capture, refund or cancellation moves or releases money and cannot be undone, and a payment request reaches a customer: `requiresConfirmation` is true for every write, and a host should have a person confirm each call outside the chat. Read-only tools get a client that refuses POST and DELETE. When an audit log or sink is configured, a write does not run unless its start record is written.
- **The keys stay on the Vipps MobilePay hosts.** Redirects are never followed, and the base URL must be `api.vipps.no` or `apitest.vipps.no` over https (or loopback).
- **The HTTP transport fails closed**: token required off loopback, constant-time comparison, throttled failures, `Origin` and `Host` checks, capped bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Not verified against Vipps MobilePay

The client follows the published OpenAPI specifications (Access Token 2.0.0, Report 2.0, ePayment 1.8.5, Recurring 3.2.3) and is tested against mocked HTTP only. Not yet tried against the test environment:

- the paging of `GET /recurring/v3/agreements` with `pageNumber` and `pageSize`, and `Continuation-Token` on the charge list;
- an `Idempotency-Key` on `POST .../cancel` (the ePayment specification does not list it for cancel);
- what a repeated `Idempotency-Key` on `POST /epayment/v1/payments` is answered with (the first answer again, or a refusal), for how long a key is remembered, and whether a reference already used is refused with HTTP 400 or 409; `create_payment` handles each of these, and reads the payment after either status;
- the form of the customer's link (`redirectUrl`), `PUSH_MESSAGE` on an approved sales unit, and a request with `expiresAt` on a sales unit that has it enabled;
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
| `src/vipps/reports.ts`, `payments.ts`, `recurring.ts` | API calls and paging. |
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
