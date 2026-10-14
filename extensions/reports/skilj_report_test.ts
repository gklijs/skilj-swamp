import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { report } from "./skilj_report.ts";

function context(overrides: Record<string, unknown> = {}) {
  const logged: string[] = [];
  return {
    // deno-lint-ignore no-explicit-any
    ctx: {
      modelType: "@gklijs/skilj",
      modelId: "withdraw",
      definition: { name: "withdraw" },
      methodName: "triggerCommand",
      methodArgs: {},
      executionStatus: "succeeded",
      dataHandles: [],
      dataRepository: {
        getContent: () => Promise.resolve(null),
      },
      logger: { info: (msg: string) => logged.push(msg) },
      ...overrides,
    } as never,
    logged,
  };
}

function repoWith(data: unknown) {
  return {
    getContent: () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(data)),
      ),
  };
}

Deno.test("triggerCommand acceptance names the stored sequences", async () => {
  const { ctx } = context({
    dataHandles: [{ name: "trigger", specName: "commandResult", version: 1 }],
    dataRepository: repoWith({
      dryRun: false,
      accepted: true,
      triggeredEventSequences: [7, 8],
      rejectionReason: null,
      rejectionKind: null,
      deduplicated: false,
      correlationId: "c1",
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "Accepted");
  assertStringIncludes(out.markdown, "7, 8");
  assertStringIncludes(out.markdown, "swamp data get withdraw trigger");
  assertEquals(out.json.method, "triggerCommand");
});

Deno.test("dryRunCommand rejection is a dry run, not a failure", async () => {
  const { ctx } = context({
    methodName: "dryRunCommand",
    dataHandles: [{ name: "dryRun", specName: "commandResult", version: 1 }],
    dataRepository: repoWith({
      dryRun: true,
      accepted: false,
      triggeredEventSequences: [],
      rejectionReason: "insufficient funds",
      rejectionKind: "insufficient_funds",
      deduplicated: false,
      correlationId: null,
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "Dry run (nothing stored)");
  assertStringIncludes(out.markdown, "insufficient_funds");
});

Deno.test("fetchEvents lists the served events and truncation", async () => {
  const { ctx } = context({
    methodName: "fetchEvents",
    dataHandles: [{ name: "events", specName: "events", version: 1 }],
    dataRepository: repoWith({
      eventTypeName: "Withdrawn",
      eventTypeSchema: "{}",
      eventTypeSchemaVersion: 1,
      epoch: "e1",
      events: [
        { sequence: 1, eventType: "Withdrawn" },
        { sequence: 2, eventType: "Withdrawn" },
      ],
      nextCursor: "2@e1",
      pages: 1,
      truncated: true,
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "2 event(s)");
  assertStringIncludes(out.markdown, "#1 `Withdrawn`");
  assertStringIncludes(out.markdown, "truncated");
});

Deno.test("consumeEvents points at acknowledgeEvents for manual mode", async () => {
  const { ctx } = context({
    methodName: "consumeEvents",
    methodArgs: { mode: "manual" },
    dataHandles: [{ name: "consume", specName: "consumedEvents", version: 1 }],
    dataRepository: repoWith({
      eventTypeName: "Withdrawn",
      eventTypeSchema: "{}",
      eventTypeSchemaVersion: 1,
      epoch: "e9",
      mode: "manual",
      events: [{ sequence: 3, eventType: "Withdrawn" }],
      count: 1,
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "acknowledgeEvents");
  assertStringIncludes(out.markdown, "`manual` mode");
});

Deno.test("acknowledgeEvents names the sequence and epoch", async () => {
  const { ctx } = context({
    methodName: "acknowledgeEvents",
    dataHandles: [{ name: "ack", specName: "ack", version: 1 }],
    dataRepository: repoWith({ sequence: 7, epoch: "e9" }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "#7");
  assertStringIncludes(out.markdown, "e9");
});

Deno.test("event writes distinguish stored from redelivered", async () => {
  const { ctx: stored } = context({
    methodName: "createDirectEvent",
    dataHandles: [{ name: "direct", specName: "eventWrite", version: 1 }],
    dataRepository: repoWith({ kind: "direct", sequence: 42, redelivered: false }),
  });
  assertStringIncludes((await report.execute(stored)).markdown, "#42");

  const { ctx: redelivered } = context({
    methodName: "ingestExternalEvent",
    dataHandles: [{ name: "external", specName: "eventWrite", version: 1 }],
    dataRepository: repoWith({ kind: "external", sequence: null, redelivered: true }),
  });
  assertStringIncludes(
    (await report.execute(redelivered)).markdown,
    "watermark hit",
  );
});

Deno.test("reportParkedDelivery names the stored delivery", async () => {
  const { ctx } = context({
    methodName: "reportParkedDelivery",
    dataHandles: [{ name: "parked", specName: "parkedDelivery", version: 1 }],
    dataRepository: repoWith({
      id: "pd-1",
      kind: "command_trigger",
      source: "kafka-inbound",
      identifier: "orders:0:41",
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "pd-1");
  assertStringIncludes(out.markdown, "kafka-inbound");
});

Deno.test("a failed method points at the failure summary, not data", async () => {
  const { ctx } = context({ executionStatus: "failed" });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "@swamp/method-summary");
  assertEquals(
    (out.json.artifacts as unknown[]).length,
    0,
    "no artifacts on failure",
  );
  assert(out.markdown.length > 0);
});
