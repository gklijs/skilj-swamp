import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model, SkiljApiError, type SkiljContext } from "./skilj.ts";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function mockFetch(
  responses: Array<
    { status: number; body: unknown; headers?: Record<string, string> }
  >,
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      }),
    );
  };
  return calls;
}

function context() {
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx: SkiljContext = {
    globalArgs: {
      baseUrl: "https://skilj.example.com/api",
      token: "tok.secret",
      timeoutMs: 1000,
      maxRetries: 0,
    },
    logger: { info() {}, warning() {} },
    writeResource(spec, name, data) {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { ctx, written };
}

const realFetch = globalThis.fetch;

Deno.test("triggerCommand sends auth, idempotency key and records acceptance", async () => {
  const calls = mockFetch([{
    status: 200,
    body: {
      accepted: true,
      triggeredEventSequences: [7],
      deduplicated: false,
      correlationId: "c1",
    },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.triggerCommand.execute(
      { payload: { wallet_id: "w1", amount: 5 }, idempotencyKey: "k1" },
      ctx,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(
    calls[0].url,
    "https://skilj.example.com/api/v1/commands/trigger",
  );
  assertEquals(calls[0].headers.get("Authorization"), "Bearer tok.secret");
  assertEquals(calls[0].headers.get("Idempotency-Key"), "k1");
  assertEquals(written[0].spec, "commandResult");
  assertEquals(written[0].data, {
    dryRun: false,
    pendingApproval: false,
    proposalId: null,
    accepted: true,
    triggeredEventSequences: [7],
    rejectionReason: null,
    rejectionKind: null,
    deduplicated: false,
    correlationId: "c1",
  });
});

Deno.test("triggerCommand without an idempotency key is not retried", async () => {
  const calls = mockFetch([{
    status: 503,
    body: { code: "temporarily_unavailable", message: "busy" },
  }]);
  const { ctx, written } = context();
  try {
    const err = await assertRejects(
      () => model.methods.triggerCommand.execute({ payload: { a: 1 } }, ctx),
      SkiljApiError,
    );
    assertEquals(err.status, 503);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(calls.length, 1);
  assertEquals(written.length, 0);
});

Deno.test("triggerCommand with an idempotency key retries a 503 once", async () => {
  const calls = mockFetch([
    { status: 503, body: { code: "busy", message: "busy" } },
    {
      status: 200,
      body: { accepted: true, triggeredEventSequences: [9] },
    },
  ]);
  const { ctx, written } = context();
  ctx.globalArgs.maxRetries = 2;
  // Avoid real waiting in tests by collapsing the timers.
  const realSetTimeout = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout = (fn: () => void) => {
    fn();
    return 0;
  };
  try {
    await model.methods.triggerCommand.execute(
      { payload: { a: 1 }, idempotencyKey: "k-retry" },
      ctx,
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
  }
  assertEquals(calls.length, 2);
  assertEquals(written[0].data.triggeredEventSequences, [9]);
});

Deno.test("dryRunCommand records a rejection without throwing", async () => {
  mockFetch([{
    status: 200,
    body: {
      accepted: false,
      rejectionReason: "insufficient funds",
      rejectionKind: "insufficient_funds",
    },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.dryRunCommand.execute({ payload: { amount: 99 } }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written[0].name, "dryRun");
  assertEquals(written[0].data.accepted, false);
  assertEquals(written[0].data.rejectionKind, "insufficient_funds");
});

Deno.test("an HTTP error throws with the SkilJ error code and writes nothing", async () => {
  mockFetch([{
    status: 403,
    body: { code: "wrong_token_variant", message: "nope" },
  }]);
  const { ctx, written } = context();
  try {
    const err = await assertRejects(
      () => model.methods.createDirectEvent.execute({ payload: {} }, ctx),
      SkiljApiError,
    );
    assertEquals(err.code, "wrong_token_variant");
    assertEquals(err.status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.length, 0);
});

const event = (sequence: number) => ({
  sequence,
  eventType: "Withdrawn",
  payload: { amount: 1 },
  tags: [{ key: "wallet", value: "w1" }],
  metadata: {
    type: "Withdrawn",
    version: 1,
    clientId: "c",
    createdAt: "2026-10-14T00:00:00Z",
  },
});
const page = (events: unknown[], nextCursor: string | null) => ({
  events,
  nextCursor,
  epoch: "e1",
  eventTypeName: "Withdrawn",
  eventTypeSchema: "{}",
  eventTypeSchemaVersion: 1,
});

Deno.test("fetchEvents follows nextCursor and reports truncation", async () => {
  const calls = mockFetch([
    { status: 200, body: page([event(1), event(2)], "2@e1") },
    { status: 200, body: page([event(3)], "3@e1") },
  ]);
  const { ctx, written } = context();
  try {
    await model.methods.fetchEvents.execute(
      { filters: ["amount:greater_than:0"], maxPages: 2 },
      ctx,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(
    calls[0].url,
    "https://skilj.example.com/api/v1/events?filter=amount%3Agreater_than%3A0",
  );
  assertEquals(calls[1].url.endsWith("&after=2%40e1"), true);
  const data = written[0].data;
  assertEquals((data.events as unknown[]).length, 3);
  assertEquals(data.nextCursor, "3@e1");
  assertEquals(data.truncated, true);
});

Deno.test("fetchEvents stops on an empty page and is not truncated", async () => {
  mockFetch([
    { status: 200, body: page([event(1)], "1@e1") },
    { status: 200, body: page([], "1@e1") },
  ]);
  const { ctx, written } = context();
  try {
    await model.methods.fetchEvents.execute({ filters: [], maxPages: 5 }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written[0].data.pages, 2);
  assertEquals(written[0].data.truncated, false);
});

Deno.test("fetchEvents refuses an epoch change mid-read and writes nothing", async () => {
  mockFetch([
    { status: 200, body: page([event(1)], "1@e1") },
    { status: 200, body: { ...page([event(2)], "2@e2"), epoch: "e2" } },
  ]);
  const { ctx, written } = context();
  try {
    const err = await assertRejects(
      () =>
        model.methods.fetchEvents.execute({ filters: [], maxPages: 5 }, ctx),
      SkiljApiError,
      "epoch_changed",
    );
    assertEquals(err.status, 409);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.length, 0);
});

Deno.test("consumeEvents serves a manual batch and records it", async () => {
  const calls = mockFetch([{
    status: 200,
    body: {
      ...page([event(1), event(2)], null),
      epoch: "e9",
    },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.consumeEvents.execute(
      { filters: ["amount:greater_than:0"], mode: "manual" },
      ctx,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(
    calls[0].url,
    "https://skilj.example.com/api/v1/events/consume?filter=amount%3Agreater_than%3A0&mode=manual",
  );
  assertEquals(written[0].spec, "consumedEvents");
  assertEquals(written[0].data, {
    eventTypeName: "Withdrawn",
    eventTypeSchema: "{}",
    eventTypeSchemaVersion: 1,
    epoch: "e9",
    mode: "manual",
    events: written[0].data.events,
    count: 2,
  });
});

Deno.test("consumeEvents rejects a mode mismatch with its code", async () => {
  mockFetch([{
    status: 400,
    body: { code: "cursor_ack_mode_mismatch", message: "mode differs" },
  }]);
  const { ctx, written } = context();
  try {
    const err = await assertRejects(
      () =>
        model.methods.consumeEvents.execute({ filters: [], mode: "auto" }, ctx),
      SkiljApiError,
    );
    assertEquals(err.code, "cursor_ack_mode_mismatch");
    assertEquals(err.status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.length, 0);
});

Deno.test("acknowledgeEvents posts the sequence and epoch, then records it", async () => {
  const calls = mockFetch([{ status: 200, body: {} }]);
  const { ctx, written } = context();
  try {
    await model.methods.acknowledgeEvents.execute(
      { sequence: 7, epoch: "e9" },
      ctx,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(
    calls[0].url,
    "https://skilj.example.com/api/v1/events/consume/ack",
  );
  assertEquals(calls[0].body, { sequence: 7, epoch: "e9" });
  assertEquals(written[0].spec, "ack");
  assertEquals(written[0].data, { sequence: 7, epoch: "e9" });
});

Deno.test("acknowledgeEvents refuses a regressing ack and writes nothing", async () => {
  mockFetch([{
    status: 409,
    body: { code: "acknowledgement_regresses", message: "backwards" },
  }]);
  const { ctx, written } = context();
  try {
    const err = await assertRejects(
      () => model.methods.acknowledgeEvents.execute({ sequence: 1 }, ctx),
      SkiljApiError,
    );
    assertEquals(err.code, "acknowledgement_regresses");
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.length, 0);
});

Deno.test("ingestExternalEvent records a watermark redelivery with a null sequence", async () => {
  const calls = mockFetch([{
    status: 200,
    body: { sequence: null, redelivered: true },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.ingestExternalEvent.execute({
      payload: { id: 1 },
      sourceContent: '{"id":1}',
      dedupe: { partitionKey: "p0", sequence: 4 },
    }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals((calls[0].body as Record<string, unknown>).dedupe, {
    partitionKey: "p0",
    sequence: 4,
  });
  assertEquals(written[0].data, {
    kind: "external",
    sequence: null,
    redelivered: true,
  });
});

Deno.test("ingestExternalEvent records a key-based redelivery with its sequence", async () => {
  const calls = mockFetch([{
    status: 200,
    body: { sequence: 11, redelivered: true },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.ingestExternalEvent.execute({
      payload: { id: 2 },
      sourceContent: '{"id":2}',
      idempotencyKey: "msg-2",
    }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(calls[0].headers.get("Idempotency-Key"), "msg-2");
  assertEquals(written[0].data, {
    kind: "external",
    sequence: 11,
    redelivered: true,
  });
});

Deno.test("a network failure names the route", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("connection refused"));
  const { ctx, written } = context();
  try {
    await assertRejects(
      () => model.methods.createDirectEvent.execute({ payload: {} }, ctx),
      Error,
      "SkilJ POST /api/v1/events/direct could not be reached: TypeError: connection refused",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.length, 0);
});

Deno.test("createDirectEvent records the stored sequence", async () => {
  const calls = mockFetch([{ status: 200, body: { sequence: 42 } }]);
  const { ctx, written } = context();
  try {
    await model.methods.createDirectEvent.execute(
      { payload: { a: 1 }, correlationId: "c9" },
      ctx,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(calls[0].body, { payload: { a: 1 }, correlationId: "c9" });
  assertEquals(written[0].data, {
    kind: "direct",
    sequence: 42,
    redelivered: false,
  });
});

Deno.test("reportParkedDelivery stores the id and refuses dedupe plus key", async () => {
  const calls = mockFetch([{ status: 201, body: { id: "pd-1" } }]);
  const { ctx, written } = context();
  try {
    await model.methods.reportParkedDelivery.execute({
      source: "kafka-inbound",
      kind: "command_trigger",
      identifier: "orders:0:41",
      error: "decide() timed out",
      attemptCount: 5,
      firstFailedAt: "2026-10-14T00:00:00Z",
      request: { payload: { wallet_id: "w1" } },
      idempotencyKey: "k-parked",
    }, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(
    calls[0].url,
    "https://skilj.example.com/api/v1/parked-deliveries",
  );
  assertEquals(
    (calls[0].body as Record<string, unknown>).idempotencyKey,
    "k-parked",
  );
  assertEquals(written[0].spec, "parkedDelivery");
  assertEquals(written[0].data, {
    id: "pd-1",
    kind: "command_trigger",
    source: "kafka-inbound",
    identifier: "orders:0:41",
  });

  const { ctx: ctx2, written: written2 } = context();
  const err = await assertRejects(
    () =>
      model.methods.reportParkedDelivery.execute({
        source: "kafka-inbound",
        kind: "external_event",
        identifier: "orders:0:42",
        error: "downstream full",
        attemptCount: 3,
        firstFailedAt: "2026-10-14T00:00:00Z",
        request: {
          payload: { id: 3 },
          dedupe: { partitionKey: "p0", sequence: 3 },
        },
        idempotencyKey: "k-both",
      }, ctx2),
    Error,
    "dedupe_and_idempotency_key",
  );
  assertStringIncludes(err.message, "watermark dedupe cursor");
  assertEquals(written2.length, 0);
  assert(calls.length === 1, "refused delivery must not reach the server");
});

Deno.test("triggerCommand preserves approval proposals as a distinct outcome", async () => {
  mockFetch([{
    status: 200,
    body: {
      accepted: false,
      pendingApproval: true,
      proposalId: "p1",
      deduplicated: false,
    },
  }]);
  const { ctx, written } = context();
  try {
    await model.methods.triggerCommand.execute({ payload: {} }, ctx);
    assertEquals(written[0].data.pendingApproval, true);
    assertEquals(written[0].data.proposalId, "p1");
    assertEquals(written[0].data.rejectionReason, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("fetchEvents carries as-of bound and correlation across pages", async () => {
  const calls = mockFetch([
    { status: 200, body: page([event(1)], "1@e1") },
    { status: 200, body: page([], "1@e1") },
  ]);
  const { ctx } = context();
  try {
    await model.methods.fetchEvents.execute({
      filters: [],
      maxPages: 2,
      upToSequence: 10,
      correlationId: "order & 1",
    }, ctx);
    for (const call of calls) {
      const params = new URL(call.url).searchParams;
      assertEquals(params.get("upToSequence"), "10");
      assertEquals(params.get("correlationId"), "order & 1");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("fetchEvents reports a terminal cursor without false truncation", async () => {
  mockFetch([{ status: 200, body: page([event(1)], null) }]);
  const { ctx, written } = context();
  try {
    await model.methods.fetchEvents.execute({
      filters: [],
      maxPages: 1,
      after: "0@e1",
    }, ctx);
    assertEquals(written[0].data.truncated, false);
    assertEquals(written[0].data.nextCursor, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("fetchEvents refuses a stuck cursor without duplicating pages", async () => {
  const calls = mockFetch([{ status: 200, body: page([event(1)], "1@e1") }]);
  const { ctx, written } = context();
  try {
    await assertRejects(
      () =>
        model.methods.fetchEvents.execute({
          filters: [],
          maxPages: 3,
          after: "1@e1",
        }, ctx),
      Error,
      "GET /v1/events",
    );
    assertEquals(calls.length, 1);
    assertEquals(written.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("consumeEvents never retries an ambiguous failure in any mode", async () => {
  for (const mode of ["auto", "manual", undefined] as const) {
    const calls = mockFetch([{
      status: 503,
      body: { code: "busy", message: "busy" },
    }]);
    const { ctx } = context();
    ctx.globalArgs.maxRetries = 2;
    try {
      await assertRejects(
        () => model.methods.consumeEvents.execute({ filters: [], mode }, ctx),
        SkiljApiError,
      );
      assertEquals(calls.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("searchUsedTags encodes literal prefixes and preserves null values", async () => {
  const tags = [{ key: "account", value: null }, {
    key: "account",
    value: "a&b",
  }];
  const calls = mockFetch([{ status: 200, body: { tags } }]);
  const { ctx, written } = context();
  try {
    await model.methods.searchUsedTags.execute({
      key: "account",
      prefix: "a&",
      limit: 20,
    }, ctx);
    assertEquals(new URL(calls[0].url).searchParams.get("prefix"), "a&");
    assertEquals(written[0].data.tags, tags);
    assertEquals(written[0].data.count, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("triggerCommands preserves ordered acceptance, rejection, approval and errors", async () => {
  const calls = mockFetch([{
    status: 200,
    body: {
      outcomes: [
        { accepted: true, triggeredEventSequences: [1], deduplicated: false },
        {
          accepted: false,
          rejectionKind: "insufficient_funds",
          rejectionReason: "low balance",
        },
        { accepted: false, pendingApproval: true, proposalId: "p1" },
        { error: { status: 409, code: "not_processed", message: "Stopped" } },
      ],
    },
  }]);
  const { ctx, written } = context();
  const commands = Array.from(
    { length: 4 },
    (_, index) => ({ payload: { index }, idempotencyKey: `k${index}` }),
  );
  try {
    await model.methods.triggerCommands.execute({
      commands,
      stopAtFirstFailure: true,
    }, ctx);
    assertEquals(calls[0].body, { commands, stopAtFirstFailure: true });
    assertEquals(calls[0].headers.get("Idempotency-Key"), null);
    assertEquals([
      written[0].data.accepted,
      written[0].data.rejected,
      written[0].data.pending,
      written[0].data.failed,
    ], [1, 1, 1, 1]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("batch command retries require a key on every item", async () => {
  for (const protectedBatch of [false, true]) {
    const calls = mockFetch([
      { status: 503, body: { code: "busy", message: "busy" } },
      {
        status: 200,
        body: { outcomes: [{ accepted: true }, { accepted: true }] },
      },
    ]);
    const { ctx } = context();
    ctx.globalArgs.maxRetries = 1;
    const args = {
      commands: [{ payload: {}, idempotencyKey: "k1" }, {
        payload: {},
        idempotencyKey: protectedBatch ? "k2" : undefined,
      }],
      stopAtFirstFailure: false,
    };
    try {
      if (protectedBatch) {
        await model.methods.triggerCommands.execute(args, ctx);
      } else {await assertRejects(() =>
          model.methods.triggerCommands.execute(args, ctx), SkiljApiError);}
      assertEquals(calls.length, protectedBatch ? 2 : 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("batch external-event retries require protection on every event", async () => {
  for (const protectedBatch of [false, true]) {
    const calls = mockFetch([
      { status: 503, body: { code: "busy", message: "busy" } },
      {
        status: 200,
        body: {
          outcomes: [{ sequence: 1, redelivered: true }, {
            sequence: null,
            redelivered: true,
          }],
        },
      },
    ]);
    const { ctx, written } = context();
    ctx.globalArgs.maxRetries = 1;
    const args = {
      events: [
        { payload: {}, sourceContent: "a", idempotencyKey: "k1" },
        {
          payload: {},
          sourceContent: "b",
          dedupe: protectedBatch
            ? { partitionKey: "p", sequence: 2 }
            : undefined,
        },
      ],
      stopAtFirstFailure: true,
    };
    try {
      if (protectedBatch) {
        await model.methods.ingestExternalEvents.execute(args, ctx);
        assertEquals(written[0].data.redelivered, 2);
        assertEquals(written[0].data.stored, 0);
      } else {await assertRejects(
          () => model.methods.ingestExternalEvents.execute(args, ctx),
          SkiljApiError,
        );}
      assertEquals(calls.length, protectedBatch ? 2 : 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("diagnostics log metadata without request values and forward trace headers", async () => {
  const calls = mockFetch([{ status: 200, body: page([], null) }]);
  const { ctx } = context();
  const logs: unknown[] = [];
  ctx.globalArgs.debug = true;
  ctx.globalArgs.traceparent =
    "00-12345678901234567890123456789012-1234567890123456-01";
  ctx.globalArgs.tracestate = "vendor=value";
  ctx.logger.info = (message, props) => {
    logs.push({ message, props });
  };
  try {
    await model.methods.fetchEvents.execute({
      filters: ["name:equals:private-value"],
      maxPages: 1,
      correlationId: "private-correlation",
    }, ctx);
    assertEquals(
      calls[0].headers.get("traceparent"),
      ctx.globalArgs.traceparent,
    );
    assertEquals(calls[0].headers.get("tracestate"), "vendor=value");
    const text = JSON.stringify(logs);
    assertStringIncludes(text, '"status":200');
    assertStringIncludes(text, '"attempt":1');
    for (
      const secret of [
        "tok.secret",
        "private-value",
        "private-correlation",
        "vendor=value",
      ]
    ) assert(!text.includes(secret));
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("response body failures retain route context and respect retry safety", async () => {
  for (const safe of [false, true]) {
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("connection lost reading body"));
              },
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ accepted: true })));
    };
    const { ctx } = context();
    ctx.globalArgs.maxRetries = 1;
    try {
      if (safe) await model.methods.dryRunCommand.execute({ payload: {} }, ctx);
      else {await assertRejects(
          () => model.methods.triggerCommand.execute({ payload: {} }, ctx),
          Error,
          "POST /api/v1/commands/trigger",
        );}
      assertEquals(calls, safe ? 2 : 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("HTTP requests inherit Swamp trace headers and allow explicit parent overrides", async () => {
  const calls = mockFetch([
    { status: 200, body: { accepted: true } },
    { status: 200, body: { accepted: true } },
  ]);
  const { ctx } = context();
  ctx.traceHeaders = {
    traceparent: "inherited-parent",
    tracestate: "inherited-state",
    Authorization: "should-not-forward",
  };
  try {
    await model.methods.dryRunCommand.execute({ payload: {} }, ctx);
    assertEquals(calls[0].headers.get("traceparent"), "inherited-parent");
    assertEquals(calls[0].headers.get("tracestate"), "inherited-state");
    assertEquals(calls[0].headers.get("Authorization"), "Bearer tok.secret");
    ctx.globalArgs.traceparent = "explicit-parent";
    await model.methods.dryRunCommand.execute({ payload: {} }, ctx);
    assertEquals(calls[1].headers.get("traceparent"), "explicit-parent");
    assertEquals(calls[1].headers.get("tracestate"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("safe retries honor Retry-After zero and refuse excessive server waits", async () => {
  for (
    const retryAfter of [
      "0",
      "120",
      new Date(Date.now() + 120000).toUTCString(),
    ]
  ) {
    const calls = mockFetch([
      {
        status: 429,
        body: { code: "limited", message: "Slow down" },
        headers: { "Retry-After": retryAfter },
      },
      { status: 200, body: { accepted: true } },
    ]);
    const { ctx } = context();
    ctx.globalArgs.maxRetries = 1;
    try {
      if (retryAfter === "0") {
        await model.methods.dryRunCommand.execute({ payload: {} }, ctx);
      } else {await assertRejects(
          () => model.methods.dryRunCommand.execute({ payload: {} }, ctx),
          SkiljApiError,
        );}
      assertEquals(calls.length, retryAfter === "0" ? 2 : 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("cancellation before a request avoids network activity", async () => {
  const calls = mockFetch([]);
  const { ctx } = context();
  ctx.signal = AbortSignal.abort(new Error("Cancelled by operator"));
  try {
    await assertRejects(
      () => model.methods.dryRunCommand.execute({ payload: {} }, ctx),
      Error,
      "Cancelled by operator",
    );
    assertEquals(calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("cancellation during backoff stops immediately without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    // Abort once the response has been processed and the backoff is pending.
    setTimeout(
      () => controller.abort(new Error("Cancelled during backoff")),
      10,
    );
    return Promise.resolve(
      new Response(JSON.stringify({ code: "busy", message: "busy" }), {
        status: 503,
      }),
    );
  };
  const { ctx } = context();
  ctx.signal = controller.signal;
  ctx.globalArgs.maxRetries = 2;
  try {
    await assertRejects(
      () => model.methods.dryRunCommand.execute({ payload: {} }, ctx),
      Error,
      "Cancelled during backoff",
    );
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("malformed event envelopes fail instead of masquerading as empty history", async () => {
  for (const method of ["fetchEvents", "consumeEvents"] as const) {
    for (
      const body of [
        { ...page([], null), events: undefined },
        { ...page([], null), events: "not-an-array" },
        { ...page([], null), epoch: undefined },
        { ...page([], null), eventTypeName: undefined },
      ]
    ) {
      mockFetch([{ status: 200, body }]);
      const { ctx, written } = context();
      try {
        if (method === "fetchEvents") {
          await assertRejects(() =>
            model.methods.fetchEvents.execute({ filters: [], maxPages: 1 }, ctx)
          );
        } else {await assertRejects(() =>
            model.methods.consumeEvents.execute(
              { filters: [], mode: "manual" },
              ctx,
            )
          );}
        assertEquals(written.length, 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  }
});

Deno.test("event cursors reject regression, wrong epochs and cycles", async () => {
  for (
    const responses of [
      [{ status: 200, body: page([event(2)], "1@e1") }],
      [{ status: 200, body: page([event(2)], "2@e2") }],
      [
        { status: 200, body: page([event(2)], "2@e1") },
        { status: 200, body: page([event(3)], "3@e1") },
        { status: 200, body: page([event(4)], "2@e1") },
      ],
    ]
  ) {
    mockFetch(responses);
    const { ctx, written } = context();
    try {
      await assertRejects(() =>
        model.methods.fetchEvents.execute({ filters: [], maxPages: 5 }, ctx)
      );
      assertEquals(written.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("duplicate, out-of-order, missing and unsafe event sequences cannot be persisted or acknowledged", async () => {
  for (
    const events of [
      [event(2), event(2)],
      [event(3), event(2)],
      [event(Number.MAX_SAFE_INTEGER + 1)],
      [{ ...event(2), sequence: undefined }],
      [{ ...event(2), payload: undefined }],
    ]
  ) {
    mockFetch([{ status: 200, body: page(events, "4@e1") }]);
    const { ctx, written } = context();
    try {
      await assertRejects(() =>
        model.methods.fetchEvents.execute({ filters: [], maxPages: 1 }, ctx)
      );
      assertEquals(written.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

Deno.test("private POST bodies are never followed through HTTP redirects", async () => {
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls++;
    assertEquals(init?.redirect, "manual");
    return Promise.resolve(
      new Response("Moved", {
        status: 307,
        headers: { Location: "https://other.example.com/collect" },
      }),
    );
  };
  const { ctx, written } = context();
  try {
    await assertRejects(
      () =>
        model.methods.createDirectEvent.execute({
          payload: { confidential: "value" },
        }, ctx),
      SkiljApiError,
      "HTTP 307",
    );
    assertEquals(calls, 1);
    assertEquals(written.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("manual consume refuses duplicate served sequences before exposing a batch for acknowledgement", async () => {
  const calls = mockFetch([{
    status: 200,
    body: page([event(2), event(2)], null),
  }]);
  const { ctx, written } = context();
  try {
    await assertRejects(
      () =>
        model.methods.consumeEvents.execute(
          { filters: [], mode: "manual" },
          ctx,
        ),
      Error,
      "duplicate or unordered",
    );
    assertEquals(written.length, 0);
    assertEquals(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
