import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditTarget } from '../src/vipps/audit.js';
import { auditLines, connect, KEYS, texts } from './helpers.js';

/**
 * The audit of a payment request when the keys are missing.
 *
 * The description of a payment request is logged only as a keyed hash, made with a key derived from the client
 * secret. Without the keys that hash cannot be made. The description is then left out of the audit: it never falls
 * back to a hash without a key, which anyone can test a guess of a short text against. Everything here is made up.
 */

const DESCRIPTION = 'Kagebord til lørdag';
const SHA256 = createHash('sha256').update(DESCRIPTION).digest('hex');
const INPUT = { reference: 'fjord-order-10077', amount: 24_900, currency: 'DKK', description: DESCRIPTION, delivery: 'link', returnUrl: 'https://fjordbakeriet.example/tak' };

/** What a fallback could write: the text, a hash of it without a key, whole or cut, or a hash keyed with something that is no secret. */
const NEVER = [
  'Kagebord',
  'lørdag',
  SHA256,
  SHA256.slice(0, 32),
  SHA256.slice(0, 16),
  createHash('sha256').update(DESCRIPTION).digest('base64'),
  createHash('sha1').update(DESCRIPTION).digest('hex'),
  createHmac('sha256', '').update(DESCRIPTION).digest('hex').slice(0, 32),
  createHmac('sha256', 'mcp-server-vippsmobilepay audit-text v1').update(DESCRIPTION).digest('hex').slice(0, 32),
  createHmac('sha256', createHmac('sha256', '').update('mcp-server-vippsmobilepay audit-text v1').digest()).update(DESCRIPTION).digest('hex').slice(0, 32),
  'descriptionSha256',
  'descriptionHmac',
];

const originalEnv = { ...process.env };
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('VIPPS_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('the audit target of a tool that logs its text as a keyed hash', () => {
  it('leaves the text out when the keyed hash cannot be made, and keeps the other fields', () => {
    const target = auditTarget(INPUT, () => {
      throw new Error('Missing Vipps MobilePay keys.');
    });
    expect(Object.keys(target ?? {}).sort()).toEqual(['amount', 'currency', 'delivery', 'reference']);
    for (const never of NEVER) expect(JSON.stringify(target), never).not.toContain(never);
  });

  it('logs the keyed hash when it can be made, and the hash without a key only for a tool that did not ask for a keyed one', () => {
    expect(auditTarget(INPUT, () => 'ab'.repeat(32))).toMatchObject({ descriptionHmac: 'ab'.repeat(16) });
    expect(auditTarget(INPUT, () => 'ab'.repeat(32))).not.toHaveProperty('descriptionSha256');
    expect(auditTarget(INPUT)).toMatchObject({ descriptionSha256: SHA256 });
  });
});

describe('create_payment without keys', () => {
  const MISSING: Array<[string, Record<string, string | undefined>]> = [
    ['no client secret', { clientSecret: '' }],
    ['no client id', { clientId: '' }],
    ['no subscription key', { subscriptionKey: '' }],
    ['no keys at all', { clientId: '', clientSecret: '', subscriptionKey: '' }],
    ['partner keys without a sales unit', { keyType: 'partner', environment: 'production', merchantSerialNumber: undefined }],
  ];

  for (const [what, options] of MISSING) {
    it(`fails before any request, and the audit holds nothing of the description (${what})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vipps-audit-'));
      const path = join(dir, 'audit.jsonl');
      process.env.VIPPS_ENABLE_WRITES = 'true';
      process.env.VIPPS_AUDIT_LOG = path;
      const { mcpClient, calls } = await connect({}, options as never);

      const result = await mcpClient.callTool({ name: 'vipps_create_payment', arguments: INPUT });

      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(/^(Missing Vipps MobilePay keys|Partner keys need the merchant)/);
      expect(calls).toHaveLength(0);

      const lines = auditLines(path);
      expect(lines.map(line => line.action)).toEqual(['start', 'error']);
      for (const line of lines) expect(Object.keys(line.target as Record<string, unknown>).sort()).toEqual(['amount', 'currency', 'delivery', 'reference']);
      const written = readFileSync(path, 'utf8');
      for (const never of [...NEVER, INPUT.reference, 'fjordbakeriet.example']) expect(written, never).not.toContain(never);
      for (const never of NEVER) expect(JSON.stringify(result), never).not.toContain(never);
    });
  }

  it('logs the keyed hash, and no hash without a key, when the keys are there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vipps-audit-'));
    const path = join(dir, 'audit.jsonl');
    process.env.VIPPS_ENABLE_WRITES = 'true';
    process.env.VIPPS_AUDIT_LOG = path;
    const { mcpClient } = await connect({});

    await mcpClient.callTool({ name: 'vipps_create_payment', arguments: INPUT });

    const keyed = createHmac('sha256', createHmac('sha256', KEYS.clientSecret).update('mcp-server-vippsmobilepay audit-text v1').digest())
      .update(DESCRIPTION)
      .digest('hex')
      .slice(0, 32);
    const lines = auditLines(path);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect((line.target as Record<string, unknown>).descriptionHmac).toBe(keyed);
    const written = readFileSync(path, 'utf8');
    for (const never of NEVER.filter(never => never !== 'descriptionHmac')) expect(written, never).not.toContain(never);
  });
});
