import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VippsMobilePayClient, type VippsClientOptions } from '../src/vipps/client.js';
import { createVippsMobilePayGateway, type VippsGatewayOptions } from '../src/gateway.js';
import { createServer } from '../src/server.js';

/** The test environment's base URL; requests never leave the process (fetch is stubbed). */
export const BASE = 'https://apitest.vipps.no';

/**
 * A made-up value that looks like a key, derived at run time from a seed, so the source holds no literal that
 * looks like a secret (the public-hygiene scan reads the source).
 */
export function fakeKey(seed: string, length = 32): string {
  return createHash('sha256').update(seed).digest('base64url').slice(0, length);
}

/** A made-up access token in the shape of a JWT. */
export function fakeToken(seed: string): string {
  const part = (text: string) => Buffer.from(text).toString('base64url');
  return [part('{"typ":"JWT","alg":"RS256"}'), part(`{"sub":"${seed}","pad":"${'x'.repeat(60)}"}`), fakeKey(`${seed}-sig`, 43)].join('.');
}

/** Made-up keys of a made-up merchant ("Fjordbakeriet"). */
export const KEYS = {
  clientId: fakeKey('fjordbakeriet-id', 36),
  clientSecret: fakeKey('fjordbakeriet-secret', 34),
  subscriptionKey: fakeKey('fjordbakeriet-subscription', 32),
  merchantSerialNumber: '212345',
} as const;

export const TOKEN = fakeToken('fjordbakeriet');

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
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
    const key = `${method} ${url.pathname}`;
    const route =
      routes[key] ??
      (key === 'POST /accesstoken/get'
        ? { body: { token_type: 'Bearer', expires_in: '3600', access_token: TOKEN } }
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
  return calls.filter(call => call.path !== '/accesstoken/get');
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
