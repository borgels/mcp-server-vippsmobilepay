import { createHmac } from 'node:crypto';
import { ConfigError, readEnvBoolean, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { VippsHttpError, describeUrl, parseRetryAfterMs, requestIdFrom, SecretRedactor } from '../errors.js';
import { PACKAGE_VERSION, USER_AGENT } from '../version.js';
import type { KeyedHashPurpose } from './values.js';

/** Which Vipps MobilePay environment the keys belong to. */
export type VippsEnvironment = 'test' | 'production';

/**
 * Whose keys these are.
 *   merchant  the sales unit's own keys from the business portal (all tools).
 *   partner   a partner's keys, used with the merchant's Merchant-Serial-Number.
 *             Vipps MobilePay documents partner keys for the ePayment and
 *             Recurring APIs, in production only, and not for the Report API.
 *   accounting  an accounting partner's keys: a client id and a client secret
 *             only, in production only. They give access to the Report API and
 *             the Sales API, for every business that has given the partner
 *             access in the portal. The token is therefore not one business's:
 *             every call is bound to the organisation its host names for it
 *             (src/vipps/owner-binding.ts), and only the gateway entry point
 *             takes these keys.
 */
export type VippsKeyType = 'merchant' | 'partner' | 'accounting';

export const ENVIRONMENT_BASE_URLS: Readonly<Record<VippsEnvironment, string>> = Object.freeze({
  test: 'https://apitest.vipps.no',
  production: 'https://api.vipps.no',
});

/** Hosts the keys may be sent to. Loopback http is allowed for local mocks. */
export const UPSTREAM_HOSTS: readonly string[] = ['api.vipps.no', 'apitest.vipps.no'];

/** Header names that carry a credential; redaction follows them by name. */
export const CREDENTIAL_HEADERS = ['client_id', 'client_secret', 'Ocp-Apim-Subscription-Key', 'Authorization'] as const;

/** The value sent as Vipps-System-Name. */
export const SYSTEM_NAME = 'mcp-server-vippsmobilepay';

const MSN_PATTERN = /^\d{4,10}$/;
/** Vipps-System-* values: one short word, at most 30 characters (the documented limit). */
const SYSTEM_HEADER_PATTERN = /^[A-Za-z0-9._-]{1,30}$/;
/** Idempotency-Key: the Recurring API allows 1-40 characters without '#', '?', '/' or '\'; we allow a strict subset. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9-]{8,40}$/;

export interface VippsClientOptions {
  /** client_id. When omitted, read from VIPPS_CLIENT_ID in `credentialEnv`. */
  clientId?: string;
  /** client_secret. When omitted, read from VIPPS_CLIENT_SECRET in `credentialEnv`. */
  clientSecret?: string;
  /** Ocp-Apim-Subscription-Key. When omitted, read from VIPPS_SUBSCRIPTION_KEY in `credentialEnv`. */
  subscriptionKey?: string;
  /** Merchant-Serial-Number of the sales unit. When omitted, read from VIPPS_MERCHANT_SERIAL_NUMBER. */
  merchantSerialNumber?: string;
  /** test or production. When omitted, read from VIPPS_ENVIRONMENT (default test). */
  environment?: VippsEnvironment;
  /**
   * merchant (default), partner or accounting. When omitted, read from VIPPS_KEY_TYPE (merchant or partner only:
   * accounting keys are never read from the environment).
   */
  keyType?: VippsKeyType;
  /**
   * Override of the base URL, for a local mock. Must be loopback, or one of
   * UPSTREAM_HOSTS over https unless allowCustomBaseUrl is set. When omitted,
   * read from VIPPS_BASE_URL; otherwise derived from `environment`.
   */
  baseUrl?: string;
  /** Allow a base URL outside UPSTREAM_HOSTS (env VIPPS_ALLOW_CUSTOM_BASE_URL=true). */
  allowCustomBaseUrl?: boolean;
  /** Vipps-System-Plugin-Name, for a host that embeds this package (one word, at most 30 characters). */
  systemPluginName?: string;
  /** Vipps-System-Plugin-Version (at most 30 characters). */
  systemPluginVersion?: string;
  /**
   * Where omitted credentials are read from. Defaults to process.env for the
   * standalone server. The gateway passes `{}`, so an embedded instance only
   * ever uses the credentials it was given.
   */
  credentialEnv?: Env;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env VIPPS_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env VIPPS_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env VIPPS_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for GETs and the token request on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /** Total time one call may spend waiting between retries (default 10 s). */
  retryBudgetMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the token cache (ms since epoch). */
  now?: () => number;
}

export type QueryValue = string | number | boolean | null | undefined;

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/** A page of a response: the body and the response headers this server reads (lower-case names). */
export interface ResponsePage<T> {
  data: T;
  headers: Readonly<Record<string, string>>;
}

/** Options of a request that changes something. */
export interface WriteOptions {
  /**
   * Idempotency-Key header. Required, and never generated here. For a capture,
   * refund or cancellation the caller chooses it, logs it before the request,
   * and sends the same key when it repeats the same change, so Vipps MobilePay
   * carries the change out once. For a new payment the tool derives it from
   * the request's own content (derivedIdempotencyKey in values.ts).
   */
  idempotencyKey: string;
}

/** Response headers this server reads; every other header is dropped unread. */
const READ_RESPONSE_HEADERS = ['continuation-token'] as const;

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;
/** The token is renewed this long before Vipps MobilePay says it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
/** A token is never kept for less than this, whatever the response says. */
const MIN_TOKEN_LIFETIME_MS = 30_000;
/** A token is never kept for longer than this (Vipps: 1 hour in test, 24 hours in production). */
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_TIMER_MS = 2_147_483_647;

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Every API request this server can make, by method. A path is checked
 * against this list before anything is sent, whichever tool asks: nothing
 * outside it (agreement changes, merchant or sales unit settings, new
 * charges) can be sent, whatever the policy says. Path segments arrive
 * already encoded by encodePathParam. Accounting keys have a list of their
 * own (ACCOUNTING_REQUESTS).
 */
const SEGMENT = '[^/?#]+';
const ALLOWED_REQUESTS: Readonly<Record<HttpMethod, readonly RegExp[]>> = {
  GET: [
    /^\/settlement\/v1\/ledgers$/,
    /^\/report\/v2\/ledgers\/\d{1,20}\/(funds|fees)\/dates\/\d{4}-\d{2}-\d{2}$/,
    new RegExp(`^/epayment/v1/payments/${SEGMENT}$`),
    new RegExp(`^/epayment/v1/payments/${SEGMENT}/events$`),
    /^\/recurring\/v3\/agreements$/,
    new RegExp(`^/recurring/v3/agreements/${SEGMENT}$`),
    new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges$`),
    new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}$`),
    // A charge by its own id, when the agreement is not known (find_charge).
    new RegExp(`^/recurring/v3/charges/${SEGMENT}$`),
    // The order lines and category stored with a payment or a charge (get_receipt).
    new RegExp(`^/order-management/v2/(ECOM|RECURRING)/${SEGMENT}$`),
    // The sales units the keys can read, and one of them (list_sales_units, get_sales_unit). Production only.
    /^\/management\/v1\/sales-units$/,
    /^\/management\/v1\/sales-units\/\d{4,10}$/,
    // The sales unit's fixed QR codes (list_qr_codes).
    /^\/qr\/v1\/merchant-redirect$/,
    /^\/qr\/v1\/merchant-callback$/,
  ],
  POST: [
    // A new payment request (create_payment). The customer approves it in the app before any money moves.
    /^\/epayment\/v1\/payments$/,
    new RegExp(`^/epayment/v1/payments/${SEGMENT}/(capture|refund|cancel)$`),
    new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}/refund$`),
  ],
  // Vipps MobilePay cancels a Recurring charge with DELETE on the charge. It is
  // the only DELETE this server can send, and it deletes no record: the charge
  // stays. A pending, due or reserved charge ends as CANCELLED; a partially
  // captured one ends as CHARGED, with the rest released to the customer.
  DELETE: [new RegExp(`^/recurring/v3/agreements/${SEGMENT}/charges/${SEGMENT}$`)],
};

/**
 * Every API request a client with accounting keys can make: the ledger list,
 * the funds and fees ledgers of a ledger date, and the sales of a ledger (by
 * ledger date, by the business's reference, by Vipps MobilePay's
 * reference). All are GET. Nothing of the other list is among them, and the
 * sales paths are in no other list: the Sales API takes accounting keys only.
 * The feed of a ledger is not here: it is for keeping a copy, and this
 * server keeps none.
 */
const ACCOUNTING_REQUESTS: readonly RegExp[] = [
  /^\/settlement\/v1\/ledgers$/,
  /^\/report\/v2\/ledgers\/\d{1,20}\/(funds|fees)\/dates\/\d{4}-\d{2}-\d{2}$/,
  /^\/sales\/report\/v1\/ledgers\/\d{1,20}\/dates\/\d{4}-\d{2}-\d{2}$/,
  new RegExp(`^/sales/report/v1/ledgers/\\d{1,20}/(references|psp-references)/${SEGMENT}$`),
];

/** A dot segment, or an encoded dot or separator, in a path: never sent. */
const DOT_OR_ENCODED_SEPARATOR = /(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c/i;

/**
 * Whether a client with keys of this type may send the request at all (see
 * ALLOWED_REQUESTS and ACCOUNTING_REQUESTS).
 */
export function isAllowedRequest(method: HttpMethod, path: string, keyType: VippsKeyType = 'merchant'): boolean {
  if (keyType === 'accounting') return method === 'GET' && ACCOUNTING_REQUESTS.some(pattern => pattern.test(path));
  return (ALLOWED_REQUESTS[method] ?? []).some(pattern => pattern.test(path));
}

/**
 * The ledgers of one organisation, as a client bound to that organisation
 * reads them (src/vipps/owner-binding.ts). Read anew for every call and kept
 * by nothing after it.
 */
export interface OwnLedgers {
  /** The ledgers whose owner is the organisation, through the allow-list. The payout account is not among the fields. */
  readonly ledgers: ReadonlyArray<Record<string, unknown>>;
  /** Their ids: the only ledgers the call may ask for. */
  readonly ids: ReadonlySet<string>;
  /** Ledgers left out because they could not be attributed to one organisation. They may be this organisation's. */
  readonly notAttributed: number;
}

/**
 * The client as handed to tool handlers. Read-only tools get a view whose
 * post and delete throw (see readOnlyClient).
 */
export interface UpstreamClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  getPage<T>(path: string, query?: Record<string, QueryValue>, headers?: Record<string, string>): Promise<ResponsePage<T>>;
  post<T>(path: string, body: unknown, options: WriteOptions): Promise<T>;
  delete<T>(path: string, options: WriteOptions): Promise<T>;
  /** Fetch an access token (or use the cached one): whether the keys work. */
  verifyCredentials(): Promise<void>;
  /**
   * Accounting keys only: the ledgers of the organisation the call is bound to. Present exactly when the client is
   * bound to an organisation, and a tool handler with accounting keys never gets a client that is not.
   */
  ownLedgers?(): Promise<OwnLedgers>;
  /** The sales unit the keys are used for, when one is configured. Not a secret. */
  readonly merchantSerialNumber?: string;
  /** The client's clock, in milliseconds since the epoch. */
  currentTime(): number;
  /**
   * A keyed hash (HMAC-SHA-256, hex) of a text, with a key derived from the client secret for this one purpose. The
   * secret and the derived key stay in the client. The same keys give the same hash on every instance; after the
   * client secret is replaced, the same text gives another hash.
   */
  keyedHash(purpose: KeyedHashPurpose, text: string): string;
}

/** A view of the client that only allows GET. */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get: (path, query) => client.get(path, query),
    getPage: (path, query, headers) => client.getPage(path, query, headers),
    post: refuse('POST'),
    delete: refuse('DELETE'),
    verifyCredentials: () => client.verifyCredentials(),
    ...(client.ownLedgers ? { ownLedgers: () => (client.ownLedgers as () => Promise<OwnLedgers>)() } : {}),
    merchantSerialNumber: client.merchantSerialNumber,
    currentTime: () => client.currentTime(),
    keyedHash: (purpose, text) => client.keyedHash(purpose, text),
  };
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Client for the Vipps MobilePay APIs.
 *
 * Authentication: the Access Token API (`POST /accesstoken/get`) with
 * client_id, client_secret, Ocp-Apim-Subscription-Key and
 * Merchant-Serial-Number, and the Vipps-System-* headers. The token is kept
 * until shortly before it expires and shared by concurrent calls; an API call
 * answered with 401 gets a fresh token and is sent once more.
 *
 * Redirects are never followed. GETs and the token request are retried with
 * backoff on throttling, gateway errors and transient network failures;
 * POST and DELETE are never retried except once after a 401 (with the same
 * Idempotency-Key, since a 401 means nothing was done).
 *
 * Each client owns a SecretRedactor holding its own client_id, client_secret,
 * subscription key and current access token.
 *
 * Accounting keys (keyType accounting) authenticate in another way: the
 * token comes from `POST /miami/v1/token` with the client id and the client
 * secret as HTTP Basic credentials and the form body
 * `grant_type=client_credentials`. No Ocp-Apim-Subscription-Key and no
 * Merchant-Serial-Number is sent, on the token request or on any other, and
 * the client can send only the requests in ACCOUNTING_REQUESTS. The token
 * lives 15 minutes and is renewed five minutes before that. It is the
 * partner's token, not one business's: what a call may read with it is
 * decided for each call by the owner binding, never by this client.
 */
export class VippsMobilePayClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  readonly environment: VippsEnvironment;
  readonly keyType: VippsKeyType;
  readonly baseUrl: string;
  readonly merchantSerialNumber?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly subscriptionKey?: string;
  /** Accounting keys: the client id and the client secret as HTTP Basic credentials. */
  private readonly basicCredentials?: string;
  private readonly systemHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private token?: CachedToken;
  private pendingToken?: Promise<CachedToken>;

  constructor(options: VippsClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.clientId = options.clientId ?? readEnvString('VIPPS_CLIENT_ID', env);
    this.clientSecret = options.clientSecret ?? readEnvString('VIPPS_CLIENT_SECRET', env);
    this.subscriptionKey = options.subscriptionKey ?? readEnvString('VIPPS_SUBSCRIPTION_KEY', env);
    this.redactor = new SecretRedactor();
    for (const header of CREDENTIAL_HEADERS) this.redactor.addHeader(header);
    this.redactor.addSecret(this.clientId).addSecret(this.clientSecret).addSecret(this.subscriptionKey);

    const msn = options.merchantSerialNumber ?? readEnvString('VIPPS_MERCHANT_SERIAL_NUMBER', env);
    if (msn !== undefined) {
      if (typeof msn !== 'string' || !MSN_PATTERN.test(msn)) {
        throw new ConfigError('VIPPS_MERCHANT_SERIAL_NUMBER must be 4 to 10 digits.');
      }
      this.merchantSerialNumber = msn;
    }

    this.environment = choice(
      options.environment ?? readEnvString('VIPPS_ENVIRONMENT', env) ?? 'test',
      ['test', 'production'] as const,
      'VIPPS_ENVIRONMENT must be "test" or "production".',
    );
    // Accounting keys are named by the embedding host only: the environment can say merchant or partner.
    this.keyType =
      options.keyType !== undefined
        ? choice(options.keyType, ['merchant', 'partner', 'accounting'] as const, 'keyType must be "merchant", "partner" or "accounting".')
        : choice(
            readEnvString('VIPPS_KEY_TYPE', env) ?? 'merchant',
            ['merchant', 'partner'] as const,
            'VIPPS_KEY_TYPE must be "merchant" or "partner".',
          );
    if (this.keyType === 'partner' && this.environment !== 'production') {
      throw new ConfigError('Partner keys work only in the production environment (VIPPS_ENVIRONMENT=production).');
    }
    if (this.keyType === 'accounting') {
      if (this.environment !== 'production') {
        throw new ConfigError('Accounting keys work only in the production environment.');
      }
      if (this.subscriptionKey !== undefined || this.merchantSerialNumber !== undefined) {
        throw new ConfigError(
          'Accounting keys are a client id and a client secret only: give no subscription key and no Merchant-Serial-Number with them.',
        );
      }
      if (this.clientId && this.clientSecret) {
        this.basicCredentials = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64');
        this.redactor.addSecret(this.basicCredentials);
      }
    }

    const override = options.baseUrl ?? readEnvString('VIPPS_BASE_URL', env);
    this.baseUrl = trimTrailingSlash(override ?? ENVIRONMENT_BASE_URLS[this.environment]);
    assertSafeBaseUrl(this.baseUrl, options.allowCustomBaseUrl ?? readEnvBoolean('VIPPS_ALLOW_CUSTOM_BASE_URL', false, env));

    this.systemHeaders = {
      'Vipps-System-Name': SYSTEM_NAME,
      'Vipps-System-Version': PACKAGE_VERSION,
    };
    for (const [header, value, name] of [
      ['Vipps-System-Plugin-Name', options.systemPluginName, 'systemPluginName'],
      ['Vipps-System-Plugin-Version', options.systemPluginVersion, 'systemPluginVersion'],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !SYSTEM_HEADER_PATTERN.test(value)) {
        throw new ConfigError(`${name} must be 1 to 30 letters, digits, dots, dashes or underscores.`);
      }
      this.systemHeaders[header] = value;
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'VIPPS_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'VIPPS_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(intOption('maxConcurrency', options.maxConcurrency, 'VIPPS_MAX_CONCURRENCY', 4, 1, 64));
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return (await this.call<T>('GET', path, { query })).data;
  }

  async getPage<T>(path: string, query?: Record<string, QueryValue>, headers?: Record<string, string>): Promise<ResponsePage<T>> {
    return this.call<T>('GET', path, { query, headers });
  }

  currentTime(): number {
    return this.now();
  }

  keyedHash(purpose: KeyedHashPurpose, text: string): string {
    const clientSecret = this.keyType === 'accounting' ? this.accountingCredentials().clientSecret : this.credentials().clientSecret;
    // One key for each purpose, so a value made for one says nothing of a value made for another.
    const key = createHmac('sha256', clientSecret).update(`mcp-server-vippsmobilepay ${purpose} v1`).digest();
    return createHmac('sha256', key).update(text).digest('hex');
  }

  async post<T>(path: string, body: unknown, options: WriteOptions): Promise<T> {
    return (await this.call<T>('POST', path, { body, idempotencyKey: idempotencyKey(options) })).data;
  }

  async delete<T>(path: string, options: WriteOptions): Promise<T> {
    return (await this.call<T>('DELETE', path, { idempotencyKey: idempotencyKey(options) })).data;
  }

  async verifyCredentials(): Promise<void> {
    await this.accessToken();
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private credentials(): { clientId: string; clientSecret: string; subscriptionKey: string } {
    if (!this.clientId || !this.clientSecret || !this.subscriptionKey) {
      throw new Error(
        'Missing Vipps MobilePay keys. Set VIPPS_CLIENT_ID, VIPPS_CLIENT_SECRET and VIPPS_SUBSCRIPTION_KEY in the MCP server environment.',
      );
    }
    if (this.keyType === 'partner' && !this.merchantSerialNumber) {
      throw new Error('Partner keys need the merchant’s VIPPS_MERCHANT_SERIAL_NUMBER.');
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret, subscriptionKey: this.subscriptionKey };
  }

  /** Accounting keys: the Basic credentials, or the refusal when a key is missing. */
  private accountingCredentials(): { clientSecret: string; basic: string } {
    if (!this.clientId || !this.clientSecret || !this.basicCredentials) {
      throw new Error('Missing Vipps MobilePay accounting keys: a client id and a client secret.');
    }
    return { clientSecret: this.clientSecret, basic: this.basicCredentials };
  }

  private commonHeaders(subscriptionKey: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      ...(this.merchantSerialNumber ? { 'Merchant-Serial-Number': this.merchantSerialNumber } : {}),
      ...this.systemHeaders,
    };
  }

  /** The headers every request with accounting keys has: no subscription key and no Merchant-Serial-Number. */
  private accountingHeaders(): Record<string, string> {
    return { Accept: 'application/json', 'User-Agent': USER_AGENT, ...this.systemHeaders };
  }

  /** The headers of an API request, without the token: by the kind of keys. */
  private apiHeaders(): Record<string, string> {
    if (this.keyType === 'accounting') {
      this.accountingCredentials();
      return this.accountingHeaders();
    }
    return this.commonHeaders(this.credentials().subscriptionKey);
  }

  /** The cached token, or a new one. Concurrent callers share one token request. */
  private async accessToken(): Promise<CachedToken> {
    if (this.token && this.token.expiresAt > this.now()) {
      return this.token;
    }
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  /** The token request, by the kind of keys: where it goes, its headers and its body. */
  private tokenRequest(): { url: string; init: RequestInit } {
    if (this.keyType === 'accounting') {
      const { basic } = this.accountingCredentials();
      return {
        url: this.buildUrl('/miami/v1/token'),
        init: {
          method: 'POST',
          headers: {
            ...this.accountingHeaders(),
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          // Vipps MobilePay: without this line the answer is `invalid_client`.
          body: 'grant_type=client_credentials',
        },
      };
    }
    const { clientId, clientSecret, subscriptionKey } = this.credentials();
    return {
      url: this.buildUrl('/accesstoken/get'),
      init: {
        method: 'POST',
        headers: {
          ...this.commonHeaders(subscriptionKey),
          client_id: clientId,
          client_secret: clientSecret,
        },
      },
    };
  }

  private async requestToken(): Promise<CachedToken> {
    const { url, init } = this.tokenRequest();
    const body = await this.execute('POST', url, init, true, async response => {
      await this.refuseUnsuccessful(response, 'POST', url, true);
      return readResponseBody(response, this.maxResponseBytes);
    });
    const parsed = asRecord(body);
    const value = parsed.access_token;
    if (typeof value !== 'string' || value.length < 16 || !/^[\x21-\x7E]+$/.test(value)) {
      throw new Error('The Vipps MobilePay Access Token API answered without a usable access token.');
    }
    // The token is a secret of this instance from now on (exact forms only: it is a long JWT, and pieces of it
    // are common in other base64 text such as report cursors).
    this.redactor.addExactSecret(value);
    const lifetime = tokenLifetimeMs(parsed, this.now());
    const token = { value, expiresAt: this.now() + Math.max(MIN_TOKEN_LIFETIME_MS, lifetime - TOKEN_EXPIRY_MARGIN_MS) };
    this.token = token;
    return token;
  }

  private async call<T>(
    method: HttpMethod,
    path: string,
    request: { query?: Record<string, QueryValue>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string },
  ): Promise<ResponsePage<T>> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (!isAllowedRequest(method, normalizedPath, this.keyType)) {
      // Our own text: the path is not quoted, it may hold caller input.
      throw new Error(`Refused: this server never sends that ${method} request to Vipps MobilePay.`);
    }
    const url = this.buildUrl(normalizedPath, request.query);
    // Checked again on the final URL, after the URL parser has resolved dot segments and encodings: the list
    // holds for what is sent, not only for what was asked.
    const finalPath = new URL(url).pathname;
    if (!isAllowedRequest(method, finalPath, this.keyType) || finalPath !== normalizedPath || DOT_OR_ENCODED_SEPARATOR.test(normalizedPath)) {
      throw new Error(`Refused: this server never sends that ${method} request to Vipps MobilePay.`);
    }
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        ...this.apiHeaders(),
        ...(request.headers ?? {}),
        Authorization: `Bearer ${token.value}`,
      };
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
      const init: RequestInit = { method, headers };
      if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(request.body);
      }
      const outcome = await this.execute<{ page?: ResponsePage<T> }>(method, url, init, method === 'GET', async response => {
        if (response.status === 401 && attempt === 1) {
          await discardBody(response);
          return {};
        }
        await this.refuseUnsuccessful(response, method, url, false);
        const data = (await readResponseBody(response, this.maxResponseBytes)) as T;
        const kept: Record<string, string> = {};
        for (const name of READ_RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) kept[name] = value;
        }
        return { page: { data, headers: kept } };
      });
      if (outcome.page) return outcome.page;
      // 401: the token may have been revoked or expired early. One more try with a new token.
      if (this.token === token) this.token = undefined;
    }
  }

  private async refuseUnsuccessful(response: Response, method: HttpMethod, url: string, tokenRequest: boolean): Promise<void> {
    if (isRedirect(response.status)) {
      await discardBody(response);
      throw new Error(
        `Vipps MobilePay API responded with a redirect (HTTP ${response.status}) for ${method}; redirects are not followed.`,
      );
    }
    if (!response.ok) {
      // The body is the vendor's text: it is never read into an error, a result or an audit record.
      await discardBody(response);
      throw new VippsHttpError({
        status: response.status,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId: requestIdFrom(response.headers),
        tokenRequest,
        accountingKeys: this.keyType === 'accounting',
      });
    }
  }

  /**
   * Run one request: limit concurrency, apply the timeout, and retry
   * idempotent requests on retryable statuses and transient network errors
   * within the retry budget.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    retryable: boolean,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = retryable ? this.maxAttempts : 1;
    let slept = 0;
    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, error);
          }
        }
        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              if (isTimeoutError(error)) {
                throw this.transportError(method, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is configuration and is not quoted.
  private transportError(method: HttpMethod, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`Vipps MobilePay API request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling the Vipps MobilePay API (${method})${shown}.`), { cause: error });
  }
}

function idempotencyKey(options: WriteOptions | undefined): string {
  const given = options?.idempotencyKey;
  if (typeof given !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(given)) {
    throw new Error('Refused: a change needs an idempotencyKey of 8 to 40 letters, digits or dashes. Nothing was sent.');
  }
  return given;
}

/** Lifetime of a token from expires_in (seconds) or expires_on (epoch seconds), bounded. */
function tokenLifetimeMs(body: Record<string, unknown>, now: number): number {
  const seconds = (value: unknown): number | undefined => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
  };
  const expiresIn = seconds(body.expires_in);
  const expiresOn = seconds(body.expires_on);
  const lifetime =
    expiresIn !== undefined ? expiresIn * 1000 : expiresOn !== undefined ? expiresOn * 1000 - now : MIN_TOKEN_LIFETIME_MS;
  return Math.min(MAX_TOKEN_LIFETIME_MS, Math.max(0, lifetime));
}

function choice<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) return [];
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') codes.push(code);
  if (Array.isArray(errors)) {
    for (const entry of errors) codes.push(...causeCodes(entry, depth + 1));
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`Vipps MobilePay API response of ${declared} bytes exceeds the ${maxBytes} byte limit (VIPPS_MAX_RESPONSE_BYTES).`);
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    if (isTimeoutError(error) || isTransientNetworkError(error)) throw error;
    throw new Error('The Vipps MobilePay API response could not be read.');
  }
  if (read.exceeded) {
    throw new Error(`Vipps MobilePay API response exceeds the ${maxBytes} byte limit (VIPPS_MAX_RESPONSE_BYTES).`);
  }
  const text = new TextDecoder().decode(read.bytes);
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string, allowCustomHost: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError('VIPPS_BASE_URL is not a valid URL.');
  }
  if (parsed.username || parsed.password || baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new ConfigError('VIPPS_BASE_URL must not contain credentials, a query string or a fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new ConfigError('VIPPS_BASE_URL must be an origin without a path (this server adds the API paths).');
  }
  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return;
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError('Refusing to send the keys over a scheme other than https://.');
  }
  const host = parsed.hostname.toLowerCase();
  if (allowCustomHost || UPSTREAM_HOSTS.includes(host)) {
    return;
  }
  throw new ConfigError(
    `Refusing to send the keys to that host: VIPPS_BASE_URL must be on ${UPSTREAM_HOSTS.join(' or ')}. ` +
      'Set VIPPS_ALLOW_CUSTOM_BASE_URL=true to allow another host.',
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
