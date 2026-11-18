// One property, through every channel: no piece (six characters or more) of an instance's client_id,
// client_secret or subscription key, and not the access token, reaches a host result, a thrown error or an
// audit record. The upstream echoes them whole, in fragments, in object keys, in error bodies and in a
// redirect's Location; the caller and the input carry them too.
import { describe, expect, it } from 'vitest';
import { FRAGMENT_LENGTH } from '../src/errors.js';
import { createVippsMobilePayGateway, type GatewayToolResult } from '../src/gateway.js';
import { KEY_REFUSED } from '../src/key-admission.js';
import { fakeKey, fakeToken } from './helpers.js';

// Each key holds a quote and a backslash, so a form serialised before it is redacted would show.
const KEYS = {
  clientId: `${fakeKey('leak-id', 12)}"\\${fakeKey('leak-id-2', 12)}`,
  clientSecret: `${fakeKey('leak-secret', 14)}"\\${fakeKey('leak-secret-2', 14)}`,
  subscriptionKey: `${fakeKey('leak-subscription', 16)}"\\${fakeKey('leak-subscription-2', 8)}`,
  merchantSerialNumber: '212345',
};
const TOKEN = fakeToken('leak');
const SECRETS = [KEYS.clientId, KEYS.clientSecret, KEYS.subscriptionKey];

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (const secret of SECRETS) {
    for (let i = 0; i + FRAGMENT_LENGTH <= secret.length; i += 1) {
      const piece = secret.slice(i, i + FRAGMENT_LENGTH);
      if (texts.some(text => text.includes(piece))) found.add(piece);
    }
  }
  if (texts.some(text => text.includes(TOKEN))) found.add('token');
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const upstream: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/accesstoken/get') return json({ access_token: TOKEN, expires_in: '3600' });
  const reference = url.pathname.split('/')[4] ?? '';
  if (init?.method === 'POST') return json({ echo: KEYS.clientSecret, [KEYS.subscriptionKey]: TOKEN });
  switch (reference) {
    case 'echo-whole-1':
      return json({ reference: KEYS.clientSecret, nested: { [KEYS.clientId]: [KEYS.subscriptionKey.slice(2, 14)] }, token: TOKEN });
    case 'echo-error-1':
      return json({ detail: `Rejected ${KEYS.clientSecret}`, title: TOKEN }, 400);
    case 'redirect-01':
      return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${KEYS.clientId}` } });
    case 'network-01':
      throw new TypeError(`fetch failed for ${KEYS.subscriptionKey}`, { cause: Object.assign(new Error(KEYS.clientSecret), { code: 'X' }) });
    default:
      return json({ title: `no stub ${KEYS.clientId}` }, 404);
  }
};

describe('no piece of a key leaves an instance', () => {
  it('holds for results, errors, input echoes and audit records', async () => {
    const records: unknown[] = [];
    const gw = createVippsMobilePayGateway({
      ...KEYS,
      environment: 'test',
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
    const results: GatewayToolResult[] = [];
    for (const reference of ['echo-whole-1', 'echo-error-1', 'redirect-01', 'network-01', 'missing-01']) {
      results.push(await gw.callTool('get_payment', { reference }, { caller: `caller ${KEYS.clientSecret}`, requestId: KEYS.clientId }));
    }
    results.push(await gw.callTool('cancel_payment', { reference: 'fjord-order-1' }));
    results.push(await gw.callTool(`get_payment ${KEYS.subscriptionKey}`, {}));
    results.push(await gw.callTool('get_payment', { reference: 'fjord-order-1', [KEYS.clientSecret]: KEYS.clientId }));
    results.push(await gw.callTool('refund_charge', { agreementId: 'agr_1', chargeId: 'chr_1', amount: 1, currency: 'DKK', description: KEYS.clientSecret }));

    expect(results[0]?.isError).toBeUndefined();
    expect(records.length).toBeGreaterThan(8);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('refuses keys that are too short or share text with our own texts, without repeating them', () => {
    for (const [name, value] of [
      ['clientSecret', 'short'],
      ['subscriptionKey', `${KEY_REFUSED.slice(0, 20)}xyzxyzxyz`],
      ['clientId', 'Unsupported Vipps MobilePay gateway tool'],
    ] as const) {
      let message = '';
      try {
        createVippsMobilePayGateway({ ...KEYS, environment: 'test', [name]: value });
      } catch (error) {
        message = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
      }
      expect(message, name).toMatch(/refused|too short/);
      for (let i = 0; i + FRAGMENT_LENGTH <= value.length; i += 1) {
        expect(message, name).not.toContain(value.slice(i, i + FRAGMENT_LENGTH));
      }
    }
  });

  it('throws construction errors in final form: no frames, no cause', () => {
    let error: Error | undefined;
    try {
      createVippsMobilePayGateway({ ...KEYS, environment: 'test', policy: { disabledTools: [KEYS.clientSecret] } });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(/disabledTools\[0\] is not a known tool/);
    expect(error?.stack).toBe(`${error?.name}: ${error?.message}`);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(leaks(error?.message)).toEqual([]);
  });
});
