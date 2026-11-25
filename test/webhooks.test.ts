import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIPPS_PAYMENT_EVENTS, vippsGatewayTools } from '../src/gateway.js';
import { isAllowedRequest } from '../src/vipps/client.js';
import { apiCalls, gateway, KEYS } from './helpers.js';

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('VIPPS_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

const ADDRESS = 'https://events.example.com/fjordbakeriet';
const REGISTRATION_ID = 'reg-fjord-one';
// Made up for the test, in the form Vipps MobilePay gives a registration's secret.
const WEBHOOK_SECRET = 'notreal-webhook-signing-secret';
/** A made-up secret in the form of a UUID, as Vipps MobilePay's guide shows one. */
const UUID_SECRET = '7a1b2c3d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';

describe('webhook registration for the host', () => {
  it('registers the address for chosen ePayment events and returns the id and the secret, once', async () => {
    const { gw, calls } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: WEBHOOK_SECRET } } });
    const events = ['epayments.payment.authorized.v1', 'epayments.payment.captured.v1'] as const;
    expect(await gw.registerPaymentEvents(ADDRESS, events)).toEqual({ id: REGISTRATION_ID, secret: WEBHOOK_SECRET });
    const [call] = apiCalls(calls);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ url: ADDRESS, events: [...events] });
    expect(call?.headers['Merchant-Serial-Number']).toBe(KEYS.merchantSerialNumber);
    // The same address and events give the same operation key.
    expect(call?.headers['Idempotency-Key']).toMatch(/^wh-[A-Za-z0-9]{32}$/);
  });

  it('refuses an internal or non-public destination before anything is sent', async () => {
    const { gw, calls } = gateway();
    const inward = [
      'https://localhost/x',
      'https://api.localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://172.16.4.2/x',
      'https://192.168.1.10/x',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://printer.local/x',
      'https://intranet/x',
      'https://api.internal/x',
      'https://router.lan/x',
      'https://nas.home.arpa/x',
      'https://events.example.com:8443/x',
    ];
    for (const address of inward) {
      await expect(gw.registerPaymentEvents(address, ['epayments.payment.captured.v1']), address).rejects.toThrow(/Refused/);
    }
    expect(apiCalls(calls)).toEqual([]);
  });

  it('sends the same operation key for the same address and set of events, in any order', async () => {
    const { gw, calls } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: WEBHOOK_SECRET } } });
    await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1', 'epayments.payment.authorized.v1']);
    await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.authorized.v1', 'epayments.payment.captured.v1', 'epayments.payment.authorized.v1']);
    await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.authorized.v1']);
    const [first, second, other] = apiCalls(calls);
    expect(second?.headers['Idempotency-Key']).toBe(first?.headers['Idempotency-Key']);
    expect(second?.body).toEqual(first?.body);
    expect(other?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
  });

  it('masks the secret from then on: in a later failure, its metadata, a result and the audit', async () => {
    const records: unknown[] = [];
    const { gw } = gateway({
      'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: UUID_SECRET } },
      'GET /epayment/v1/payments/fjord-order-10042': { status: 500, body: { detail: UUID_SECRET }, headers: { 'x-request-id': UUID_SECRET } },
      'GET /epayment/v1/payments/fjord-order-10043': { body: { reference: 'fjord-order-10043', note: UUID_SECRET } },
      'DELETE /webhooks/v1/webhooks/reg-fjord-two': { status: 503, headers: { 'x-request-id': UUID_SECRET } },
    }, { policy: { audit: record => void records.push(record) } });
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(UUID_SECRET);
    const failed = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain(UUID_SECRET);
    expect(failed.failure?.requestId).toBeUndefined();
    // An answer that holds it is never passed on with it.
    expect(JSON.stringify(await gw.callTool('get_payment', { reference: 'fjord-order-10043' }))).not.toContain(UUID_SECRET);
    const removal = await gw.removeWebhook('reg-fjord-two').catch((e: unknown) => e as Error);
    expect(String((removal as Error).message)).not.toContain(UUID_SECRET);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(UUID_SECRET);
  });

  it('refuses an address that is not https, or an unknown event, before anything is sent', async () => {
    const { gw, calls } = gateway();
    await expect(gw.registerPaymentEvents('http://host.example/x', ['epayments.payment.captured.v1'])).rejects.toThrow(/https URL/);
    await expect(gw.registerPaymentEvents('https://user:pw@host.example/x', ['epayments.payment.captured.v1'])).rejects.toThrow(/https URL/);
    await expect(gw.registerPaymentEvents(ADDRESS, ['recurring.agreement.stopped.v1' as never])).rejects.toThrow(/known ePayment events/);
    await expect(gw.registerPaymentEvents(ADDRESS, [])).rejects.toThrow(/known ePayment events/);
    expect(apiCalls(calls)).toEqual([]);
  });

  it('never quotes an answer it cannot use, which may hold the secret', async () => {
    const { gw } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: 'short' } } });
    const error = await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1']).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('short');
    expect((error as Error).cause).toBeUndefined();
  });

  it('lists the registrations as id, address and events only', async () => {
    const { gw } = gateway({
      'GET /webhooks/v1/webhooks': {
        body: { webhooks: [{ id: REGISTRATION_ID, url: ADDRESS, events: ['epayments.payment.captured.v1'], extra: 'dropped' }, { id: 1 }] },
      },
    });
    expect(await gw.listWebhooks()).toEqual([{ id: REGISTRATION_ID, url: ADDRESS, events: ['epayments.payment.captured.v1'] }]);
  });

  it('removes one registration by its id, and refuses anything else as an id', async () => {
    const { gw, calls } = gateway({ [`DELETE /webhooks/v1/webhooks/${REGISTRATION_ID}`]: { status: 204 } });
    await gw.removeWebhook(REGISTRATION_ID);
    expect(apiCalls(calls).map(c => `${c.method} ${c.path}`)).toEqual([`DELETE /webhooks/v1/webhooks/${REGISTRATION_ID}`]);
    await expect(gw.removeWebhook('../payments')).rejects.toThrow(/registration id/);
  });

  it('gives a failure from Vipps MobilePay as our own text, without the keys', async () => {
    const { gw } = gateway({ 'POST /webhooks/v1/webhooks': { status: 400, body: { detail: 'bad' } } });
    const error = await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1']).catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(/HTTP 400/);
    expect((error as Error).message).not.toContain(KEYS.clientSecret);
  });

  it('is no tool: no AI client can register, list or remove an address', () => {
    expect(vippsGatewayTools.map(t => t.name).some(name => /webhook/i.test(name))).toBe(false);
    expect(VIPPS_PAYMENT_EVENTS).toContain('epayments.payment.authorized.v1');
    expect(isAllowedRequest('DELETE', '/webhooks/v1/webhooks')).toBe(false);
    expect(isAllowedRequest('POST', '/webhooks/v1/webhooks/x')).toBe(false);
  });
});
