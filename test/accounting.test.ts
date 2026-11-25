import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVippsMobilePayGateway, vippsToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { createServer } from '../src/server.js';
import { MAX_OWNER_LEDGER_PAGES } from '../src/vipps/owner-binding.js';
import {
  ACCOUNTING_KEYS,
  ACCOUNTING_TOKEN_PATH,
  accountingGateway,
  apiCalls,
  makeClient,
  OWNER,
  stubFetch,
  texts,
  type Reply,
  type Route,
} from './helpers.js';

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('VIPPS_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

/** A fixed clock: 20 November 2026, midday in Oslo. */
const NOW = () => Date.parse('2026-11-20T11:00:00Z');

/** Another made-up organisation, and one with the same number under another scheme. */
const OTHER = { scheme: 'business:DK:CVR', id: '20000022' } as const;
const SAME_ID_OTHER_SCHEME = { scheme: 'business:NO:ORG', id: OWNER.id } as const;

const OWN_LEDGER = '302321';
const OTHER_LEDGER = '402432';

function ledger(id: string, owner: unknown, extra: Record<string, unknown> = {}) {
  return {
    ledgerId: id,
    currency: 'DKK',
    payoutBankAccount: { scheme: 'BBAN:DK', id: '12345678901234' },
    owner,
    settlesForRecipientHandles: ['DK:90601'],
    salesUnits: [{ name: 'Fjordbageriet', recipientHandle: 'DK:90601', businessIdentifier: owner }],
    ...extra,
  };
}

/** The ledger list as one page. */
function ledgerList(items: unknown[]): Record<string, Route> {
  return { 'GET /settlement/v1/ledgers': { body: { cursor: '', items } } };
}

const BOTH = [ledger(OWN_LEDGER, OWNER), ledger(OTHER_LEDGER, OTHER)];

function sale(overrides: Record<string, unknown> = {}) {
  return {
    entryType: 'capture',
    time: '2026-11-03T09:12:00Z',
    orderDate: '2026-11-03T09:11:00Z',
    pspReference: '3343121302',
    reference: 'fjord-salg-10042',
    currency: 'DKK',
    paymentType: 'vippsnummer',
    classification: { solution: 'mpos', salesCategory: 'retail' },
    amounts: { gross: 12_500, net: 10_000, vat: 2_500 },
    lines: [
      {
        lineId: '1',
        name: 'Rugbrød',
        quantity: 1,
        unitPriceGross: 12_500,
        unitPriceNet: 10_000,
        lineTotalGross: 12_500,
        lineTotalNet: 10_000,
        vatRate: 2500,
        vatAmount: 2_500,
        category: 'bread',
        discountTotal: 0,
      },
    ],
    customer: { email: 'kunde@example.invalid', phone: '+4500000000', name: 'Made Up Customer' },
    completeness: { hasLineItems: true, hasVatBreakdown: true, hasCustomerIdentity: true },
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    pspReference: '3343121302',
    time: '2026-11-03T09:12:00.000000Z',
    ledgerDate: '2026-11-03',
    entryType: 'capture',
    reference: 'fjord-salg-10042',
    currency: 'DKK',
    amount: 12_500,
    balanceBefore: 0,
    balanceAfter: 12_500,
    recipientHandle: 'DK:90601',
    name: 'Made Up Customer',
    message: 'a message',
    ...overrides,
  };
}

const ACCOUNTING_TOOLS = ['check_connection', 'list_ledgers', 'get_funds_summary', 'list_transactions', 'list_sales', 'get_sale'];

const SAMPLES: Record<string, GatewayJsonObject> = {
  list_ledgers: {},
  get_funds_summary: { ledgerId: OWN_LEDGER, fromDate: '2026-11-03', toDate: '2026-11-03' },
  list_transactions: { ledgerId: OWN_LEDGER, fromDate: '2026-11-03', toDate: '2026-11-03' },
  list_sales: { ledgerId: OWN_LEDGER, ledgerDate: '2026-11-03' },
  get_sale: { ledgerId: OWN_LEDGER, reference: 'fjord-salg-10042' },
};

describe('accounting keys: instance', () => {
  it('offers the Report and Sales tools only', () => {
    const { gw } = accountingGateway();
    expect(gw.keyType).toBe('accounting');
    expect(gw.tools.map(tool => tool.name)).toEqual(ACCOUNTING_TOOLS);
    const catalog = vippsToolCatalog.filter(entry => entry.keyTypes.includes('accounting')).map(entry => entry.name);
    expect(catalog).toEqual(ACCOUNTING_TOOLS);
  });

  it('does not offer the Sales tools with the merchant’s own keys or partner keys', () => {
    for (const entry of vippsToolCatalog.filter(item => item.name.includes('sale') && !item.name.includes('sales_unit'))) {
      expect(entry.keyTypes).toEqual(['accounting']);
    }
  });

  it('refuses every other tool before anything is sent, the token request included', async () => {
    const { gw, calls } = accountingGateway(ledgerList(BOTH));
    for (const entry of vippsToolCatalog.filter(item => !ACCOUNTING_TOOLS.includes(item.name))) {
      const result = await gw.callTool(entry.name, {}, { owner: OWNER });
      expect(result.isError, entry.name).toBe(true);
    }
    // A tool that takes input: refused for the keys, not for the input.
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' }, { owner: OWNER });
    expect(texts(result)[0]).toContain('does not work with accounting keys');
    expect(calls).toHaveLength(0);
  });

  it('is refused with a subscription key, a Merchant-Serial-Number or the test environment', () => {
    const base = { ...ACCOUNTING_KEYS, keyType: 'accounting' as const, environment: 'production' as const, policy: {} };
    expect(() => createVippsMobilePayGateway({ ...base, subscriptionKey: 'x'.repeat(32) } as never)).toThrow(/client secret only/);
    expect(() => createVippsMobilePayGateway({ ...base, merchantSerialNumber: '212345' } as never)).toThrow(/client secret only/);
    expect(() => createVippsMobilePayGateway({ ...base, environment: 'test' } as never)).toThrow(/production/);
    expect(() => createVippsMobilePayGateway({ ...base, clientSecret: undefined } as never)).toThrow();
  });

  it('is never served over MCP, where a call names no organisation', () => {
    const { fetchImpl } = stubFetch();
    const client = makeClient(fetchImpl, {
      clientId: ACCOUNTING_KEYS.clientId,
      clientSecret: ACCOUNTING_KEYS.clientSecret,
      subscriptionKey: undefined,
      merchantSerialNumber: undefined,
      keyType: 'accounting',
      environment: 'production',
    });
    expect(() => createServer({ client })).toThrow(/gateway entry point only/);
  });

  it('is never chosen from the environment', () => {
    const { fetchImpl } = stubFetch();
    expect(() => makeClient(fetchImpl, { keyType: undefined, credentialEnv: { VIPPS_KEY_TYPE: 'accounting' } })).toThrow(/merchant" or "partner/);
  });

  it('asks for the token with Basic credentials and the form body, and sends no subscription key or MSN', async () => {
    const { gw, calls } = accountingGateway(ledgerList(BOTH), { now: NOW });
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect(result.isError).toBeUndefined();
    const token = calls.find(call => call.path === ACCOUNTING_TOKEN_PATH);
    expect(token?.method).toBe('POST');
    const basic = Buffer.from(`${ACCOUNTING_KEYS.clientId}:${ACCOUNTING_KEYS.clientSecret}`, 'utf8').toString('base64');
    expect(token?.headers.Authorization).toBe(`Basic ${basic}`);
    expect(token?.headers['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(token?.body).toBe('grant_type=client_credentials');
    expect(calls.some(call => call.path === '/accesstoken/get')).toBe(false);
    for (const call of calls) {
      const names = Object.keys(call.headers).map(name => name.toLowerCase());
      expect(names).not.toContain('ocp-apim-subscription-key');
      expect(names).not.toContain('merchant-serial-number');
      expect(names).not.toContain('client_id');
      expect(names).not.toContain('client_secret');
    }
    // Neither key, nor the two joined, is in the result.
    const text = JSON.stringify(result);
    expect(text).not.toContain(ACCOUNTING_KEYS.clientSecret);
    expect(text).not.toContain(basic);
  });

  it('names the accounting keys when the token request is refused', async () => {
    const { gw } = accountingGateway({ [`POST ${ACCOUNTING_TOKEN_PATH}`]: { status: 401, body: { error: 'invalid_client' } } });
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('accounting keys were rejected');
  });
});

describe('accounting keys: the organisation of the call', () => {
  it('refuses every tool when the call names no organisation, before anything is sent', async () => {
    const { gw, calls } = accountingGateway(ledgerList(BOTH));
    for (const name of ACCOUNTING_TOOLS) {
      const result = await gw.callTool(name, SAMPLES[name] ?? {});
      expect(result.isError, name).toBe(true);
      expect(texts(result)[0], name).toContain('names none');
      const empty = await gw.callTool(name, SAMPLES[name] ?? {}, {});
      expect(empty.isError, name).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an organisation in another form, taken exactly as given', async () => {
    const { gw, calls } = accountingGateway(ledgerList(BOTH));
    const malformed: unknown[] = [
      null,
      'business:DK:CVR:10000011',
      { scheme: OWNER.scheme },
      { id: OWNER.id },
      { scheme: OWNER.scheme, id: 10000011 },
      { scheme: OWNER.scheme, id: ` ${OWNER.id}` },
      { scheme: OWNER.scheme, id: '' },
      { scheme: 'business:dk:cvr', id: OWNER.id },
      { scheme: 'BBAN:DK', id: OWNER.id },
      [OWNER.scheme, OWNER.id],
    ];
    for (const owner of malformed) {
      const result = await gw.callTool('list_ledgers', {}, { owner } as never);
      expect(result.isError, JSON.stringify(owner)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('lists only the organisation’s ledgers, without the payout account, and counts those it cannot attribute', async () => {
    const unreadable = [
      ledger('500001', undefined),
      ledger('500002', { scheme: OWNER.scheme }),
      ledger('500003', { scheme: OWNER.scheme, id: 10000011 }),
      ledger('500004', 'business:DK:CVR'),
      {},
    ];
    const { gw } = accountingGateway(
      ledgerList([...BOTH, ledger('600001', SAME_ID_OTHER_SCHEME), ledger('600002', { scheme: OWNER.scheme, id: `${OWNER.id} ` }), ...unreadable]),
    );
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as { count: number; ledgers: Array<Record<string, unknown>>; ledgersNotAttributed: number; note: string };
    expect(data.count).toBe(1);
    expect(data.ledgers).toEqual([
      {
        ledgerId: OWN_LEDGER,
        currency: 'DKK',
        owner: OWNER,
        settlesForRecipientHandles: ['DK:90601'],
        salesUnits: [{ name: 'Fjordbageriet', recipientHandle: 'DK:90601' }],
      },
    ]);
    expect(data.ledgersNotAttributed).toBe(unreadable.length);
    expect(texts(result)[0]).toContain('may lack ledgers of this organisation');
    const text = JSON.stringify(result);
    expect(text).not.toContain('payoutBankAccount');
    expect(text).not.toContain('12345678901234');
    expect(text).not.toContain('1234"');
    expect(text).not.toContain(OTHER.id);
    expect(text).not.toContain(OTHER_LEDGER);
  });

  it('keeps two organisations with the same number under different schemes apart', async () => {
    const routes = ledgerList([ledger(OWN_LEDGER, OWNER), ledger('600001', SAME_ID_OTHER_SCHEME)]);
    const dk = await accountingGateway(routes).gw.callTool('list_ledgers', {}, { owner: OWNER });
    const no = await accountingGateway(routes).gw.callTool('list_ledgers', {}, { owner: SAME_ID_OTHER_SCHEME });
    expect((dk.structuredContent as { ledgers: Array<{ ledgerId: string }> }).ledgers.map(item => item.ledgerId)).toEqual([OWN_LEDGER]);
    expect((no.structuredContent as { ledgers: Array<{ ledgerId: string }> }).ledgers.map(item => item.ledgerId)).toEqual(['600001']);
  });

  it('leaves out a ledger whose sales unit names another organisation than its owner', async () => {
    const mixed = ledger('700001', OWNER, { salesUnits: [{ name: 'Andet', recipientHandle: 'DK:90602', businessIdentifier: OTHER }] });
    const { gw } = accountingGateway(ledgerList([ledger(OWN_LEDGER, OWNER), mixed]));
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    const data = result.structuredContent as { count: number; ledgersNotAttributed: number };
    expect(data.count).toBe(1);
    expect(data.ledgersNotAttributed).toBe(1);
    const refused = await gw.callTool('list_sales', { ledgerId: '700001', ledgerDate: '2026-11-03' }, { owner: OWNER });
    expect(refused.isError).toBe(true);
  });

  it('refuses the whole list when a ledger of the organisation is in another form', async () => {
    for (const bad of [
      ledger(OWN_LEDGER, OWNER, { currency: 208 }),
      ledger(OWN_LEDGER, OWNER, { settlesForRecipientHandles: 'DK:90601' }),
      ledger(OWN_LEDGER, OWNER, { salesUnits: [{}] }),
      ledger('not-a-number', OWNER),
    ]) {
      const { gw, calls } = accountingGateway(ledgerList([bad]));
      const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
      expect(texts(result)[0]).toContain('unexpected form');
      // Refused for the owner's own reading: nothing else is asked.
      expect(apiCalls(calls).every(call => call.path === '/settlement/v1/ledgers')).toBe(true);
    }
  });

  it('refuses a list in another form, and a ledger named twice', async () => {
    for (const body of [
      { items: [] },
      { cursor: '', items: {} },
      { cursor: null, items: [] },
      { cursor: '', items: [null] },
      { cursor: '', items: [ledger(OWN_LEDGER, OWNER), ledger(OWN_LEDGER, OWNER)] },
      { cursor: '', items: [ledger(OWN_LEDGER, OWNER), ledger(OWN_LEDGER, OTHER)] },
    ]) {
      const { gw } = accountingGateway({ 'GET /settlement/v1/ledgers': { body } });
      const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
      expect(result.isError, JSON.stringify(body)).toBe(true);
    }
  });

  it('reads every page of the ledger list, following the cursor', async () => {
    const pages: Record<string, Reply> = {
      '': { body: { cursor: 'c2', items: [ledger(OTHER_LEDGER, OTHER)] } },
      c2: { body: { cursor: 'c3', items: [] } },
      c3: { body: { cursor: '', items: [ledger(OWN_LEDGER, OWNER)] } },
    };
    const { gw, calls } = accountingGateway({ 'GET /settlement/v1/ledgers': url => pages[url.searchParams.get('cursor') ?? ''] as Reply });
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect((result.structuredContent as { count: number }).count).toBe(1);
    expect(apiCalls(calls).map(call => call.query.cursor)).toEqual([undefined, 'c2', 'c3']);
  });

  it('ends on an empty page that gives back the cursor it was asked with (as observed in production for an empty list)', async () => {
    const pages: Record<string, Reply> = {
      '': { body: { cursor: 'c2', items: [ledger(OWN_LEDGER, OWNER)] } },
      c2: { body: { cursor: 'c2', items: [] } },
    };
    const { gw, calls } = accountingGateway({ 'GET /settlement/v1/ledgers': url => pages[url.searchParams.get('cursor') ?? ''] as Reply });
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect((result.structuredContent as { count: number }).count).toBe(1);
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it('refuses ledgers under a cursor that does not move', async () => {
    const pages: Record<string, Reply> = {
      '': { body: { cursor: 'c2', items: [ledger(OWN_LEDGER, OWNER)] } },
      c2: { body: { cursor: 'c2', items: [ledger(OTHER_LEDGER, OTHER)] } },
    };
    const { gw, calls } = accountingGateway({ 'GET /settlement/v1/ledgers': url => pages[url.searchParams.get('cursor') ?? ''] as Reply });
    const result = await gw.callTool('list_ledgers', {}, { owner: OWNER });
    expect(result.isError).toBe(true);
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it(`refuses a list that does not end within ${MAX_OWNER_LEDGER_PAGES} pages, and asks for no report or sale`, async () => {
    let page = 0;
    const { gw, calls } = accountingGateway(
      {
        'GET /settlement/v1/ledgers': () => {
          page += 1;
          return { body: { cursor: `c${page}`, items: page === 1 ? [ledger(OWN_LEDGER, OWNER)] : [] } };
        },
      },
      { now: NOW },
    );
    const result = await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain(`${MAX_OWNER_LEDGER_PAGES} pages`);
    const made = apiCalls(calls);
    expect(made).toHaveLength(MAX_OWNER_LEDGER_PAGES);
    expect(made.every(call => call.path === '/settlement/v1/ledgers')).toBe(true);
  });

  it('refuses a ledger of another organisation, and one that does not exist, with one text and nothing asked for it', async () => {
    const answers: string[] = [];
    for (const ledgerId of [OTHER_LEDGER, '999999']) {
      for (const [name, input] of Object.entries(SAMPLES)) {
        if (!('ledgerId' in input)) continue;
        const { gw, calls } = accountingGateway({ ...ledgerList(BOTH), ...everyRead() }, { now: NOW });
        const result = await gw.callTool(name, { ...input, ledgerId }, { owner: OWNER });
        expect(result.isError, `${name} ${ledgerId}`).toBe(true);
        answers.push(texts(result)[0] ?? '');
        expect(apiCalls(calls).map(call => call.path)).toEqual(['/settlement/v1/ledgers']);
      }
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('not one of this organisation’s ledgers');
  });

  it('shares the token between callers, and reads the ledgers anew for every call', async () => {
    const { gw, calls } = accountingGateway({ ...ledgerList(BOTH), ...everyRead() }, { now: NOW });
    const own = await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER });
    expect(own.isError).toBeUndefined();
    // The other organisation reads its own ledger; then neither can read the other's, whatever was read before.
    const other = await gw.callTool('list_sales', { ...SAMPLES.list_sales, ledgerId: OTHER_LEDGER }, { owner: OTHER });
    expect(other.isError).toBeUndefined();
    const crossA = await gw.callTool('list_sales', { ...SAMPLES.list_sales, ledgerId: OTHER_LEDGER }, { owner: OWNER });
    const crossB = await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OTHER });
    expect(crossA.isError).toBe(true);
    expect(crossB.isError).toBe(true);
    expect(calls.filter(call => call.path === ACCOUNTING_TOKEN_PATH)).toHaveLength(1);
    expect(calls.filter(call => call.path === '/settlement/v1/ledgers')).toHaveLength(4);
    expect(calls.filter(call => call.path.startsWith('/sales/'))).toHaveLength(2);
  });

  it('stops reading a ledger at the next call once the organisation no longer owns it, and keeps no answer', async () => {
    let owner: unknown = OWNER;
    let salesAsked = 0;
    const { gw } = accountingGateway(
      {
        'GET /settlement/v1/ledgers': () => ({ body: { cursor: '', items: [ledger(OWN_LEDGER, owner)] } }),
        'GET /sales/report/v1/ledgers/302321/dates/2026-11-03': () => {
          salesAsked += 1;
          return { body: { items: [sale()], cursor: null, hasMore: false } };
        },
      },
      { now: NOW },
    );
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER })).isError).toBeUndefined();
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER })).isError).toBeUndefined();
    expect(salesAsked).toBe(2);
    owner = OTHER;
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER })).isError).toBe(true);
    expect(salesAsked).toBe(2);
  });
});

/** Answers for every read of the own and the other ledger. */
function everyRead(): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const id of [OWN_LEDGER, OTHER_LEDGER, '999999']) {
    routes[`GET /sales/report/v1/ledgers/${id}/dates/2026-11-03`] = { body: { items: [sale()], cursor: null, hasMore: false } };
    routes[`GET /sales/report/v1/ledgers/${id}/references/fjord-salg-10042`] = { body: { items: [sale()], cursor: null, hasMore: false } };
    for (const topic of ['funds', 'fees']) {
      routes[`GET /report/v2/ledgers/${id}/${topic}/dates/2026-11-03`] = { body: { items: [entry()], hasMore: false, tryLater: false } };
    }
  }
  return routes;
}

describe('accounting keys: reports and sales', () => {
  it('reads the funds ledger of the organisation’s ledger, and passes on nothing about the payer', async () => {
    const { gw } = accountingGateway({ ...ledgerList(BOTH), ...everyRead() }, { now: NOW });
    const result = await gw.callTool('list_transactions', SAMPLES.list_transactions, { owner: OWNER });
    expect(result.isError).toBeUndefined();
    const text = JSON.stringify(result.structuredContent);
    expect(text).toContain('3343121302');
    expect(text).not.toContain('Made Up Customer');
    expect(text).not.toContain('a message');
    const summary = await gw.callTool('get_funds_summary', SAMPLES.get_funds_summary, { owner: OWNER });
    expect(summary.isError).toBeUndefined();
  });

  it('refuses a ledger entry in another form', async () => {
    for (const bad of [entry({ amount: '125.00' }), entry({ balanceAfter: undefined }), {}]) {
      const { gw } = accountingGateway(
        { ...ledgerList(BOTH), 'GET /report/v2/ledgers/302321/funds/dates/2026-11-03': { body: { items: [bad], hasMore: false, tryLater: false } } },
        { now: NOW },
      );
      const result = await gw.callTool('list_transactions', SAMPLES.list_transactions, { owner: OWNER });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('lists the sales of a ledger date with order lines and VAT, and nothing about the customer', async () => {
    const pages: Record<string, Reply> = {
      '': { body: { items: [sale()], cursor: 's2', hasMore: true } },
      s2: { body: { items: [sale({ entryType: 'refund', pspReference: '3343121303', amounts: { gross: -12_500, net: -10_000, vat: -2_500 } })], cursor: null, hasMore: false } },
    };
    const { gw, calls } = accountingGateway(
      { ...ledgerList(BOTH), 'GET /sales/report/v1/ledgers/302321/dates/2026-11-03': url => pages[url.searchParams.get('cursor') ?? ''] as Reply },
      { now: NOW },
    );
    const result = await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER });
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent as { count: number; complete: boolean; items: Array<Record<string, unknown>> };
    expect(data.count).toBe(2);
    expect(data.complete).toBe(true);
    const { customer: _customer, completeness: _completeness, ...rest } = sale();
    expect(data.items[0]).toEqual({ ...rest, completeness: { hasLineItems: true, hasVatBreakdown: true } });
    const text = JSON.stringify(result);
    expect(text).not.toContain('kunde@example.invalid');
    expect(text).not.toContain('Made Up Customer');
    expect(text).not.toContain('hasCustomerIdentity');
    expect(apiCalls(calls).filter(call => call.path.startsWith('/sales/')).map(call => call.query.cursor)).toEqual([undefined, 's2']);
  });

  it('says that more sales can come for the newest dates, and refuses a date that has not begun', async () => {
    const { gw, calls } = accountingGateway(
      { ...ledgerList(BOTH), 'GET /sales/report/v1/ledgers/302321/dates/2026-11-20': { body: { items: [], cursor: null, hasMore: false } } },
      { now: NOW },
    );
    const today = await gw.callTool('list_sales', { ledgerId: OWN_LEDGER, ledgerDate: '2026-11-20' }, { owner: OWNER });
    expect((today.structuredContent as { complete: boolean }).complete).toBe(false);
    expect(texts(today)[0]).toContain('may not be over');
    const tomorrow = await gw.callTool('list_sales', { ledgerId: OWN_LEDGER, ledgerDate: '2026-11-21' }, { owner: OWNER });
    expect(tomorrow.isError).toBe(true);
    expect(apiCalls(calls).filter(call => call.path.includes('2026-11-21'))).toHaveLength(0);
  });

  it('refuses a page of sales in another form: a wrong type, a missing field, an empty item', async () => {
    for (const items of [
      [sale({ amounts: { gross: '125.00', net: 10_000, vat: 2_500 } })],
      [sale({ amounts: { gross: 12_500, net: 10_000 } })],
      [sale({ lines: undefined })],
      [sale({ lines: [{}] })],
      [sale({ completeness: { hasLineItems: true } })],
      [sale({ pspReference: undefined })],
      [{}],
    ]) {
      const { gw } = accountingGateway(
        { ...ledgerList(BOTH), 'GET /sales/report/v1/ledgers/302321/dates/2026-11-03': { body: { items, cursor: null, hasMore: false } } },
        { now: NOW },
      );
      const result = await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER });
      expect(result.isError, JSON.stringify(items)).toBe(true);
    }
  });

  it('refuses more pages of sales without a new cursor', async () => {
    const { gw } = accountingGateway(
      { ...ledgerList(BOTH), 'GET /sales/report/v1/ledgers/302321/dates/2026-11-03': { body: { items: [sale()], cursor: null, hasMore: true } } },
      { now: NOW },
    );
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { owner: OWNER })).isError).toBe(true);
  });

  it('reads one sale by the business’s reference or by Vipps MobilePay’s', async () => {
    const { gw, calls } = accountingGateway(
      {
        ...ledgerList(BOTH),
        'GET /sales/report/v1/ledgers/302321/references/fjord-salg-10042': { body: { items: [sale()], cursor: null, hasMore: false } },
        'GET /sales/report/v1/ledgers/302321/psp-references/3343121302': { body: { items: [sale()], cursor: null, hasMore: false } },
      },
      { now: NOW },
    );
    const byReference = await gw.callTool('get_sale', SAMPLES.get_sale, { owner: OWNER });
    expect(byReference.structuredContent).toMatchObject({ ledgerId: OWN_LEDGER, reference: 'fjord-salg-10042', count: 1 });
    const byPsp = await gw.callTool('get_sale', { ledgerId: OWN_LEDGER, pspReference: '3343121302' }, { owner: OWNER });
    expect(byPsp.structuredContent).toMatchObject({ pspReference: '3343121302', count: 1 });
    expect(JSON.stringify([byReference, byPsp])).not.toContain('kunde@example.invalid');
    const both = await gw.callTool('get_sale', { ...SAMPLES.get_sale, pspReference: '3343121302' }, { owner: OWNER });
    const neither = await gw.callTool('get_sale', { ledgerId: OWN_LEDGER }, { owner: OWNER });
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(apiCalls(calls).filter(call => call.path.startsWith('/sales/'))).toHaveLength(2);
  });

  it('refuses a sale answered with another reference than the one asked for', async () => {
    const { gw } = accountingGateway({
      ...ledgerList(BOTH),
      'GET /sales/report/v1/ledgers/302321/references/fjord-salg-10042': { body: { items: [sale({ reference: 'other' })], cursor: null, hasMore: false } },
    });
    expect((await gw.callTool('get_sale', SAMPLES.get_sale, { owner: OWNER })).isError).toBe(true);
  });
});

describe('accounting keys: connection check', () => {
  const outcome = (result: { structuredContent?: unknown }) => (result.structuredContent as { outcome?: string }).outcome;

  it('is connected only when a ledger of the organisation is visible', async () => {
    const { gw } = accountingGateway(ledgerList(BOTH));
    const result = await gw.callTool('check_connection', {}, { owner: OWNER });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ connected: true, outcome: 'connected', ledgers: 1 });
  });

  it('says so in its own outcome when no ledger of the organisation is visible (as observed in production: an empty list)', async () => {
    const { gw } = accountingGateway({ 'GET /settlement/v1/ledgers': { body: { cursor: '', items: [] } } });
    const result = await gw.callTool('check_connection', {}, { owner: OWNER });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ connected: false, outcome: 'no_ledger_for_owner' });
    expect(texts(result)[0]).toContain('No ledger of this organisation is visible yet');
    // Ledgers of other organisations do not make the connection work for this one.
    const other = await accountingGateway(ledgerList([ledger(OTHER_LEDGER, OTHER), ledger('600001', SAME_ID_OTHER_SCHEME)])).gw.callTool(
      'check_connection',
      {},
      { owner: OWNER },
    );
    expect(outcome(other)).toBe('no_ledger_for_owner');
  });

  it('tells refused keys, an unavailable service and a missing organisation apart', async () => {
    for (const status of [400, 401, 403]) {
      const { gw } = accountingGateway({ [`POST ${ACCOUNTING_TOKEN_PATH}`]: { status, body: {} } });
      expect(outcome(await gw.callTool('check_connection', {}, { owner: OWNER })), String(status)).toBe('keys_refused');
    }
    for (const status of [401, 403]) {
      const { gw } = accountingGateway({ 'GET /settlement/v1/ledgers': { status, body: {} } });
      expect(outcome(await gw.callTool('check_connection', {}, { owner: OWNER })), String(status)).toBe('keys_refused');
    }
    for (const reply of [{ status: 500, body: {} }, { status: 429, body: {} }, { body: { items: [] } }]) {
      const { gw } = accountingGateway({ 'GET /settlement/v1/ledgers': reply });
      expect(outcome(await gw.callTool('check_connection', {}, { owner: OWNER })), JSON.stringify(reply)).toBe('unavailable');
    }
    const { gw, calls } = accountingGateway(ledgerList(BOTH));
    const missing = await gw.callTool('check_connection', {});
    expect(missing.structuredContent).toEqual({ connected: false, outcome: 'owner_missing' });
    expect(calls).toHaveLength(0);
  });
});

describe('accounting keys: audit', () => {
  it('does not write the organisation of the call, and records a refusal for a call without one', async () => {
    const records: unknown[] = [];
    const { gw } = accountingGateway({ ...ledgerList(BOTH), ...everyRead() }, { now: NOW, policy: { audit: record => void records.push(record) } });
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { caller: 'user-17', owner: OWNER })).isError).toBeUndefined();
    expect((await gw.callTool('list_sales', SAMPLES.list_sales, { caller: 'user-17' })).isError).toBe(true);
    const text = JSON.stringify(records);
    expect(text).not.toContain(OWNER.id);
    expect(text).not.toContain(OWNER.scheme);
    expect(text).toContain('policy_denied');
  });
});
