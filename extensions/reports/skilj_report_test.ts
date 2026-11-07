import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { report } from "./skilj_report.ts";

function context(overrides: Record<string, unknown> = {}) {
  const logged: string[] = [];
  return {
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
    dataRepository: repoWith({
      kind: "direct",
      sequence: 42,
      redelivered: false,
    }),
  });
  assertStringIncludes((await report.execute(stored)).markdown, "#42");

  const { ctx: redelivered } = context({
    methodName: "ingestExternalEvent",
    dataHandles: [{ name: "external", specName: "eventWrite", version: 1 }],
    dataRepository: repoWith({
      kind: "external",
      sequence: null,
      redelivered: true,
    }),
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

Deno.test("pending approval is not described as a rejection", async () => {
  const { ctx } = context({
    dataHandles: [{ name: "trigger", specName: "commandResult", version: 1 }],
    dataRepository: repoWith({
      accepted: false,
      pendingApproval: true,
      proposalId: "p1",
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "Awaiting approval");
  assertStringIncludes(out.markdown, "p1");
  assert(!out.markdown.includes("Rejected"));
});

Deno.test("batch report exposes per-item failures and pending counts", async () => {
  const { ctx } = context({
    methodName: "triggerCommands",
    dataHandles: [{ name: "commands", specName: "batchCommands", version: 1 }],
    dataRepository: repoWith({
      count: 2,
      accepted: 0,
      rejected: 0,
      pending: 1,
      failed: 1,
      outcomes: [
        { accepted: false, pendingApproval: true, proposalId: "p1" },
        { error: { status: 409, code: "not_processed", message: "Stopped" } },
      ],
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "1 awaiting approval");
  assertStringIncludes(out.markdown, "not_processed");
});

Deno.test("GraphQL report summarizes errors without exposing data or credentials", async () => {
  for (const methodName of ["execute", "debugCommand", "createAccessToken"]) {
    const { ctx } = context({
      modelType: "@gklijs/skilj-graphql",
      methodName,
      dataHandles: [{ name: "graphql", specName: "graphqlResult", version: 1 }],
      dataRepository: repoWith({
        succeeded: false,
        errorCount: 1,
        kind: "command",
        id: "t1",
        credential: "secret-value",
        data: { secret: "secret-value" },
        errors: [{ message: "secret-value" }],
      }),
    });
    const out = await report.execute(ctx);
    assert(!out.markdown.includes("secret-value"));
    assert(!JSON.stringify(out.json).includes("secret-value"));
    if (methodName !== "createAccessToken") {
      assertStringIncludes(out.markdown, "1 error(s)");
    }
  }
});

Deno.test("GraphQL debug report distinguishes rejection and capped matching history", async () => {
  const { ctx } = context({
    modelType: "@gklijs/skilj-graphql",
    methodName: "debugCommand",
    dataHandles: [{ name: "debug", specName: "graphqlResult", version: 1 }],
    dataRepository: repoWith({
      succeeded: true,
      errorCount: 0,
      commandSummary: {
        accepted: false,
        wouldBeEventCount: 0,
        matchingEventCount: 25,
        matchingEventsTruncated: true,
      },
      data: { private: "do-not-display" },
    }),
  });
  const out = await report.execute(ctx);
  assertStringIncludes(out.markdown, "Dry run rejected");
  assertStringIncludes(out.markdown, "25 matching event(s)");
  assertStringIncludes(out.markdown, "history truncated");
  assert(!out.markdown.includes("do-not-display"));
});

Deno.test("GraphQL schema export report works without a resource payload", async () => {
  const { ctx } = context({
    modelType: "@gklijs/skilj-graphql",
    methodName: "exportSchema",
    dataHandles: [{
      name: "schema.json",
      specName: "schemaExport",
      version: 1,
    }],
  });
  assertStringIncludes(
    (await report.execute(ctx)).markdown,
    "Exported GraphQL introspection JSON",
  );
});

Deno.test("operation validation report keeps private variable diagnostics out of summaries", async () => {
  const { ctx } = context({
    modelType: "@gklijs/skilj-graphql",
    methodName: "validateOperation",
    dataHandles: [{
      name: "validation",
      specName: "operationValidation",
      version: 1,
    }],
    dataRepository: repoWith({
      valid: false,
      errorCount: 1,
      errors: [{ message: "private-variable-value" }],
    }),
  });
  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "is invalid");
  assertStringIncludes(result.markdown, "No operation executed");
  assert(!result.markdown.includes("private-variable-value"));
});

Deno.test("schema and approval reports expose outcomes while withholding private details", async () => {
  const cases = [
    ["compareSchema", {
      changed: true,
      compatible: false,
      breakingCount: 2,
      dangerousCount: 1,
      breakingChanges: [{ description: "private-detail" }],
    }, "2 breaking"],
    ["listCommandProposals", {
      count: 3,
      pages: 1,
      truncated: true,
      payload: "private-detail",
    }, "truncated"],
    ["approveCommand", {
      proposalId: "p1",
      accepted: false,
      triggeredEventSequences: [],
      rejectionReason: "private-detail",
    }, "rejected by domain rules"],
    ["rejectCommand", {
      proposalId: "p1",
      accepted: false,
      rejectionReason: "private-detail",
    }, "no command executed"],
  ] as const;
  for (const [methodName, data, expected] of cases) {
    const { ctx } = context({
      modelType: "@gklijs/skilj-graphql",
      methodName,
      dataHandles: [{ name: "result", specName: "result", version: 1 }],
      dataRepository: repoWith(data),
    });
    const out = await report.execute(ctx);
    assertStringIncludes(out.markdown, expected);
    assert(!out.markdown.includes("private-detail"));
  }
});
