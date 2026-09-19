/**
 * `@guuey/hooks` — the guuey hook spec (guuey#1511 §8, guuey#1528).
 *
 * A hook is a lifecycle moment the PLATFORM detects and dispatches — never a
 * function inside the agent. Two handler kinds share one contract:
 *
 *   - `agent` — a one-shot run inside the app's own session runtime: an
 *     instruction, a tool allowlist, the effects that MUST happen. The model
 *     decides content; the Router enforces `required` after the fold.
 *   - `tool`  — one MCP tool called directly by the dispatcher, no model.
 *
 * This package holds the vocabulary, the envelope in, the result out, the
 * `guuey.json` block, and the per-event table. It has no runtime of its own:
 * the dispatcher (backend) and the Router (`nocode-runtime`) import it to
 * validate what they send and receive; `@guuey/config` composes
 * {@link hooksSectionSchema} into the agent section of `guuey.json`.
 *
 * Rolling-release posture: every field is optional both ways. A config
 * without `hooks` behaves exactly as before; a result without `effects`
 * parses with `effects: []`.
 */
import { z } from 'zod';

// ── Vocabulary ────────────────────────────────────────────────────────

/** Every event name the spec knows. v1 FIRES the first two; the rest are reserved. */
export const HOOK_EVENT_NAMES = [
  'session.ended',
  'handoff.requested',
  'session.idled',
  'turn.completed',
  'session.started',
  'turn.start',
  'schedule.tick',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** `notify` handlers observe after the fact; `decide` handlers sit on the turn path (reserved). */
export type HookEventClass = 'notify' | 'decide';

/** `session` events carry a `threadId`; `app` events (schedules) bind to the app alone. */
export type HookEventScope = 'session' | 'app';

export interface HookEventSpec {
  readonly class: HookEventClass;
  readonly scope: HookEventScope;
  /** May a handler block or rewrite what the event describes? Declared, never inferred. */
  readonly blockable: boolean;
  /** Does the v1 platform fire this event? Reserved names parse but are refused in `hooks`. */
  readonly firedInV1: boolean;
  /** May a handler's `append` reach the visitor? Only while the session is live. */
  readonly allowsAppend: boolean;
}

/**
 * The per-event table (§8.1). Managed Agents' split is kept on purpose:
 * `session.idled` = awaiting input at every turn end; `session.ended` =
 * dormant/closed — one name never carries both.
 */
export const HOOK_EVENTS: Readonly<Record<HookEventName, HookEventSpec>> = {
  'session.ended': { class: 'notify', scope: 'session', blockable: false, firedInV1: true, allowsAppend: false },
  'handoff.requested': { class: 'notify', scope: 'session', blockable: false, firedInV1: true, allowsAppend: true },
  'session.idled': { class: 'notify', scope: 'session', blockable: false, firedInV1: false, allowsAppend: true },
  'turn.completed': { class: 'notify', scope: 'session', blockable: false, firedInV1: false, allowsAppend: true },
  'session.started': { class: 'notify', scope: 'session', blockable: false, firedInV1: false, allowsAppend: true },
  'turn.start': { class: 'decide', scope: 'session', blockable: true, firedInV1: false, allowsAppend: true },
  /** A cron the app declares (`hooks.schedules`) — no thread, no session; the daily digest (#1507) rides it. */
  'schedule.tick': { class: 'notify', scope: 'app', blockable: false, firedInV1: false, allowsAppend: false },
};

export const hookEventNameSchema = z.enum(HOOK_EVENT_NAMES);

/** Prebuilt hooks a `{ use }` handler may name. The platform's registry is the authority; this list is the v1 catalog. */
export const PREBUILT_HOOKS = ['email-reporter'] as const;
export type PrebuiltHookName = (typeof PREBUILT_HOOKS)[number];

// ── JSON ──────────────────────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON-shaped value — the hook's `output` and a reserved event's `data`. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A JSON object — a tool call's arguments, a hook's structured output when a tool must be called with it. */
export type JsonObject = { [key: string]: JsonValue };
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

// ── Tool names ────────────────────────────────────────────────────────

/** `guuey.json` mcpServers keys: the same grammar `@guuey/config` accepts (non-empty, no dots — the dot separates server from tool). */
const SERVER_KEY = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/** `"<server>.<tool>"` — the name a config uses for one tool. */
export const toolNameSchema = z
  .string()
  .min(3)
  .max(200)
  .refine((v) => {
    const i = v.indexOf('.');
    return i > 0 && SERVER_KEY.test(v.slice(0, i)) && TOOL_NAME.test(v.slice(i + 1));
  }, 'a tool is named "<server>.<tool>" — the mcpServers key, a dot, the tool name');

/** `"<server>.<tool>"` or `"<server>.*"` — an allowlist entry. */
export const toolPatternSchema = z
  .string()
  .min(3)
  .max(200)
  .refine((v) => {
    const i = v.indexOf('.');
    if (i <= 0 || !SERVER_KEY.test(v.slice(0, i))) return false;
    const tool = v.slice(i + 1);
    return tool === '*' || TOOL_NAME.test(tool);
  }, 'a tool pattern is "<server>.<tool>" or "<server>.*"');

/**
 * The wire name of a tool call as the runtime's fold sees it —
 * `mcp__<server>__<tool>` (the reserved hand-off child already uses this
 * grammar: `mcp__guuey-handoff__request_human`). ONE function for both sides:
 * config names in, extractor names out.
 */
export function toWireToolName(name: string): string {
  const parsed = toolNameSchema.safeParse(name);
  if (!parsed.success) throw new Error(`toWireToolName: not a "<server>.<tool>" name: ${name}`);
  const i = name.indexOf('.');
  return `mcp__${name.slice(0, i)}__${name.slice(i + 1)}`;
}

/** Does an allowlist pattern (`server.tool` | `server.*`) cover a tool name? */
export function toolPatternCovers(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  const i = pattern.indexOf('.');
  if (i <= 0 || pattern.slice(i + 1) !== '*') return false;
  return name.startsWith(pattern.slice(0, i + 1));
}

// ── Names ─────────────────────────────────────────────────────────────

const HOOK_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** A hook or schedule name: a lowercase slug (a-z, 0-9, -), 64 chars max. */
export const hookNameSchema = z.string().regex(HOOK_NAME, 'a hook name is a lowercase slug (a-z, 0-9, -), 64 chars max');
function hookNameSchemaRef(): typeof hookNameSchema {
  return hookNameSchema;
}

// ── The envelope in (§8.2) ────────────────────────────────────────────

/**
 * Id caps: an event id is `<threadId>#<event>#<seq | ISO instant>` and a run
 * id adds `#<hookName>` — with a 128-char threadId, a 24-char instant and a
 * 64-char name that is ~231 chars, so 320 leaves room; 128 refused valid ids.
 */
const ID_MAX = 320;

const hookRefSchema = z.strictObject({
  /** The hook the platform is dispatching (a prebuilt name or a `definitions` key). */
  name: z.string().min(1).max(64),
  /** The HookRun id — the idempotency key of this delivery. */
  runId: z.string().min(1).max(ID_MAX),
});

const baseEvent = {
  /** The event id — dedupe on it; deliveries are at-least-once and unordered. */
  id: z.string().min(1).max(ID_MAX),
  at: z.iso.datetime({ offset: true }),
  appId: z.string().min(1).max(128),
  hook: hookRefSchema,
};
/** Session-scoped events name their conversation; app-scoped events (schedules) have none. */
const sessionEvent = { ...baseEvent, threadId: z.string().min(1).max(128) };

/** One tick of a declared schedule — app-scoped; the run has no conversation history and reads what it needs through tools. */
export const scheduleTickDataSchema = z.strictObject({
  /** The `hooks.schedules` key that fired. */
  schedule: hookNameSchemaRef(),
  /** The tick the platform intended (a cron may fire late; the intended instant is the idempotency key with the event id). */
  scheduledFor: z.iso.datetime({ offset: true }),
});

/** What the rep recorded when the visitor asked for a person (the hand-off child's fields + #1510's summary). */
export const handoffRequestedDataSchema = z.strictObject({
  question: z.string().min(1).max(2000),
  contactEmail: z.string().max(320).optional(),
  contactName: z.string().max(200).optional(),
  summary: z.string().max(1200).optional(),
});

export const sessionEndedDataSchema = z.strictObject({
  reason: z.literal('idle'),
  idleMinutes: z.number().int().positive(),
  lastActivityAt: z.iso.datetime({ offset: true }),
  /** Turns in the conversation at the time it ended. */
  turns: z.number().int().nonnegative(),
  /** The hand-off recorded in this conversation, if one happened. */
  handoff: handoffRequestedDataSchema.optional(),
});

/**
 * Reserved session-scoped events, as a LITERAL tuple so the envelope's
 * discriminated union stays precise at the type level (a filtered array
 * would type as `HookEventName[]` and swallow the fired members' narrowing).
 * `index.test.ts` pins this list to the table.
 */
export const RESERVED_SESSION_EVENT_NAMES = ['session.idled', 'turn.completed', 'session.started', 'turn.start'] as const;

export const hookEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...sessionEvent, type: z.literal('session.ended'), data: sessionEndedDataSchema }),
  z.strictObject({ ...sessionEvent, type: z.literal('handoff.requested'), data: handoffRequestedDataSchema }),
  // App-scoped: a schedule tick carries no threadId.
  z.strictObject({ ...baseEvent, type: z.literal('schedule.tick'), data: scheduleTickDataSchema }),
  // Reserved session events carry an opaque payload until their slice defines one.
  z.strictObject({ ...sessionEvent, type: z.enum(RESERVED_SESSION_EVENT_NAMES), data: jsonValueSchema }),
]);

export type HookEvent = z.infer<typeof hookEventSchema>;
export type SessionEndedData = z.infer<typeof sessionEndedDataSchema>;
export type ScheduleTickData = z.infer<typeof scheduleTickDataSchema>;
export type HandoffRequestedData = z.infer<typeof handoffRequestedDataSchema>;

// ── The result out (§8.2, §8.9) ───────────────────────────────────────

export const hookEffectSchema = z.strictObject({
  /** `"<server>.<tool>"`. */
  tool: toolNameSchema,
  /** `called` by the model · `enforced` by the Router (a `required` tool the model skipped) · `failed`. */
  status: z.enum(['called', 'enforced', 'failed']),
});

export const hookResultSchema = z.strictObject({
  status: z.enum(['ok', 'skipped', 'failed']),
  /** The hook's structured output (the definition's result schema shapes it). */
  output: jsonValueSchema.optional(),
  effects: z.array(hookEffectSchema).default([]),
  /** Owner-visible only: a `kind:'event'` row in the console, never the widget, never the model's history. */
  note: z.strictObject({ text: z.string().min(1).max(2000) }).optional(),
  /** Visitor-visible text — honoured only on events whose `allowsAppend` is true. */
  append: z.strictObject({ text: z.string().min(1).max(4000) }).optional(),
  reason: z.string().max(500).optional(),
});

export type HookResult = z.infer<typeof hookResultSchema>;
export type HookEffect = z.infer<typeof hookEffectSchema>;
/** A run's lifecycle as the dispatcher records it — the result statuses plus the two it decides alone. */
export type HookRunStatus = HookResult['status'] | 'deferred' | 'parked';

// ── The `guuey.json` block (§8.7) ─────────────────────────────────────

export const hookHandlerRefSchema = z.union([
  /** A prebuilt hook, by name. */
  z.strictObject({ use: hookNameSchema }),
  /** One MCP tool, called directly with the envelope — no model. */
  z.strictObject({ kind: z.literal('tool'), server: z.string().regex(SERVER_KEY), tool: z.string().regex(TOOL_NAME) }),
  /** A dev-defined agent hook, by its `definitions` key. */
  z.strictObject({ kind: z.literal('agent'), definition: hookNameSchema }),
]);
export type HookHandlerRef = z.infer<typeof hookHandlerRefSchema>;

const agentDefinitionSchema = z
  .strictObject({
    kind: z.literal('agent'),
    on: z.array(hookEventNameSchema).min(1),
    /** The hook's system instruction — what to do with the conversation and the event. */
    instruction: z.string().min(1).max(8000),
    /** Tools the run may call (`server.tool` | `server.*`); absent = the app's declared servers. */
    tools: z.array(toolPatternSchema).max(64).optional(),
    /** Effects that MUST happen; the Router calls them with the structured output if the model did not. */
    required: z.array(toolNameSchema).max(16).optional(),
    model: z.enum(['small', 'default']).optional(),
    maxTurns: z.number().int().min(1).max(16).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    /**
     * A JSON Schema the run's structured `output` must satisfy — the Router
     * hands it to the adapter's structured-output mode (Claude
     * `outputFormat: json_schema`, OpenAI `output_type`, ADK's parsed text).
     * Absent = free-form output. What a `required` effect is called with when
     * the model skipped it, and what a prebuilt's platform-made effect takes.
     */
    output: jsonValueSchema.optional(),
    /** v1: the hook principal only. The field exists so the enum can widen without a shape change. */
    actAs: z.literal('hook').optional(),
  })
  .superRefine((d, ctx) => {
    if (!d.tools || !d.required) return;
    for (const [i, req] of d.required.entries()) {
      if (!d.tools.some((p) => toolPatternCovers(p, req))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['required', i],
          message: `required tool "${req}" is not covered by the hook's tools allowlist`,
        });
      }
    }
  });

const toolDefinitionSchema = z.strictObject({
  kind: z.literal('tool'),
  on: z.array(hookEventNameSchema).min(1),
  tool: toolNameSchema,
});

export const hookDefinitionSchema = z.union([agentDefinitionSchema, toolDefinitionSchema]);
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;
export type AgentHookDefinition = z.infer<typeof agentDefinitionSchema>;

const handlers = z.array(hookHandlerRefSchema).min(1).max(8);

export const hooksSectionSchema = z
  .strictObject({
    'session.ended': handlers.optional(),
    'handoff.requested': handlers.optional(),
    'session.idled': handlers.optional(),
    'turn.completed': handlers.optional(),
    'session.started': handlers.optional(),
    'turn.start': handlers.optional(),
    'schedule.tick': handlers.optional(),
    definitions: z.record(hookNameSchema, hookDefinitionSchema).optional(),
    /**
     * App-scoped crons (reserved in v1 — parses, refused like any reserved
     * event until the platform fires `schedule.tick`): `{ <name>: { cron,
     * timezone?, handlers } }`. The daily digest (#1507) is the first.
     */
    schedules: z
      .record(
        hookNameSchema,
        z.strictObject({
          /** Five-field cron, evaluated by the platform's scheduler. */
          cron: z.string().min(9).max(64),
          timezone: z.string().min(1).max(64).optional(),
          handlers,
        }),
      )
      .optional(),
  })
  .superRefine((section, ctx) => {
    if (section.schedules && !HOOK_EVENTS['schedule.tick'].firedInV1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedules'],
        message: 'hooks.schedules: reserved — the platform does not fire schedule.tick yet',
      });
    }
    for (const event of HOOK_EVENT_NAMES) {
      const refs = section[event];
      if (!refs) continue;
      if (!HOOK_EVENTS[event].firedInV1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [event],
          message: `hooks.${event}: reserved — the platform does not fire it yet`,
        });
        continue;
      }
      for (const [i, ref] of refs.entries()) {
        if (!('kind' in ref) || ref.kind !== 'agent') continue;
        const def = section.definitions?.[ref.definition];
        if (!def) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [event, i, 'definition'],
            message: `hooks.${event}[${i}]: no definition named "${ref.definition}"`,
          });
        } else if (!def.on.includes(event)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [event, i, 'definition'],
            message: `hooks.${event}[${i}]: definition "${ref.definition}" is not declared for ${event} (its "on" is ${def.on.join(', ')})`,
          });
        }
      }
    }
  });

export type HooksSection = z.infer<typeof hooksSectionSchema>;

// ── The runtime's hook door (§8.4 — the wire between the dispatcher and the pod) ──

/** Where a live pod answers hook runs: `POST <pod origin>/agent/hook`. */
export const HOOK_DOOR_PATH = '/agent/hook';

/**
 * What the dispatcher POSTs. Minimal by design: the pod resolves the hook's
 * definition (instruction, tools, required, output, timeout) BY NAME — from
 * its own snapshot for a dev-defined hook, from {@link PREBUILT_DEFINITIONS}
 * for a prebuilt — never from the wire, so nothing on the wire can widen a
 * hook's reach. `timeoutMs` is the dispatcher's wait; the pod caps it by the
 * definition's own.
 */
export const hookInvokeRequestSchema = z.strictObject({
  runId: z.string().min(1).max(ID_MAX),
  name: hookNameSchema,
  event: hookEventSchema,
  timeoutMs: z.number().int().min(1_000).max(300_000),
});
export type HookInvokeRequest = z.infer<typeof hookInvokeRequestSchema>;

/** One effect as the POD reports it — `missing` = a `required` tool the model never called (the dispatcher enforces it). */
export const hookDoorEffectSchema = z.strictObject({
  tool: toolNameSchema,
  status: z.enum(['called', 'failed', 'missing']),
});
export type HookDoorEffect = z.infer<typeof hookDoorEffectSchema>;

/**
 * What the pod answers, synchronously, with a 200. `ok` / `failed` only — the
 * run's terminal state is the dispatcher's to write (one writer); `deferred`,
 * `parked` and `skipped` are decided on its side. Other faces are HTTP: 503 +
 * `Retry-After` at capacity, 422 `UNKNOWN_HOOK` for a name the pod cannot
 * resolve, 401/403 for a principal that is not this app's hook.
 *
 * NOT strict on purpose (the rolling-release rule): the pod may add fields
 * (`stopReason`, `timedOut`, …) the dispatcher does not read yet; a reader
 * never refuses a key the other side started sending. The REQUEST stays
 * strict — nothing on it may widen a hook's reach.
 */
export const hookInvokeResultSchema = z.object({
  runId: z.string().min(1).max(ID_MAX),
  status: z.enum(['ok', 'failed']),
  output: jsonValueSchema.optional(),
  effects: z.array(hookDoorEffectSchema).default([]),
  error: z.string().max(2000).optional(),
});
export type HookInvokeResult = z.infer<typeof hookInvokeResultSchema>;

// ── Prebuilt hooks (§8.8) — one copy for the pod and the dispatcher ──

/**
 * A prebuilt bound to an event as ONE tool call, no model: the dispatcher
 * calls `tool` on the FIRST-PARTY hosted server `serverId` (a registry id —
 * never the app's `mcpServers` map; the gateway still requires the app's
 * grant) with `args(event)`. `undefined` from `args` = this event carries
 * nothing for the tool → the run is `skipped`, not failed.
 */
export interface PrebuiltToolBinding {
  readonly kind: 'tool';
  readonly serverId: string;
  readonly tool: string;
  args(event: HookEvent): JsonObject | undefined;
}

/** An effect the DISPATCHER makes after a prebuilt agent run answers `ok`: `tool` on `serverId` with the run's `output` as the arguments. */
export interface PrebuiltEffect {
  readonly serverId: string;
  readonly tool: string;
}

/**
 * A prebuilt bound to an event as an agent run. "The model writes, the
 * platform calls": the definition is TOOL-LESS — its structured `output`
 * (shaped by `definition.output`) is what the dispatcher hands to each
 * {@link PrebuiltEffect}. So the pod never mounts a first-party server for a
 * hook run, and the app's `mcpServers` need not declare guuey's own tools.
 */
export interface PrebuiltAgentBinding {
  readonly kind: 'agent';
  readonly definition: AgentHookDefinition;
  readonly effects: readonly PrebuiltEffect[];
}

export type PrebuiltBinding = PrebuiltToolBinding | PrebuiltAgentBinding;

export function isPrebuiltHookName(name: string): name is PrebuiltHookName {
  return (PREBUILT_HOOKS as readonly string[]).includes(name);
}

/** The report the email reporter's tool takes (`report_conversation`'s input): the shape both prebuilt bindings produce. */
export const conversationReportSchema = z.strictObject({
  summary: z.string().min(1).max(1200),
  wantedHuman: z.boolean().optional(),
  contactEmail: z.string().max(320).optional(),
  contactName: z.string().max(200).optional(),
});
export type ConversationReport = z.infer<typeof conversationReportSchema>;

/** `report_conversation`'s input as a JSON Schema — the reporter's `output` contract for the session-end run. */
export const CONVERSATION_REPORT_JSON_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'wantedHuman'],
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 1200,
      description:
        "Two to four sentences for the app's owner: what the visitor wanted, what was answered, and what is still open.",
    },
    wantedHuman: { type: 'boolean', description: 'Whether the visitor asked to talk to a person.' },
    contactEmail: { type: 'string', maxLength: 320, description: "The visitor's email address for a follow-up, if they shared one." },
    contactName: { type: 'string', maxLength: 200, description: "The visitor's name, if they shared one." },
  },
};

const EMAIL_REPORTER_SERVER_ID = 'email-reporter';
const EMAIL_REPORTER_TOOL = 'report_conversation';

/**
 * The prebuilt catalog, keyed per event (guuey#1537). A prebuilt with no
 * binding for an event the app declared it on is `prebuilt-not-served` on
 * the dispatcher's side and `UNKNOWN_HOOK` at the door — never a guess.
 *
 * `email-reporter` (guuey#1511): on `handoff.requested` the rep already
 * wrote the summary (guuey#1510) — one tool call maps the envelope onto
 * `report_conversation`; on `session.ended` nothing has summarised the
 * conversation yet — a tool-less agent run writes the report as its
 * structured output and the dispatcher makes the call.
 */
export const PREBUILT_DEFINITIONS: Readonly<Record<PrebuiltHookName, Partial<Readonly<Record<HookEventName, PrebuiltBinding>>>>> = {
  'email-reporter': {
    'handoff.requested': {
      kind: 'tool',
      serverId: EMAIL_REPORTER_SERVER_ID,
      tool: EMAIL_REPORTER_TOOL,
      args(event) {
        if (event.type !== 'handoff.requested') return undefined;
        const { data } = event;
        const report: ConversationReport = {
          summary: (data.summary ?? data.question).slice(0, 1200),
          wantedHuman: true,
          ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
          ...(data.contactName !== undefined ? { contactName: data.contactName } : {}),
        };
        return report;
      },
    },
    'session.ended': {
      kind: 'agent',
      definition: {
        kind: 'agent',
        on: ['session.ended'],
        instruction:
          "The conversation has ended. Write the app owner's report of it as the structured output: `summary` — two to four " +
          'sentences on what the visitor wanted, what was answered, and what is still open, written from the whole ' +
          'conversation; `wantedHuman` — whether the visitor asked to talk to a person; `contactEmail` and `contactName` ' +
          'only if the visitor shared them. Report facts from the transcript; never invent contact details.',
        output: CONVERSATION_REPORT_JSON_SCHEMA,
        model: 'small',
        maxTurns: 2,
        timeoutMs: 90_000,
      },
      effects: [{ serverId: EMAIL_REPORTER_SERVER_ID, tool: EMAIL_REPORTER_TOOL }],
    },
  },
};

/** The binding a prebuilt has for an event, if any. */
export function prebuiltBinding(name: PrebuiltHookName, event: HookEventName): PrebuiltBinding | undefined {
  return PREBUILT_DEFINITIONS[name][event];
}
