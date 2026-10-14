/**
 * Swamp model for the REST surface of a running SkilJ deployment
 * (https://codeberg.org/gklijs/SkilJ): trigger or dry-run commands, read
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
  sequence: z.number().int().describe(
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

const CommandResultSchema = z.object({
  dryRun: z.boolean().describe("True when nothing was stored"),
  accepted: z.boolean().describe("Whether decide() accepted the command"),
  triggeredEventSequences: z.array(z.number()).describe(
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
  sequence: z.number(),
  eventType: z.string(),
  payload: z.unknown(),
  tags: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  metadata: z.object({
    type: z.string(),
    version: z.number(),
    clientId: z.string(),
    createdAt: z.string(),
    correlationId: z.string().nullable(),
    causationId: z.string().nullable(),
  }),
});

const EventTypeInfo = {
  eventTypeName: z.string(),
  eventTypeSchema: z.string(),
  eventTypeSchemaVersion: z.number(),
  epoch: z.string(),
};

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
  sequence: z.number().describe("The sequence the cursor was advanced to"),
  epoch: z.string().nullable().describe("Epoch the ack was recorded in"),
});

const EventWriteSchema = z.object({
  kind: z.enum(["external", "direct"]),
  sequence: z.number().nullable().describe(
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

/** Minimal logger shape used by the model. */
interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
}

/** Method context fields this model uses. */
export interface SkiljContext {
  globalArgs: GlobalArgs;
  logger: Logger;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  globalArgs: GlobalArgs,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string; retry?: boolean } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(path, globalArgs.baseUrl.replace(/\/?$/, "/"));
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${globalArgs.token}`,
    "Accept": "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const route = `${method} ${url.pathname}`;
  const maxAttempts = options.retry
    ? 1 + Math.min(Math.max(globalArgs.maxRetries ?? 0, 0), 10)
    : 1;
  for (let attempt = 0;; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
        signal: AbortSignal.timeout(globalArgs.timeoutMs),
      });
    } catch (err) {
      if (attempt + 1 < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const reason = err instanceof DOMException && err.name === "TimeoutError"
        ? `timed out after ${globalArgs.timeoutMs}ms`
        : String(err);
      throw new Error(`SkilJ ${route} could not be reached: ${reason}`, {
        cause: err,
      });
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body, reported below.
    }
    if (!response.ok) {
      if (attempt + 1 < maxAttempts && isRetryableStatus(response.status)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const body = json as { code?: string; message?: string } | null;
      throw new SkiljApiError(
        route,
        response.status,
        body?.code ?? null,
        body?.message ?? (text.slice(0, 500) || response.statusText),
      );
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      if (attempt + 1 < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new SkiljApiError(
        route,
        response.status,
        null,
        `expected a JSON object, got: ${text.slice(0, 200)}`,
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

function toEventTypeInfo(
  body: Record<string, unknown>,
  epoch: string,
): z.infer<typeof EventsSchema>["eventTypeName"] extends never ? never : {
  eventTypeName: string;
  eventTypeSchema: string;
  eventTypeSchemaVersion: number;
  epoch: string;
} {
  return {
    eventTypeName: String(body.eventTypeName ?? ""),
    eventTypeSchema: String(body.eventTypeSchema ?? ""),
    eventTypeSchemaVersion: Number(body.eventTypeSchemaVersion ?? 0),
    epoch,
  };
}

/** The `@gklijs/skilj` model definition. */
export const model = {
  type: "@gklijs/skilj",
  version: "2026.10.14.2",
  globalArguments: GlobalArgsSchema,

  resources: {
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
          context.globalArgs,
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
        const result = CommandResultSchema.parse({
          dryRun: false,
          accepted: body.accepted,
          triggeredEventSequences: body.triggeredEventSequences ?? [],
          rejectionReason: body.rejectionReason ?? null,
          rejectionKind: body.rejectionKind ?? null,
          deduplicated: body.deduplicated ?? false,
          correlationId: body.correlationId ?? null,
        });
        if (result.accepted) {
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
          context.globalArgs,
          "POST",
          "v1/commands/dry-run",
          {
            body: { payload: args.payload },
            // Stores nothing, so always safe to retry.
            retry: true,
          },
        );
        const result = CommandResultSchema.parse({
          dryRun: true,
          accepted: body.accepted,
          triggeredEventSequences: [],
          rejectionReason: body.rejectionReason ?? null,
          rejectionKind: body.rejectionKind ?? null,
          deduplicated: false,
          correlationId: null,
        });
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
        let first: Record<string, unknown> | null = null;
        let epoch = "";
        let pages = 0;
        let lastPageEmpty = false;
        while (pages < args.maxPages) {
          const body = await request(
            context.globalArgs,
            "GET",
            eventsPath(args, cursor),
            // A read: always safe to retry.
            { retry: true },
          );
          first ??= body;
          pages++;
          const pageEpoch = typeof body.epoch === "string" ? body.epoch : "";
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
          const page = Array.isArray(body.events) ? body.events : [];
          events.push(
            ...page.map((e) => toEvent(e as Record<string, unknown>)),
          );
          const next = typeof body.nextCursor === "string"
            ? body.nextCursor
            : null;
          lastPageEmpty = page.length === 0;
          if (next !== null) cursor = next;
          if (lastPageEmpty || next === null) break;
        }
        const result = EventsSchema.parse({
          ...toEventTypeInfo(first ?? {}, epoch),
          events,
          nextCursor: cursor ?? null,
          pages,
          truncated: pages >= args.maxPages && !lastPageEmpty,
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
          context.globalArgs,
          "GET",
          consumePath(args),
          // A read: always safe to retry.
          { retry: true },
        );
        const served = Array.isArray(body.events) ? body.events : [];
        const result = ConsumedEventsSchema.parse({
          ...toEventTypeInfo(body, String(body.epoch ?? "")),
          mode: args.mode ?? null,
          events: served.map((e) => toEvent(e as Record<string, unknown>)),
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
          context.globalArgs,
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
          context.globalArgs,
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
          sequence: body.sequence ?? null,
          redelivered: body.redelivered ?? false,
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
          context.globalArgs,
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
          context.globalArgs,
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
