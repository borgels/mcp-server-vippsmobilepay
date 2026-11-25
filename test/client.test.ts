import { describe, expect, it } from 'vitest';
import { VippsHttpError } from '../src/errors.js';
import { DEFAULT_PLUGIN_VERSION, isAllowedRequest, VippsMobilePayClient } from '../src/vipps/client.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { apiCalls, KEYS, makeClient, stubFetch, TOKEN } from './helpers.js';

describe('authentication', () => {
  it('requests a token with the keys and the system headers, then calls the API with it', async () => {
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { body: { id: 'agr_1' } } });
    const client = makeClient(fetchImpl, { systemPluginName: 'acme-host', systemPluginVersion: '2.1.0' });
    await expect(client.get('/recurring/v3/agreements/agr_1')).resolves.toEqual({ id: 'agr_1' });

    const [token, api] = calls;
    expect(token).toMatchObject({ method: 'POST', path: '/accesstoken/get' });
    expect(token?.headers).toMatchObject({
      client_id: KEYS.clientId,
      client_secret: KEYS.clientSecret,
      'Ocp-Apim-Subscription-Key': KEYS.subscriptionKey,
      'Merchant-Serial-Number': KEYS.merchantSerialNumber,
      'Vipps-System-Name': 'mcp-server-vippsmobilepay',
      'Vipps-System-Version': PACKAGE_VERSION,
      'Vipps-System-Plugin-Name': 'acme-host',
      'Vipps-System-Plugin-Version': '2.1.0',
    });
    expect(api?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Ocp-Apim-Subscription-Key': KEYS.subscriptionKey,
      'Merchant-Serial-Number': KEYS.merchantSerialNumber,
      'Vipps-System-Name': 'mcp-server-vippsmobilepay',
      'Vipps-System-Version': PACKAGE_VERSION,
      'Vipps-System-Plugin-Name': 'acme-host',
      'Vipps-System-Plugin-Version': '2.1.0',
    });
    // The API call never carries client_id or client_secret.
    expect(api?.headers).not.toHaveProperty('client_secret');
    expect(api?.headers).not.toHaveProperty('client_id');
    expect(fetchImpl.mock.calls.every(([, init]) => (init as RequestInit).redirect === 'manual')).toBe(true);
  });

  it('keeps the token until shortly before it expires, and shares one token request between concurrent calls', async () => {
    let now = Date.parse('2026-11-18T10:00:00Z');
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { body: {} } });
    const client = makeClient(fetchImpl, { now: () => now });
    await Promise.all([1, 2, 3].map(() => client.get('/recurring/v3/agreements/agr_1')));
    expect(calls.filter(call => call.path === '/accesstoken/get')).toHaveLength(1);

    now += 50 * 60_000; // 50 of 60 minutes: still kept
    await client.get('/recurring/v3/agreements/agr_1');
    expect(calls.filter(call => call.path === '/accesstoken/get')).toHaveLength(1);

    now += 6 * 60_000; // within five minutes of expiry: renewed
    await client.get('/recurring/v3/agreements/agr_1');
    expect(calls.filter(call => call.path === '/accesstoken/get')).toHaveLength(2);
  });

  it('gets a new token and retries once on 401, for reads and writes, with the same Idempotency-Key', async () => {
    let tokens = 0;
    let answers = 0;
    const { fetchImpl, calls } = stubFetch({
      'POST /accesstoken/get': () => ({ body: { expires_in: '3600', access_token: `${TOKEN}${(tokens += 1)}` } }),
      'POST /epayment/v1/payments/fjord-order-1/cancel': () => ((answers += 1) === 1 ? { status: 401 } : { body: { state: 'TERMINATED' } }),
    });
    const client = makeClient(fetchImpl);
    await expect(client.post('/epayment/v1/payments/fjord-order-1/cancel', {}, { idempotencyKey: 'key-0001-abcd' })).resolves.toEqual({
      state: 'TERMINATED',
    });
    const posts = apiCalls(calls);
    expect(posts).toHaveLength(2);
    expect(posts.map(call => call.headers['Idempotency-Key'])).toEqual(['key-0001-abcd', 'key-0001-abcd']);
    expect(posts.map(call => call.headers.Authorization)).toEqual([`Bearer ${TOKEN}1`, `Bearer ${TOKEN}2`]);
  });

  it('gives up after the second 401 with our own text', async () => {
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { status: 401, body: { message: 'secret detail' } } });
    const error = (await makeClient(fetchImpl).get('/recurring/v3/agreements/agr_1').catch((e: unknown) => e)) as VippsHttpError;
    expect(error).toBeInstanceOf(VippsHttpError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain('secret detail');
    expect(apiCalls(calls)).toHaveLength(2);
    expect(calls.filter(call => call.path === '/accesstoken/get')).toHaveLength(2);
  });

  it('explains a refused token request without quoting the answer', async () => {
    const { fetchImpl } = stubFetch({ 'POST /accesstoken/get': { status: 401, body: { error: 'invalid_client', key: KEYS.clientSecret } } });
    const error = (await makeClient(fetchImpl).verifyCredentials().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/access token request failed with HTTP 401.*keys were rejected/);
    expect(error.message).not.toContain('invalid_client');
  });

  it('refuses a token answer without a usable token', async () => {
    const { fetchImpl } = stubFetch({ 'POST /accesstoken/get': { body: { token_type: 'Bearer' } } });
    await expect(makeClient(fetchImpl).verifyCredentials()).rejects.toThrow(/without a usable access token/);
  });

  it('redacts the access token exactly, and the keys with their pieces', () => {
    const { fetchImpl } = stubFetch();
    const client = makeClient(fetchImpl);
    return client.verifyCredentials().then(() => {
      expect(client.redactor.redact(`a ${TOKEN} b`)).toBe('a ‹redacted› b');
      expect(client.redactor.redact(`x${KEYS.clientSecret.slice(3, 12)}y`)).not.toContain(KEYS.clientSecret.slice(3, 12));
      expect(client.redactor.redact(`client_secret: whatever`)).toBe('client_secret: ‹redacted›');
    });
  });
});

describe('configuration', () => {
  it('uses the test and production hosts and refuses other hosts, plain http and paths', () => {
    expect(makeClient(fetch).baseUrl).toBe('https://apitest.vipps.no');
    expect(makeClient(fetch, { environment: 'production' }).baseUrl).toBe('https://api.vipps.no');
    expect(makeClient(fetch, { baseUrl: 'http://127.0.0.1:8080' }).baseUrl).toBe('http://127.0.0.1:8080');
    expect(() => makeClient(fetch, { baseUrl: 'https://api.vipps.no.example.test' })).toThrow(/must be on api\.vipps\.no/);
    expect(() => makeClient(fetch, { baseUrl: 'http://api.vipps.no' })).toThrow(/https/);
    expect(() => makeClient(fetch, { baseUrl: 'https://api.vipps.no/epayment' })).toThrow(/without a path/);
  });

  it('accepts partner keys only in production', () => {
    expect(() => makeClient(fetch, { keyType: 'partner' })).toThrow(/only in the production/);
    expect(makeClient(fetch, { keyType: 'partner', environment: 'production' }).keyType).toBe('partner');
  });

  it('validates the MSN, the environment and the plugin headers without quoting them', () => {
    expect(() => makeClient(fetch, { merchantSerialNumber: 'abc' })).toThrow(/4 to 10 digits/);
    expect(() => makeClient(fetch, { environment: 'staging' as never })).toThrow(/"test" or "production"/);
    expect(() => makeClient(fetch, { systemPluginName: 'has space', systemPluginVersion: '1' })).toThrow(/systemPluginName/);
    expect(() => makeClient(fetch, { systemName: 'acme', systemVersion: 'x'.repeat(31) })).toThrow(/systemVersion/);
    expect(() => makeClient(fetch, { systemName: 'acme' })).toThrow(/given together/);
    expect(() => makeClient(fetch, { systemPluginVersion: '1.0' })).toThrow(/only with systemPluginName/);
  });

  it('still takes a plugin name without a version, as before, and sends the documented default version', async () => {
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { body: { id: 'agr_1' } } });
    await makeClient(fetchImpl, { systemPluginName: 'acme-host' }).get('/recurring/v3/agreements/agr_1');
    expect(DEFAULT_PLUGIN_VERSION).toBe('0');
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        'Vipps-System-Name': 'mcp-server-vippsmobilepay',
        'Vipps-System-Version': PACKAGE_VERSION,
        'Vipps-System-Plugin-Name': 'acme-host',
        'Vipps-System-Plugin-Version': DEFAULT_PLUGIN_VERSION,
      });
    }
  });

  it('refuses a system header that holds a key or a piece of one, without quoting it, for all four options', () => {
    const pieces = [KEYS.clientId.slice(0, 30), KEYS.clientSecret.slice(4, 20), KEYS.subscriptionKey.slice(-12), KEYS.clientSecret.slice(10, 16)];
    for (const piece of pieces) {
      for (const options of [
        { systemName: piece, systemVersion: '1' },
        { systemName: 'acme', systemVersion: piece },
        { systemPluginName: piece, systemPluginVersion: '1' },
        { systemPluginName: 'acme', systemPluginVersion: piece },
      ]) {
        const error = (() => {
          try {
            makeClient(fetch, options);
          } catch (e) {
            return e as Error;
          }
          return undefined;
        })();
        expect(error?.message, JSON.stringify(Object.keys(options))).toMatch(/shares text with the keys/);
        expect(error?.message).not.toContain(piece);
      }
    }
  });

  it('sends the four system headers on writes and on the retry after a 401', async () => {
    let answers = 0;
    const { fetchImpl, calls } = stubFetch({
      'POST /epayment/v1/payments/fjord-order-1/cancel': () => ((answers += 1) === 1 ? { status: 401 } : { body: { state: 'TERMINATED' } }),
      'DELETE /recurring/v3/agreements/agr_1/charges/chr_1': { body: {} },
    });
    const client = makeClient(fetchImpl, { systemName: 'Acme', systemVersion: '3.1' });
    await client.post('/epayment/v1/payments/fjord-order-1/cancel', {}, { idempotencyKey: 'key-0001-abcd' });
    await client.delete('/recurring/v3/agreements/agr_1/charges/chr_1', { idempotencyKey: 'key-0002-abcd' });
    const writes = apiCalls(calls);
    expect(writes.map(call => call.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(calls.filter(call => call.path === '/accesstoken/get')).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        'Vipps-System-Name': 'Acme',
        'Vipps-System-Version': '3.1',
        'Vipps-System-Plugin-Name': 'mcp-server-vippsmobilepay',
        'Vipps-System-Plugin-Version': PACKAGE_VERSION,
      });
    }
  });

  it('sends all four system headers on every request, with a host as the system and the server as the plugin', async () => {
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { body: { id: 'agr_1' } } });
    const client = makeClient(fetchImpl, { systemName: 'Acme', systemVersion: '3.1' });
    await client.get('/recurring/v3/agreements/agr_1');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        'Vipps-System-Name': 'Acme',
        'Vipps-System-Version': '3.1',
        'Vipps-System-Plugin-Name': 'mcp-server-vippsmobilepay',
        'Vipps-System-Plugin-Version': PACKAGE_VERSION,
      });
    }
  });

  it('sends the server as both system and plugin when it runs on its own', async () => {
    const { fetchImpl, calls } = stubFetch({ 'GET /recurring/v3/agreements/agr_1': { body: { id: 'agr_1' } } });
    await makeClient(fetchImpl).get('/recurring/v3/agreements/agr_1');
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        'Vipps-System-Name': 'mcp-server-vippsmobilepay',
        'Vipps-System-Version': PACKAGE_VERSION,
        'Vipps-System-Plugin-Name': 'mcp-server-vippsmobilepay',
        'Vipps-System-Plugin-Version': PACKAGE_VERSION,
      });
    }
  });

  it('reads the keys from the environment in the standalone server only', async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new VippsMobilePayClient({
      fetchImpl,
      credentialEnv: {
        VIPPS_CLIENT_ID: KEYS.clientId,
        VIPPS_CLIENT_SECRET: KEYS.clientSecret,
        VIPPS_SUBSCRIPTION_KEY: KEYS.subscriptionKey,
        VIPPS_MERCHANT_SERIAL_NUMBER: KEYS.merchantSerialNumber,
      },
    });
    await client.verifyCredentials();
    expect(calls[0]?.headers.client_id).toBe(KEYS.clientId);

    const empty = new VippsMobilePayClient({ fetchImpl, credentialEnv: {} });
    await expect(empty.verifyCredentials()).rejects.toThrow(/Missing Vipps MobilePay keys/);
  });
});

describe('requests', () => {
  it('sends only the requests on the fixed list', async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = makeClient(fetchImpl);
    await expect(client.post('/recurring/v3/agreements', {}, { idempotencyKey: 'op-0001-aaaa' })).rejects.toThrow(/never sends that POST/);
    await expect(client.delete('/recurring/v3/agreements/agr_1', { idempotencyKey: 'op-0001-aaaa' })).rejects.toThrow(/never sends that DELETE/);
    await expect(client.get('/management/v1/merchants/business:DK:CVR/10000008')).rejects.toThrow(/never sends that GET/);
    await expect(client.get('/management/v1/merchants/business:DK:CVR/10000008/sales-units')).rejects.toThrow(/never sends that GET/);
    await expect(client.get('/qr/v1/merchant-redirect/skilt_havnegade')).rejects.toThrow(/never sends that GET/);
    // Dot segments are resolved by the URL parser; the list is checked on what would be sent, and they are refused.
    await expect(client.delete('/recurring/v3/agreements/agr_1/charges/..', { idempotencyKey: 'op-0001-aaaa' })).rejects.toThrow(/never sends that DELETE/);
    await expect(client.post('/epayment/v1/payments/../../recurring/v3/agreements/agr_1/charges/chr_1/refund', {}, { idempotencyKey: 'op-0001-aaaa' })).rejects.toThrow(
      /never sends that POST/,
    );
    await expect(client.get('/epayment/v1/payments/%2e%2e')).rejects.toThrow(/never sends that GET/);
    expect(calls).toHaveLength(0);

    expect(isAllowedRequest('POST', '/recurring/v3/agreements/agr_1/charges/chr_1/refund')).toBe(true);
    expect(isAllowedRequest('POST', '/recurring/v3/agreements/agr_1/charges/chr_1/capture')).toBe(false);
    expect(isAllowedRequest('POST', '/recurring/v3/agreements/agr_1/charges')).toBe(false);
    expect(isAllowedRequest('DELETE', '/recurring/v3/agreements/agr_1/charges/chr_1')).toBe(true);
    // A new payment request is on the list; nothing else is created.
    expect(isAllowedRequest('POST', '/epayment/v1/payments')).toBe(true);
    expect(isAllowedRequest('POST', '/epayment/v1/payments/')).toBe(false);
    expect(isAllowedRequest('DELETE', '/epayment/v1/payments')).toBe(false);
    expect(isAllowedRequest('POST', '/epayment/v1/payments/fjord-order-1')).toBe(false);
    expect(isAllowedRequest('GET', '/report/v2/ledgers/abc/funds/dates/2026-11-01')).toBe(false);
    // The reads of a charge by its id, the order details, the sales units and the fixed QR codes: reads only.
    const reads = [
      '/recurring/v3/charges/chr-5kSeqz',
      '/order-management/v2/ECOM/fjord-order-10042',
      '/order-management/v2/RECURRING/chr-5kSeqz',
      '/management/v1/sales-units',
      '/management/v1/sales-units/212345',
      '/qr/v1/merchant-redirect',
      '/qr/v1/merchant-callback',
    ];
    for (const path of reads) {
      expect(isAllowedRequest('GET', path), path).toBe(true);
      expect(isAllowedRequest('POST', path), path).toBe(false);
      expect(isAllowedRequest('DELETE', path), path).toBe(false);
    }
    const never = [
      '/recurring/v3/charges',
      '/recurring/v3/charges/chr-5kSeqz/refund',
      '/order-management/v2/OTHER/fjord-order-10042',
      '/order-management/v2/ECOM/receipts/fjord-order-10042',
      '/order-management/v1/receipts/fjord-order-10042',
      '/order-management/v3/categories',
      '/management/v1/sales-units/abc',
      '/management/v1/sales-units/212345/extra',
      '/management/v2/product-orders',
      '/management/v1/partners/price-packages',
      '/qr/v1',
      '/qr/v1/merchant-callback/kasse-1',
      '/qr/v1/exchange',
    ];
    for (const path of never) expect(isAllowedRequest('GET', path), path).toBe(false);
    expect(isAllowedRequest('POST', '/qr/v1')).toBe(false);
    expect(isAllowedRequest('POST', '/management/v1/product-orders')).toBe(false);
    expect(isAllowedRequest('POST', '/order-management/v2/ECOM/receipts/fjord-order-10042')).toBe(false);
  });

  it('sends the Idempotency-Key it is given and never makes one up', async () => {
    const { fetchImpl, calls } = stubFetch({ 'POST /epayment/v1/payments/fjord-order-1/cancel': { body: {} } });
    const client = makeClient(fetchImpl);
    await client.post('/epayment/v1/payments/fjord-order-1/cancel', {}, { idempotencyKey: 'op-0001-aaaa' });
    expect(apiCalls(calls).map(call => call.headers['Idempotency-Key'])).toEqual(['op-0001-aaaa']);
    await expect(client.post('/epayment/v1/payments/fjord-order-1/cancel', {}, { idempotencyKey: 'a/b' })).rejects.toThrow(/idempotencyKey/);
    await expect(client.post('/epayment/v1/payments/fjord-order-1/cancel', {}, undefined as never)).rejects.toThrow(/idempotencyKey/);
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('never retries a POST on a gateway error, but retries a GET', async () => {
    let gets = 0;
    const { fetchImpl, calls } = stubFetch({
      'POST /epayment/v1/payments/fjord-order-1/capture': { status: 503 },
      'GET /epayment/v1/payments/fjord-order-1': () => ((gets += 1) === 1 ? { status: 503 } : { body: { ok: true } }),
    });
    const client = makeClient(fetchImpl, { maxAttempts: 3 });
    await expect(client.post('/epayment/v1/payments/fjord-order-1/capture', {}, { idempotencyKey: 'op-0001-aaaa' })).rejects.toBeInstanceOf(VippsHttpError);
    await expect(client.get('/epayment/v1/payments/fjord-order-1')).resolves.toEqual({ ok: true });
    expect(apiCalls(calls).map(call => call.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('never follows a redirect and does not quote its target', async () => {
    const { fetchImpl } = stubFetch({
      'GET /epayment/v1/payments/fjord-order-1': { status: 302, headers: { location: 'https://elsewhere.test/steal' } },
    });
    const error = (await makeClient(fetchImpl).get('/epayment/v1/payments/fjord-order-1').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/redirect \(HTTP 302\)/);
    expect(error.message).not.toContain('elsewhere');
  });

  it('caps the size of a successful answer', async () => {
    const { fetchImpl } = stubFetch({ 'GET /epayment/v1/payments/fjord-order-1': { body: { pad: 'x'.repeat(5_000) } } });
    await expect(makeClient(fetchImpl, { maxResponseBytes: 1_000 }).get('/epayment/v1/payments/fjord-order-1')).rejects.toThrow(
      /byte limit/,
    );
  });

  it('names only a known network error code', async () => {
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/accesstoken/get')) {
        return new Response(JSON.stringify({ access_token: TOKEN, expires_in: '3600' }), { headers: { 'content-type': 'application/json' } });
      }
      throw new TypeError('fetch failed: secret host detail', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    }) as typeof fetch;
    const error = (await makeClient(fetchImpl).get('/recurring/v3/agreements').catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Network error calling the Vipps MobilePay API (GET) (ENOTFOUND).');
  });
});
