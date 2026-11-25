import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIPPS_PAYMENT_EVENTS, vippsGatewayTools, type GatewayJsonObject } from '../src/gateway.js';
import { isAllowedRequest } from '../src/vipps/client.js';
import { apiCalls, fakeToken, gateway, KEYS, payment, TOKEN } from './helpers.js';

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
const SIGNING_VALUE = 'whsig_QmvZrLpTxKwYbN';
/** A made-up secret in the form of a UUID, as Vipps MobilePay's guide shows one. */
const UUID_SIGNING_VALUE = '7a1b2c3d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';

describe('webhook registration for the host', () => {
  it('registers the address for chosen ePayment events and returns the id and the secret, once', async () => {
    const { gw, calls } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: SIGNING_VALUE } } });
    const events = ['epayments.payment.authorized.v1', 'epayments.payment.captured.v1'] as const;
    expect(await gw.registerPaymentEvents(ADDRESS, events)).toEqual({ id: REGISTRATION_ID, secret: SIGNING_VALUE });
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
    const { gw, calls } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: SIGNING_VALUE } } });
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
      'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: UUID_SIGNING_VALUE } },
      'GET /epayment/v1/payments/fjord-order-10042': { status: 500, body: { detail: UUID_SIGNING_VALUE }, headers: { 'x-request-id': UUID_SIGNING_VALUE } },
      'GET /epayment/v1/payments/fjord-order-10043': { body: payment({ reference: 'fjord-order-10043', pspReference: UUID_SIGNING_VALUE }) },
      'DELETE /webhooks/v1/webhooks/reg-fjord-two': { status: 503, headers: { 'x-request-id': UUID_SIGNING_VALUE } },
    }, { policy: { audit: record => void records.push(record) } });
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(UUID_SIGNING_VALUE);
    const failed = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain(UUID_SIGNING_VALUE);
    expect(failed.failure?.requestId).toBeUndefined();
    // An answer that holds it is never passed on with it, and the call itself still succeeds.
    const read = await gw.callTool('get_payment', { reference: 'fjord-order-10043' });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).not.toContain(UUID_SIGNING_VALUE);
    const removal = await gw.removeWebhook('reg-fjord-two').catch((e: unknown) => e as Error);
    expect(String((removal as Error).message)).not.toContain(UUID_SIGNING_VALUE);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(UUID_SIGNING_VALUE);
  });

  it('masks the secret in the list of registrations too, as in any other value it returns', async () => {
    const { gw } = gateway({
      'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: UUID_SIGNING_VALUE } },
      'GET /webhooks/v1/webhooks': {
        body: { webhooks: [{ id: REGISTRATION_ID, url: `${ADDRESS}?k=${UUID_SIGNING_VALUE}`, events: [UUID_SIGNING_VALUE, 'epayments.payment.captured.v1'] }] },
      },
    });
    await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1']);
    const listed = await gw.listWebhooks();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(UUID_SIGNING_VALUE);
    expect(JSON.stringify(listed)).not.toContain(UUID_SIGNING_VALUE.slice(9, 23));
  });

  it('masks a key in the list of registrations, as in a tool result', async () => {
    const { gw } = gateway({
      'GET /webhooks/v1/webhooks': { body: { webhooks: [{ id: REGISTRATION_ID, url: `${ADDRESS}?c=${KEYS.clientSecret}`, events: [] }] } },
    });
    expect(JSON.stringify(await gw.listWebhooks())).not.toContain(KEYS.clientSecret);
  });

  it('refuses an empty fragment too', async () => {
    const { gw, calls } = gateway();
    await expect(gw.registerPaymentEvents('https://events.example.com/x#', ['epayments.payment.captured.v1'])).rejects.toThrow(/https URL/);
    expect(apiCalls(calls)).toEqual([]);
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

/** A sample input per tool: the sweep below fails for a tool without one, so a new tool is swept too. */
const SAMPLES: Record<string, GatewayJsonObject> = {
  check_connection: {},
  list_ledgers: {},
  get_funds_summary: { ledgerId: '302321', fromDate: '2026-11-01', toDate: '2026-11-02' },
  list_transactions: { ledgerId: '302321', fromDate: '2026-11-01', toDate: '2026-11-01', topic: 'fees' },
  get_payment: { reference: 'fjord-order-10042' },
  list_agreements: { status: 'STOPPED' },
  get_agreement: { agreementId: 'agr_7TqP2m' },
  list_charges: { agreementId: 'agr_7TqP2m' },
  get_charge: { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz' },
  find_charge: { chargeId: 'chr-5kSeqz' },
  get_receipt: { reference: 'fjord-order-10042' },
  list_sales_units: {},
  get_sales_unit: {},
  list_qr_codes: {},
  create_payment: { reference: 'fjord-order-10077', amount: 24_900, currency: 'DKK', description: 'Kagebord', delivery: 'link', returnUrl: 'https://fjordbakeriet.example.com/tak' },
  capture_payment: { reference: 'fjord-order-10042', amount: 100, currency: 'DKK', idempotencyKey: 'op-0001-aaaa' },
  refund_payment: { reference: 'fjord-order-10042', amount: 100, currency: 'DKK', idempotencyKey: 'op-0001-aaaa' },
  cancel_payment: { reference: 'fjord-order-10042', idempotencyKey: 'op-0001-aaaa' },
  refund_charge: { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', amount: 100, currency: 'DKK', description: 'Fejl i ordren', idempotencyKey: 'op-0001-aaaa' },
  cancel_charge: { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', idempotencyKey: 'op-0001-aaaa' },
};

describe('the secret, swept through every result', () => {
  // Varied: the secret's form, and an id that is ordinary. (An id holding the secret, and a secret that is a key, are
  // withheld at registration; see 'what a registration answer gives on'.)
  it.each([UUID_SIGNING_VALUE, SIGNING_VALUE, 'c0ffee00-1234-4bcd-8ef0-a1b2c3d4e5f6'])('is never in what any tool or host function returns or throws, once registered (%#)', async SWEPT => {
    let status = 200;
    let registered = false;
    // After the registration every answer carries the secret wherever a text can stand: values, a key, a header.
    const answer = (url: URL) => {
      if (!registered && url.pathname === '/webhooks/v1/webhooks') {
        registered = true;
        return { body: { id: REGISTRATION_ID, secret: SWEPT } };
      }
      return {
        status,
        headers: { 'x-request-id': SWEPT },
        body:
          url.pathname === '/webhooks/v1/webhooks'
            ? { id: REGISTRATION_ID, secret: SWEPT, webhooks: [{ id: REGISTRATION_ID, url: `${ADDRESS}?${SWEPT}`, events: [SWEPT] }] }
            : payment({ reference: SWEPT, pspReference: SWEPT, [SWEPT]: SWEPT, note: SWEPT }),
      };
    };
    const routes = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => (key === 'POST /accesstoken/get' ? undefined : answer),
    });
    const records: unknown[] = [];
    const { gw } = gateway(routes as never, { policy: { enableWrites: true, audit: record => void records.push(record) } });
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(SWEPT);
    const seen: unknown[] = [];
    for (status of [200, 400, 500]) {
      for (const tool of vippsGatewayTools) {
        expect(SAMPLES, `a sample for ${tool.name}`).toHaveProperty(tool.name);
        seen.push(await gw.callTool(tool.name, SAMPLES[tool.name]!));
      }
      seen.push(await gw.listWebhooks().catch((e: unknown) => String(e)));
      // A new registration gives its secret on, as asked; only that field may hold it.
      const again = await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.authorized.v1']).catch((e: unknown) => String(e));
      seen.push(typeof again === 'string' ? again : { ...again, secret: again.secret === SWEPT ? 'the one asked for' : again.secret });
      seen.push(await gw.removeWebhook(REGISTRATION_ID).catch((e: unknown) => String(e)));
    }
    expect(seen.length).toBe(3 * (vippsGatewayTools.length + 3));
    const text = JSON.stringify([seen, records]);
    expect(text).not.toContain(SWEPT);
    expect(text).not.toContain(SWEPT.slice(9, 23));
  });
});

describe('what a registration answer gives on', () => {
  const register = async (answer: Record<string, unknown>) => {
    const records: unknown[] = [];
    const { gw } = gateway(
      {
        'POST /webhooks/v1/webhooks': { body: answer },
        'GET /webhooks/v1/webhooks': { body: { webhooks: [{ id: REGISTRATION_ID, url: ADDRESS, events: [] }] } },
      },
      { policy: { audit: record => void records.push(record) } },
    );
    const result = await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1']).catch((e: unknown) => e as Error);
    const listed = await gw.listWebhooks().catch((e: unknown) => String(e));
    return { gw, result, text: JSON.stringify([result instanceof Error ? result.message : result, listed, records]) };
  };

  // Several made-up registration values, in the forms Vipps MobilePay's guides show.
  const values = [UUID_SIGNING_VALUE, SIGNING_VALUE, 'c0ffee00-1234-4bcd-8ef0-a1b2c3d4e5f6', 'Zx9_Ym8-Wv7_Ut6-Sr5_Qp4'];

  it('withholds an id that is, or holds, the new secret, whatever the secret', async () => {
    for (const value of values) {
      for (const id of [value, `reg-${value}`.slice(0, 64), `${value.slice(0, 20)}-x`]) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) continue;
        const { result, text } = await register({ id, secret: value });
        expect(result, `${id} / ${value}`).toBeInstanceOf(Error);
        expect(text, `${id} / ${value}`).not.toContain(value);
        expect(text, `${id} / ${value}`).not.toContain(value.slice(2, 14));
      }
    }
  });

  it('withholds a secret that is, or shares a piece with, one of the instance\'s keys', async () => {
    for (const key of [KEYS.clientSecret, KEYS.clientId, KEYS.subscriptionKey]) {
      for (const secret of [key, `${key.slice(0, 12)}-new-value-zzzz`, `prefix-${key}`]) {
        const { result, text } = await register({ id: REGISTRATION_ID, secret });
        expect(result, secret.slice(0, 4)).toBeInstanceOf(Error);
        expect(text).not.toContain(key);
        expect(text).not.toContain(key.slice(0, 12));
      }
    }
  });

  it('gives a new secret on once, and the same secret again on a repeat, and masks it everywhere else', async () => {
    for (const value of values) {
      const { gw, result, text } = await register({ id: REGISTRATION_ID, secret: value });
      expect(result).toEqual({ id: REGISTRATION_ID, secret: value });
      // Only the field asked for holds it.
      expect(text.split(value).length - 1).toBe(1);
      expect(await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).toEqual({ id: REGISTRATION_ID, secret: value });
    }
  });
});

describe('a registration answer, refused or not, never lets its secret out later', () => {
  const S = 'Lm4_Nq7-Rt2_Vx9-Kp3_Hz6';
  /** An instance whose registration answers `answer`, and whose every later answer carries S where a text can stand. */
  const instance = (answer: unknown) => {
    const records: unknown[] = [];
    const later = { status: 200, headers: { 'x-request-id': S }, body: payment({ reference: S, pspReference: S, note: S }) };
    const { gw } = gateway(
      {
        'POST /webhooks/v1/webhooks': { body: answer },
        'GET /webhooks/v1/webhooks': { body: { webhooks: [{ id: REGISTRATION_ID, url: `${ADDRESS}?${S}`, events: [S] }] } },
        'GET /epayment/v1/payments/fjord-order-10042': later,
        'GET /epayment/v1/payments/fjord-order-10042/events': { body: [] },
        'DELETE /webhooks/v1/webhooks/reg-fjord-one': { status: 500, headers: { 'x-request-id': S } },
      },
      { policy: { audit: record => void records.push(record) } },
    );
    return { gw, records };
  };
  const afterwards = async (gw: ReturnType<typeof gateway>['gw'], records: unknown[]) =>
    JSON.stringify([
      await gw.listWebhooks().catch((e: unknown) => String(e)),
      await gw.callTool('get_payment', { reference: 'fjord-order-10042' }),
      await gw.removeWebhook(REGISTRATION_ID).catch((e: unknown) => String(e)),
      records,
    ]);

  it.each([
    ['an id that is not an id', { id: '../x', secret: S }],
    ['no id', { secret: S }],
    ['an id that is the secret', { id: S.replace(/_/g, '-'), secret: S }],
    ['a secret too short to be one', { id: REGISTRATION_ID, secret: S.slice(0, 12) }],
    ['the secret inside a list', { id: REGISTRATION_ID, secret: [S] }],
    ['the secret inside an object', { id: REGISTRATION_ID, secret: { value: S } }],
  ])('masks it when the answer is refused: %s', async (_name, answer) => {
    const { gw, records } = instance(answer);
    await expect(gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).rejects.toThrow();
    const text = await afterwards(gw, records);
    for (const piece of [S, S.slice(0, 12), S.slice(6, 18)]) expect(text).not.toContain(piece);
  });

  it('masks it when the answer is refused because the secret shares a piece with a key', async () => {
    const value = `${KEYS.clientSecret.slice(0, 10)}${S}`;
    const { gw, records } = instance({ id: REGISTRATION_ID, secret: value });
    await expect(gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).rejects.toThrow(/withheld/);
    expect(await afterwards(gw, records)).not.toContain(S);
  });
});

describe('a registration secret that is or holds another secret of the instance', () => {
  // An access token of a form that shares nothing with the made-up keys, so only the token itself can match.
  const ISSUED_VALUE = 'Jw8Mn3Bq7Vc2Xz5Lp9Rk4Td6';
  const register = (answers: unknown[]) => {
    let n = 0;
    const { gw } = gateway({
      'POST /accesstoken/get': { body: { token_type: 'Bearer', expires_in: '3600', access_token: ISSUED_VALUE } },
      'POST /webhooks/v1/webhooks': () => ({ body: answers[Math.min(n++, answers.length - 1)] }),
    });
    return gw;
  };

  it.each([
    ['is', () => ISSUED_VALUE],
    ['starts with', () => `${ISSUED_VALUE}-more`],
    ['holds', () => `pre-${ISSUED_VALUE}-post`],
    ['is a piece of', () => ISSUED_VALUE.slice(2, 18)],
  ])('withholds a secret that %s the access token', async (_how, secret) => {
    const gw = register([{ id: REGISTRATION_ID, secret: secret() }]);
    const error = await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1']).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(ISSUED_VALUE.slice(2, 18));
  });

  it('withholds the access token of the helpers too (a token the keys also resemble)', async () => {
    const { gw } = gateway({ 'POST /webhooks/v1/webhooks': { body: { id: REGISTRATION_ID, secret: TOKEN } } });
    await expect(gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).rejects.toThrow(/withheld/);
  });

  const FIRST = 'Qa1_Wb2-Ec3_Rd4-Tf5_Yg6';
  it.each([
    ['starts with', `${FIRST}-and-more`],
    ['holds', `zz-${FIRST}-zz`],
    ['is a piece of', FIRST.slice(2, 18)],
  ])('withholds a new secret that %s an earlier registration secret', async (_how, secret) => {
    const gw = register([{ id: REGISTRATION_ID, secret: FIRST }, { id: 'reg-fjord-two', secret }]);
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(FIRST);
    await expect(gw.registerPaymentEvents(ADDRESS, ['epayments.payment.authorized.v1'])).rejects.toThrow(/withheld/);
  });

  it('gives on exactly the same earlier registration secret again: a repeat', async () => {
    const gw = register([{ id: REGISTRATION_ID, secret: FIRST }, { id: REGISTRATION_ID, secret: FIRST }]);
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(FIRST);
    expect((await gw.registerPaymentEvents(ADDRESS, ['epayments.payment.captured.v1'])).secret).toBe(FIRST);
  });
});
