// Failure metadata on gateway error results: method, path template, the upstream API's HTTP status, its request id, and
// Vipps MobilePay's error code and trace id in their fixed forms only. Never the rest of the body or the vendor's message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureMetadata, requestIdFrom, VippsHttpError, vendorErrorFields, vendorRequestId } from '../src/errors.js';
import { requestTemplate } from '../src/vipps/client.js';
import { BASE, gateway, payment } from './helpers.js';

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const REFERENCE = 'order-1001';
const PAYMENT = `GET /epayment/v1/payments/${REFERENCE}`;
const VENDOR_BODY = { title: 'Payment for Jane Doe not found', type: 'E_NOPE', detail: 'Jane Doe' };
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('VIPPS_')) delete process.env[name];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    expect(failureMetadata(new VippsHttpError({ status: 404, url: `${BASE}/epayment/v1/payments/x`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new VippsHttpError({ status: 500, url: `${BASE}/epayment/v1/payments/x`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
    const http = new VippsHttpError({ status: 503, url: `${BASE}/epayment/v1/payments/x/events`, requestId: UUID });
    expect(failureMetadata(new Error('ours', { cause: http }))).toEqual({ httpStatus: 503, requestId: UUID });
    expect(failureMetadata(new Error('ours', { cause: new Error('boom') }))).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const { gw } = gateway({ [PAYMENT]: { status: 404, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID, method: 'GET', pathTemplate: '/epayment/v1/payments/{reference}' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status and request id of a failed access token request', async () => {
    const { gw } = gateway({ 'POST /accesstoken/get': { status: 401, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 401, requestId: UUID, method: 'POST', pathTemplate: '/accesstoken/get' });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });

  it('carry the status of a second 401 after a new token', async () => {
    const { gw, calls } = gateway({ [PAYMENT]: { status: 401, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(calls.filter(call => call.path === `/epayment/v1/payments/${REFERENCE}`)).toHaveLength(2);
    expect(result.failure).toEqual({ httpStatus: 401, requestId: UUID, method: 'GET', pathTemplate: '/epayment/v1/payments/{reference}' });
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const { gw } = gateway({
      [PAYMENT]: { status: 422, body: VENDOR_BODY, headers: { 'x-request-id': 'Jane Doe <jane@example.com>' } },
    });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.failure).toEqual({ httpStatus: 422, method: 'GET', pathTemplate: '/epayment/v1/payments/{reference}' });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of a key', async () => {
    // A key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const { gw } = gateway(
      { [PAYMENT]: { status: 500, body: {}, headers: { 'x-request-id': 'deadbeef00112233' } } },
      { clientSecret: 'deadbeef00112233-zq7k-wv9x-mt4p-0' },
    );
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.failure).toEqual({ httpStatus: 500, method: 'GET', pathTemplate: '/epayment/v1/payments/{reference}' });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not the upstream API', async () => {
    const { gw } = gateway();
    expect((await gw.callTool('get_payment', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = gateway(
      {},
      {
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      },
    ).gw;
    expect((await offline.callTool('get_payment', { reference: REFERENCE })).failure).toBeUndefined();
  });

  it('carry the status of a failed events read when a capture or refund is refused, and nothing is sent', async () => {
    const reference = 'fjord-order-10042';
    const path = `/epayment/v1/payments/${reference}`;
    for (const tool of ['capture_payment', 'refund_payment']) {
      const { gw, calls } = gateway(
        {
          [`GET ${path}`]: { body: payment() },
          [`GET ${path}/events`]: { status: 503, body: VENDOR_BODY, headers: { 'x-request-id': UUID } },
        },
        { policy: { enableWrites: true } },
      );
      const result = await gw.callTool(tool, { reference, amount: 60_000, currency: 'DKK', idempotencyKey: 'op-0001-aaaa' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/^Refused: /);
      expect(result.failure).toEqual({ httpStatus: 503, requestId: UUID, method: 'GET', pathTemplate: '/epayment/v1/payments/{reference}/events' });
      expect(JSON.stringify(result)).not.toContain('Jane Doe');
      expect(calls.filter(call => call.method === 'POST' && call.path.startsWith('/epayment/'))).toHaveLength(0);
    }
  });

  it('have no metadata when a capture is refused after the events were read', async () => {
    const reference = 'fjord-order-10042';
    const path = `/epayment/v1/payments/${reference}`;
    const { gw } = gateway(
      { [`GET ${path}`]: { body: payment() }, [`GET ${path}/events`]: { body: [] } },
      { policy: { enableWrites: true } },
    );
    const result = await gw.callTool('capture_payment', { reference, amount: 60_000, currency: 'DKK', idempotencyKey: 'op-0001-aaaa' });
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const { gw } = gateway({
      [PAYMENT]: { body: { reference: REFERENCE, state: 'AUTHORIZED' }, headers: { 'x-request-id': UUID } },
      [`${PAYMENT}/events`]: { body: [] },
    });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});

describe("Vipps MobilePay's error code and trace id", () => {
  const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const EPAYMENT_ERROR = {
    type: 'https://httpstatuses.io/400',
    title: 'Cannot capture before reservation for Jane Doe',
    status: 400,
    detail: 'Jane Doe, phone 4512345678',
    instance: `/v1/payments/${REFERENCE}/capture`,
    traceId: TRACE,
    extraDetails: [
      { name: 'reference', reason: 'Jane Doe' },
      { name: 'ErrorCode', reason: '6080' },
    ],
  };

  it('takes only the error code and the trace id from the body, with the method and the path as a template', async () => {
    const records: Array<Record<string, unknown>> = [];
    const { gw } = gateway(
      {
        [PAYMENT]: { body: payment({ reference: REFERENCE }) },
        [`GET /epayment/v1/payments/${REFERENCE}/events`]: { body: [] },
        [`POST /epayment/v1/payments/${REFERENCE}/capture`]: {
          status: 400,
          body: EPAYMENT_ERROR,
          headers: { 'content-type': 'application/problem+json' },
        },
      },
      { policy: { enableWrites: true, audit: record => void records.push(record) } },
    );
    const result = await gw.callTool('capture_payment', { reference: REFERENCE, amount: 1000, currency: 'DKK', idempotencyKey: 'op-0001-aaaa' });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({
      httpStatus: 400,
      method: 'POST',
      pathTemplate: '/epayment/v1/payments/{reference}/capture',
      errorCode: '6080',
      traceId: TRACE,
    });
    const error = records.find(record => record.action === 'error');
    expect(error).toMatchObject({
      httpStatus: 400,
      method: 'POST',
      pathTemplate: '/epayment/v1/payments/{reference}/capture',
      errorCode: '6080',
      traceId: TRACE,
    });
    for (const text of [JSON.stringify(result), JSON.stringify(records)]) {
      expect(text).not.toContain('Jane Doe');
      expect(text).not.toContain('4512345678');
      expect(text).not.toContain(REFERENCE);
      expect(text).not.toContain('httpstatuses');
    }
  });

  it('drops a code or trace id out of form, and reads no body that is not JSON', async () => {
    const odd = { ...EPAYMENT_ERROR, traceId: 'Jane Doe', extraDetails: [{ name: 'ErrorCode', reason: 'Jane Doe' }] };
    const { gw } = gateway({ [PAYMENT]: { status: 400, body: odd } });
    expect((await gw.callTool('get_payment', { reference: REFERENCE })).failure).toEqual({
      httpStatus: 400,
      method: 'GET',
      pathTemplate: '/epayment/v1/payments/{reference}',
    });
    const text = gateway({ [PAYMENT]: { status: 500, body: '6080', headers: { 'content-type': 'text/plain' } } }).gw;
    expect((await text.callTool('get_payment', { reference: REFERENCE })).failure).toEqual({
      httpStatus: 500,
      method: 'GET',
      pathTemplate: '/epayment/v1/payments/{reference}',
    });
  });

  it('keeps an error code, a trace id and a UUID context id only in their forms', () => {
    expect(vendorErrorFields({ extraDetails: [{ name: 'ErrorCode', reason: '6080' }], traceId: TRACE })).toEqual({ errorCode: '6080', traceId: TRACE });
    expect(vendorErrorFields({ errorCode: 35, contextId: UUID })).toEqual({ errorCode: '35', traceId: UUID });
    expect(vendorErrorFields({ code: 'invalid_request', traceId: 'abc' })).toEqual({});
    expect(vendorErrorFields({ errorCode: '6080 for Jane Doe' })).toEqual({});
    expect(vendorErrorFields(['6080'])).toEqual({});
    expect(vendorErrorFields('6080')).toEqual({});
  });

  it('gives every allowed request a template without ids, dates or query', () => {
    expect(requestTemplate('GET', `/epayment/v1/payments/${REFERENCE}/events`)).toBe('/epayment/v1/payments/{reference}/events');
    expect(requestTemplate('GET', '/report/v2/ledgers/302321/funds/dates/2026-11-20')).toBe('/report/v2/ledgers/{ledgerId}/funds/dates/{date}');
    expect(requestTemplate('GET', '/recurring/v3/agreements?status=ACTIVE')).toBe('/recurring/v3/agreements');
    expect(requestTemplate('DELETE', '/recurring/v3/agreements/agr_1/charges/chr_1')).toBe('/recurring/v3/agreements/{agreementId}/charges/{chargeId}');
    expect(requestTemplate('POST', '/accesstoken/get')).toBe('/accesstoken/get');
    expect(requestTemplate('POST', '/recurring/v3/agreements')).toBeUndefined();
  });
});
