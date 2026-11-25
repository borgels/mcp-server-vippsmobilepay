/**
 * Errors and redaction.
 *
 * The rule: no text the upstream API controls ever reaches a host, a result
 * or an audit record through an error. An HTTP error carries the status, our
 * own hint for it, and a parsed Retry-After; never the response body, the
 * vendor's error code or message, or a redirect's Location. Upstream text can
 * quote the request, personal data, or part of the key, and no redactor
 * recognises every fragment.
 *
 * Redaction is the second line: every instance redacts its key (the exact
 * value, its URL- and JSON-encoded forms, and any fragment of
 * FRAGMENT_LENGTH characters or more) from everything it returns, always on
 * structured values before they are serialised, and before anything is cut
 * short.
 */

import { isHttpsUrl } from './vipps/values.js';

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Any piece of a secret this long or longer is redacted, wherever it appears. */
export const FRAGMENT_LENGTH = 6;
/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;
/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of a key typed or
 * issued as ASCII; a key that contains it or shares a FRAGMENT_LENGTH piece with it is refused (overlapsMarker).
 */
export const REDACTION_MARKER = '‹redacted›';

/** Whether a secret could survive its own redaction: it contains the marker, or shares a piece with it. */
export function overlapsMarker(value: string): boolean {
  if (value.includes(REDACTION_MARKER)) {
    return true;
  }
  for (let i = 0; i + FRAGMENT_LENGTH <= REDACTION_MARKER.length; i += 1) {
    if (value.includes(REDACTION_MARKER.slice(i, i + FRAGMENT_LENGTH))) {
      return true;
    }
  }
  return false;
}

/** Matches `<name>: <value>`, `<name>=<value>` and `"<name>": "<value>"` for one header (case-insensitive). */
function headerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`["']?${escaped}["']?\s*[:=]\s*["']?[^"',\s}]+`, 'gi');
}

/** Patterns that are always applied: credential-shaped key/value pairs. They hold no secret values. */
const BASE_PATTERNS: readonly RegExp[] = [
  headerPattern('client_secret'),
  headerPattern('client_id'),
  headerPattern('ocp-apim-subscription-key'),
  // Any scheme word (Bearer, Basic, Token, ...) followed by the credentials.
  /["']?authorization["']?\s*[:=]\s*["']?(?:[a-z][\w-]*\s+)?[^"',\s}]+/gi,
  /(clientSecret|subscriptionKey|VIPPS_CLIENT_SECRET|VIPPS_SUBSCRIPTION_KEY|VIPPS_CLIENT_ID|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * Credentials without a name in front: each match is replaced whole (only a scheme word is kept), never split at a
 * separator, because base64 padding (`=`, `==`) is part of the value.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Bearer or Basic, in any case, before a value that holds the marker of an earlier redaction: the scheme word and the
  // whole value up to a space, quote, comma or brace, whatever its length (a short tail after the marker is still part
  // of the credential).
  /\b(bearer|basic)\s+[^\s"',}]*‹redacted›[^\s"',}]*/gi,
  // Bearer or Basic in any case, when what follows looks like a token: 8 or more base64 or base64url characters,
  // padding included. A short word after "basic" ("basic plan") is left alone; a longer one is masked, a false
  // positive we accept.
  // A marker left by an earlier redaction counts as part of the value, so the rest of the value is masked too.
  /\b(bearer|basic)\s+(?:[A-Za-z0-9._~+/-]|‹redacted›){8,}=*/gi,
  // A JSON Web Token anywhere: three base64url segments, the first a JSON header ("eyJ").
  /\beyJ(?:[A-Za-z0-9_-]|‹redacted›)*\.(?:[A-Za-z0-9_-]|‹redacted›)+\.(?:[A-Za-z0-9_-]|‹redacted›)*/g,
];

/** Every credential match replaced whole: `Bearer ‹redacted›`, `basic ‹redacted›`, or `‹redacted›` for a JWT. */
function applyCredentialPatterns(value: string): string {
  return CREDENTIAL_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const scheme = /^(bearer|basic)\s/i.exec(match)?.[1];
        return scheme ? `${scheme} ‹redacted›` : '‹redacted›';
      }),
    value,
  );
}

/**
 * Redacts the secrets of one client, and so of one gateway or server
 * instance: the exact values (raw, URL-encoded and JSON-escaped), every
 * fragment of FRAGMENT_LENGTH characters or more of them, and the values of
 * named credential headers. Each instance owns its redactor, so a host that
 * runs several tenants in one process never mixes their keys, and a tenant's
 * key is released with its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly fragments = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /**
   * Redact this value and every piece of it, also base64- and base64url-encoded (as a Basic credential or an echo
   * would carry it). Values shorter than MIN_SECRET_LENGTH are ignored.
   */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), ...base64Forms(value)])) {
      this.secrets.add(form);
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) {
        this.fragments.add(form.slice(i, i + FRAGMENT_LENGTH));
      }
    }
    return this;
  }

  /** Redact the value of this header wherever it appears as `<name>: <value>` or `<name>=<value>`. */
  addHeader(name: string): this {
    const pattern = headerPattern(name);
    if (!this.patterns.some(existing => existing.source === pattern.source)) {
      this.patterns.push(pattern);
    }
    return this;
  }

  /**
   * Redact this value only as a whole (raw, URL-encoded and JSON-escaped), not
   * its pieces: for a long, structured secret such as an access token (a JWT),
   * whose pieces are common in other base64 text.
   */
  addExactSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
      this.secrets.add(form);
    }
    return this;
  }

  /** Whether this exact value is one of this instance's secrets. */
  hasSecret(value: string): boolean {
    return this.secrets.has(value);
  }

  /** Whether the text contains one of the secrets in any form, or any FRAGMENT_LENGTH-character piece of one. */
  matches(text: string): boolean {
    for (const secret of this.secrets) {
      if (text.includes(secret)) return true;
    }
    if (this.fragments.size === 0) return false;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
    }
    return false;
  }

  redact(value: string): string {
    // Credential-shaped text first, while it is whole: a known key replaced inside a Basic value or a token would
    // break the match and leave the rest of the value. Then the known keys and their pieces, then the patterns again
    // (they also take the marker as part of a value), until nothing changes.
    let result = this.applyAllPatterns(value);
    for (let round = 0; round < 4; round += 1) {
      let next = result;
      for (const secret of this.secrets) {
        next = next.split(secret).join(REDACTION_MARKER);
      }
      next = this.applyAllPatterns(this.redactFragments(next));
      if (next === result) break;
      result = next;
    }
    return result;
  }

  private applyAllPatterns(text: string): string {
    return applyPatterns(applyCredentialPatterns(text), this.patterns);
  }

  /** Every run of text covered by a FRAGMENT_LENGTH-character piece of a secret becomes one ‹redacted›. */
  private redactFragments(text: string): string {
    if (this.fragments.size === 0 || text.length < FRAGMENT_LENGTH) {
      return text;
    }
    let covered: Uint8Array | undefined;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered ??= new Uint8Array(text.length);
        covered.fill(1, i, i + FRAGMENT_LENGTH);
      }
    }
    if (!covered) {
      return text;
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (covered[i]) {
        out += '‹redacted›';
        while (i < text.length && covered[i]) i += 1;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }
}

/**
 * The base64 and base64url forms of a secret, without padding: of the value alone and of `value:`, the start of a
 * Basic credential. Every piece of them is redacted like a piece of the value.
 */
function base64Forms(value: string): string[] {
  return [value, `${value}:`].flatMap(text => {
    const encoded = Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '');
    return [encoded, encoded.replace(/\+/g, '-').replace(/\//g, '_')];
  });
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} ‹redacted›`;
      }),
    value,
  );
}

/** Our own guidance per HTTP status, for the statuses the Vipps MobilePay APIs document. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Vipps MobilePay refused the request as invalid. Check the input; retrying the same request will not help.',
  401: 'The access token was refused. The keys may be wrong, expired or revoked.',
  403: 'The keys have no access to this API or this sales unit. Retrying will not help.',
  404: 'Not found, or the keys have no access to it. Check the reference or id.',
  409: 'Vipps MobilePay refused the change in the current state of the payment or charge.',
  429: 'Vipps MobilePay is throttling requests. Wait and retry later.',
};

/** Hints for the Access Token API. */
const TOKEN_STATUS_HINTS: Record<number, string> = {
  400: 'The Access Token API refused the request. Check the client_id, the Merchant-Serial-Number and the environment.',
  401: 'The keys were rejected: client_id, client_secret or Ocp-Apim-Subscription-Key is wrong, or belongs to the other environment.',
  403: 'The keys have no access. Check that they belong to this sales unit and environment.',
};

/**
 * An HTTP error from Vipps MobilePay. It keeps the status and the parsed
 * Retry-After, nothing from the response body: the message is our own.
 */
export class VippsHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or malformed. */
  readonly retryAfter?: string;
  /** The vendor's own id for the request, when a response header gives one as a UUID or hex id. */
  readonly requestId?: string;
  /** True when the Access Token API answered: no API request was sent. */
  readonly tokenRequest: boolean;

  constructor(input: { status: number; url: string; retryAfter?: string; tokenRequest?: boolean; requestId?: string; note?: string }) {
    super(httpErrorMessage(input.status, input.retryAfter, input.tokenRequest === true, input.note));
    this.name = 'VippsHttpError';
    this.status = input.status;
    this.url = describeUrl(input.url);
    const retryMs = parseRetryAfterMs(input.retryAfter);
    this.retryAfter = retryMs === undefined ? undefined : String(Math.ceil(retryMs / 1000));
    this.requestId = vendorRequestId(input.requestId);
    this.tokenRequest = input.tokenRequest === true;
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first. Add the vendor's documented
 * header in front when it has one.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status the upstream API answered with
 * and its request id. Never the response body, the vendor's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of the upstream API's answer (100-599). */
  httpStatus: number;
  /** The vendor's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * The failure metadata of an error: an HTTP error from the upstream API gives its status and request id, also when
 * it is the direct cause of our own error (a capture or refund refused after a failed read of the events).
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  const http =
    error instanceof VippsHttpError
      ? error
      : error instanceof Error && error.cause instanceof VippsHttpError
        ? error.cause
        : undefined;
  if (http === undefined) return undefined;
  const status = http.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(http.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

/**
 * The same HTTP error with a note of our own added to its text: what the status means for the tool that met it. The
 * note is a fixed text of ours; status, Retry-After and request id are kept, and nothing of the answer is read.
 */
export function withNote(error: VippsHttpError, note: string): VippsHttpError {
  return new VippsHttpError({
    status: error.status,
    url: error.url,
    retryAfter: error.retryAfter,
    requestId: error.requestId,
    tokenRequest: error.tokenRequest,
    note,
  });
}

/** The whole text of an HTTP error: status, our hint, a parsed Retry-After in seconds, and a tool's own note. */
export function httpErrorMessage(status: number, retryAfter?: string, tokenRequest = false, note?: string): string {
  const retryMs = parseRetryAfterMs(retryAfter);
  const hints = tokenRequest ? TOKEN_STATUS_HINTS : STATUS_HINTS;
  return [
    tokenRequest ? `Vipps MobilePay access token request failed with HTTP ${status}` : `Vipps MobilePay API request failed with HTTP ${status}`,
    Object.hasOwn(hints, status) ? hints[status] : undefined,
    retryMs === undefined ? undefined : `retry-after=${Math.ceil(retryMs / 1000)}s`,
    note,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, redactor);
  }
  return redactSecrets(String(error), redactor);
}

/**
 * Redact with an instance's redactor. Without one, only the credential-shaped
 * patterns are applied: no secret values are known outside an instance.
 */
export function redactSecrets(value: string, redactor?: SecretRedactor): string {
  return redactor ? redactor.redact(value) : applyPatterns(applyCredentialPatterns(value), BASE_PATTERNS);
}

/** Origin and path of a URL, without query string or fragment (which may carry signatures). */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** The longest customer link passed on. */
export const MAX_CUSTOMER_LINK_LENGTH = 4096;
/**
 * A link Vipps MobilePay made for the customer to open: the address of a
 * payment request, or of its QR code. It carries the customer's own token for
 * that one payment, and it is what a payment request exists to hand over, so
 * redactDeep passes it on unchanged. The credential-shaped patterns would
 * otherwise mask the token (it is a JSON Web Token) and leave a link that
 * opens nothing.
 *
 * Only the patterns are set aside. The link still passes the sink check in
 * its final form (leaksSecret), so a link that holds this instance's key, a
 * piece of it or its access token withholds the whole result. A link is made
 * only by CustomerLink.from: an https address of URL characters, with a host
 * and without a user name or password, at most MAX_CUSTOMER_LINK_LENGTH
 * characters. It cannot hold a sentence.
 */
export class CustomerLink {
  private constructor(readonly href: string) {}

  /** The link when the value is one in the form above; otherwise undefined. */
  static from(value: unknown): CustomerLink | undefined {
    return isHttpsUrl(value, MAX_CUSTOMER_LINK_LENGTH) ? new CustomerLink(value) : undefined;
  }

  /** The link as text: how it is written in a result. */
  toJSON(): string {
    return this.href;
  }
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets, and every number, boolean or bigint whose string form
 * would be redacted replaced by the string "‹redacted›" (so the copy still
 * serialises to valid JSON). Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on,
 * so a deep value cannot exhaust the stack when the copy is serialised.
 * A CustomerLink is passed on as it is (see the class).
 */
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const text = String(value);
    if (redactSecrets(text, redactor) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (value instanceof CustomerLink) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    // A Date and the like: redact what JSON.stringify would write.
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, redactor),
      redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/**
 * Text for a failure kept inside a result that is otherwise returned (one
 * part of a combined read that could not be fetched): the HTTP status, or a
 * fixed text. Never the error's own message.
 */
export function nestedFailureText(error: unknown): string {
  if (error instanceof VippsHttpError) {
    return `Vipps MobilePay API request failed with HTTP ${error.status}`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'Vipps MobilePay API request timed out.';
  }
  return 'Vipps MobilePay API request failed.';
}

/** Keys whose value is a failure context: anything inside that carries an error or a message is a failure. */
const FAILURE_CONTEXTS = new Set(['failures', 'failure', 'errors', 'error', 'metadata', 'warnings', 'amount']);
/** Fields that make an object in a failure context a failure. */
const FAILURE_FIELDS = ['error', 'errors', 'failures', 'warnings', 'message', 'detail', 'description'];
/** Failure lists: every element in one is a failure, whatever its fields. */
const FAILURE_LISTS = new Set(['failures', 'failure', 'errors', 'error', 'warnings']);

/** One element of a failure list, reduced to a numeric status (when it has one) and our own text. */
function failureEntry(value: unknown): { status?: number; message: string } {
  const status =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { status, message: `Vipps MobilePay API request failed with HTTP ${status}` }
    : { message: 'Vipps MobilePay API request failed.' };
}

/** A failure list: every element (an object with any fields, a text, a list) becomes a failureEntry. */
function failureList(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return Array.isArray(value) ? value.map(failureEntry) : failureEntry(value);
}

/**
 * Copy of a successful body with every failure reported inside it reduced to
 * its HTTP status and our own text.
 *
 * - Every element of a failure list (`failures`, `failure`, `errors`,
 *   `error`, `warnings`), at any depth, becomes `{ status?, message }`: a
 *   numeric status is kept, and every other field, whatever its name, is
 *   dropped. Nothing below a failure list is kept.
 * - Elsewhere a failure is an object with a numeric `status` of 400 or
 *   more, an object with an `error` field, or an object in a failure
 *   context (`metadata`, `amount` and the like, also through wrappers such
 *   as `data` below them) with any of `error`, `errors`, `failures`,
 *   `warnings`, `message`, `detail` or `description`. It becomes
 *   `{ status?, error }` with our own text.
 *
 * A text outside a failure list, an amount among them, is kept.
 * Depth-limited.
 */
export function nestedFailuresAsStatus(value: unknown, depth = 0, context = false): unknown {
  if (depth > 64) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => nestedFailuresAsStatus(entry, depth + 1, context));
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const failedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  const present = (field: string) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined;
  if (failedStatus || present('error') || (context && FAILURE_FIELDS.some(present))) {
    return failedStatus
      ? { status, error: `Vipps MobilePay API request failed with HTTP ${status}` }
      : { error: 'Vipps MobilePay API request failed.' };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      FAILURE_LISTS.has(key)
        ? failureList(entry)
        : // A failure context holds through wrappers such as `data` below it.
          nestedFailuresAsStatus(entry, depth + 1, context || FAILURE_CONTEXTS.has(key)),
    ]),
  );
}

/** IMF-fixdate, the HTTP date format used by Retry-After. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Retry-After header (delay in seconds or an HTTP date) into
 * milliseconds from `now`. Returns undefined when absent, malformed, zero or
 * in the past, so callers fall back to their own backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return date - now;
}
