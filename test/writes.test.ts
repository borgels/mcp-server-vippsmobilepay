import { describe, expect, it } from 'vitest';
import { resolveVippsChange } from '../src/gateway.js';
import { apiCalls, charge, gateway, payment, texts } from './helpers.js';

const WRITES = { policy: { enableWrites: true } };
const PAY = '/epayment/v1/payments/fjord-order-10042';
const CHARGE = '/recurring/v3/agreements/agr_7TqP2m/charges/chr-5kSeqz';

describe('write gate', () => {
  it('refuses every write tool unless the host enables writes, without any request', async () => {
    const { gw, calls } = gateway();
    for (const [tool, input] of [
      ['capture_payment', { reference: 'fjord-order-10042', amount: 100, currency: 'DKK' }],
      ['refund_payment', { reference: 'fjord-order-10042', amount: 100, currency: 'DKK' }],
      ['cancel_payment', { reference: 'fjord-order-10042' }],
      ['refund_charge', { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', amount: 100, currency: 'DKK', description: 'Fejl i ordren' }],
      ['cancel_charge', { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz' }],
    ] as const) {
      const result = await gw.callTool(tool, input);
      expect(result.isError, tool).toBe(true);
      expect(texts(result)[0]).toMatch(/write tool is disabled.*embedding host has not enabled writes/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('ePayment changes', () => {
  it('captures after checking state, currency and the amount left to capture', async () => {
    const { gw, calls } = gateway(
      {
        [`GET ${PAY}`]: { body: payment() },
        [`POST ${PAY}/capture`]: { body: { reference: 'fjord-order-10042', state: 'AUTHORIZED' } },
      },
      WRITES,
    );
    const result = await gw.callTool('capture_payment', {
      reference: 'fjord-order-10042',
      amount: 49_900,
      currency: 'DKK',
      idempotencyKey: 'capture-0001-aaaa',
    });
    expect(result.isError).toBeUndefined();
    const post = apiCalls(calls).find(call => call.method === 'POST');
    expect(post?.body).toEqual({ modificationAmount: { currency: 'DKK', value: 49_900 } });
    expect(post?.headers['Idempotency-Key']).toBe('capture-0001-aaaa');
  });

  it.each([
    ['a different currency', { amount: 100, currency: 'NOK' }, payment(), /in DKK, not NOK/],
    ['more than is left', { amount: 49_901, currency: 'DKK' }, payment(), /more than the 49900/],
    [
      'more than is left after a partial capture',
      { amount: 40_000, currency: 'DKK' },
      payment({
        aggregate: {
          authorizedAmount: { currency: 'DKK', value: 49_900 },
          capturedAmount: { currency: 'DKK', value: 10_000 },
          cancelledAmount: { currency: 'DKK', value: 0 },
          refundedAmount: { currency: 'DKK', value: 0 },
        },
      }),
      /more than the 39900/,
    ],
    ['a payment that is not authorized', { amount: 100, currency: 'DKK' }, payment({ state: 'CREATED' }), /only an authorized payment/],
    ['a payment it cannot read', { amount: 100, currency: 'DKK' }, { reference: 'fjord-order-10042' }, /expected form/],
  ])('refuses a capture of %s and sends nothing', async (_label, input, current, message) => {
    const { gw, calls } = gateway({ [`GET ${PAY}`]: { body: current } }, WRITES);
    const result = await gw.callTool('capture_payment', { reference: 'fjord-order-10042', ...input });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(message);
    expect(texts(result)[0]).toMatch(/nothing was sent/i);
    expect(apiCalls(calls).filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('refunds no more than is captured and not yet refunded', async () => {
    const captured = payment({
      state: 'AUTHORIZED',
      aggregate: {
        authorizedAmount: { currency: 'DKK', value: 49_900 },
        capturedAmount: { currency: 'DKK', value: 49_900 },
        cancelledAmount: { currency: 'DKK', value: 0 },
        refundedAmount: { currency: 'DKK', value: 9_900 },
      },
    });
    const { gw, calls } = gateway({ [`GET ${PAY}`]: { body: captured }, [`POST ${PAY}/refund`]: { body: {} } }, WRITES);
    expect((await gw.callTool('refund_payment', { reference: 'fjord-order-10042', amount: 40_001, currency: 'DKK' })).isError).toBe(true);
    expect(apiCalls(calls).filter(call => call.method === 'POST')).toHaveLength(0);
    expect((await gw.callTool('refund_payment', { reference: 'fjord-order-10042', amount: 40_000, currency: 'DKK' })).isError).toBeUndefined();
    expect(apiCalls(calls).find(call => call.method === 'POST')?.body).toEqual({ modificationAmount: { currency: 'DKK', value: 40_000 } });
  });

  it('cancels, with cancelTransactionOnly when asked', async () => {
    const { gw, calls } = gateway({ [`POST ${PAY}/cancel`]: { body: { state: 'TERMINATED' } } }, WRITES);
    await gw.callTool('cancel_payment', { reference: 'fjord-order-10042' });
    await gw.callTool('cancel_payment', { reference: 'fjord-order-10042', cancelTransactionOnly: true });
    expect(apiCalls(calls).map(call => call.body)).toEqual([{}, { cancelTransactionOnly: true }]);
  });

  it('refuses amounts that are not whole minor units within the API limits, and unsupported currencies', async () => {
    const { gw, calls } = gateway({}, WRITES);
    for (const input of [
      { amount: 12.5, currency: 'DKK' },
      { amount: 0, currency: 'DKK' },
      { amount: 65_000_001, currency: 'DKK' },
      { amount: '100', currency: 'DKK' },
      { amount: 100, currency: 'dkk' },
      { amount: 100, currency: 'SEK' },
    ]) {
      expect((await gw.callTool('capture_payment', { reference: 'fjord-order-10042', ...input })).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Recurring charge changes', () => {
  it('refunds a charge after checking currency and amount, and sends the description', async () => {
    const { gw, calls } = gateway({ [`GET ${CHARGE}`]: { body: charge() }, [`POST ${CHARGE}/refund`]: { status: 204 } }, WRITES);
    const result = await gw.callTool('refund_charge', {
      agreementId: 'agr_7TqP2m',
      chargeId: 'chr-5kSeqz',
      amount: 19_900,
      currency: 'DKK',
      description: 'Leveringen udeblev',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      refundRequested: true,
      agreementId: 'agr_7TqP2m',
      chargeId: 'chr-5kSeqz',
      amount: 19_900,
      currency: 'DKK',
    });
    expect(apiCalls(calls).find(call => call.method === 'POST')?.body).toEqual({ amount: 19_900, description: 'Leveringen udeblev' });
  });

  it('refuses a charge refund in another currency or above what is left', async () => {
    const { gw, calls } = gateway(
      { [`GET ${CHARGE}`]: { body: charge({ summary: { captured: 19_900, refunded: 19_000, cancelled: 0 } }) } },
      WRITES,
    );
    const base = { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', description: 'Fejl' };
    expect(texts(await gw.callTool('refund_charge', { ...base, amount: 100, currency: 'NOK' }))[0]).toMatch(/in DKK, not NOK/);
    expect(texts(await gw.callTool('refund_charge', { ...base, amount: 901, currency: 'DKK' }))[0]).toMatch(/more than the 900/);
    expect(apiCalls(calls).filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('cancels a pending charge with DELETE on the charge, and refuses one already charged', async () => {
    const { gw, calls } = gateway(
      {
        [`GET ${CHARGE}`]: { body: charge({ status: 'PENDING' }) },
        [`DELETE ${CHARGE}`]: { status: 204 },
        'GET /recurring/v3/agreements/agr_7TqP2m/charges/chr-done': { body: charge({ id: 'chr-done', status: 'CHARGED' }) },
      },
      WRITES,
    );
    const ok = await gw.callTool('cancel_charge', { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz' });
    expect(ok.structuredContent).toEqual({ cancelRequested: true, agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', previousStatus: 'PENDING' });
    const refused = await gw.callTool('cancel_charge', { agreementId: 'agr_7TqP2m', chargeId: 'chr-done' });
    expect(texts(refused)[0]).toMatch(/only a pending, due, reserved or partially captured charge/);
    expect(apiCalls(calls).filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([CHARGE]);
  });
});

describe('resolveVippsChange', () => {
  it('returns the action, record and typed log values, never the description', () => {
    const resolution = resolveVippsChange('refund_charge', {
      agreementId: 'agr_7TqP2m',
      chargeId: 'chr-5kSeqz',
      amount: 19_900,
      currency: 'DKK',
      description: 'Ole Hansen ringede og var vred',
      idempotencyKey: 'refund-0001-aaaa',
    });
    expect(resolution).toEqual({
      ok: true,
      change: {
        tool: 'refund_charge',
        action: 'refund',
        record: 'charge',
        movesMoney: true,
        values: { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz', amount: 19_900, currency: 'DKK', idempotencyKey: 'refund-0001-aaaa' },
      },
    });
    expect(JSON.stringify(resolution)).not.toContain('Ole');
  });

  it('accepts the name with the prefix, and refuses read tools, unknown tools and invalid input', () => {
    expect(resolveVippsChange('vipps_cancel_payment', { reference: 'fjord-order-10042' })).toMatchObject({
      ok: true,
      change: { action: 'cancel', record: 'payment', values: { reference: 'fjord-order-10042' } },
    });
    expect(resolveVippsChange('get_payment', { reference: 'fjord-order-10042' })).toEqual({ ok: false, reason: 'get_payment is not a write tool.' });
    expect(resolveVippsChange('delete_agreement', {})).toMatchObject({ ok: false });
    expect(resolveVippsChange('capture_payment', { reference: 'fjord-order-10042', amount: 1.5, currency: 'DKK' })).toMatchObject({ ok: false });
    expect(resolveVippsChange('capture_payment', { reference: 'Ole Hansen', amount: 100, currency: 'DKK' })).toMatchObject({ ok: false });
  });
});
