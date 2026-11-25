import { createHash } from 'node:crypto';
import type { UpstreamClient } from './client.js';

/**
 * Webhook registration for the host (Webhooks API, /webhooks/v1/webhooks): an
 * embedding host registers its own address for a sales unit's ePayment events,
 * lists what is registered and removes it again. Host functions on a gateway
 * instance (src/gateway.ts), never tools: no AI client can register, list or
 * remove an address.
 *
 * The secret Vipps MobilePay gives with a new registration signs every event
 * sent to the address. It is returned to the host once, from
 * registerPaymentEvents, and nowhere else: it is never logged, never part of an
 * error, and Vipps MobilePay's list does not return it.
 */

/** The ePayment events a host can register for. */
export const PAYMENT_EVENTS = [
  'epayments.payment.created.v1',
  'epayments.payment.aborted.v1',
  'epayments.payment.expired.v1',
  'epayments.payment.cancelled.v1',
  'epayments.payment.captured.v1',
  'epayments.payment.refunded.v1',
  'epayments.payment.authorized.v1',
  'epayments.payment.terminated.v1',
] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

/** A registration as Vipps MobilePay lists it. */
export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
}

/** A new registration: its id, for removing it, and the secret that signs its events. */
export interface WebhookRegistration {
  readonly id: string;
  /** Signs every event sent to the address. Keep it like a key; it is not given again. */
  readonly secret: string;
}

const WEBHOOKS_PATH = '/webhooks/v1/webhooks';
/** A registration id as Vipps MobilePay gives one: letters, digits and dashes. */
const WEBHOOK_ID = /^[A-Za-z0-9-]{8,64}$/;
const SECRET = /^[\x21-\x7e]{16,256}$/;

/**
 * Host names that never reach a public address: a single label, and the names kept for local or internal use. Vipps
 * MobilePay requires an address it can reach on the internet; one of these could only aim its messages inward.
 */
const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa|localdomain|test|invalid|example)$/i;

/**
 * Whether the host is a public name: never an IP literal (IPv4 in any form the URL parser accepts, or IPv6), never a
 * single label, and never a name kept for local or internal use. A host registers its own published name.
 */
function isPublicName(hostname: string): boolean {
  const name = hostname.replace(/\.$/, '');
  if (name.startsWith('[') || name.includes(':')) return false;
  if (/^[0-9.]+$/.test(name) || /^0x/i.test(name)) return false;
  if (!name.includes('.')) return false;
  const labels = name.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  // A top-level label of digits only is how an IP literal ends; no public top-level domain is one.
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return false;
  return !INTERNAL_NAMES.test(name);
}

/**
 * The address must be the host's own and public: https on the default port, a public name, no credentials, no
 * fragment. An IP literal, a single label and a local or internal name are refused before anything is sent.
 */
function checkedAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Refused: the address for events must be an https URL. Nothing was sent.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Refused: the address for events must be an https URL. Nothing was sent.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== value) {
    throw new Error('Refused: the address for events must be an https URL. Nothing was sent.');
  }
  if (url.port !== '' || !isPublicName(url.hostname)) {
    throw new Error('Refused: the address for events must be on a public host name. Nothing was sent.');
  }
  return value;
}

function checkedEvents(events: readonly unknown[]): PaymentEvent[] {
  const known = new Set<string>(PAYMENT_EVENTS);
  if (events.length === 0 || events.some(event => typeof event !== 'string' || !known.has(event))) {
    throw new Error('Refused: register only known ePayment events. Nothing was sent.');
  }
  // One order whatever order they came in: the same set gives the same request and the same operation key.
  return [...new Set(events as PaymentEvent[])].sort();
}

/**
 * An operation key from the request's own content: the same address and set of events give the same key. Vipps
 * MobilePay's Webhooks API does not document Idempotency-Key, so a repeat is not promised to be one registration; a
 * host that is unsure lists the registrations and removes a duplicate.
 */
function operationKey(...parts: string[]): string {
  return `wh-${createHash('sha256').update(parts.join('\n')).digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
}

export async function registerPaymentEvents(
  client: UpstreamClient,
  address: string,
  events: readonly PaymentEvent[],
): Promise<WebhookRegistration> {
  const url = checkedAddress(address);
  const chosen = checkedEvents(events);
  const answer = await client.post<unknown>(WEBHOOKS_PATH, { url, events: chosen }, { idempotencyKey: operationKey('register', url, ...chosen) });
  const record = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const { id, secret } = record;
  if (typeof id !== 'string' || !WEBHOOK_ID.test(id) || typeof secret !== 'string' || !SECRET.test(secret)) {
    // Never quoted: the answer may hold the secret.
    throw new Error('Vipps MobilePay answered the registration in an unexpected form.');
  }
  return { id, secret };
}

export async function listWebhooks(client: UpstreamClient): Promise<Webhook[]> {
  const answer = await client.get<unknown>(WEBHOOKS_PATH);
  const list = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>).webhooks : undefined;
  if (!Array.isArray(list)) throw new Error('Vipps MobilePay answered the list of registrations in an unexpected form.');
  return list.flatMap(item => {
    if (item === null || typeof item !== 'object') return [];
    const { id, url, events } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !WEBHOOK_ID.test(id) || typeof url !== 'string' || !Array.isArray(events)) return [];
    // Only id, address and events: anything else in an entry is dropped unread.
    return [{ id, url, events: events.filter((event): event is string => typeof event === 'string') }];
  });
}

export async function removeWebhook(client: UpstreamClient, id: string): Promise<void> {
  if (typeof id !== 'string' || !WEBHOOK_ID.test(id)) throw new Error('Refused: not a registration id. Nothing was sent.');
  await client.delete<unknown>(`${WEBHOOKS_PATH}/${id}`, { idempotencyKey: operationKey('remove', id) });
}
