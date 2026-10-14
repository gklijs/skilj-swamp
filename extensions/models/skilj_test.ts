import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model, SkiljApiError, type SkiljContext } from "./skilj.ts";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
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
      new Response(JSON.stringify(next.body), { status: next.status }),
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
      () =>
        model.methods.triggerCommand.execute({ payload: { a: 1 } }, ctx),
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
      () => model.methods.fetchEvents.execute({ filters: [], maxPages: 5 }, ctx),
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
      () => model.methods.consumeEvents.execute({ filters: [], mode: "auto" }, ctx),
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
