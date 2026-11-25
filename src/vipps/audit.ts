import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { VippsHttpError, failureMetadata, formatUnknownError, redactDeep, redactSecrets, type FailureMetadata, type SecretRedactor } from '../errors.js';
import { STDERR_WITHHELD, withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { ConfigError, readEnvString } from '../config-env.js';
import { currentInstancePolicy, currentRedactor } from './policy.js';
import { pseudonym } from './values.js';

export interface AuditEvent {
  /** Shared by all events of one tool call (start/finish/error). */
  requestId: string;
  tool: string;
  /** Caller identity supplied by an embedding host, when available. Written only as callerPseudonym(caller). */
  caller?: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: Record<string, unknown>;
  status?: string;
  reason?: string;
  error?: unknown;
  durationMs?: number;
}

const MAX_AUDIT_MESSAGE_LENGTH = 200;

/**
 * Error summary for the audit log: for an HTTP error, also one wrapped as the `cause` of our own error (a capture
 * refused after a failed read of the events, a charge id that is ambiguous), the failure metadata (method, path
 * template, status, request id, Vipps MobilePay's error code and trace id, each in its fixed form, from
 * failureMetadata); and the message, a fixed text for a direct HTTP error or this server's own message, redacted
 * before it is shortened. Nothing else the upstream controls (body, message) is logged: it can quote input or part of
 * the key.
 */
export function auditErrorSummary(
  error: unknown,
  redactor?: SecretRedactor,
): { httpStatus?: number; message: string; failure?: Omit<FailureMetadata, 'httpStatus'> } {
  const metadata = failureMetadata(error);
  const { httpStatus, ...failure } = metadata ?? {};
  const http = metadata === undefined ? {} : { httpStatus, ...(Object.keys(failure).length > 0 ? { failure } : {}) };
  if (error instanceof VippsHttpError) {
    return { ...http, httpStatus: error.status, message: `Vipps MobilePay API request failed with HTTP ${error.status}` };
  }
  const message = formatUnknownError(error, redactor);
  return {
    ...http,
    message: message.length > MAX_AUDIT_MESSAGE_LENGTH ? `${message.slice(0, MAX_AUDIT_MESSAGE_LENGTH)}…` : message,
  };
}

export function newRequestId(): string {
  return randomUUID();
}

/** The key of the caller pseudonyms: random per process, never written anywhere. */
const CALLER_KEY = randomBytes(32);

/**
 * The caller as `hmac:` and 16 hex characters: the same caller gives the same pseudonym within the process. The
 * caller is the host's text, often a mail address, so it is never written in clear.
 */
export function callerPseudonym(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === '') return undefined;
  return `hmac:${createHmac('sha256', CALLER_KEY).update(caller, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Startup check: when VIPPS_AUDIT_LOG is set, its directory must exist and
 * be writable (and the file, if it exists, writable), so a typo fails at
 * startup rather than refusing every write tool call later.
 */
export function assertAuditLogWritable(): void {
  const auditPath = readEnvString('VIPPS_AUDIT_LOG');
  if (!auditPath) {
    return;
  }
  try {
    const existing = statSync(auditPath, { throwIfNoEntry: false });
    accessSync(existing ? auditPath : dirname(auditPath), constants.W_OK);
  } catch {
    throw new ConfigError('VIPPS_AUDIT_LOG is not writable.');
  }
}

/**
 * Append one JSON line to VIPPS_AUDIT_LOG (no-op when unset). Under a
 * host's InstancePolicy the record goes to the policy's `audit` sink instead
 * (no-op without one), and VIPPS_AUDIT_LOG is not read.
 *
 * By default a failing audit sink is reported on stderr and does not change
 * the tool result: after a call has run, surfacing an error would invite a
 * retry and a duplicate write. With `required: true` (used for the event
 * written before a write tool runs) the failure is thrown instead, so no
 * write happens without an audit record. `redactor` is the redactor of the
 * instance that ran the call.
 */
export async function writeAuditEvent(
  event: AuditEvent,
  options: { required?: boolean; redactor?: SecretRedactor } = {},
): Promise<void> {
  const hosted = currentInstancePolicy();
  const sink = hosted?.audit;
  const auditPath = hosted ? undefined : readEnvString('VIPPS_AUDIT_LOG');
  if (!sink && !auditPath) {
    return;
  }
  // One redactor for the record and for every failure message: the caller's, else the call scope's.
  const redactor = options.redactor ?? currentRedactor();
  // The sink check (src/key-admission.ts), on each record and line in its final form.
  const leaks = (value: unknown) => redactor !== undefined && leaksSecret(value, redactor);
  const stderrLine = (line: string) => process.stderr.write(`${leaks(line) ? STDERR_WITHHELD : line}\n`);

  try {
    const record = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      tool: event.tool,
      // Only as a pseudonym: the caller is the host's text, often a mail address.
      caller: callerPseudonym(event.caller),
      action: event.action,
      target: event.target,
      status: event.status,
      durationMs: event.durationMs,
      reason: event.reason,
      ...(event.error === undefined ? {} : errorFields(auditErrorSummary(event.error, redactor))),
    };

    // Every value in the record, keys and numbers included, with the instance's secrets redacted (the shared
    // redactDeep): a key can reach the record through a tool name, an input field, the caller or a reason.
    const safe = redactDeep(record, redactor) as Record<string, unknown>;
    if (sink) {
      // A copy through JSON: the sink gets plain data, not an object the server keeps.
      const copy = JSON.parse(JSON.stringify(safe)) as Record<string, unknown>;
      await sink(leaks(copy) ? withheldAuditRecord() : copy);
    } else if (auditPath) {
      const line = JSON.stringify(safe);
      await appendFile(auditPath, `${leaks(line) ? JSON.stringify(withheldAuditRecord()) : line}\n`, 'utf8');
    }
  } catch (error) {
    if (options.required) {
      // Details (path, OS error) go to stderr only, not to the caller.
      const tool = formatUnknownError(event.tool, redactor);
      // The whole line, prefix included, through the redactor and then the sink check.
      stderrLine(redactSecrets(`[vippsmobilepay-mcp] audit log write failed, refusing ${tool}: ${formatUnknownError(error, redactor)}`, redactor));
      throw new Error(`Audit log is not writable on this instance; ${tool} was not run.`);
    }
    stderrLine(redactSecrets(`[vippsmobilepay-mcp] audit log write failed: ${formatUnknownError(error, redactor)}`, redactor));
  }
}

/**
 * The error's fields in the audit record. The vendor's request id goes in as vendorRequestId: the record's requestId
 * is the server's own, shared by the call's start, finish and error records, and is never replaced.
 */
function errorFields(summary: ReturnType<typeof auditErrorSummary>) {
  const { requestId: vendorRequestId, ...failure } = summary.failure ?? {};
  return {
    httpStatus: summary.httpStatus,
    error: summary.message,
    ...failure,
    ...(vendorRequestId === undefined ? {} : { vendorRequestId }),
  };
}

/**
 * Fields logged in clear text: provider ledger ids (digits), dates and
 * times, enum values, amounts in minor units, currency codes and flags. They
 * are checked against the tool's input schema before a call runs. A payment
 * request's phone number, return address, order lines and receipt number are
 * not logged in any form: a phone number has too few digits for a hash to
 * hide it.
 */
const ID_FIELDS = [
  'ledgerId',
  'topic',
  'status',
  'fromDate',
  'toDate',
  'createdAfter',
  'amount',
  'currency',
  'cancelTransactionOnly',
  'delivery',
  'expiresAt',
  'customerPresent',
  'qrFormat',
] as const;

/**
 * Identifiers the caller chose (a payment reference can be any text of the
 * allowed characters, a name among them): logged only as their pseudonym,
 * the same one resolveVippsChange gives without a host key.
 */
const PSEUDONYM_FIELDS = ['reference', 'agreementId', 'chargeId', 'idempotencyKey'] as const;

/**
 * Free-text fields are hashed so user-written text does not land in the log:
 * `<field>Sha256`. A hash without a key does not hide a short text from
 * someone who tries candidates, so a tool can ask for a keyed one instead
 * (auditTarget's `keyedText`): `<field>Hmac`, which cannot be tested against
 * a guess without the client secret.
 */
const FREE_TEXT_FIELDS = ['description'] as const;

/** Characters of a keyed hash of a free text that are logged: 128 bits, as hex. */
const KEYED_TEXT_LENGTH = 32;

/** Write payload objects: only their field names are logged. None of the tools takes one. */
const PAYLOAD_FIELDS = [] as const;

/**
 * Build the audit `target` for a tool input. Values not listed above are not
 * logged. With `keyedText` a free text is logged as that keyed hash of it,
 * and never as a hash without a key; when the keyed hash cannot be made (no
 * keys), nothing of the text is logged.
 */
export function auditTarget(input: unknown, keyedText?: (text: string) => string): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = input as Record<string, unknown>;
  const target: Record<string, unknown> = {};

  for (const field of ID_FIELDS) {
    if (value[field] !== undefined) {
      target[field] = value[field];
    }
  }

  for (const field of PSEUDONYM_FIELDS) {
    if (typeof value[field] === 'string' && value[field] !== '') {
      target[field] = pseudonym(value[field] as string);
    }
  }

  for (const field of FREE_TEXT_FIELDS) {
    if (typeof value[field] === 'string' && value[field] !== '') {
      if (keyedText === undefined) {
        target[`${field}Sha256`] = hashValue(value[field] as string);
        continue;
      }
      try {
        target[`${field}Hmac`] = keyedText(value[field] as string).slice(0, KEYED_TEXT_LENGTH);
      } catch {
        // No keys to make it with: the call fails on that, and the text is left out.
      }
    }
  }

  for (const field of PAYLOAD_FIELDS as readonly string[]) {
    const payload = value[field];
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      target[`${field}Fields`] = Object.keys(payload).sort();
    }
  }

  return target;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
