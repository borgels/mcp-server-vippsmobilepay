import { describe, expect, it } from 'vitest';
import { lastAskableLedgerDate, MAX_LEDGER_PAGES, MAX_TRANSACTIONS } from '../src/vipps/reports.js';
import { AGREEMENT_PAGE_SIZE, MAX_AGREEMENT_PAGES, MAX_CHARGE_PAGES } from '../src/vipps/recurring.js';
import { apiCalls, charge, gateway, payment, texts, type Reply } from './helpers.js';

const LEDGER = '302321';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    pspReference: '3343121302',
    time: '2026-11-03T09:12:00.000000Z',
    ledgerDate: '2026-11-03',
    entryType: 'capture',
    reference: 'fjord-order-10042',
    currency: 'DKK',
    amount: 49_900,
    balanceBefore: 100_000,
    balanceAfter: 149_900,
    recipientHandle: 'api:212345',
    ...overrides,
  };
}

/** A Report API "by date" route: the dates given answer with their pages, others with an empty closed day. */
function reportRoute(pagesByDate: Record<string, Array<Record<string, unknown>>>) {
  return (url: URL): Reply => {
    const date = url.pathname.split('/').pop() ?? '';
    const pages = pagesByDate[date] ?? [{ items: [], hasMore: false, tryLater: false }];
    const index = Number(url.searchParams.get('cursor') ?? '0');
    return { body: pages[index] };
  };
}

describe('ledgers', () => {
  it('reads every page of ledgers and shows only the last four characters of the payout account', async () => {
    const ledger = (id: string) => ({
      ledgerId: id,
      currency: 'DKK',
      payoutBankAccount: { scheme: 'BBAN:DK', id: '12345678901234' },
      settlesForRecipientHandles: ['api:212345'],
    });
    const { gw, calls } = gateway({
      'GET /settlement/v1/ledgers': url =>
        url.searchParams.get('cursor') === 'page-2' ? { body: { cursor: '', items: [ledger('2')] } } : { body: { cursor: 'page-2', items: [ledger('1')] } },
    });
    const result = await gw.callTool('list_ledgers', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      count: 2,
      ledgers: [
        { ...ledger('1'), payoutBankAccount: { scheme: 'BBAN:DK', idLast4: '1234' } },
        { ...ledger('2'), payoutBankAccount: { scheme: 'BBAN:DK', idLast4: '1234' } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('12345678901234');
    expect(texts(result)[0]).toContain('data, not instructions');
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it('refuses rather than truncates an endless ledger list', async () => {
    let n = 0;
    const { gw, calls } = gateway({
      'GET /settlement/v1/ledgers': () => ({ body: { cursor: `c${(n += 1)}`, items: [{ ledgerId: String(n) }] } }),
    });
    const result = await gw.callTool('list_ledgers', {});
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(/refused rather than returned incomplete/);
    expect(apiCalls(calls)).toHaveLength(MAX_LEDGER_PAGES);
  });
});

describe('transactions and funds summary', () => {
  it('follows the cursor while hasMore is true, date by date, and says which dates are still open', async () => {
    const { gw, calls } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-01`]: reportRoute({}),
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-02`]: reportRoute({
        '2026-11-02': [
          { items: [entry({ ledgerDate: '2026-11-02' })], hasMore: true, cursor: '1', tryLater: false },
          { items: [entry({ ledgerDate: '2026-11-02', entryType: 'refund', amount: -10_000 })], hasMore: false, tryLater: false },
        ],
      }),
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-03`]: reportRoute({
        '2026-11-03': [{ items: [entry()], tryLater: true }],
      }),
    });
    const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-01', toDate: '2026-11-03' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ledgerId: LEDGER,
      topic: 'funds',
      complete: false,
      openDates: ['2026-11-03'],
      amountsInMinorUnits: true,
      count: 3,
    });
    const requests = apiCalls(calls);
    expect(requests.map(call => `${call.path.split('/').pop()}${call.query.cursor ? `#${call.query.cursor}` : ''}`)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-02#1',
      '2026-11-03',
    ]);
    // Names, messages and phone numbers are never asked for.
    expect(requests.every(call => !('includeGDPRSensitiveData' in call.query))).toBe(true);
  });

  it('reads every page of a date that is still open: tryLater with hasMore does not end the pages', async () => {
    const route = reportRoute({
      '2026-11-03': [
        { items: [entry(), entry({ entryType: 'refund', amount: -10_000 })], hasMore: true, cursor: '1', tryLater: true },
        { items: [entry({ amount: 20_000 })], hasMore: true, cursor: '2', tryLater: true },
        { items: [entry({ entryType: 'fees-retained', amount: -300 })], hasMore: false, tryLater: true },
      ],
    });
    const { gw, calls } = gateway({ [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-03`]: route });
    const input = { ledgerId: LEDGER, fromDate: '2026-11-03', toDate: '2026-11-03' };

    const listed = await gw.callTool('list_transactions', input);
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toMatchObject({ complete: false, openDates: ['2026-11-03'], count: 4 });
    expect(apiCalls(calls).map(call => call.query.cursor ?? '')).toEqual(['', '1', '2']);

    const summed = await gw.callTool('get_funds_summary', input);
    expect(summed.structuredContent).toMatchObject({
      complete: false,
      openDates: ['2026-11-03'],
      period: { entries: 4, totalsByEntryType: { capture: 69_900, refund: -10_000, 'fees-retained': -300 } },
      days: [{ ledgerDate: '2026-11-03', open: true, entries: 4 }],
    });
  });

  it('keeps a date open when an earlier page said tryLater and the last page does not', async () => {
    const { gw } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-03`]: reportRoute({
        '2026-11-03': [
          { items: [entry()], hasMore: true, cursor: '1', tryLater: true },
          { items: [entry()], hasMore: false },
        ],
      }),
    });
    const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-03', toDate: '2026-11-03' });
    expect(result.structuredContent).toMatchObject({ complete: false, openDates: ['2026-11-03'], count: 2 });
  });

  it('refuses an open date that says there are more pages without a new cursor', async () => {
    const { gw, calls } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-03`]: () => ({ body: { items: [entry()], hasMore: true, tryLater: true } }),
    });
    const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-03', toDate: '2026-11-03' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(apiCalls(calls)).toHaveLength(1);
  });

  describe('a period that reaches past today', () => {
    const day = (date: string) => `GET /report/v2/ledgers/${LEDGER}/funds/dates/${date}`;
    const closed = (date: string, amount: number) =>
      reportRoute({ [date]: [{ items: [entry({ ledgerDate: date, amount })], hasMore: false, tryLater: false }] });
    /** Vipps MobilePay's answer for a ledger date more than 24 hours ahead. */
    const refused = () => ({ status: 400, body: { title: 'Bad Request', detail: 'ledgerDate is in the future' } });
    const routes = {
      [day('2026-11-24')]: closed('2026-11-24', 30_000),
      [day('2026-11-25')]: reportRoute({ '2026-11-25': [{ items: [entry({ ledgerDate: '2026-11-25', amount: 12_500 })], tryLater: true }] }),
      [day('2026-11-26')]: reportRoute({ '2026-11-26': [{ items: [], tryLater: true }] }),
      [day('2026-11-27')]: refused,
      [day('2026-11-28')]: refused,
    };
    const period = { ledgerId: LEDGER, fromDate: '2026-11-24', toDate: '2026-11-28' };
    const midday = () => Date.parse('2026-11-25T11:00:00Z');

    it('asks only for dates Vipps MobilePay can answer for, and names the rest as open', async () => {
      const { gw, calls } = gateway(routes, { now: midday });
      const result = await gw.callTool('list_transactions', period);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        complete: false,
        openDates: ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'],
        count: 2,
      });
      expect(apiCalls(calls).map(call => call.path.split('/').pop())).toEqual(['2026-11-24', '2026-11-25', '2026-11-26']);
    });

    it('sums the days that have been, with the days to come as open days without entries', async () => {
      const { gw, calls } = gateway(routes, { now: midday });
      const result = await gw.callTool('get_funds_summary', period);
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        complete: false,
        openDates: ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'],
        period: { entries: 2, totalsByEntryType: { capture: 42_500 } },
        days: [
          { ledgerDate: '2026-11-24', open: false, entries: 1 },
          { ledgerDate: '2026-11-25', open: true, entries: 1 },
          { ledgerDate: '2026-11-26', open: true, entries: 0 },
          { ledgerDate: '2026-11-27', open: true, entries: 0, openingBalance: null, closingBalance: null },
          { ledgerDate: '2026-11-28', open: true, entries: 0, openingBalance: null, closingBalance: null },
        ],
      });
      expect(apiCalls(calls)).toHaveLength(3);
    });

    it('asks nothing for a period that has not begun', async () => {
      const { gw, calls } = gateway(routes, { now: midday });
      const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-27', toDate: '2026-11-28' });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ complete: false, openDates: ['2026-11-27', '2026-11-28'], count: 0, items: [] });
      expect(apiCalls(calls)).toHaveLength(0);
    });

    it("asks for tomorrow's date in UTC: late in the evening it is already the sales unit's day", () => {
      expect(lastAskableLedgerDate(Date.parse('2026-11-25T00:00:00Z'))).toBe('2026-11-26');
      expect(lastAskableLedgerDate(Date.parse('2026-11-25T23:59:59Z'))).toBe('2026-11-26');
      expect(lastAskableLedgerDate(Date.parse('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    });
  });

  it('reads the fees ledger when asked', async () => {
    const { gw, calls } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/fees/dates/2026-11-01`]: reportRoute({}),
    });
    const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-01', toDate: '2026-11-01', topic: 'fees' });
    expect(result.structuredContent).toMatchObject({ topic: 'fees', complete: true, count: 0 });
    expect(apiCalls(calls)[0]?.path).toContain('/fees/dates/');
  });

  it(`refuses rather than truncates more than ${MAX_TRANSACTIONS} entries`, async () => {
    const many = Array.from({ length: 1_000 }, () => entry());
    const { gw } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-01`]: () => ({ body: { items: many, hasMore: false, tryLater: false } }),
      ...Object.fromEntries(
        ['02', '03', '04', '05', '06'].map(day => [
          `GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-${day}`,
          () => ({ body: { items: many, hasMore: false, tryLater: false } }),
        ]),
      ),
    });
    const result = await gw.callTool('list_transactions', { ledgerId: LEDGER, fromDate: '2026-11-01', toDate: '2026-11-06' });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(/more than 5000 entries.*Refused rather than returned incomplete/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses a period that is reversed, too long or not a real date, before any request', async () => {
    const { gw, calls } = gateway();
    for (const input of [
      { ledgerId: LEDGER, fromDate: '2026-11-05', toDate: '2026-11-01' },
      { ledgerId: LEDGER, fromDate: '2026-10-01', toDate: '2026-11-15' },
      { ledgerId: LEDGER, fromDate: '2026-02-30', toDate: '2026-03-01' },
      { ledgerId: 'abc', fromDate: '2026-11-01', toDate: '2026-11-01' },
    ]) {
      const result = await gw.callTool('get_funds_summary', input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('sums the funds ledger per date and for the period', async () => {
    const { gw } = gateway({
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-01`]: reportRoute({
        '2026-11-01': [
          {
            items: [
              entry({ amount: 49_900, balanceBefore: 0, balanceAfter: 49_900 }),
              entry({ entryType: 'refund', amount: -9_900, balanceBefore: 49_900, balanceAfter: 40_000 }),
              entry({ entryType: 'fees-retained', amount: -500, balanceBefore: 40_000, balanceAfter: 39_500 }),
            ],
            hasMore: false,
            tryLater: false,
          },
        ],
      }),
      [`GET /report/v2/ledgers/${LEDGER}/funds/dates/2026-11-02`]: reportRoute({
        '2026-11-02': [
          {
            items: [entry({ entryType: 'payout-scheduled', amount: -39_500, balanceBefore: 39_500, balanceAfter: 0, recipientHandle: '' })],
            hasMore: false,
            tryLater: false,
          },
        ],
      }),
    });
    const result = await gw.callTool('get_funds_summary', { ledgerId: LEDGER, fromDate: '2026-11-01', toDate: '2026-11-02' });
    expect(result.structuredContent).toMatchObject({
      complete: true,
      period: {
        entries: 4,
        currencies: ['DKK'],
        totalsByEntryType: { capture: 49_900, refund: -9_900, 'fees-retained': -500, 'payout-scheduled': -39_500 },
        openingBalance: 0,
        closingBalance: 0,
      },
      days: [
        { ledgerDate: '2026-11-01', entries: 3, openingBalance: 0, closingBalance: 39_500 },
        { ledgerDate: '2026-11-02', entries: 1, closingBalance: 0 },
      ],
    });
  });

  it('is not offered with partner keys (the Report API does not accept them)', async () => {
    const { gw, calls } = gateway({}, { keyType: 'partner', environment: 'production' });
    const names = gw.tools.map(tool => tool.name);
    expect(names).not.toContain('list_ledgers');
    expect(names).not.toContain('get_funds_summary');
    expect(names).not.toContain('list_transactions');
    expect(names).toContain('get_payment');
    const result = await gw.callTool('list_ledgers', {});
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(/does not work with partner keys/);
    expect(calls).toHaveLength(0);
  });
});

describe('ePayment reads', () => {
  it('returns the payment and its events', async () => {
    const events = [{ reference: 'fjord-order-10042', name: 'AUTHORIZED', amount: { currency: 'DKK', value: 49_900 }, success: true }];
    const { gw } = gateway({
      'GET /epayment/v1/payments/fjord-order-10042': { body: payment() },
      'GET /epayment/v1/payments/fjord-order-10042/events': { body: events },
    });
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    const { profile: _profile, ...own } = payment();
    expect(result.structuredContent).toEqual({ payment: own, events });
  });

  it('passes on no personal data of the payer: names, phone, e-mail, address and user id are left out', async () => {
    const personal = {
      profile: { sub: 'c06c4afe-d9e1-4c5d-939a-177d752a0944' },
      userDetails: { firstName: 'Ada', lastName: 'Lovelace', mobileNumber: '4512345678', email: 'ada@example.test' },
      shippingDetails: { address: { addressLine1: 'Fjordvej 1', postCode: '8000', city: 'Aarhus' } },
      paymentMethod: { type: 'WALLET', cardBin: '540185' },
      redirectUrl: 'https://pay.example.test/session',
    };
    const events = [{ reference: 'fjord-order-10042', name: 'AUTHORIZED', amount: { currency: 'DKK', value: 49_900 }, success: true, userDetails: { firstName: 'Ada' } }];
    const { gw } = gateway({
      'GET /epayment/v1/payments/fjord-order-10042': { body: payment(personal) },
      'GET /epayment/v1/payments/fjord-order-10042/events': { body: events },
    });
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    const all = JSON.stringify(result);
    for (const word of ['Ada', 'Lovelace', '4512345678', 'ada@example.test', 'Fjordvej', 'c06c4afe', '540185', 'pay.example.test']) {
      expect(all, word).not.toContain(word);
    }
    expect(result.structuredContent).toMatchObject({ payment: { state: 'AUTHORIZED', paymentMethod: { type: 'WALLET' } } });
    expect(all).toContain('49900');
  });

  it('keeps the payment when the events cannot be read, with the status only', async () => {
    const { gw } = gateway({
      'GET /epayment/v1/payments/fjord-order-10042': { body: payment() },
      'GET /epayment/v1/payments/fjord-order-10042/events': { status: 500, body: { detail: 'internal trace' } },
    });
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    expect(result.structuredContent).toMatchObject({ events: { error: 'Vipps MobilePay API request failed with HTTP 500' } });
    expect(JSON.stringify(result)).not.toContain('internal trace');
  });

  it('passes on no personal data placed inside allowed fields, and keeps only typed values', async () => {
    const who = { firstName: 'Ada', email: 'ada@example.test' };
    const body = payment({
      amount: { currency: 'DKK', value: 49_900, userDetails: who },
      aggregate: { authorizedAmount: { currency: 'DKK', value: 49_900 }, shippingDetails: { address: 'Fjordvej 1' }, capturedAmount: 'Ada' },
      paymentMethod: { type: { name: 'Ada' } },
      state: 'AUTHORIZED',
    });
    const { gw } = gateway({
      'GET /epayment/v1/payments/fjord-order-10042': { body },
      'GET /epayment/v1/payments/fjord-order-10042/events': { body: [{ name: 'AUTHORIZED', amount: { value: 1, userDetails: who }, success: true }] },
    });
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    const all = JSON.stringify(result);
    for (const word of ['Ada', 'ada@example.test', 'Fjordvej', 'userDetails', 'shippingDetails']) expect(all, word).not.toContain(word);
    expect(result.structuredContent).toMatchObject({ payment: { amount: { currency: 'DKK', value: 49_900 }, paymentMethod: {} } });
  });

  it('never passes on an error text the events answer itself carries, only our fixed text', async () => {
    const { gw } = gateway({
      'GET /epayment/v1/payments/fjord-order-10042': { body: payment() },
      'GET /epayment/v1/payments/fjord-order-10042/events': { body: { error: 'Ada Lovelace ada@example.test http://10.0.0.1/internal' } },
    });
    const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
    expect(JSON.stringify(result)).not.toMatch(/Ada|example\.test|10\.0\.0\.1/);
    expect(result.structuredContent).toMatchObject({ events: { error: 'Vipps MobilePay answered the events in an unexpected form.' } });
  });

  it('refuses a payment answer that is not a payment, instead of an empty result', async () => {
    for (const body of [[], 'text', { title: 'not a payment' }, { reference: 'fjord-order-10042' }]) {
      const { gw } = gateway({ 'GET /epayment/v1/payments/fjord-order-10042': { body } });
      const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042', includeEvents: false });
      expect(result.isError, JSON.stringify(body)).toBe(true);
      expect(JSON.stringify(result)).toContain('unexpected form');
    }
  });

  it('gives only the fixed text for every malformed events answer, and keeps the payment', async () => {
    const malformed: unknown[] = [
      'Ada Lovelace',
      { events: [] },
      ['AUTHORIZED'],
      [{ name: 'AUTHORIZED', success: true }, 'Ada Lovelace'],
      [{ name: 'AUTHORIZED' }, null],
      [[{ name: 'AUTHORIZED' }]],
      42,
    ];
    for (const body of malformed) {
      const { gw } = gateway({
        'GET /epayment/v1/payments/fjord-order-10042': { body: payment() },
        'GET /epayment/v1/payments/fjord-order-10042/events': { body },
      });
      const result = await gw.callTool('get_payment', { reference: 'fjord-order-10042' });
      expect(result.isError, JSON.stringify(body)).toBeUndefined();
      expect(result.structuredContent, JSON.stringify(body)).toMatchObject({
        payment: { reference: 'fjord-order-10042' },
        events: { error: 'Vipps MobilePay answered the events in an unexpected form.' },
      });
      expect(JSON.stringify(result), JSON.stringify(body)).not.toContain('Ada');
    }
  });

  it('refuses a reference outside the documented pattern before any request', async () => {
    const { gw, calls } = gateway();
    for (const reference of ['short', '../../management', 'fjord order 1', 'x'.repeat(65)]) {
      expect((await gw.callTool('get_payment', { reference })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Recurring reads', () => {
  it('passes on an agreement\'s terms and state, never the user id or userinfo address', async () => {
    const agreement = {
      id: 'agr_5kSeqz',
      status: 'ACTIVE',
      productName: 'Abonnement',
      pricing: { type: 'LEGACY', amount: 4_900, currency: 'DKK' },
      interval: { unit: 'MONTH', count: 1 },
      sub: 'c06c4afe-d9e1-4c5d-939a-177d752a0944',
      userinfoUrl: 'https://api.example.test/userinfo/c06c4afe',
      phoneNumber: '4512345678',
      pricing2: { userDetails: { firstName: 'Ada' } },
      campaign: { type: 'PRICE_CAMPAIGN', price: 100, userinfoUrl: 'https://api.example.test/userinfo/c06c4afe', explanation: { name: 'Ada' } },
    };
    (agreement as Record<string, unknown>).pricing = { ...agreement.pricing, userDetails: { firstName: 'Ada', email: 'ada@example.test' } };
    const { gw } = gateway({
      'GET /recurring/v3/agreements/agr_5kSeqz': { body: agreement },
      'GET /recurring/v3/agreements': { body: [agreement] },
    });
    for (const [tool, input] of [['get_agreement', { agreementId: 'agr_5kSeqz' }], ['list_agreements', {}]] as const) {
      const result = await gw.callTool(tool, input);
      const all = JSON.stringify(result);
      for (const word of ['c06c4afe', 'userinfo', '4512345678', 'Ada', 'ada@example.test']) expect(all, `${tool} ${word}`).not.toContain(word);
      expect(all, tool).toContain('Abonnement');
    }
  });

  it('refuses an agreement answer that is not an agreement, instead of an empty result', async () => {
    for (const body of [[], 'Ada Lovelace', 42, { status: 'ACTIVE' }, { id: 42, status: 'ACTIVE' }, { id: { name: 'Ada' } }]) {
      const { gw } = gateway({ 'GET /recurring/v3/agreements/agr_7TqP2m': { body } });
      const result = await gw.callTool('get_agreement', { agreementId: 'agr_7TqP2m' });
      expect(result.isError, JSON.stringify(body)).toBe(true);
      expect(JSON.stringify(result), JSON.stringify(body)).toContain('unexpected form');
      expect(JSON.stringify(result), JSON.stringify(body)).not.toContain('Ada');
    }
  });

  it('refuses an agreement list that is not a list, or holds something that is not an agreement', async () => {
    for (const body of [{ agreements: [] }, 'Ada Lovelace', [{ id: 'agr_5kSeqz', status: 'ACTIVE' }, { status: 'ACTIVE', name: 'Ada' }], [null], ['agr_5kSeqz']]) {
      const { gw } = gateway({ 'GET /recurring/v3/agreements': { body } });
      const result = await gw.callTool('list_agreements', {});
      expect(result.isError, JSON.stringify(body)).toBe(true);
      expect(JSON.stringify(result), JSON.stringify(body)).toContain('unexpected form');
      expect(JSON.stringify(result), JSON.stringify(body)).not.toContain('Ada');
    }
  });

  it('pages through agreements and stops at the first short page', async () => {
    const page = (n: number, size: number) => Array.from({ length: size }, (_, i) => ({ id: `agr_${n}_${i}`, status: 'ACTIVE' }));
    const { gw, calls } = gateway({
      'GET /recurring/v3/agreements': url => {
        const n = Number(url.searchParams.get('pageNumber'));
        return { body: n === 1 ? page(1, AGREEMENT_PAGE_SIZE) : page(2, 3) };
      },
    });
    const result = await gw.callTool('list_agreements', { status: 'ACTIVE', createdAfter: '2026-01-01' });
    expect(result.structuredContent).toMatchObject({ status: 'ACTIVE', count: AGREEMENT_PAGE_SIZE + 3 });
    const requests = apiCalls(calls);
    expect(requests.map(call => call.query)).toEqual([
      { status: 'ACTIVE', createdAfter: String(Date.parse('2026-01-01T00:00:00Z')), pageNumber: '1', pageSize: String(AGREEMENT_PAGE_SIZE) },
      { status: 'ACTIVE', createdAfter: String(Date.parse('2026-01-01T00:00:00Z')), pageNumber: '2', pageSize: String(AGREEMENT_PAGE_SIZE) },
    ]);
  });

  it('refuses rather than truncates more agreements than it reads in one call', async () => {
    const { gw, calls } = gateway({
      'GET /recurring/v3/agreements': url => ({
        body: Array.from({ length: AGREEMENT_PAGE_SIZE }, (_, i) => ({ id: `agr_${url.searchParams.get('pageNumber')}_${i}` })),
      }),
    });
    const result = await gw.callTool('list_agreements', {});
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(/more than 5000 agreements/);
    expect(apiCalls(calls)).toHaveLength(MAX_AGREEMENT_PAGES + 1);
  });

  it('accepts a full last page when the next one is empty', async () => {
    const { gw } = gateway({
      'GET /recurring/v3/agreements': url => ({
        body:
          Number(url.searchParams.get('pageNumber')) <= MAX_AGREEMENT_PAGES
            ? Array.from({ length: AGREEMENT_PAGE_SIZE }, (_, i) => ({ id: `agr_${url.searchParams.get('pageNumber')}_${i}` }))
            : [],
      }),
    });
    const result = await gw.callTool('list_agreements', {});
    expect(result.structuredContent).toMatchObject({ count: MAX_AGREEMENT_PAGES * AGREEMENT_PAGE_SIZE });
  });

  it('follows the Continuation-Token of the charge list', async () => {
    const { gw, calls } = gateway({
      'GET /recurring/v3/agreements/agr_7TqP2m/charges': (_url, init) => {
        const token = (init.headers as Record<string, string>)['Continuation-Token'];
        return token === 'next-page-2'
          ? { body: [charge({ id: 'chr-2' })] }
          : { body: [charge({ id: 'chr-1' })], headers: { 'continuation-token': 'next-page-2' } };
      },
    });
    const result = await gw.callTool('list_charges', { agreementId: 'agr_7TqP2m', status: 'CHARGED' });
    expect(result.structuredContent).toMatchObject({ agreementId: 'agr_7TqP2m', count: 2 });
    expect(apiCalls(calls).map(call => call.query)).toEqual([{ status: 'CHARGED' }, { status: 'CHARGED' }]);
  });

  it('refuses rather than truncates an endless charge list', async () => {
    let n = 0;
    const { gw, calls } = gateway({
      'GET /recurring/v3/agreements/agr_7TqP2m/charges': () => ({ body: [charge()], headers: { 'continuation-token': `t-${(n += 1)}` } }),
    });
    const result = await gw.callTool('list_charges', { agreementId: 'agr_7TqP2m' });
    expect(result.isError).toBe(true);
    expect(apiCalls(calls)).toHaveLength(MAX_CHARGE_PAGES);
  });

  it('reads one agreement and one charge', async () => {
    const { gw } = gateway({
      'GET /recurring/v3/agreements/agr_7TqP2m': { body: { id: 'agr_7TqP2m', status: 'ACTIVE' } },
      'GET /recurring/v3/agreements/agr_7TqP2m/charges/chr-5kSeqz': { body: charge() },
    });
    expect((await gw.callTool('get_agreement', { agreementId: 'agr_7TqP2m' })).structuredContent).toEqual({ id: 'agr_7TqP2m', status: 'ACTIVE' });
    expect((await gw.callTool('get_charge', { agreementId: 'agr_7TqP2m', chargeId: 'chr-5kSeqz' })).structuredContent).toEqual(charge());
  });
});
