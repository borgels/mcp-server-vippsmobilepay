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
      return json({ reference: KEYS.clientSecret, state: TOKEN, nested: { [KEYS.clientId]: [KEYS.subscriptionKey.slice(2, 14)] }, token: TOKEN });
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

describe('base64 forms of the keys and credential-shaped text', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const b64url = (text: string) => b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('masks a key echoed base64- or base64url-encoded, alone or as a Basic credential', async () => {
    const echoes = [
      b64(KEYS.clientSecret),
      b64url(KEYS.subscriptionKey),
      b64(`${KEYS.clientId}:${KEYS.clientSecret}`),
      b64url(`${KEYS.clientId}:`),
    ];
    const gw = createVippsMobilePayGateway({
      ...KEYS,
      environment: 'test',
      maxAttempts: 1,
      sleep: async () => undefined,
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/accesstoken/get') return json({ access_token: TOKEN, expires_in: '3600' });
        return json({ reference: 'echo-b64-0001', state: 'AUTHORIZED', pspReference: echoes.join(' ') });
      },
      policy: {},
    });
    const result = await gw.callTool('get_payment', { reference: 'echo-b64-0001', includeEvents: false });
    const all = JSON.stringify(result);
    for (const echo of echoes) {
      expect(all).not.toContain(echo.slice(0, 12));
    }
  });

  it('masks Bearer and Basic values in any case, and JSON Web Tokens, in text', async () => {
    const basic = Buffer.from('user:pass').toString('base64');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlLXRlc3Q'].join('.');
    const gw = createVippsMobilePayGateway({
      ...KEYS,
      environment: 'test',
      maxAttempts: 1,
      sleep: async () => undefined,
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/accesstoken/get') return json({ access_token: TOKEN, expires_in: '3600' });
        return json({ reference: 'echo-cred-0001', state: 'AUTHORIZED', pspReference: `bearer abcdefgh12345678 BASIC ${basic} ${jwt}` });
      },
      policy: {},
    });
    const all = JSON.stringify(await gw.callTool('get_payment', { reference: 'echo-cred-0001', includeEvents: false }));
    expect(all).not.toMatch(/abcdefgh12345678|eyJzdWIi/);
    expect(all).not.toContain(basic);
  });
});

describe('credential values with base64 padding (review of #10)', () => {
  it('masks the whole Basic or Bearer value with = and == padding, never keeping the part before the padding', async () => {
    const { SecretRedactor, redactSecrets } = await import('../src/errors.js');
    const one = Buffer.from('qzxw:efg').toString('base64'); // 8 bytes: one '='
    const two = Buffer.from('qzxw:ef').toString('base64'); // 7 bytes: '=='
    expect(one).toMatch(/[^=]=$/);
    expect(two).toMatch(/==$/);
    const cases = [
      `Basic ${one}`,
      `basic ${two}`,
      `BASIC ${two} and more`,
      'bearer qzxwabcd12345678=',
      'Bearer qzxwabcd12345678==',
      `Authorization: Basic ${two}`,
      `"authorization": "Bearer qzxwabcd12345678=="`,
    ];
    const expected = [
      'Basic ‹redacted›',
      'basic ‹redacted›',
      'BASIC ‹redacted› and more',
      'bearer ‹redacted›',
      'Bearer ‹redacted›',
      'Authorization: ‹redacted›',
      '"authorization": ‹redacted›"',
    ];
    cases.forEach((text, i) => {
      for (const out of [new SecretRedactor().redact(text), redactSecrets(text)]) expect(out, text).toBe(expected[i]);
    });
    expect(redactSecrets('client_secret=qzxw=cd:ef')).toBe('client_secret= ‹redacted›');
  });
});

describe('credential values that hold a known key (review of #10, round 2)', () => {
  it('masks the whole Basic, Bearer or JWT value even when a known key sits inside it', async () => {
    const { SecretRedactor } = await import('../src/errors.js');
    const r = new SecretRedactor().addSecret('qzxwabcd12345678');
    const basic = Buffer.from('qzxwabcd12345678:othersecret').toString('base64');
    expect(r.redact(`Basic ${basic}`)).toBe('Basic ‹redacted›');
    expect(r.redact('Bearer qzxwabcd12345678tailtoken')).toBe('Bearer ‹redacted›');
    expect(r.redact('Bearer headtokenqzxwabcd12345678==')).toBe('Bearer ‹redacted›');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from('{"sub":"qzxwabcd12345678"}').toString('base64url'), 'qzxwabcd12345678sig'].join('.');
    expect(r.redact(`token ${jwt} end`)).toBe('token ‹redacted› end');
    // A value a previous redaction already marked is still masked whole.
    expect(r.redact('Basic ‹redacted›pvdGhlcnNlY3JldA==')).toBe('Basic ‹redacted›');
    // The known key on its own is still replaced.
    expect(r.redact('plain qzxwabcd12345678 text')).toBe('plain ‹redacted› text');
  });
});

describe('a scheme word before a value that holds the marker (review of #10, round 3)', () => {
  const values = ['Basic ‹redacted›cGFzcw==', 'basic ‹redacted›abcdef', 'BEARER ‹redacted›abcdef', 'Bearer ‹redacted›x'];
  const masked = ['Basic ‹redacted›', 'basic ‹redacted›', 'BEARER ‹redacted›', 'Bearer ‹redacted›'];

  it('masks the whole value, whatever the length of the tail after the marker', async () => {
    const { SecretRedactor, redactSecrets } = await import('../src/errors.js');
    values.forEach((text, i) => {
      expect(new SecretRedactor().redact(text), text).toBe(masked[i]);
      expect(new SecretRedactor().addSecret('qzxwabcd12345678').redact(text), text).toBe(masked[i]);
      expect(redactSecrets(text), text).toBe(masked[i]);
    });
    expect(redactSecrets('"Bearer ‹redacted›x", next')).toBe('"Bearer ‹redacted›", next');
    expect(redactSecrets('a basic plan')).toBe('a basic plan');
  });

  it('masks it through the gateway, in structuredContent and in the text block', async () => {
    const gw = createVippsMobilePayGateway({
      ...KEYS,
      environment: 'test',
      maxAttempts: 1,
      sleep: async () => undefined,
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/accesstoken/get') return json({ access_token: TOKEN, expires_in: '3600' });
        return json({ reference: 'echo-mark-0001', state: 'AUTHORIZED', pspReference: values.join(' | ') });
      },
      policy: {},
    });
    const result = await gw.callTool('get_payment', { reference: 'echo-mark-0001', includeEvents: false });
    const payment = (result.structuredContent as { payment: { pspReference: string } }).payment;
    expect(payment.pspReference).toBe(masked.join(' | '));
    expect(JSON.stringify(result.content)).not.toMatch(/cGFzcw|abcdef|‹redacted›x/);
  });
});
