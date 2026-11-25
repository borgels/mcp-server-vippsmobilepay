import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './vipps/annotations.js';
import {
  VippsMobilePayClient,
  type VippsClientOptions,
  type VippsEnvironment,
  type VippsKeyType,
} from './vipps/client.js';
import {
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type InstancePolicy,
} from './vipps/policy.js';
import { ConfigError } from './config-env.js';
import {
  listWebhooks,
  PAYMENT_EVENTS,
  registerPaymentEvents,
  removeWebhook,
  type PaymentEvent,
  type Webhook,
  type WebhookRegistration,
} from './vipps/webhooks.js';
import { failureMetadata, formatUnknownError, redactDeep, SecretRedactor, vendorRequestId, type FailureMetadata } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import {
  auditRejectedCall,
  enabledTools,
  executeTool,
  findTool,
  logFieldValue,
  validateStartupConfig,
  VIPPS_TOOLS,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
  type VippsChangeAction,
  type VippsChangeSpec,
  type VippsLogField,
  type VippsLogFieldType,
} from './tools/vipps.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/vipps.ts.
 *
 * One instance per merchant (sales unit). Several instances can run in one
 * process: each uses only the keys passed to createVippsMobilePayGateway
 * (never VIPPS_* credentials from the environment), keeps its own access
 * token, and redacts with its own secrets only.
 *
 * Instance policy comes from the host when it passes `policy`: that instance
 * then reads none of VIPPS_ENABLE_WRITES, VIPPS_DISABLED_TOOLS,
 * VIPPS_AUDIT_LOG or VIPPS_ALLOW_CUSTOM_BASE_URL. Limits (timeouts, retries)
 * are still read from the environment and apply to every instance.
 *
 * What no policy can turn on: a request outside the client's fixed list
 * (src/vipps/client.ts, ALLOWED_REQUESTS). There is no tool that changes an
 * agreement (price, interval, status), merchant or sales unit settings, or
 * the keys, and none that creates a charge.
 */

export type { AuditSink, InstancePolicy } from './vipps/policy.js';
export type { VippsEnvironment, VippsKeyType } from './vipps/client.js';
export type { VippsChangeAction, VippsChangeSpec, VippsLogField, VippsLogFieldType } from './tools/vipps.js';
export type { PaymentEvent, Webhook, WebhookRegistration } from './vipps/webhooks.js';
/** The ePayment events a host can register its address for (registerPaymentEvents). */
export const VIPPS_PAYMENT_EVENTS: readonly PaymentEvent[] = Object.freeze([...PAYMENT_EVENTS]);

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status the upstream API answered
 * with, and the vendor's own request id when a response header gives one as a UUID or hex id. For a host that counts
 * failures without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from the upstream API only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /** True when the tool can read more than its name says. False for every tool here. */
  readonly broad: boolean;
  /** The key types the tool works with. Report tools and the list of sales units need the merchant's own keys. */
  readonly keyTypes: readonly VippsKeyType[];
  /**
   * The environments the tool works in. The two sales unit tools work in
   * production only: Vipps MobilePay has no Management API in the test
   * environment.
   */
  readonly environments: readonly VippsEnvironment[];
  /**
   * Vipps MobilePay addition: true for every write tool. A capture, refund
   * or cancellation moves or releases money, and a payment request reaches
   * a customer: a host should have a person confirm each call outside the
   * chat before it runs. `change.movesMoney` tells the two kinds apart.
   */
  readonly requiresConfirmation: boolean;
  /**
   * Write tools only: what the change does, for a host that logs a change
   * before it is sent. `logFields` are the input fields that identify it,
   * each with the one type its value must have (amounts in minor units, ISO
   * currency codes, flags and the delivery of a payment request in clear;
   * references, agreement and charge ids and idempotency keys only as
   * pseudonyms; never names, phone numbers or free text).
   * `resolveVippsChange` returns their values.
   */
  readonly change?: VippsChangeSpec;
}

export interface VippsGatewayOptions
  extends Omit<VippsClientOptions, 'clientId' | 'clientSecret' | 'subscriptionKey' | 'merchantSerialNumber' | 'environment' | 'credentialEnv'> {
  /** client_id of this instance. Required; never read from the environment. */
  clientId: string;
  /** client_secret of this instance. Required; never read from the environment. */
  clientSecret: string;
  /** Ocp-Apim-Subscription-Key of this instance. Required; never read from the environment. */
  subscriptionKey: string;
  /** Merchant-Serial-Number of the merchant's sales unit (4-10 digits). Required. */
  merchantSerialNumber: string;
  /** test or production. Required: an instance never guesses the environment. */
  environment: VippsEnvironment;
  /**
   * merchant (default): the sales unit's own keys. partner: a partner's keys
   * used for this merchant's MSN; production only, and without the Report
   * API tools (Vipps MobilePay does not accept partner keys there).
   */
  keyType?: VippsKeyType;
  /**
   * Instance policy from the host: enableWrites, disabledTools,
   * allowedTools and audit. When given, the instance reads no policy or
   * audit variables from the environment. A host serving several merchants
   * should always pass it.
   */
  policy?: InstancePolicy;
}

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface VippsChange {
  readonly tool: string;
  readonly action: VippsChangeAction;
  readonly record: 'payment' | 'charge';
  /** Whether the call itself moves or releases money (false for a new payment request). */
  readonly movesMoney: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export type VippsChangeResolution =
  | { readonly ok: true; readonly change: VippsChange }
  | { readonly ok: false; readonly reason: string };

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs. A numeric bound of six digits or more
 * (the amount limit, or the safe-integer limit zod adds to an integer) is
 * dropped too, for the same reason zod still checks it: every text in the
 * tool list is compared with the keys, and a run of six digits is a piece a
 * hex key can hold (test/fixed-corpus.test.ts).
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    unrepresentable: 'any',
    override: ctx => {
      const json = ctx.jsonSchema as Record<string, unknown>;
      delete json.format;
      for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
        if (typeof json[bound] === 'number' && Math.abs(json[bound]) >= 100_000) delete json[bound];
      }
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function riskLevel(tool: ToolDefinition): GatewayRiskLevel {
  return tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write';
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: riskLevel(tool),
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const vippsGatewayTools: GatewayToolDefinition[] = VIPPS_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition, the upstream
 * requests it may make, the key types it works with, whether it needs a
 * person's confirmation, and (write tools) what it changes. Generated from
 * the same tool table as the MCP server, and deeply frozen.
 */
export const vippsToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  VIPPS_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    keyTypes: [...tool.keyTypes],
    environments: [...(tool.environments ?? (['test', 'production'] as const))],
    requiresConfirmation: tool.change !== undefined,
    ...(tool.change
      ? { change: { ...tool.change, logFields: tool.change.logFields.map(field => ({ ...field })) } }
      : {}),
  })),
);

function toolByGatewayName(toolName: unknown): ToolDefinition | undefined {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  return name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
}

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change (and asks a person to confirm it) before the call runs: the action,
 * the record kind, whether the call itself moves money and the values of the
 * tool's `logFields` that are present and well-formed. Identifiers the
 * caller chose (reference, agreement and
 * charge id, idempotency key) come back only as pseudonyms: HMAC-SHA-256 with
 * `options.pseudonymKey` when the host gives one (recommended: a reference
 * such as an order number is easy to guess from a plain hash), otherwise
 * SHA-256; 16 hex characters with an `hmac:` or `sha256:` prefix. Amounts,
 * currency and flags are in clear. Refuses read tools, unknown tools and
 * invalid input, as callTool does.
 */
export function resolveVippsChange(
  toolName: string,
  input: GatewayJsonObject = {},
  options: { pseudonymKey?: string | Uint8Array } = {},
): VippsChangeResolution {
  const tool = toolByGatewayName(toolName);
  if (!tool) return { ok: false, reason: 'Unsupported Vipps MobilePay gateway tool.' };
  if (!tool.change) return { ok: false, reason: `${stripPrefix(tool.name)} is not a write tool.` };
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, reason: `Invalid input for ${stripPrefix(tool.name)}.` };
  const data = parsed.data as Record<string, unknown>;
  const values: Record<string, string | number | boolean> = {};
  for (const field of tool.change.logFields) {
    const value = logFieldValue(field.type, data[field.name], options.pseudonymKey);
    if (value !== undefined) values[field.name] = value;
  }
  return {
    ok: true,
    change: Object.freeze({
      tool: stripPrefix(tool.name),
      action: tool.change.action,
      record: tool.change.record,
      movesMoney: tool.change.movesMoney,
      values: Object.freeze(values),
    }),
  };
}

const SECRET_OPTIONS = ['clientId', 'clientSecret', 'subscriptionKey'] as const;
type SecretOption = (typeof SECRET_OPTIONS)[number];

function requiredSecret(options: Partial<VippsGatewayOptions> | undefined, name: SecretOption): string {
  const value: unknown = options?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createVippsMobilePayGateway requires options.${name}. A gateway inside a host does not read credentials from the environment.`,
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new ConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/**
 * Create one gateway instance for one merchant. clientId, clientSecret,
 * subscriptionKey, merchantSerialNumber and environment are required and are
 * the only credentials the instance uses; a missing value fails here.
 */
export function createVippsMobilePayGateway(options: VippsGatewayOptions) {
  const given = options as Partial<VippsGatewayOptions> | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const secrets = SECRET_OPTIONS.flatMap(name => {
    const value: unknown = given?.[name];
    return typeof value === 'string' ? [value, value.trim()] : [];
  });
  let guard: SecretRedactor | undefined;
  try {
    const admitted = Object.fromEntries(SECRET_OPTIONS.map(name => [name, requiredSecret(given, name)])) as Record<SecretOption, string>;
    guard = new SecretRedactor();
    for (const name of SECRET_OPTIONS) guard.addSecret(admitted[name]);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of a key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(keyRefusedText(''));
    }
    const gateway = buildGateway(options, admitted);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(keyRefusedText(''));
    }
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    if (guard) {
      message = guard.redact(raw);
      if (leaksSecret(message, guard)) message = keyRefusedText('');
    }
    // A fresh error in final form: no cause, a stack without frames, and name, message and stack masked against
    // every key given. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (guard && leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(keyRefusedText('')), ...secrets);
    }
    throw final;
  }
}

function buildGateway(options: VippsGatewayOptions, secrets: Record<SecretOption, string>) {
  const {
    policy: hostPolicy,
    clientId: _clientId,
    clientSecret: _clientSecret,
    subscriptionKey: _subscriptionKey,
    merchantSerialNumber,
    environment,
    ...clientOptions
  } = options;
  if (environment !== 'test' && environment !== 'production') {
    throw new ConfigError('createVippsMobilePayGateway requires options.environment: "test" or "production".');
  }
  if (typeof merchantSerialNumber !== 'string' || !/^\d{4,10}$/.test(merchantSerialNumber)) {
    throw new ConfigError('createVippsMobilePayGateway requires options.merchantSerialNumber: 4 to 10 digits.');
  }
  const policy = hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, VIPPS_TOOLS.map(tool => tool.name));
  if (policy === undefined) {
    // In a scope of its own: a gateway created from inside another instance's call validates against the
    // environment, never against that instance's policy.
    runInCallScope({}, () => validateStartupConfig());
  }
  const client = new VippsMobilePayClient({
    ...clientOptions,
    ...secrets,
    merchantSerialNumber,
    environment,
    credentialEnv: {},
    // Under a host's policy nothing is read from the environment, this switch included.
    ...(policy ? { allowCustomBaseUrl: clientOptions.allowCustomBaseUrl ?? false } : {}),
  });
  const redactor: SecretRedactor = client.redactor;
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);
  /**
   * What a host function returns, as a tool result is returned: with this instance's secrets redacted everywhere, then
   * the sink check. A value that still holds a piece of a secret is withheld whole, as a failure in our own words.
   */
  const guarded = <T>(value: T): T => {
    if (value === undefined) return value;
    const final = JSON.parse(JSON.stringify(redactDeep(redactDeep(value, redactor), redactor))) as T;
    if (leaksSecret(final, redactor)) throw new Error(HOST_ANSWER_WITHHELD);
    return final;
  };
  /**
   * Every host function goes through here: its value through `guarded`, its failure as our own text, redacted, without
   * the cause. Nothing a host function returns or throws skips either.
   */
  const hostCall = async <T>(work: () => Promise<T>, after?: (value: T) => void, guard = true): Promise<T> => {
    try {
      const raw = await underPolicy(work);
      const value = guard ? guarded(raw) : raw;
      after?.(value);
      return value;
    } catch (error) {
      throw sealedError(new Error(formatUnknownError(error, redactor)));
    }
  };

  return {
    /** Tools offered on this instance: not disabled or outside allowedTools, and usable with its keys. */
    tools: underPolicy(() =>
      enabledTools(client.keyType, client.environment).map(toGatewayDefinition),
    ),
    /** The environment and key type of this instance. */
    environment: client.environment,
    keyType: client.keyType,
    /**
     * Host only, never a tool: register `address` (https, the host's own) for this sales unit's ePayment `events`.
     * Returns the registration's id and the secret that signs every event sent there; the secret is given only here, and
     * the instance masks it from then on. Registering the same address and set of events again sends the same operation
     * key (Vipps MobilePay does not document it for this API).
     */
    registerPaymentEvents(address: string, events: readonly PaymentEvent[]): Promise<WebhookRegistration> {
      // The secret is the one value given on unmasked: it is what the host asked for, and a repeat of the registration may
      // give the same one again. Everything else of the answer (the id) goes through the same check as any other value.
      // From then on the secret is masked like the keys: in every later error, failure metadata, result, host value and
      // audit record.
      return hostCall(async () => {
        const registration = await underPolicy(() => registerPaymentEvents(client, address, events));
        const { id } = guarded({ id: registration.id });
        redactor.addSecret(registration.secret);
        return { id, secret: registration.secret };
      }, undefined, false);
    },
    /** Host only, never a tool: the registrations of this sales unit, as id, address and events (no secret). */
    listWebhooks(): Promise<Webhook[]> {
      return hostCall(() => listWebhooks(client));
    },
    /** Host only, never a tool: remove one registration by its id. */
    removeWebhook(id: string): Promise<void> {
      return hostCall(() => removeWebhook(client, id));
    },
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted, then the sink check: a result that holds a piece of a key anywhere is withheld whole.
      return underPolicy(() =>
        runCall(toolName, input, context).then(result => {
          const final = withFailureInForm(
            JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
          );
          return leaksSecret(final, redactor) ? withheldResult() : final;
        }),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const tool = toolByGatewayName(toolName);
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        const reason = `Unsupported Vipps MobilePay gateway tool: ${redactor.redact(String(toolName)).slice(0, 100)}`;
        await auditRejectedCall(undefined, input, 'unsupported tool', context);
        return errorResult(redactor.redact(reason));
      }
      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${stripPrefix(tool.name)}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool, input, 'invalid input', context);
        return errorResult(redactor.redact(reason));
      }
      const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
      // What the answer lacks and why goes into the text too, not only into the data: a reader of the text alone
      // must not take a part for the whole.
      const note = tool.resultNote?.(data);
      const said = note ? `${tool.summary} ${note}` : tool.summary;
      const text = tool.returnsUpstreamContent ? `${said} ${UNTRUSTED_CONTENT_NOTE}` : said;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor), failureMetadata(error));
    }
  }
}

/** A host function's value that held a piece of a secret after redaction: withheld whole. */
const HOST_ANSWER_WITHHELD = 'The answer from Vipps MobilePay was withheld: it held a piece of a key of this instance.';

/** One gateway instance, as returned by createVippsMobilePayGateway. */
export type VippsMobilePayGateway = ReturnType<typeof createVippsMobilePayGateway>;

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}
