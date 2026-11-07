/**
 * Swamp model for the REST surface of a running SkilJ deployment
 * (https://github.com/gklijs/SkilJ): trigger or dry-run commands, read
 * events with a client-tracked cursor or a server-tracked consume cursor,
 * acknowledge consumed events, write external or direct events, and report
 * parked broker deliveries.
 *
 * SkilJ access tokens are capability-scoped: one token authorizes exactly
 * one route kind for one command or event type. Create one model instance
 * per token; calling a method the token doesn't authorize fails with
 * `wrong_token_variant` (HTTP 403).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Global arguments shared by every method of the model. */
export const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Base URL of the SkilJ REST server, e.g. https://skilj.example.com",
  ),
  token: z.string().min(3).meta({ sensitive: true }).describe(
    "SkilJ access token in '<id>.<secret>' form - store it in a vault",
  ),
  debug: z.boolean().optional().describe(
    "Log request method, route, attempt, status and elapsed time; excludes headers, query values and bodies",
  ),
  traceparent: z.string().regex(
    /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/,
  ).optional().describe(
    "W3C traceparent header to connect requests to an upstream distributed trace",
  ),
  tracestate: z.string().max(512).regex(/^[\x20-\x7e]*$/).optional().describe(
    "Optional W3C tracestate header accompanying traceparent",
  ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "Per-request timeout in milliseconds",
  ),
  maxRetries: z.number().int().min(0).max(10).default(2).describe(
    "Retries for transient failures (timeouts, 408/429/502/503/504) on " +
      "side-effect-free calls and on writes protected by an idempotency key " +
      "or dedupe cursor; other writes are never retried",
  ),
});

/** Validated global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TraceArgs = {
  correlationId: z.string().optional().describe(
    "Correlation id to attach; SkilJ generates one when omitted",
  ),
  causationId: z.string().optional().describe(
    "Id of whatever caused this request, e.g. an upstream message id",
  ),
};

const IdempotencyKeyArg = z.string().min(1).optional().describe(
  "Sent as the Idempotency-Key header so retries are recognised",
);

const FilterArg = z.array(z.string()).default([]).describe(
  "Payload filters as 'field:op:value' with op one of equals, contains, " +
    "is_like, greater_than, less_than, near, similar_color, in_subnet, in - " +
    "e.g. 'amount:greater_than:100'",
);

/** Arguments for `triggerCommand`. */
export const TriggerCommandArgsSchema = z.object({
  payload: z.record(z.string(), z.unknown()).describe(
    "The command payload, as the command type's schema expects it",
  ),
  idempotencyKey: IdempotencyKeyArg,
  ...TraceArgs,
});

/** Arguments for `dryRunCommand`. */
export const DryRunCommandArgsSchema = z.object({
  payload: z.record(z.string(), z.unknown()).describe(
    "The command payload to decide on without storing anything",
  ),
});

/** Arguments for `fetchEvents`. */
export const FetchEventsArgsSchema = z.object({
  filters: FilterArg,
  after: z.string().optional().describe(
    "Start after this cursor (a previous nextCursor, or a bare sequence)",
  ),
  epoch: z.string().optional().describe(
    "Database epoch the 'after' cursor was read in, if not inside it",
  ),
  correlationId: z.string().optional().describe(
    "Only return events with this correlation id",
  ),
  upToSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .optional().describe(
      "Read history as known at this sequence, inclusive (SkilJ 0.3.0)",
    ),
  maxPages: z.number().int().positive().max(100).default(1).describe(
    "Follow nextCursor for up to this many pages",
  ),
});

/** Arguments for `consumeEvents`. */
export const ConsumeEventsArgsSchema = z.object({
  filters: FilterArg,
  mode: z.enum(["auto", "manual"]).optional().describe(
    "Server-tracked cursor mode: required on the token's first consume " +
      "call, afterwards the cursor's own mode applies and a different mode " +
      "is refused",
  ),
});

/** Arguments for `acknowledgeEvents`. */
export const AcknowledgeEventsArgsSchema = z.object({
  sequence: z.number().int().nonnegative().describe(
    "Advance a manual_ack cursor up to this served sequence",
  ),
  epoch: z.string().optional().describe(
    "Epoch from the consume response that served the sequence",
  ),
});

/** Arguments for `ingestExternalEvent`. */
export const IngestExternalEventArgsSchema = z.object({
  payload: z.record(z.string(), z.unknown()).describe(
    "The external event payload",
  ),
  sourceContent: z.string().describe(
    "The original message, verbatim, as received from the source",
  ),
  sourceContext: z.string().optional().describe(
    "Where the message came from, e.g. a topic or queue name",
  ),
  dedupe: z.object({
    partitionKey: z.string(),
    sequence: z.number().int(),
  }).optional().describe(
    "Watermark dedupe for an in-order source: partition and its sequence",
  ),
  idempotencyKey: IdempotencyKeyArg,
  ...TraceArgs,
});

/** Arguments for `createDirectEvent`. */
export const CreateDirectEventArgsSchema = z.object({
  payload: z.record(z.string(), z.unknown()).describe("The event payload"),
  ...TraceArgs,
});

/** Arguments for `reportParkedDelivery`. */
export const ReportParkedDeliveryArgsSchema = z.object({
  source: z.string().min(1).describe(
    "The bridge's own name for itself, e.g. 'kafka-inbound'",
  ),
  kind: z.enum(["external_event", "command_trigger"]).describe(
    "Which original route the delivery was bound for",
  ),
  identifier: z.string().min(1).describe(
    "Broker-native message id, e.g. '{topic}:{partition}:{offset}'",
  ),
  error: z.string().min(1).describe(
    "Why the bridge gave up retrying this delivery",
  ),
  attemptCount: z.number().int().nonnegative().describe(
    "How many delivery attempts the bridge made",
  ),
  firstFailedAt: z.string().min(1).describe(
    "ISO-8601 timestamp of the first failed attempt",
  ),
  request: z.record(z.string(), z.unknown()).describe(
    "The verbatim original POST body for the delivery, in the shape the " +
      "kind's own route takes",
  ),
  idempotencyKey: z.string().min(1).optional().describe(
    "The Idempotency-Key header the original POST carried, if any - " +
      "refused together with a watermark dedupe cursor in 'request'",
  ),
});

/** Arguments for ordered command batches; the server enforces its batch limit. */
export const TriggerCommandsArgsSchema = z.object({
  commands: z.array(TriggerCommandArgsSchema).min(1),
  stopAtFirstFailure: z.boolean().default(false),
});

/** Arguments for ordered external-event batches. */
export const IngestExternalEventsArgsSchema = z.object({
  events: z.array(IngestExternalEventArgsSchema).min(1),
  stopAtFirstFailure: z.boolean().default(true).describe(
    "Stop after a failure to avoid advancing a source watermark past it",
  ),
});

/** Discover tag values visible to the event-read token. */
export const SearchUsedTagsArgsSchema = z.object({
  key: z.string().min(1),
  prefix: z.string().default(""),
  limit: z.number().int().min(0).max(100).default(20),
});

const CommandResultSchema = z.object({
  pendingApproval: z.boolean().default(false),
  proposalId: z.string().nullable().default(null),
  dryRun: z.boolean().describe("True when nothing was stored"),
  accepted: z.boolean().describe("Whether decide() accepted the command"),
  triggeredEventSequences: z.array(z.number().int().nonnegative()).describe(
    "Sequences of the events the command stored (empty for dry runs)",
  ),
  rejectionReason: z.string().nullable(),
  rejectionKind: z.string().nullable(),
  deduplicated: z.boolean().describe(
    "True when the Idempotency-Key matched an earlier accepted outcome",
  ),
  correlationId: z.string().nullable(),
});

const EventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  eventType: z.string(),
  payload: z.unknown().refine(
    (value) => value !== undefined,
    "Event payload is missing",
  ),
  tags: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  metadata: z.object({
    type: z.string(),
    version: z.number().int().nonnegative(),
    clientId: z.string(),
    createdAt: z.string(),
    correlationId: z.string().nullable(),
    causationId: z.string().nullable(),
  }),
});

const EventTypeInfo = {
  eventTypeName: z.string().min(1),
  eventTypeSchema: z.string().min(1),
  eventTypeSchemaVersion: z.number().int().nonnegative(),
  epoch: z.string().min(1),
};

const EventsResponseSchema = z.object({
  ...EventTypeInfo,
  events: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().min(1).nullable(),
});
const ConsumeResponseSchema = EventsResponseSchema.omit({ nextCursor: true });

const EventsSchema = z.object({
  ...EventTypeInfo,
  events: z.array(EventSchema),
  nextCursor: z.string().nullable().describe(
    "Pass as 'after' on the next call to continue",
  ),
  pages: z.number().describe("How many pages were fetched"),
  truncated: z.boolean().describe(
    "True when maxPages was reached and more events may follow",
  ),
});

const ConsumedEventsSchema = z.object({
  ...EventTypeInfo,
  mode: z.enum(["auto", "manual"]).nullable().describe(
    "The mode this call consumed under, when the caller stated one",
  ),
  events: z.array(EventSchema),
  count: z.number().describe("How many events this call served"),
});

const AckSchema = z.object({
  sequence: z.number().int().nonnegative().describe(
    "The sequence the cursor was advanced to",
  ),
  epoch: z.string().nullable().describe("Epoch the ack was recorded in"),
});

const EventWriteSchema = z.object({
  kind: z.enum(["external", "direct"]),
  sequence: z.number().int().nonnegative().nullable().describe(
    "Sequence of the stored event; null for a watermark-dedupe redelivery",
  ),
  redelivered: z.boolean().describe(
    "True when the message had already been ingested before",
  ),
});

const ParkedDeliverySchema = z.object({
  id: z.string().describe("Id of the stored parked delivery"),
  kind: z.enum(["external_event", "command_trigger"]),
  source: z.string(),
  identifier: z.string(),
});

const BatchErrorSchema = z.object({
  error: z.object({
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
  }),
});
const CommandOutcomeSchema = CommandResultSchema.omit({ dryRun: true });
const BatchCommandsSchema = z.object({
  outcomes: z.array(z.union([BatchErrorSchema, CommandOutcomeSchema])),
  count: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  pending: z.number(),
  failed: z.number(),
});
const ExternalOutcomeSchema = EventWriteSchema.omit({ kind: true });
const BatchEventsSchema = z.object({
  outcomes: z.array(z.union([BatchErrorSchema, ExternalOutcomeSchema])),
  count: z.number(),
  stored: z.number(),
  redelivered: z.number(),
  failed: z.number(),
});
const TagsSchema = z.object({
  truncated: z.boolean().nullable().describe(
    "True when the requested limit was reached; null when completeness is unknown because the server supplies neither a total nor a continuation cursor",
  ),
  key: z.string(),
  prefix: z.string(),
  tags: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  count: z.number(),
});

function commandResult(body: Record<string, unknown>, dryRun = false) {
  return CommandResultSchema.parse({
    ...body,
    dryRun,
    triggeredEventSequences: body.triggeredEventSequences ?? [],
    rejectionReason: body.rejectionReason ?? null,
    rejectionKind: body.rejectionKind ?? null,
    correlationId: body.correlationId ?? null,
    deduplicated: body.deduplicated ?? false,
  });
}

/** Minimal logger shape used by the model. */
interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
}

/** Method context fields this model uses. */
export interface SkiljContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  signal?: AbortSignal;
  traceHeaders?: Readonly<Record<string, string>>;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Error thrown for a non-2xx answer from the SkilJ server. */
export class SkiljApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** SkilJ error code from the response body, e.g. `wrong_token_variant`. */
  readonly code: string | null;

  /** Builds the error from a failed response. */
  constructor(
    route: string,
    status: number,
    code: string | null,
    detail: string,
  ) {
    super(
      `SkilJ ${route} failed with HTTP ${status}${
        code ? ` (${code})` : ""
      }: ${detail}`,
    );
    this.name = "SkiljApiError";
    this.status = status;
    this.code = code;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 502 &&
      status <= 504;
}

function backoffMs(attempt: number): number {
  return Math.min(200 * 2 ** attempt, 2000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryDelay(response: Response, attempt: number): number | null {
  const header = response.headers.get("Retry-After");
  if (header !== null) {
    const value = header.trim();
    const delay = /^\d+$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(delay)) {
      // Do not retry sooner than the server asks. Long waits are left to
      // the caller rather than holding a Swamp method indefinitely.
      return delay > 30000 ? null : Math.max(0, delay);
    }
  }
  return backoffMs(attempt);
}

/** Perform an authenticated JSON request with retry and diagnostic controls. */
export async function request(
  context: SkiljContext,
  method: "GET" | "POST",
  path: string,
  options: {
    body?: unknown;
    idempotencyKey?: string;
    retry?: boolean;
    sensitiveResponse?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const globalArgs = context.globalArgs;
  const url = new URL(path, globalArgs.baseUrl.replace(/\/?$/, "/"));
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${globalArgs.token}`,
    "Accept": "application/json",
  };
  const traceparent = globalArgs.traceparent ??
    context.traceHeaders?.traceparent;
  const tracestate = globalArgs.tracestate ??
    (globalArgs.traceparent ? undefined : context.traceHeaders?.tracestate);
  if (traceparent) headers.traceparent = traceparent;
  if (tracestate) headers.tracestate = tracestate;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const route = `${method} ${url.pathname}`;
  const maxAttempts = options.retry
    ? 1 + Math.min(Math.max(globalArgs.maxRetries ?? 0, 0), 10)
    : 1;
  for (let attempt = 0;; attempt++) {
    context.signal?.throwIfAborted();
    const started = performance.now();
    const diagnostic = (status: number | null) => {
      if (globalArgs.debug) {
        context.logger.info("SkilJ HTTP request", {
          route,
          attempt: attempt + 1,
          status,
          elapsedMs: Math.round(performance.now() - started),
        });
      }
    };
    let response: Response;
    let text: string;
    let status: number | null = null;
    try {
      response = await fetch(url, {
        method,
        headers,
        // Redirecting a POST can forward its private body to another host.
        redirect: "manual",
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal: context.signal
          ? AbortSignal.any([
            context.signal,
            AbortSignal.timeout(globalArgs.timeoutMs),
          ])
          : AbortSignal.timeout(globalArgs.timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (err) {
      diagnostic(status);
      context.signal?.throwIfAborted();
      if (attempt + 1 < maxAttempts) {
        await sleep(backoffMs(attempt), context.signal);
        continue;
      }
      const reason = err instanceof DOMException && err.name === "TimeoutError"
        ? `timed out after ${globalArgs.timeoutMs}ms`
        : String(err);
      throw new Error(`SkilJ ${route} could not be reached: ${reason}`, {
        cause: err,
      });
    }
    diagnostic(response.status);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body, reported below.
    }
    if (!response.ok) {
      if (attempt + 1 < maxAttempts && isRetryableStatus(response.status)) {
        const delay = retryDelay(response, attempt);
        if (delay !== null) {
          await sleep(delay, context.signal);
          continue;
        }
      }
      const body =
        json !== null && typeof json === "object" && !Array.isArray(json)
          ? json as Record<string, unknown>
          : {};
      const code = typeof body.code === "string" ? body.code : null;
      const detail = typeof body.message === "string"
        ? body.message
        : (text.slice(0, 500) || response.statusText);
      throw new SkiljApiError(
        route,
        response.status,
        options.sensitiveResponse ? null : code,
        options.sensitiveResponse
          ? "response body withheld because it may contain sensitive data"
          : detail,
      );
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      if (attempt + 1 < maxAttempts) {
        await sleep(backoffMs(attempt), context.signal);
        continue;
      }
      throw new SkiljApiError(
        route,
        response.status,
        null,
        options.sensitiveResponse
          ? "expected a JSON object; response body withheld"
          : `expected a JSON object, got: ${text.slice(0, 200)}`,
      );
    }
    return json as Record<string, unknown>;
  }
}

function eventsPath(
  args: z.infer<typeof FetchEventsArgsSchema>,
  after?: string,
): string {
  const params = new URLSearchParams();
  for (const filter of args.filters) params.append("filter", filter);
  if (after) params.set("after", after);
  if (args.epoch && after === args.after) params.set("epoch", args.epoch);
  if (args.upToSequence !== undefined) {
    params.set("upToSequence", String(args.upToSequence));
  }
  if (args.correlationId) params.set("correlationId", args.correlationId);
  const query = params.toString();
  return query ? `v1/events?${query}` : "v1/events";
}

function consumePath(args: z.infer<typeof ConsumeEventsArgsSchema>): string {
  const params = new URLSearchParams();
  for (const filter of args.filters) params.append("filter", filter);
  if (args.mode) params.set("mode", args.mode);
  const query = params.toString();
  return query ? `v1/events/consume?${query}` : "v1/events/consume";
}

function toEvent(raw: Record<string, unknown>): z.infer<typeof EventSchema> {
  const meta = (raw.metadata ?? {}) as Record<string, unknown>;
  return EventSchema.parse({
    sequence: raw.sequence,
    eventType: raw.eventType,
    payload: raw.payload,
    tags: raw.tags,
    metadata: {
      type: meta.type,
      version: meta.version,
      clientId: meta.clientId,
      createdAt: meta.createdAt,
      correlationId: meta.correlationId ?? null,
      causationId: meta.causationId ?? null,
    },
  });
}

function toEventTypeInfo(body: Record<string, unknown>) {
  return z.object(EventTypeInfo).parse(body);
}

/** The `@gklijs/skilj` model definition. */
export const model = {
  type: "@gklijs/skilj",
  version: "2026.11.07.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.11.07.1",
    description:
      "SkilJ 0.3.0 features; existing connection arguments remain compatible",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],

  resources: {
    batchCommands: {
      description:
        "Ordered command outcomes, including per-item errors and pending approvals",
      schema: BatchCommandsSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    batchEvents: {
      description: "Ordered external-event outcomes, including per-item errors",
      schema: BatchEventsSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    usedTags: {
      description: "Distinct used tag values visible to the event-read token",
      schema: TagsSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    commandResult: {
      description: "Outcome of a triggered or dry-run command",
      schema: CommandResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    events: {
      description: "A page (or several) of events read with an EventRead token",
      schema: EventsSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    consumedEvents: {
      description:
        "Events served from a server-tracked consume cursor with an EventRead token",
      schema: ConsumedEventsSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    ack: {
      description: "Record of a manual_ack cursor acknowledgement",
      schema: AckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    eventWrite: {
      description: "Result of writing an external or direct event",
      schema: EventWriteSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    parkedDelivery: {
      description: "A bridge's parked-delivery report stored by SkilJ",
      schema: ParkedDeliverySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },

  methods: {
    triggerCommands: {
      description:
        "Trigger ordered commands (POST /v1/commands/trigger/batch); per-item failures are recorded, not thrown. Not atomic",
      arguments: TriggerCommandsArgsSchema,
      execute: async (
        args: z.infer<typeof TriggerCommandsArgsSchema>,
        context: SkiljContext,
      ) => {
        context.logger.info("Triggering SkilJ command batch ({count} items)", {
          count: args.commands.length,
        });
        const body = await request(
          context,
          "POST",
          "v1/commands/trigger/batch",
          {
            body: args,
            // Each command needs its own key; a request-level key is ignored.
            retry: args.commands.every((item) =>
              item.idempotencyKey !== undefined
            ),
          },
        );
        const raw = z.array(z.record(z.string(), z.unknown())).length(
          args.commands.length,
        ).parse(body.outcomes);
        const outcomes = raw.map((item) =>
          "error" in item
            ? BatchErrorSchema.parse(item)
            : CommandOutcomeSchema.parse(commandResult(item))
        );
        const done = outcomes.filter((
          item,
        ): item is Exclude<typeof item, { error: unknown }> =>
          !("error" in item)
        );
        const result = BatchCommandsSchema.parse({
          outcomes,
          count: outcomes.length,
          accepted: done.filter((item) =>
            item.accepted && !item.pendingApproval
          ).length,
          rejected: done.filter((item) =>
            !item.accepted && !item.pendingApproval
          ).length,
          pending: done.filter((item) => item.pendingApproval).length,
          failed: outcomes.length - done.length,
        });
        context.logger.info(
          "Command batch completed ({count} outcomes, {failed} errors)",
          { count: result.count, failed: result.failed },
        );
        return {
          dataHandles: [
            await context.writeResource("batchCommands", "commands", result),
          ],
        };
      },
    },
    ingestExternalEvents: {
      description:
        "Ingest ordered external events (POST /v1/events/external/batch); per-item failures are recorded. Not atomic",
      arguments: IngestExternalEventsArgsSchema,
      execute: async (
        args: z.infer<typeof IngestExternalEventsArgsSchema>,
        context: SkiljContext,
      ) => {
        context.logger.info("Ingesting SkilJ event batch ({count} items)", {
          count: args.events.length,
        });
        const body = await request(
          context,
          "POST",
          "v1/events/external/batch",
          {
            body: args,
            retry: args.events.every((item) =>
              item.idempotencyKey !== undefined || item.dedupe !== undefined
            ),
          },
        );
        const outcomes = z.array(
          z.union([BatchErrorSchema, ExternalOutcomeSchema]),
        ).length(args.events.length).parse(body.outcomes);
        const done = outcomes.filter((
          item,
        ): item is Exclude<typeof item, { error: unknown }> =>
          !("error" in item)
        );
        const result = BatchEventsSchema.parse({
          outcomes,
          count: outcomes.length,
          stored: done.filter((item) => !item.redelivered).length,
          redelivered: done.filter((item) => item.redelivered).length,
          failed: outcomes.length - done.length,
        });
        context.logger.info(
          "Event batch completed ({count} outcomes, {failed} errors)",
          { count: result.count, failed: result.failed },
        );
        return {
          dataHandles: [
            await context.writeResource("batchEvents", "externalBatch", result),
          ],
        };
      },
    },
    searchUsedTags: {
      description:
        "Discover distinct tag values by literal prefix (GET /v1/events/tags) within the token's event type and owner scope",
      arguments: SearchUsedTagsArgsSchema,
      execute: async (
        args: z.infer<typeof SearchUsedTagsArgsSchema>,
        context: SkiljContext,
      ) => {
        context.logger.info("Searching visible SkilJ tag values");
        const params = new URLSearchParams({
          key: args.key,
          prefix: args.prefix,
          limit: String(args.limit),
        });
        const body = await request(context, "GET", `v1/events/tags?${params}`, {
          retry: true,
        });
        const tags = TagsSchema.shape.tags.parse(body.tags);
        const result = TagsSchema.parse({
          ...args,
          tags,
          count: tags.length,
          truncated: tags.length >= args.limit ? true : null,
        });
        context.logger.info("Found {count} visible tag values", {
          count: result.count,
        });
        return {
          dataHandles: [
            await context.writeResource("usedTags", "tags", result),
          ],
        };
      },
    },
    triggerCommand: {
      description:
        "Trigger the token's command type (POST /v1/commands/trigger). A business rejection is recorded, not thrown",
      arguments: TriggerCommandArgsSchema,
      execute: async (
        args: z.infer<typeof TriggerCommandArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Triggering SkilJ command");
        const body = await request(
          context,
          "POST",
          "v1/commands/trigger",
          {
            body: {
              payload: args.payload,
              correlationId: args.correlationId,
              causationId: args.causationId,
            },
            idempotencyKey: args.idempotencyKey,
            // Safe to retry only under an idempotency key: without one a
            // retried POST could store the command twice.
            retry: args.idempotencyKey !== undefined,
          },
        );
        const result = commandResult(body);
        if (result.pendingApproval) {
          context.logger.info("Command awaiting approval: {proposalId}", {
            proposalId: result.proposalId,
          });
        } else if (result.accepted) {
          context.logger.info("Command accepted, stored {count} event(s)", {
            count: result.triggeredEventSequences.length,
          });
        } else {
          context.logger.warning("Command rejected ({kind}): {reason}", {
            kind: result.rejectionKind,
            reason: result.rejectionReason,
          });
        }
        const handle = await context.writeResource(
          "commandResult",
          "trigger",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    dryRunCommand: {
      description:
        "Ask whether the token's command type would accept a payload, storing nothing (POST /v1/commands/dry-run)",
      arguments: DryRunCommandArgsSchema,
      execute: async (
        args: z.infer<typeof DryRunCommandArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Dry-running SkilJ command");
        const body = await request(
          context,
          "POST",
          "v1/commands/dry-run",
          {
            body: { payload: args.payload },
            // Stores nothing, so always safe to retry.
            retry: true,
          },
        );
        const result = commandResult(body, true);
        context.logger.info("Dry run {outcome}", {
          outcome: result.accepted
            ? "accepted"
            : `rejected (${result.rejectionKind})`,
        });
        const handle = await context.writeResource(
          "commandResult",
          "dryRun",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    fetchEvents: {
      description:
        "Read the token's event type (GET /v1/events), following nextCursor up to maxPages",
      arguments: FetchEventsArgsSchema,
      execute: async (
        args: z.infer<typeof FetchEventsArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Fetching SkilJ events, up to {maxPages} page(s)", {
          maxPages: args.maxPages,
        });
        const events: z.infer<typeof EventSchema>[] = [];
        let cursor = args.after;
        let first: z.infer<typeof EventsResponseSchema> | null = null;
        const visited = new Set(args.after ? [args.after] : []);
        const initialPosition = /^(-?\d+)(?:@.+)?$/.exec(args.after ?? "");
        let lastSequence = initialPosition ? BigInt(initialPosition[1]) : -1n;
        let epoch = "";
        let pages = 0;
        let hasMore = false;
        while (pages < args.maxPages) {
          const body = await request(
            context,
            "GET",
            eventsPath(args, cursor),
            // A read: always safe to retry.
            { retry: true },
          );
          const response = EventsResponseSchema.parse(body);
          first ??= response;
          pages++;
          const pageEpoch = response.epoch;
          if (epoch && pageEpoch && pageEpoch !== epoch) {
            throw new SkiljApiError(
              "GET /v1/events",
              409,
              "epoch_changed",
              `database epoch changed mid-read from ${epoch} to ${pageEpoch} ` +
                `- start over from the latest nextCursor`,
            );
          }
          if (pageEpoch) epoch = pageEpoch;
          const page = response.events.map(toEvent);
          for (const event of page) {
            if (event.sequence <= lastSequence) {
              throw new Error(
                "SkilJ GET /v1/events returned duplicate or unordered event sequences",
              );
            }
            lastSequence = BigInt(event.sequence);
          }
          events.push(...page);
          const next = response.nextCursor;
          if (next !== null) {
            const position = /^(-?\d+)@(.+)$/.exec(next);
            if (
              !position || position[2] !== response.epoch ||
              BigInt(position[1]) < lastSequence
            ) {
              throw new Error(
                "SkilJ GET /v1/events returned an invalid, regressing or wrong-epoch cursor",
              );
            }
          }
          hasMore = page.length > 0 && next !== null;
          if (hasMore && visited.has(next!)) {
            throw new Error(
              "SkilJ GET /v1/events returned a non-advancing cursor (repeated or cyclic)",
            );
          }
          if (next !== null) visited.add(next);
          cursor = next ?? undefined;
          if (!hasMore) break;
        }
        const result = EventsSchema.parse({
          ...toEventTypeInfo(first ?? {}),
          events,
          nextCursor: cursor ?? null,
          pages,
          truncated: pages >= args.maxPages && hasMore,
        });
        context.logger.info("Fetched {count} event(s) in {pages} page(s)", {
          count: events.length,
          pages,
        });
        const handle = await context.writeResource("events", "events", result);
        return { dataHandles: [handle] };
      },
    },

    consumeEvents: {
      description:
        "Serve the token's event type from its server-tracked cursor (GET /v1/events/consume); the cursor advances itself, nothing is passed back",
      arguments: ConsumeEventsArgsSchema,
      execute: async (
        args: z.infer<typeof ConsumeEventsArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Consuming SkilJ events in {mode} mode", {
          mode: args.mode ?? "cursor's own",
        });
        const body = await request(
          context,
          "GET",
          consumePath(args),
          // This GET advances the cursor or acquires a claim. A lost response
          // must not silently skip an auto batch or replace a manual claim.
          { retry: false },
        );
        const response = ConsumeResponseSchema.parse(body);
        const served = response.events.map(toEvent);
        for (let index = 1; index < served.length; index++) {
          if (served[index].sequence <= served[index - 1].sequence) {
            throw new Error(
              "SkilJ GET /v1/events/consume returned duplicate or unordered event sequences",
            );
          }
        }
        const result = ConsumedEventsSchema.parse({
          ...toEventTypeInfo(response),
          mode: args.mode ?? null,
          events: served,
          count: served.length,
        });
        context.logger.info("Consumed {count} event(s)", {
          count: result.count,
        });
        const handle = await context.writeResource(
          "consumedEvents",
          "consume",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    acknowledgeEvents: {
      description:
        "Advance a manual_ack consume cursor (POST /v1/events/consume/ack) up to a served sequence",
      arguments: AcknowledgeEventsArgsSchema,
      execute: async (
        args: z.infer<typeof AcknowledgeEventsArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Acknowledging SkilJ events up to {sequence}", {
          sequence: args.sequence,
        });
        await request(
          context,
          "POST",
          "v1/events/consume/ack",
          {
            body: { sequence: args.sequence, epoch: args.epoch },
            // Re-acknowledging the same sequence is a no-op success, so a
            // retry can never move the cursor twice.
            retry: true,
          },
        );
        const result = AckSchema.parse({
          sequence: args.sequence,
          epoch: args.epoch ?? null,
        });
        const handle = await context.writeResource("ack", "ack", result);
        return { dataHandles: [handle] };
      },
    },

    ingestExternalEvent: {
      description:
        "Record an event from an outside system (POST /v1/events/external), deduplicated by Idempotency-Key or watermark",
      arguments: IngestExternalEventArgsSchema,
      execute: async (
        args: z.infer<typeof IngestExternalEventArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Ingesting external SkilJ event");
        const body = await request(
          context,
          "POST",
          "v1/events/external",
          {
            body: {
              payload: args.payload,
              sourceContent: args.sourceContent,
              sourceContext: args.sourceContext,
              dedupe: args.dedupe,
              correlationId: args.correlationId,
              causationId: args.causationId,
            },
            idempotencyKey: args.idempotencyKey,
            // Safe to retry only under a dedupe mechanism: the server
            // recognises either as the same message.
            retry: args.idempotencyKey !== undefined ||
              args.dedupe !== undefined,
          },
        );
        const result = EventWriteSchema.parse({
          kind: "external",
          ...ExternalOutcomeSchema.parse(body),
        });
        context.logger.info("External event {outcome}", {
          outcome: result.redelivered
            ? "was a redelivery"
            : `stored at ${result.sequence}`,
        });
        const handle = await context.writeResource(
          "eventWrite",
          "external",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    createDirectEvent: {
      description:
        "Store an event directly, bypassing any command (POST /v1/events/direct)",
      arguments: CreateDirectEventArgsSchema,
      execute: async (
        args: z.infer<typeof CreateDirectEventArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        context.logger.info("Creating direct SkilJ event");
        const body = await request(
          context,
          "POST",
          "v1/events/direct",
          {
            body: {
              payload: args.payload,
              correlationId: args.correlationId,
              causationId: args.causationId,
            },
            // Every call stores a fresh event: never retried.
          },
        );
        const result = EventWriteSchema.parse({
          kind: "direct",
          sequence: body.sequence,
          redelivered: false,
        });
        context.logger.info("Direct event stored at {sequence}", {
          sequence: result.sequence,
        });
        const handle = await context.writeResource(
          "eventWrite",
          "direct",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    reportParkedDelivery: {
      description:
        "Report a broker delivery the bridge gave up retrying (POST /v1/parked-deliveries), for a later retryParkedDelivery",
      arguments: ReportParkedDeliveryArgsSchema,
      execute: async (
        args: z.infer<typeof ReportParkedDeliveryArgsSchema>,
        context: SkiljContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const dedupe = (args.request.dedupe ?? null) as unknown;
        if (
          args.kind === "external_event" && dedupe !== null &&
          args.idempotencyKey !== undefined
        ) {
          throw new Error(
            "SkilJ POST /v1/parked-deliveries refused: 'request' carries a " +
              "watermark dedupe cursor and 'idempotencyKey' is also set " +
              "(dedupe_and_idempotency_key) - pass one or the other",
          );
        }
        context.logger.info("Reporting parked SkilJ delivery from {source}", {
          source: args.source,
        });
        const body = await request(
          context,
          "POST",
          "v1/parked-deliveries",
          {
            body: {
              source: args.source,
              kind: args.kind,
              identifier: args.identifier,
              error: args.error,
              attemptCount: args.attemptCount,
              firstFailedAt: args.firstFailedAt,
              request: args.request,
              idempotencyKey: args.idempotencyKey,
            },
            // Every call stores a fresh parked delivery: never retried.
          },
        );
        const result = ParkedDeliverySchema.parse({
          id: body.id,
          kind: args.kind,
          source: args.source,
          identifier: args.identifier,
        });
        context.logger.info("Parked delivery stored as {id}", {
          id: result.id,
        });
        const handle = await context.writeResource(
          "parkedDelivery",
          "parked",
          result,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
