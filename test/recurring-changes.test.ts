import { describe, expect, it } from 'vitest';
import { resolveVippsChange, vippsToolCatalog, type GatewayJsonObject, type GatewayToolResult } from '../src/gateway.js';
import { isDerivedIdempotencyKey, pseudonym } from '../src/vipps/values.js';
import { chargeView } from '../src/vipps/views.js';
import { apiCalls, connect, gateway, KEYS, TOKEN, texts, type Call, type Reply, type Route } from './helpers.js';
import { KeyMemory, REPEATS, type Repeat } from './second-call.js';

/**
 * The four Recurring changes (create_charge, capture_charge, update_agreement, stop_agreement) against a stand-in for
 * the Recurring API that keeps what it is asked to do. Everything here is made up: the bakery, its agreement, the
 * charges and the texts.
 */

const AGREEMENT_ID = 'agr_7TqP2m';
const AGREEMENT_PATH = `/recurring/v3/agreements/${AGREEMENT_ID}`;
const CHARGES_PATH = `${AGREEMENT_PATH}/charges`;
const RESERVED_ID = 'chr-Rz4mQ8';
const WRITES = { policy: { enableWrites: true }, maxAttempts: 5, retryBaseDelayMs: 1 };

const newCharge = {
  agreementId: AGREEMENT_ID,
  amount: 19_900,
  currency: 'DKK',
  description: 'Brødabonnement: december',
  due: '2026-12-01',
  retryDays: 3,
  transactionType: 'RESERVE_CAPTURE',
} as const;
const capture = { agreementId: AGREEMENT_ID, chargeId: RESERVED_ID, amount: 19_900, currency: 'DKK', alreadyCaptured: 0 } as const;
const rename = { agreementId: AGREEMENT_ID, productName: 'Brødabonnement, stor' } as const;
const stop = { agreementId: AGREEMENT_ID } as const;

/** An error body as a vendor could write it: it quotes a name and a key. None of it may be passed on. */
const vendorText = {
  type: 'https://developer.example/problems/recurring',
  title: 'Charge rejected for Solveig Fjordheim',
  detail: `Customer Solveig Fjordheim, key ${KEYS.clientSecret}`,
  contextId: '0b1f6d2e-4c3a-4f7e-9a8b-1c2d3e4f5a6b',
};
const NEVER = [KEYS.clientId, KEYS.clientSecret, KEYS.subscriptionKey, TOKEN, 'Solveig', 'Fjordheim', 'apitest.vipps.no'];
function expectNothingLeaks(value: unknown, more: string[] = []) {
  const said = JSON.stringify(value);
  for (const text of [...NEVER, ...more]) expect(said, text).not.toContain(text);
}

const data = (result: GatewayToolResult) => result.structuredContent as Record<string, unknown>;
const writesOf = (calls: Call[]) => apiCalls(calls).filter(call => call.method !== 'GET');
const keysOf = (calls: Call[]) => writesOf(calls).map(call => String(call.headers['Idempotency-Key']));

const timeout = (): never => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

interface KeptCharge {
  id: string;
  agreementId: string;
  amount: number;
  currency: string;
  description: string;
  due: string;
  status: string;
  type: string;
  transactionType: string;
  retryDays: number;
  summary: { captured: number; refunded: number; cancelled: number };
  history: Array<Record<string, unknown>>;
}

/**
 * A stand-in for the Recurring API: one agreement, its charges, and the Idempotency-Keys it has seen. A repeated key is
 * answered with the first answer (`replay`) or refused with HTTP 409 (`refuse`); the documentation leaves it open.
 */
function recurringStandIn(repeat: Repeat = 'refuse', agreement: Record<string, unknown> = {}) {
  const kept = {
    id: AGREEMENT_ID,
    status: 'ACTIVE',
    productName: 'Brødabonnement',
    productDescription: 'Friskt brød hver lørdag',
    pricing: { type: 'LEGACY', currency: 'DKK', amount: 19_900 },
    interval: { unit: 'MONTH', count: 1, text: 'every month' },
    ...agreement,
  } as Record<string, unknown>;
  const keys = new KeyMemory(repeat, { status: 409, body: vendorText });
  const charges = new Map<string, KeptCharge>();
  charges.set(RESERVED_ID, {
    id: RESERVED_ID,
    agreementId: AGREEMENT_ID,
    amount: 19_900,
    currency: 'DKK',
    description: 'Brødabonnement: november',
    due: '2026-11-01T00:00:00Z',
    status: 'RESERVED',
    type: 'RECURRING',
    transactionType: 'RESERVE_CAPTURE',
    retryDays: 3,
    summary: { captured: 0, refunded: 0, cancelled: 0 },
    history: [{ occurred: '2026-11-01T05:00:00Z', event: 'RESERVE', amount: 19_900, idempotencyKey: 'op-reserve-0001', success: true }],
  });
  let lose = false;
  let counter = 0;
  const patches: Array<Record<string, unknown>> = [];

  /** Answer, or carry the change out and lose the answer. */
  const answer = (reply: Reply): Reply => {
    if (lose) {
      lose = false;
      timeout();
    }
    return reply;
  };
  const once = (key: string, act: () => Reply): Reply => {
    const seen = keys.seen(key);
    if (seen) return seen;
    const reply = act();
    if ((reply.status ?? 200) < 300) keys.remember(key, reply);
    return answer(reply);
  };

  const handle = (url: URL, init: RequestInit): Reply => {
    const method = init.method ?? 'GET';
    const key = String((init.headers as Record<string, string>)['Idempotency-Key'] ?? '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname;
    if (path === AGREEMENT_PATH && method === 'GET') return { body: kept };
    if (path === AGREEMENT_PATH && method === 'PATCH') {
      return once(key, () => {
        if (kept.status === 'STOPPED' && body.status !== 'STOPPED') return { status: 400, body: vendorText };
        patches.push(body);
        if (body.status === 'STOPPED') kept.status = 'STOPPED';
        for (const field of ['productName', 'productDescription', 'merchantAgreementUrl'] as const) {
          if (body[field] !== undefined) kept[field] = body[field];
        }
        if (body.pricing) kept.pricing = { ...(kept.pricing as object), ...(body.pricing as object) };
        if (body.interval) kept.interval = (body.interval as { period?: object }).period ?? {};
        return { status: 204 };
      });
    }
    if (path === CHARGES_PATH && method === 'GET') return { body: [...charges.values()] };
    if (path === CHARGES_PATH && method === 'POST') {
      return once(key, () => {
        const id = typeof body.orderId === 'string' ? body.orderId : `chr-New${(counter += 1)}`;
        if (charges.has(id)) return { status: 409, body: vendorText };
        charges.set(id, {
          id,
          agreementId: AGREEMENT_ID,
          amount: body.amount as number,
          currency: 'DKK',
          description: body.description as string,
          due: `${String(body.due)}T00:00:00Z`,
          status: 'PENDING',
          type: String(body.type),
          transactionType: String(body.transactionType),
          retryDays: body.retryDays as number,
          summary: { captured: 0, refunded: 0, cancelled: 0 },
          history: [{ occurred: '2026-11-26T09:00:00Z', event: 'CREATE', amount: body.amount, idempotencyKey: key, success: true }],
        });
        return { status: 201, body: { chargeId: id } };
      });
    }
    const match = /^\/recurring\/v3\/agreements\/agr_7TqP2m\/charges\/([^/]+)(\/capture)?$/.exec(path);
    const found = match ? charges.get(match[1]!) : undefined;
    if (!found) return { status: 404, body: vendorText };
    if (method === 'GET' && !match![2]) return { body: found };
    if (method === 'POST' && match![2]) {
      return once(key, () => {
        const amount = body.amount as number;
        if (found.status !== 'RESERVED' && found.status !== 'PARTIALLY_CAPTURED') return { status: 400, body: vendorText };
        found.summary.captured += amount;
        found.status = found.summary.captured === found.amount ? 'CHARGED' : 'PARTIALLY_CAPTURED';
        found.history.push({ occurred: '2026-11-26T10:00:00Z', event: 'CAPTURE', amount, idempotencyKey: key, success: true });
        return { status: 204 };
      });
    }
    return { status: 404, body: vendorText };
  };

  const routes = new Proxy({} as Record<string, Route>, {
    get: (_target, name) => (name === 'POST /accesstoken/get' ? undefined : handle),
  });
  return {
    routes,
    agreement: kept,
    charges,
    patches,
    loseNextAnswer: () => void (lose = true),
    forgetKeys: () => keys.forget(),
  };
}

describe('the four Recurring changes in the catalogue', () => {
  const entry = (name: string) => vippsToolCatalog.find(item => item.name === name);

  it('are write tools that are off by default, confirmed, and say whether the call itself moves money', () => {
    const expected = {
      create_charge: {
        action: 'create',
        record: 'charge',
        movesMoney: true,
        logFields: [
          { name: 'agreementId', type: 'pseudonym' },
          { name: 'orderId', type: 'pseudonym' },
          { name: 'amount', type: 'amountMinor' },
          { name: 'currency', type: 'currency' },
        ],
        upstream: [
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
          { access: 'write', method: 'POST', path: '/recurring/v3/agreements/{agreementId}/charges' },
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges' },
        ],
      },
      capture_charge: {
        action: 'capture',
        record: 'charge',
        movesMoney: true,
        logFields: [
          { name: 'agreementId', type: 'pseudonym' },
          { name: 'chargeId', type: 'pseudonym' },
          { name: 'amount', type: 'amountMinor' },
          { name: 'currency', type: 'currency' },
        ],
        upstream: [
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}' },
          { access: 'write', method: 'POST', path: '/recurring/v3/agreements/{agreementId}/charges/{chargeId}/capture' },
        ],
      },
      update_agreement: {
        action: 'update',
        record: 'agreement',
        movesMoney: false,
        logFields: [
          { name: 'agreementId', type: 'pseudonym' },
          { name: 'price', type: 'amountMinor' },
          { name: 'suggestedMaxAmount', type: 'amountMinor' },
          { name: 'currency', type: 'currency' },
        ],
        upstream: [
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
          { access: 'write', method: 'PATCH', path: '/recurring/v3/agreements/{agreementId}' },
        ],
      },
      stop_agreement: {
        action: 'stop',
        record: 'agreement',
        movesMoney: false,
        logFields: [{ name: 'agreementId', type: 'pseudonym' }],
        upstream: [
          { access: 'read', method: 'GET', path: '/recurring/v3/agreements/{agreementId}' },
          { access: 'write', method: 'PATCH', path: '/recurring/v3/agreements/{agreementId}' },
        ],
      },
    } as const;
    for (const [name, { upstream, ...spec }] of Object.entries(expected)) {
      expect(entry(name), name).toMatchObject({
        riskLevel: 'write',
        enabledByDefault: false,
        broad: false,
        requiresConfirmation: true,
        keyTypes: ['merchant', 'partner'],
        environments: ['test', 'production'],
        upstream,
        change: spec,
      });
      // The caller does not choose the key: there is no such input.
      expect(Object.keys((entry(name)?.inputSchema as { properties: object }).properties), name).not.toContain('idempotencyKey');
    }
  });

  it('says in stop_agreement that it cannot be undone, so the AI asks the person first', () => {
    const description = entry('stop_agreement')?.description ?? '';
    expect(description).toMatch(/This cannot be undone: a stopped agreement can never be started again/);
    expect(description).toMatch(/Ask the person first/);
    expect(description).toMatch(/cancels the pending, due and reserved charges/);
    expect(entry('update_agreement')?.description).toMatch(/To stop an agreement, use stop_agreement\./);
    // update_agreement cannot stop: it has no status.
    expect(Object.keys((entry('update_agreement')?.inputSchema as { properties: object }).properties)).not.toContain('status');
  });

  it('resolve to a change with identifiers as pseudonyms and never a free text', () => {
    expect(resolveVippsChange('create_charge', { ...newCharge, orderId: 'brod-2026-12' })).toEqual({
      ok: true,
      change: {
        tool: 'create_charge',
        action: 'create',
        record: 'charge',
        movesMoney: true,
        values: { agreementId: pseudonym(AGREEMENT_ID), orderId: pseudonym('brod-2026-12'), amount: 19_900, currency: 'DKK' },
      },
    });
    expect(resolveVippsChange('update_agreement', { agreementId: AGREEMENT_ID, price: 24_900, currency: 'DKK', productName: 'Stor' })).toEqual({
      ok: true,
      change: { tool: 'update_agreement', action: 'update', record: 'agreement', movesMoney: false, values: { agreementId: pseudonym(AGREEMENT_ID), price: 24_900, currency: 'DKK' } },
    });
    expect(resolveVippsChange('stop_agreement', stop)).toMatchObject({ ok: true, change: { action: 'stop', movesMoney: false } });
    expect(JSON.stringify(resolveVippsChange('create_charge', newCharge))).not.toMatch(/Brødabonnement|agr_7TqP2m/);
  });
});

describe('create_charge', () => {
  it('reads the agreement, sends the charge once with a key made from its content, and reads its status back', async () => {
    const vendor = recurringStandIn();
    const records: Array<Record<string, unknown>> = [];
    const { gw, calls } = gateway(vendor.routes, { ...WRITES, policy: { enableWrites: true, audit: record => void records.push(record) } });
    const result = await gw.callTool('create_charge', newCharge);
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({
      created: true,
      alreadyExists: false,
      agreementId: AGREEMENT_ID,
      chargeId: 'chr-New1',
      amount: 19_900,
      currency: 'DKK',
      transactionType: 'RESERVE_CAPTURE',
      due: '2026-12-01',
      status: 'PENDING',
    });
    expect(String(data(result).note)).toMatch(/capture_charge draws it/);
    const posts = writesOf(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      method: 'POST',
      path: CHARGES_PATH,
      body: { amount: 19_900, transactionType: 'RESERVE_CAPTURE', description: 'Brødabonnement: december', type: 'RECURRING', due: '2026-12-01', retryDays: 3 },
    });
    expect(keysOf(calls)[0]).toMatch(/^charge-[0-9a-f]{32}$/);
    expect(isDerivedIdempotencyKey(keysOf(calls)[0])).toBe(true);
    expect(apiCalls(calls).map(call => `${call.method} ${call.path}`)).toEqual([`GET ${AGREEMENT_PATH}`, `POST ${CHARGES_PATH}`, `GET ${CHARGES_PATH}/chr-New1`]);
    // The key is in no answer and no audit record; the description only as a keyed hash.
    expectNothingLeaks([result, records], [keysOf(calls)[0]!, keysOf(calls)[0]!.slice(7), 'Brødabonnement: december']);
    expectNothingLeaks(records, [AGREEMENT_ID]);
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]?.target).toMatchObject({ agreementId: pseudonym(AGREEMENT_ID), amount: 19_900, currency: 'DKK', due: '2026-12-01', retryDays: 3, transactionType: 'RESERVE_CAPTURE' });
    expect(Object.keys(records[0]?.target as object)).toContain('descriptionHmac');
  });

  it('uses another key for any other content, and the business’s orderId as the charge id', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    await gw.callTool('create_charge', newCharge);
    await gw.callTool('create_charge', { ...newCharge, due: '2027-01-01' });
    const withOrder = await gw.callTool('create_charge', { ...newCharge, transactionType: 'DIRECT_CAPTURE', orderId: 'brod-2026-12' });
    expect(data(withOrder)).toMatchObject({ created: true, chargeId: 'brod-2026-12' });
    expect(String(data(withOrder).note)).toMatch(/charged on the due date/);
    expect(new Set(keysOf(calls)).size).toBe(3);
    expect(writesOf(calls)[2]?.body).toMatchObject({ orderId: 'brod-2026-12', transactionType: 'DIRECT_CAPTURE' });
  });

  const refusals: Array<[string, Record<string, unknown>, GatewayJsonObject, RegExp]> = [
    ['the agreement is not active', { status: 'STOPPED' }, newCharge, /only on an ACTIVE agreement, and this one is STOPPED\. Nothing was sent\./],
    ['the agreement’s status is unknown', { status: 'PAUSED' }, newCharge, /this one is in a status this server does not know/],
    ['the currency differs', {}, { ...newCharge, currency: 'NOK' }, /the agreement is in DKK, not NOK\. Nothing was sent\./],
    ['the amount is above the currency’s limit', {}, { ...newCharge, amount: 30_000_001 }, /a charge in DKK must be from 0\.01 DKK to 300 000\.00 DKK\. Nothing was sent\./],
    ['the amount is below NOK’s smallest', { pricing: { type: 'LEGACY', currency: 'NOK', amount: 9_900 } }, { ...newCharge, currency: 'NOK', amount: 50 }, /a charge in NOK must be from 1\.00 NOK/],
    [
      'the amount is above the maximum of a variable price',
      { pricing: { type: 'VARIABLE', currency: 'DKK', suggestedMaxAmount: 30_000, maxAmount: 25_000 } },
      { ...newCharge, amount: 30_001 },
      /a charge may be at most 300\.00 DKK, the higher of the suggested and the customer’s own maximum/,
    ],
    ['the agreement cannot be read in its form', { pricing: { type: 'LEGACY', currency: 'SEK' } }, newCharge, /could not be read in the expected form/],
    ['one try with retry days', {}, { ...newCharge, processingMode: 'SINGLE_ATTEMPT' }, /processingMode SINGLE_ATTEMPT needs retryDays 0\./],
  ];
  for (const [name, agreement, input, said] of refusals) {
    it(`is refused, and nothing is sent, when ${name}`, async () => {
      const vendor = recurringStandIn('refuse', agreement);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      const result = await gw.callTool('create_charge', input);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(said);
      expect(writesOf(calls)).toHaveLength(0);
      expect(vendor.charges.size).toBe(1);
    });
  }

  it('is refused unless the host enables writes', async () => {
    const { gw, calls } = gateway(recurringStandIn().routes, { policy: {} });
    for (const [tool, input] of [
      ['create_charge', newCharge],
      ['capture_charge', capture],
      ['update_agreement', rename],
      ['stop_agreement', stop],
    ] as const) {
      const result = await gw.callTool(tool, input);
      expect(result.isError, tool).toBe(true);
    }
    expect(apiCalls(calls)).toHaveLength(0);
  });

  it('explains a refusal by Vipps MobilePay in our own words, and quotes nothing of it', async () => {
    for (const [status, said] of [
      [400, /Nothing was created\. A charge is refused when the due date is not at least one day and at most two years ahead/],
      [404, /Nothing was created\. Vipps MobilePay does not know the agreement or the charge for these keys\./],
      [409, /Nothing was created\. Another charge has this orderId, or Vipps MobilePay refused the repeat of a request it has seen\./],
    ] as const) {
      const vendor = recurringStandIn();
      const routes = new Proxy({} as Record<string, Route>, {
        get: (_target, name) =>
          name === 'POST /accesstoken/get' ? undefined : name === `POST ${CHARGES_PATH}` ? { status, body: vendorText } : (vendor.routes as Record<string, Route>)[name as string],
      });
      const { gw, calls } = gateway(routes, WRITES);
      const result = await gw.callTool('create_charge', newCharge);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(new RegExp(`^Vipps MobilePay API request failed with HTTP ${status} `));
      expect(texts(result)[0]).toMatch(said);
      expect(result.failure).toMatchObject({ httpStatus: status, method: 'POST', pathTemplate: '/recurring/v3/agreements/{agreementId}/charges' });
      expect(writesOf(calls)).toHaveLength(1);
      expectNothingLeaks(result, ['Charge rejected']);
    }
  });

  it('is refused when its orderId is used by a charge that is not this request', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    await gw.callTool('create_charge', { ...newCharge, orderId: 'brod-2026-12' });
    const other = await gw.callTool('create_charge', { ...newCharge, amount: 100, orderId: 'brod-2026-12' });
    expect(other.isError).toBe(true);
    expect(texts(other)[0]).toMatch(/^Refused: a charge with this orderId exists and is not this request/);
    expect(vendor.charges.get('brod-2026-12')?.amount).toBe(19_900);
    expect(new Set(keysOf(calls)).size).toBe(2);
    expectNothingLeaks(other);
  });

  it('is created by the same call after HTTP 429 with Retry-After, under the same key', async () => {
    const vendor = recurringStandIn();
    let busy = true;
    const routes = new Proxy({} as Record<string, Route>, {
      get: (_target, name) => {
        if (name === 'POST /accesstoken/get') return undefined;
        const route = (vendor.routes as Record<string, Route>)[name as string] as (url: URL, init: RequestInit) => Reply;
        return name === `POST ${CHARGES_PATH}` && busy ? { status: 429, headers: { 'retry-after': '7' }, body: vendorText } : route;
      },
    });
    const { gw, calls } = gateway(routes, WRITES);
    const first = await gw.callTool('create_charge', newCharge);
    expect(first.isError).toBe(true);
    expect(texts(first)[0]).toMatch(/^Vipps MobilePay API request failed with HTTP 429 .*retry-after=7s.*Nothing was created\. After the wait: Call again with exactly the same input/);
    expect(first.failure?.httpStatus).toBe(429);
    // A POST is never retried by the client itself.
    expect(writesOf(calls)).toHaveLength(1);
    busy = false;
    expect(data(await gw.callTool('create_charge', newCharge))).toMatchObject({ created: true, chargeId: 'chr-New1' });
    expect(new Set(keysOf(calls)).size).toBe(1);
    expect(vendor.charges.size).toBe(2);
    expectNothingLeaks(first);
  });

  it('says the outcome is not known after HTTP 500 or a timeout, and to call again with the same input', async () => {
    for (const failure of [{ status: 500, body: vendorText }, timeout] as const) {
      const vendor = recurringStandIn();
      const routes = new Proxy({} as Record<string, Route>, {
        get: (_target, name) =>
          name === 'POST /accesstoken/get' ? undefined : name === `POST ${CHARGES_PATH}` ? failure : (vendor.routes as Record<string, Route>)[name as string],
      });
      const { gw, calls } = gateway(routes, WRITES);
      const result = await gw.callTool('create_charge', newCharge);
      expect(texts(result)[0]).toMatch(/It is not known whether the charge was created\. Call again with exactly the same input: the server sends the same Idempotency-Key/);
      expect(writesOf(calls)).toHaveLength(1);
      expectNothingLeaks(result);
    }
  });

  for (const repeat of REPEATS) {
    for (const orderId of [undefined, 'brod-2026-12']) {
      it(`creates one charge when the answer is lost and the call is repeated (${repeat}, ${orderId ? 'with' : 'without'} orderId)`, async () => {
        const vendor = recurringStandIn(repeat);
        const { gw, calls } = gateway(vendor.routes, WRITES);
        const input = orderId === undefined ? newCharge : { ...newCharge, orderId };
        vendor.loseNextAnswer();
        const first = await gw.callTool('create_charge', input);
        expect(texts(first)[0]).toMatch(/It is not known whether the charge was created/);
        const second = await gw.callTool('create_charge', input);
        expect(second.isError).toBeUndefined();
        const id = orderId ?? 'chr-New1';
        expect(data(second)).toMatchObject({ chargeId: id, status: 'PENDING' });
        // A replay is the first answer again; a refused repeat is found by the key in the charge's history.
        expect(data(second)).toMatchObject(repeat === 'replay' ? { created: true } : { created: false, alreadyExists: true });
        expect(vendor.charges.size).toBe(2);
        expect(keysOf(calls)).toHaveLength(2);
        expect(new Set(keysOf(calls)).size).toBe(1);
        expectNothingLeaks([first, second], [keysOf(calls)[0]!]);
      });
    }
  }

  it('never passes on the key it made, also not when the charge is read', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    await gw.callTool('create_charge', newCharge);
    const key = keysOf(calls)[0]!;
    await gw.callTool('capture_charge', { ...capture, amount: 100 });
    const captureKey = keysOf(calls)[1]!;
    for (const [tool, input] of [
      ['get_charge', { agreementId: AGREEMENT_ID, chargeId: 'chr-New1' }],
      ['get_charge', { agreementId: AGREEMENT_ID, chargeId: RESERVED_ID }],
      ['list_charges', { agreementId: AGREEMENT_ID }],
    ] as const) {
      const read = await gw.callTool(tool, input);
      expect(read.isError, tool).toBeUndefined();
      expect(JSON.stringify(read), tool).not.toContain(key);
      expect(JSON.stringify(read), tool).not.toContain(captureKey);
    }
    // A key the caller chose is still passed on.
    expect(JSON.stringify(await gw.callTool('get_charge', { agreementId: AGREEMENT_ID, chargeId: RESERVED_ID }))).toContain('op-reserve-0001');
    const view = chargeView(vendor.charges.get('chr-New1'));
    expect((view.history as Array<Record<string, unknown>>)[0]).not.toHaveProperty('idempotencyKey');
  });
});

describe('capture_charge', () => {
  it('reads the charge and captures it once with a key made from the capture and what was captured before', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    const result = await gw.callTool('capture_charge', capture);
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({ captureRequested: true, alreadyDone: false, chargeId: RESERVED_ID, amount: 19_900, currency: 'DKK' });
    expect(writesOf(calls)).toEqual([expect.objectContaining({ method: 'POST', path: `${CHARGES_PATH}/${RESERVED_ID}/capture`, body: { amount: 19_900 } })]);
    expect(keysOf(calls)[0]).toMatch(/^capture-[0-9a-f]{32}$/);
    expect(vendor.charges.get(RESERVED_ID)?.status).toBe('CHARGED');
    expectNothingLeaks(result, [keysOf(calls)[0]!]);
  });

  it('captures two parts of the same amount as two captures', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    expect(data(await gw.callTool('capture_charge', { ...capture, amount: 9_950 }))).toMatchObject({ alreadyDone: false });
    expect(data(await gw.callTool('capture_charge', { ...capture, amount: 9_950, alreadyCaptured: 9_950 }))).toMatchObject({ alreadyDone: false });
    expect(new Set(keysOf(calls)).size).toBe(2);
    expect(vendor.charges.get(RESERVED_ID)?.summary.captured).toBe(19_900);
  });

  const refusals: Array<[string, Partial<KeptCharge>, GatewayJsonObject, RegExp]> = [
    ['alreadyCaptured is not what the charge shows', {}, { ...capture, alreadyCaptured: 100 }, /0 \(minor units\) of the charge is captured, not 100 as alreadyCaptured says\. Nothing was sent\./],
    ['the currency differs', {}, { ...capture, currency: 'EUR' }, /the charge is in DKK, not EUR\. Nothing was sent\./],
    ['the charge is charged directly', { transactionType: 'DIRECT_CAPTURE' }, capture, /only a charge created as RESERVE_CAPTURE can be captured/],
    ['the charge is not reserved', { status: 'CANCELLED' }, capture, /only a reserved or partially captured charge can be captured\. Nothing was sent\./],
    ['the amount is more than is reserved', {}, { ...capture, amount: 20_000 }, /20000 is more than the 19900 \(minor units\) reserved and not captured\. Nothing was sent\./],
  ];
  for (const [name, change, input, said] of refusals) {
    it(`is refused, and nothing is sent, when ${name}`, async () => {
      const vendor = recurringStandIn();
      Object.assign(vendor.charges.get(RESERVED_ID)!, change);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      const result = await gw.callTool('capture_charge', input);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(said);
      expect(writesOf(calls)).toHaveLength(0);
    });
  }

  it('says what HTTP 429 with Retry-After means, and captures under the same key after the wait', async () => {
    const vendor = recurringStandIn();
    let busy = true;
    const capturePath = `POST ${CHARGES_PATH}/${RESERVED_ID}/capture`;
    const routes = new Proxy({} as Record<string, Route>, {
      get: (_target, name) =>
        name === 'POST /accesstoken/get'
          ? undefined
          : name === capturePath && busy
            ? { status: 429, headers: { 'retry-after': '5' }, body: vendorText }
            : (vendor.routes as Record<string, Route>)[name as string],
    });
    const { gw, calls } = gateway(routes, WRITES);
    const first = await gw.callTool('capture_charge', capture);
    expect(texts(first)[0]).toMatch(/^Vipps MobilePay API request failed with HTTP 429 .*retry-after=5s.*Nothing was captured\. After the wait: Call again with exactly the same input/);
    busy = false;
    expect(data(await gw.callTool('capture_charge', capture))).toMatchObject({ captureRequested: true, alreadyDone: false });
    expect(new Set(keysOf(calls)).size).toBe(1);
    expect(vendor.charges.get(RESERVED_ID)?.summary.captured).toBe(19_900);
    expectNothingLeaks(first);
  });

  it('explains HTTP 400 in our own words', async () => {
    const vendor = recurringStandIn();
    const routes = new Proxy({} as Record<string, Route>, {
      get: (_target, name) =>
        name === 'POST /accesstoken/get' ? undefined : name === `POST ${CHARGES_PATH}/${RESERVED_ID}/capture` ? { status: 400, body: vendorText } : (vendor.routes as Record<string, Route>)[name as string],
    });
    const result = await gateway(routes, WRITES).gw.callTool('capture_charge', capture);
    expect(texts(result)[0]).toMatch(/Nothing was captured\. A capture is refused when the charge is not reserved/);
    expectNothingLeaks(result, ['Charge rejected']);
  });

  for (const repeat of REPEATS) {
    it(`captures once when the answer is lost and the call is repeated (${repeat})`, async () => {
      const vendor = recurringStandIn(repeat);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      vendor.loseNextAnswer();
      const first = await gw.callTool('capture_charge', capture);
      expect(texts(first)[0]).toMatch(/It is not known whether the amount was captured\. Call again with exactly the same input/);
      const second = await gw.callTool('capture_charge', capture);
      expect(data(second)).toMatchObject({ captureRequested: true, alreadyDone: true });
      // The repeat finds the capture by its key in the history, and sends nothing.
      expect(writesOf(calls)).toHaveLength(1);
      const kept = vendor.charges.get(RESERVED_ID)!;
      expect(kept.summary.captured).toBe(19_900);
      expect(kept.history.filter(event => event.event === 'CAPTURE')).toHaveLength(1);
    });
  }
});

describe('update_agreement', () => {
  it('reads the agreement and sends only what changes, once, with a key made from the change and the agreement as it was', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    const result = await gw.callTool('update_agreement', {
      ...rename,
      productDescription: 'Friskt brød hver lørdag',
      price: 24_900,
      currency: 'DKK',
      interval: { type: 'RECURRING', unit: 'WEEK', count: 2 },
    });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({
      updateRequested: true,
      agreementId: AGREEMENT_ID,
      changed: ['productName', 'pricing', 'interval'],
      alreadyAsAsked: ['productDescription'],
    });
    expect(String(data(result).note)).toMatch(/does not tell the customer of a new price/);
    expect(writesOf(calls)).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: AGREEMENT_PATH,
        body: { productName: 'Brødabonnement, stor', pricing: { amount: 24_900 }, interval: { type: 'RECURRING', period: { unit: 'WEEK', count: 2 } } },
      }),
    ]);
    expect(keysOf(calls)[0]).toMatch(/^update-[0-9a-f]{32}$/);
    expect(vendor.agreement).toMatchObject({ productName: 'Brødabonnement, stor', pricing: { amount: 24_900 }, interval: { unit: 'WEEK', count: 2 } });
  });

  it('sends a flexible interval, an address and a variable price’s suggested maximum', async () => {
    const vendor = recurringStandIn('refuse', { pricing: { type: 'VARIABLE', currency: 'DKK', suggestedMaxAmount: 30_000 } });
    const { gw, calls } = gateway(vendor.routes, WRITES);
    const result = await gw.callTool('update_agreement', {
      agreementId: AGREEMENT_ID,
      suggestedMaxAmount: 40_000,
      currency: 'DKK',
      merchantAgreementUrl: 'https://fjordbakeriet.example/mit-abonnement',
      interval: { type: 'FLEXIBLE' },
    });
    expect(result.isError).toBeUndefined();
    expect(writesOf(calls)[0]?.body).toEqual({
      merchantAgreementUrl: 'https://fjordbakeriet.example/mit-abonnement',
      pricing: { suggestedMaxAmount: 40_000 },
      interval: { type: 'FLEXIBLE' },
    });
  });

  it('sends nothing when the agreement already has what is asked', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    const result = await gw.callTool('update_agreement', { agreementId: AGREEMENT_ID, productName: 'Brødabonnement', price: 19_900, currency: 'DKK' });
    expect(data(result)).toMatchObject({ updateRequested: false, changed: [], alreadyAsAsked: ['productName', 'pricing'] });
    expect(writesOf(calls)).toHaveLength(0);
  });

  const refusals: Array<[string, Record<string, unknown>, GatewayJsonObject, RegExp]> = [
    ['the agreement is stopped', { status: 'STOPPED' }, rename, /only a pending or active agreement can be changed, and this one is STOPPED\. Nothing was sent\./],
    ['the agreement has expired', { status: 'EXPIRED' }, rename, /this one is EXPIRED/],
    ['a fixed price is given for a variable price', { pricing: { type: 'VARIABLE', currency: 'DKK', suggestedMaxAmount: 30_000 } }, { agreementId: AGREEMENT_ID, price: 100, currency: 'DKK' }, /price changes a fixed price, and this agreement does not have one/],
    ['a suggested maximum is given for a fixed price', {}, { agreementId: AGREEMENT_ID, suggestedMaxAmount: 100, currency: 'DKK' }, /suggestedMaxAmount changes a variable price/],
    ['the currency differs', {}, { agreementId: AGREEMENT_ID, price: 100, currency: 'EUR' }, /the agreement is in DKK, not EUR/],
    ['the price is above the currency’s limit', {}, { agreementId: AGREEMENT_ID, price: 30_000_001, currency: 'DKK' }, /the price in DKK must be from 0\.01 DKK to 300 000\.00 DKK/],
    ['nothing is asked', {}, { agreementId: AGREEMENT_ID }, /Give at least one thing to change\./],
    ['both kinds of price are given', {}, { agreementId: AGREEMENT_ID, price: 100, suggestedMaxAmount: 100, currency: 'DKK' }, /not both/],
    ['a price has no currency', {}, { agreementId: AGREEMENT_ID, price: 100 }, /A price needs currency\./],
    ['a currency has no price', {}, { ...rename, currency: 'DKK' }, /currency is only for price or suggestedMaxAmount\./],
    ['a recurring interval has no unit', {}, { agreementId: AGREEMENT_ID, interval: { type: 'RECURRING', count: 2 } }, /needs unit and count/],
    ['a flexible interval has a unit', {}, { agreementId: AGREEMENT_ID, interval: { type: 'FLEXIBLE', unit: 'WEEK' } }, /has no unit or count/],
    ['the address is not https', {}, { agreementId: AGREEMENT_ID, merchantAgreementUrl: 'http://fjordbakeriet.example/mit' }, /Invalid input/],
    ['a status is given', {}, { agreementId: AGREEMENT_ID, status: 'STOPPED' }, /Invalid input/],
  ];
  for (const [name, agreement, input, said] of refusals) {
    it(`is refused, and nothing is sent, when ${name}`, async () => {
      const vendor = recurringStandIn('refuse', agreement);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      const result = await gw.callTool('update_agreement', input);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(said);
      expect(writesOf(calls)).toHaveLength(0);
    });
  }

  it('says what HTTP 429 with Retry-After and HTTP 400 mean, in our own words', async () => {
    for (const [reply, said] of [
      [{ status: 429, headers: { 'retry-after': '3' }, body: vendorText }, /HTTP 429 .*retry-after=3s.*Nothing was changed\. After the wait: Call again with exactly the same input/],
      [{ status: 400, body: vendorText }, /HTTP 400 .*Nothing was changed\. A change is refused when the agreement is stopped/],
      [{ status: 503, body: vendorText }, /It is not known whether the agreement was changed\. Call again with exactly the same input/],
    ] as const) {
      const vendor = recurringStandIn();
      const routes = new Proxy({} as Record<string, Route>, {
        get: (_target, name) => (name === 'POST /accesstoken/get' ? undefined : name === `PATCH ${AGREEMENT_PATH}` ? reply : (vendor.routes as Record<string, Route>)[name as string]),
      });
      const { gw, calls } = gateway(routes, WRITES);
      const result = await gw.callTool('update_agreement', rename);
      expect(texts(result)[0]).toMatch(said);
      expect(result.failure).toMatchObject({ method: 'PATCH', pathTemplate: '/recurring/v3/agreements/{agreementId}' });
      // A PATCH is never retried by the client itself, also not on 503.
      expect(writesOf(calls)).toHaveLength(1);
      expectNothingLeaks(result, ['Charge rejected']);
    }
  });

  for (const repeat of REPEATS) {
    it(`changes once when the answer is lost and the call is repeated (${repeat})`, async () => {
      const vendor = recurringStandIn(repeat);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      vendor.loseNextAnswer();
      const first = await gw.callTool('update_agreement', rename);
      expect(texts(first)[0]).toMatch(/It is not known whether the agreement was changed/);
      const second = await gw.callTool('update_agreement', rename);
      expect(data(second)).toMatchObject({ updateRequested: false, alreadyAsAsked: ['productName'] });
      expect(writesOf(calls)).toHaveLength(1);
      expect(vendor.patches).toHaveLength(1);
    });
  }

  it('makes a change and its undoing two requests, with two keys', async () => {
    const vendor = recurringStandIn('replay');
    const { gw, calls } = gateway(vendor.routes, WRITES);
    await gw.callTool('update_agreement', rename);
    await gw.callTool('update_agreement', { agreementId: AGREEMENT_ID, productName: 'Brødabonnement' });
    expect(vendor.agreement.productName).toBe('Brødabonnement');
    expect(new Set(keysOf(calls)).size).toBe(2);
  });
});

describe('stop_agreement', () => {
  it('reads the agreement and stops it once, with a key of its own', async () => {
    const vendor = recurringStandIn();
    const { gw, calls } = gateway(vendor.routes, WRITES);
    const result = await gw.callTool('stop_agreement', stop);
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({ stopped: true, alreadyStopped: false, agreementId: AGREEMENT_ID, previousStatus: 'ACTIVE' });
    expect(String(data(result).note)).toMatch(/stopped for good and cannot be started again/);
    expect(writesOf(calls)).toEqual([expect.objectContaining({ method: 'PATCH', path: AGREEMENT_PATH, body: { status: 'STOPPED' } })]);
    expect(keysOf(calls)[0]).toMatch(/^stop-[0-9a-f]{32}$/);
    expect(vendor.agreement.status).toBe('STOPPED');
  });

  it('stops a pending agreement too', async () => {
    const vendor = recurringStandIn('refuse', { status: 'PENDING' });
    const result = await gateway(vendor.routes, WRITES).gw.callTool('stop_agreement', stop);
    expect(data(result)).toMatchObject({ stopped: true, previousStatus: 'PENDING' });
  });

  it('sends nothing for an agreement that is already stopped, and refuses an expired one', async () => {
    const stopped = recurringStandIn('refuse', { status: 'STOPPED' });
    const one = gateway(stopped.routes, WRITES);
    expect(data(await one.gw.callTool('stop_agreement', stop))).toMatchObject({ stopped: true, alreadyStopped: true });
    expect(writesOf(one.calls)).toHaveLength(0);
    const expired = recurringStandIn('refuse', { status: 'EXPIRED' });
    const two = gateway(expired.routes, WRITES);
    const result = await two.gw.callTool('stop_agreement', stop);
    expect(texts(result)[0]).toMatch(/only a pending or active agreement can be stopped, and this one is EXPIRED\. Nothing was sent\./);
    expect(writesOf(two.calls)).toHaveLength(0);
  });

  it('says what HTTP 429 with Retry-After and HTTP 400 mean, in our own words', async () => {
    for (const [reply, said] of [
      [{ status: 429, headers: { 'retry-after': '9' }, body: vendorText }, /HTTP 429 .*retry-after=9s.*The agreement was not stopped\. After the wait: Call again with exactly the same input/],
      [{ status: 400, body: vendorText }, /The agreement was not stopped\. Vipps MobilePay refused to stop the agreement; get_agreement shows its status\./],
    ] as const) {
      const vendor = recurringStandIn();
      const routes = new Proxy({} as Record<string, Route>, {
        get: (_target, name) => (name === 'POST /accesstoken/get' ? undefined : name === `PATCH ${AGREEMENT_PATH}` ? reply : (vendor.routes as Record<string, Route>)[name as string]),
      });
      const result = await gateway(routes, WRITES).gw.callTool('stop_agreement', stop);
      expect(texts(result)[0]).toMatch(said);
      expectNothingLeaks(result, ['Charge rejected']);
    }
  });

  for (const repeat of REPEATS) {
    it(`stops once when the answer is lost and the call is repeated (${repeat})`, async () => {
      const vendor = recurringStandIn(repeat);
      const { gw, calls } = gateway(vendor.routes, WRITES);
      vendor.loseNextAnswer();
      const first = await gw.callTool('stop_agreement', stop);
      expect(texts(first)[0]).toMatch(/It is not known whether the agreement was stopped\. Call again with exactly the same input/);
      const second = await gw.callTool('stop_agreement', stop);
      expect(data(second)).toMatchObject({ stopped: true, alreadyStopped: true });
      expect(writesOf(calls)).toHaveLength(1);
    });
  }
});

describe('the four Recurring changes', () => {
  it('are not sent when the start of the audit cannot be written', async () => {
    for (const [tool, input] of [
      ['create_charge', newCharge],
      ['capture_charge', capture],
      ['update_agreement', rename],
      ['stop_agreement', stop],
    ] as const) {
      const vendor = recurringStandIn();
      const { gw, calls } = gateway(vendor.routes, {
        policy: {
          enableWrites: true,
          audit: () => {
            throw new Error('disk full');
          },
        },
      });
      const result = await gw.callTool(tool, input);
      expect(result.isError, tool).toBe(true);
      expect(apiCalls(calls), tool).toHaveLength(0);
    }
  });

  it('work over the MCP server when VIPPS_ENABLE_WRITES is set', async () => {
    const before = process.env.VIPPS_ENABLE_WRITES;
    process.env.VIPPS_ENABLE_WRITES = 'true';
    try {
      const vendor = recurringStandIn();
      const { mcpClient } = await connect(vendor.routes);
      const names = (await mcpClient.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['vipps_create_charge', 'vipps_capture_charge', 'vipps_update_agreement', 'vipps_stop_agreement']));
      const result = await mcpClient.callTool({ name: 'vipps_stop_agreement', arguments: stop });
      expect(result.isError).toBeFalsy();
      expect(vendor.agreement.status).toBe('STOPPED');
    } finally {
      if (before === undefined) delete process.env.VIPPS_ENABLE_WRITES;
      else process.env.VIPPS_ENABLE_WRITES = before;
    }
  });
});
