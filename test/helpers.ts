import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VippsMobilePayClient, type VippsClientOptions } from '../src/vipps/client.js';
import { createVippsMobilePayGateway, type VippsAccountingGatewayOptions, type VippsGatewayOptions } from '../src/gateway.js';
import { createServer } from '../src/server.js';

/** The test environment's base URL; requests never leave the process (fetch is stubbed). */
export const BASE = 'https://apitest.vipps.no';

/**
 * An obviously fake, low-entropy key for tests: "notreal-" and a short code from the seed, repeated to the
 * length. Invented here; it has never come from a Vipps MobilePay account.
 */
export function fakeKey(seed: string, length = 32): string {
  const code = createHash('sha256').update(seed).digest('hex').slice(0, 4);
  return `notreal-${`${code}-`.repeat(Math.ceil(length / 5))}`.slice(0, length);
}

/** An obviously fake access token for tests. */
export function fakeToken(seed: string): string {
  return `notreal-access-${seed}-${'x'.repeat(24)}`;
}

/** Made-up keys of a made-up merchant ("Fjordbakeriet"). */
export const KEYS = {
  clientId: fakeKey('fjordbakeriet-id', 36),
  clientSecret: fakeKey('fjordbakeriet-secret', 34),
  subscriptionKey: fakeKey('fjordbakeriet-subscription', 32),
  merchantSerialNumber: '212345',
} as const;

export const TOKEN = fakeToken('fjordbakeriet');

/** Made-up accounting keys of a made-up accounting partner ("Regnskabshuset"): a client id and a client secret only. */
export const ACCOUNTING_KEYS = {
  clientId: fakeKey('regnskabshuset-id', 36),
  clientSecret: fakeKey('regnskabshuset-secret', 34),
} as const;

/** The token request of accounting keys. */
export const ACCOUNTING_TOKEN_PATH = '/miami/v1/token';

/** A made-up organisation a call with accounting keys is bound to, as the Report API names an owner. */
export const OWNER = { scheme: 'business:DK:CVR', id: '10000011' } as const;

export type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };
export type Route = Reply | ((url: URL, init: RequestInit) => Reply | Promise<Reply>);

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fetch stub keyed by "METHOD /path" (no query string). The token request
 * answers with TOKEN unless a route for it is given. Unknown routes answer
 * 404. Every request is recorded in `calls`.
 */
export function stubFetch(routes: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    // A JSON body as data; any other body (the form body of the accounting token request) as its text.
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
    const key = `${method} ${url.pathname}`;
    const route =
      routes[key] ??
      (key === 'POST /accesstoken/get'
        ? { body: { token_type: 'Bearer', expires_in: '3600', access_token: TOKEN } }
        : key === `POST ${ACCOUNTING_TOKEN_PATH}`
          ? // As seen in production: exactly these three fields, the lifetime a number.
            { body: { access_token: TOKEN, expires_in: 900, token_type: 'Bearer' } }
          : undefined);
    if (!route) {
      return new Response(JSON.stringify({ title: `no stub for ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    const reply = typeof route === 'function' ? await route(url, init) : route;
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status ?? 200, headers: { 'content-type': 'text/plain', ...reply.headers } });
    }
    const status = reply.status ?? 200;
    return new Response(status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch & ReturnType<typeof vi.fn>, calls };
}

/** API calls only (the token request left out). */
export function apiCalls(calls: Call[]): Call[] {
  return calls.filter(call => call.path !== '/accesstoken/get' && call.path !== ACCOUNTING_TOKEN_PATH);
}

export function makeClient(fetchImpl: typeof fetch, options: Partial<VippsClientOptions> = {}) {
  return new VippsMobilePayClient({
    ...KEYS,
    environment: 'test',
    credentialEnv: {},
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => undefined,
    ...options,
  });
}

export function gateway(routes: Record<string, Route> = {}, options: Partial<VippsGatewayOptions> = {}) {
  const { fetchImpl, calls } = stubFetch(routes);
  const gw = createVippsMobilePayGateway({
    ...KEYS,
    environment: 'test',
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => undefined,
    policy: {},
    ...options,
  });
  return { gw, fetchImpl, calls };
}

/** A gateway with accounting keys. Every call needs `{ owner }` in its context. */
export function accountingGateway(routes: Record<string, Route> = {}, options: Partial<VippsAccountingGatewayOptions> = {}) {
  const { fetchImpl, calls } = stubFetch(routes);
  const gw = createVippsMobilePayGateway({
    ...ACCOUNTING_KEYS,
    keyType: 'accounting',
    environment: 'production',
    fetchImpl,
    maxAttempts: 1,
    sleep: async () => undefined,
    policy: {},
    ...options,
  });
  return { gw, fetchImpl, calls };
}

export async function connect(routes: Record<string, Route> = {}, options: Partial<VippsClientOptions> = {}) {
  const { fetchImpl, calls } = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl, options) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl, calls };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

/** An ePayment payment as the API returns it (made-up shop). */
export function payment(overrides: Record<string, unknown> = {}) {
  const amount = (value: number) => ({ currency: 'DKK', value });
  return {
    reference: 'fjord-order-10042',
    pspReference: '1234567890',
    state: 'AUTHORIZED',
    amount: amount(49_900),
    aggregate: {
      authorizedAmount: amount(49_900),
      capturedAmount: amount(0),
      cancelledAmount: amount(0),
      refundedAmount: amount(0),
    },
    paymentMethod: { type: 'WALLET' },
    profile: {},
    ...overrides,
  };
}

/** A Recurring charge as the API returns it. */
export function charge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chr-5kSeqz',
    agreementId: 'agr_7TqP2m',
    amount: 19_900,
    currency: 'DKK',
    description: 'Brødabonnement: november',
    status: 'CHARGED',
    due: '2026-11-01T00:00:00Z',
    summary: { captured: 19_900, refunded: 0, cancelled: 0 },
    ...overrides,
  };
}
