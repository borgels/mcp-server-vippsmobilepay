// Failure metadata on gateway error results: the upstream API's HTTP status and its request id (a UUID or hex id
// only), for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureMetadata, requestIdFrom, VippsHttpError, vendorRequestId } from '../src/errors.js';
import { BASE, gateway } from './helpers.js';

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
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const { gw } = gateway({ [PAYMENT]: { status: 404, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status and request id of a failed access token request', async () => {
    const { gw } = gateway({ 'POST /accesstoken/get': { status: 401, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 401, requestId: UUID });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });

  it('carry the status of a second 401 after a new token', async () => {
    const { gw, calls } = gateway({ [PAYMENT]: { status: 401, body: VENDOR_BODY, headers: { 'x-request-id': UUID } } });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(calls.filter(call => call.path === `/epayment/v1/payments/${REFERENCE}`)).toHaveLength(2);
    expect(result.failure).toEqual({ httpStatus: 401, requestId: UUID });
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const { gw } = gateway({
      [PAYMENT]: { status: 422, body: VENDOR_BODY, headers: { 'x-request-id': 'Jane Doe <jane@example.com>' } },
    });
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of a key', async () => {
    // A key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const { gw } = gateway(
      { [PAYMENT]: { status: 500, body: {}, headers: { 'x-request-id': 'deadbeef00112233' } } },
      { clientSecret: 'deadbeef00112233-zq7k-wv9x-mt4p-0' },
    );
    const result = await gw.callTool('get_payment', { reference: REFERENCE });
    expect(result.failure).toEqual({ httpStatus: 500 });
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
