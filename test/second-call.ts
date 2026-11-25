import { describe, it } from 'vitest';
import type { GatewayJsonObject, GatewayToolResult } from '../src/gateway.js';
import { apiCalls, gateway, payment, type Call, type Reply, type Route } from './helpers.js';

/**
 * The second call of a change tool.
 *
 * A change tool is called a second time in many ways: the same call again after a lost answer, the same call much
 * later, the same reference with other content, and so on. `secondCalls` takes a table of them, one row per way, and
 * runs every row against a stand-in for Vipps MobilePay that keeps what it has created, once for each way the
 * documentation leaves open for a repeated Idempotency-Key.
 */

/**
 * What the stand-in does with a key it has seen before: answers with the first answer again (`replay`) or refuses
 * (`refuse`). A row can also make it forget its keys, as a vendor does after some time.
 */
export const REPEATS = ['replay', 'refuse'] as const;
export type Repeat = (typeof REPEATS)[number];

/** The Idempotency-Keys a stand-in remembers, with the answer each one got. */
export class KeyMemory {
  private readonly answers = new Map<string, Reply>();

  constructor(
    readonly repeat: Repeat,
    /** The refusal of a repeated key. */
    private readonly refusal: Reply,
  ) {}

  /** The answer to a key that was seen before, or undefined for a new (or forgotten) one. */
  seen(key: string): Reply | undefined {
    const first = this.answers.get(key);
    if (first === undefined) return undefined;
    return this.repeat === 'replay' ? first : this.refusal;
  }

  remember(key: string, answer: Reply): void {
    this.answers.set(key, answer);
  }

  forget(): void {
    this.answers.clear();
  }
}

/** A stand-in for Vipps MobilePay as a row sees it: its routes, and what a row can do to it between two calls. */
export interface StandIn {
  readonly routes: Record<string, Route>;
  /** Forget every Idempotency-Key, as after a long time. */
  forgetKeys(): void;
  /** Carry out the next change and lose the answer on its way back (a timeout at the caller). */
  loseNextAnswer(): void;
}

/** A clock a row can move. */
export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export interface SecondCall<V extends StandIn> {
  /** The way the second call arrives. */
  name: string;
  first: GatewayJsonObject;
  second: GatewayJsonObject;
  /** The answer to the first call is lost: the change is carried out and the caller gets a timeout. */
  lostAnswer?: boolean;
  /** What happens between the two calls, at the stand-in or to the clock. */
  between?: (world: { vendor: V; clock: Clock }) => void;
  /** What must hold after the second call. */
  then: (seen: { first: GatewayToolResult; second: GatewayToolResult; vendor: V; calls: Call[]; repeat: Repeat }) => void;
  /** Only for one of the two ways a repeated key is answered (default: both). */
  only?: Repeat;
}

/** Runs every row of the table against a fresh stand-in, once per way a repeated key is answered. */
export function secondCalls<V extends StandIn>(tool: string, standIn: (repeat: Repeat) => V, rows: Array<SecondCall<V>>, start = Date.parse('2026-11-25T12:00:00Z')): void {
  for (const repeat of REPEATS) {
    describe(`when Vipps MobilePay answers a repeated key with a ${repeat === 'replay' ? 'replay of the first answer' : 'refusal'}`, () => {
      for (const row of rows.filter(item => item.only === undefined || item.only === repeat)) {
        it(row.name, async () => {
          const vendor = standIn(repeat);
          let time = start;
          const clock: Clock = { now: () => time, advance: ms => void (time += ms) };
          const { gw, calls } = gateway(vendor.routes, { policy: { enableWrites: true }, maxAttempts: 5, retryBaseDelayMs: 1, now: clock.now });
          if (row.lostAnswer) vendor.loseNextAnswer();
          const first = await gw.callTool(tool, row.first);
          row.between?.({ vendor, clock });
          const second = await gw.callTool(tool, row.second);
          row.then({ first, second, vendor, calls: apiCalls(calls), repeat });
        });
      }
    });
  }
}

/** A payment as the ePayment stand-in keeps it. */
export interface KeptPayment {
  key: string;
  body: Record<string, unknown>;
  state: string;
  link: string;
}

export interface PaymentStandIn extends StandIn {
  /** Every payment created, by reference. */
  readonly payments: Map<string, KeptPayment>;
  /** The customer approved, the business cancelled, or the deadline passed. */
  setState(reference: string, state: 'AUTHORIZED' | 'ABORTED' | 'EXPIRED' | 'TERMINATED'): void;
}

/**
 * A stand-in for the ePayment API's create and read of a payment, for the given references. It creates one payment
 * per reference and refuses a reference that is used (HTTP 409, or `usedReferenceStatus`). A payment is read back as
 * the specification says: amount, state, payment method, reference, the landing page address and the metadata the
 * request gave; not the phone number, the text or the order lines. `problem` is the body of every refusal.
 */
export function paymentStandIn(
  repeat: Repeat,
  options: { references: string[]; link: (reference: string) => string; landingPage: (reference: string) => string; problem?: unknown; usedReferenceStatus?: 400 | 409 },
): PaymentStandIn {
  const refusal: Reply = { status: options.usedReferenceStatus ?? 409, body: options.problem };
  const keys = new KeyMemory(repeat, refusal);
  const payments = new Map<string, KeptPayment>();
  let lose = false;
  const routes: Record<string, Route> = {
    'POST /epayment/v1/payments': (_url, init): Reply => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const key = (init.headers as Record<string, string>)['Idempotency-Key'] ?? '';
      const reference = String(body.reference);
      const repeated = keys.seen(key);
      if (repeated) return repeated;
      if (payments.has(reference)) return refusal;
      const link = options.link(reference);
      payments.set(reference, { key, body, state: 'CREATED', link });
      const answer: Reply = { status: 201, body: body.userFlow === 'PUSH_MESSAGE' ? { reference } : { redirectUrl: link, reference } };
      keys.remember(key, answer);
      if (lose) {
        lose = false;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return answer;
    },
  };
  for (const reference of options.references) {
    routes[`GET /epayment/v1/payments/${reference}`] = (): Reply => {
      const kept = payments.get(reference);
      if (!kept) return { status: 404, body: options.problem };
      return {
        body: payment({
          reference,
          state: kept.state,
          amount: kept.body.amount,
          paymentMethod: kept.body.paymentMethod,
          metadata: kept.body.metadata,
          redirectUrl: options.landingPage(reference),
          // What a real answer also holds, and what must never be passed on.
          profile: { sub: '00000000-0000-4000-8000-000000000001' },
          userDetails: { firstName: 'Solveig', lastName: 'Fjordheim', mobileNumber: '4512345678' },
        }),
      };
    };
  }
  return {
    routes,
    payments,
    forgetKeys: () => keys.forget(),
    loseNextAnswer: () => void (lose = true),
    setState: (reference, state) => {
      const kept = payments.get(reference);
      if (kept) kept.state = state;
    },
  };
}
