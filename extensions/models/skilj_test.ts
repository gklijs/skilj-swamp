import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
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
