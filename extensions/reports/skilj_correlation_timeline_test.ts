import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { report } from "./skilj_correlation_timeline.ts";

const secret = "PRIVATE_PAYLOAD_SECRET_SENTINEL";
const event = (sequence = 7, correlationId: string | null = "c1") => ({
  sequence,
  eventType: "Withdrawn",
  payload: secret,
  tags: [secret],
  metadata: { correlationId, causationId: "command-1", clientId: secret },
});
const capture = (events = [event()], epoch: string | null = "e1") => ({
  epoch,
  eventTypeName: "Withdrawn",
  events,
  truncated: false,
  credential: secret,
});
type Fixture = {
  model: string;
  artifact: string;
  version: number;
  spec: string;
  data: unknown;
};
const source = (model: string, artifact = "events", version = 1) => ({
  model,
  artifact,
  version,
});

function context(fixtures: Fixture[], overrides: Record<string, unknown> = {}) {
  const reads: unknown[][] = [];
  return {
    reads,
    ctx: {
      executionStatus: "succeeded",
      methodArgs: {
        correlationId: "c1",
        sources: fixtures.map(({ model, artifact, version }) =>
          source(model, artifact, version)
        ),
        ...overrides,
      },
      definitionRepository: {
        findByNameGlobal: (name: string) =>
          Promise.resolve(
            name === "missing-model" ? null : {
              definition: { id: name },
              type: { normalized: "@gklijs/skilj" },
            },
          ),
      },
      dataRepository: {
        findByName: (
          _type: string,
          id: string,
          name: string,
          version: number,
        ) => {
          const f = fixtures.find((f) =>
            f.model === id && f.artifact === name && f.version === version
          );
          return Promise.resolve(
            f ? { version, tags: { specName: f.spec } } : null,
          );
        },
        getContent: (
          type: string,
          id: string,
          name: string,
          version: number,
        ) => {
          reads.push([type, id, name, version]);
          const f = fixtures.find((f) =>
            f.model === id && f.artifact === name && f.version === version
          );
          return Promise.resolve(
            f ? new TextEncoder().encode(JSON.stringify(f.data)) : null,
          );
        },
      },
    },
  };
}
const fixture = (
  model: string,
  data: unknown = capture(),
  version = 1,
  spec = "events",
  artifact = "events",
): Fixture => ({ model, data, version, spec, artifact });

Deno.test("timeline reports accepted/rejected/pending commands and matching metadata without private content", async () => {
  const fixtures = [true, false, false].map((accepted, i) =>
    fixture(
      "command",
      {
        accepted,
        pendingApproval: i === 2,
        dryRun: i === 1,
        correlationId: "c1",
        triggeredEventSequences: accepted ? [7] : [],
        rejectionReason: secret,
      },
      i + 1,
      "commandResult",
      "trigger",
    )
  );
  fixtures.push(
    fixture("reader", capture([event(), event(8, "other"), event(9, null)])),
  );
  const { ctx } = context(fixtures);
  const result = await report.execute(ctx);
  assertEquals(result.json.commands?.map((c) => c.status), [
    "accepted",
    "rejected",
    "pending",
  ]);
  assertEquals(result.json.lanes?.[0].events.length, 1);
  assertEquals(result.json.sources?.[3].missingCorrelationIds, 1);
  assertEquals(result.json.sources?.[3].unrelatedRows, 1);
  assert(result.json.incomplete);
  assert(!JSON.stringify(result).includes(secret));
  assertStringIncludes(result.markdown, "causation command-1");
  assertStringIncludes(result.markdown, "Command results have no stream epoch");
  assertEquals(result, await report.execute(ctx));
});

Deno.test("duplicate captures retain pointers while equal sequences in different models/epochs stay separate", async () => {
  const { ctx, reads } = context([
    fixture("a", capture([event(8), event(7)])),
    fixture("a", capture(), 2, "consumedEvents", "consume"),
    fixture("a", capture([event()], "e2"), 3),
    fixture("b"),
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.json.lanes?.length, 3);
  assertEquals(result.json.lanes?.[0].events.map((e) => e.sequence), [7, 8]);
  assertEquals(result.json.lanes?.[0].events[0].sources, [0, 1]);
  assertEquals(result.json.sources?.[1].version, 2);
  assertEquals(reads[1], ["@gklijs/skilj", "a", "consume", 2]);
  assertStringIncludes(result.json.sources?.[1].pointer ?? "", "--version 2");
});

Deno.test("artifact and inspected-row caps bound reads including unrelated rows", async () => {
  const { ctx, reads } = context([
    fixture("a", capture([event(1, "other"), event(2)])),
    fixture("b"),
    fixture("c"),
  ], { maxArtifacts: 2, maxRows: 1 });
  const result = await report.execute(ctx);
  assertEquals(reads.length, 1);
  assertEquals(result.json.sources?.length, 2);
  assertStringIncludes(result.markdown, "artifact cap reached");
  assertStringIncludes(result.markdown, "captured rows omitted");
  assertStringIncludes(result.markdown, "artifact not read");
  assertStringIncludes(
    result.markdown,
    "absence does not establish command failure",
  );
});

Deno.test("missing, unsupported, truncated and invalid captures carry explicit gap markers", async () => {
  const { ctx } = context([
    fixture("truncated", { ...capture(), truncated: true }),
    fixture("unsupported", { credential: secret }, 1, "accessToken"),
    fixture("invalid", { events: null }),
    fixture("no-epoch", capture([event()], null)),
  ], {
    sources: [
      source("missing-model"),
      source("a", "absent"),
      source("truncated"),
      source("unsupported"),
      source("invalid"),
      source("no-epoch"),
    ],
  });
  const result = await report.execute(ctx);
  for (
    const warning of [
      "source model unavailable",
      "artifact version unavailable",
      "captured input truncated",
      "unsupported artifact spec",
      "invalid event envelope",
      "epoch missing",
    ]
  ) assertStringIncludes(result.markdown, warning);
  assert(!JSON.stringify(result).includes(secret));
});

Deno.test("malformed repository content and errors never echo private messages", async () => {
  const { ctx } = context([fixture("a")]);
  ctx.dataRepository.getContent = () => {
    throw new Error(secret);
  };
  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "artifact unavailable or invalid JSON");
  assert(!JSON.stringify(result).includes(secret));
});

Deno.test("oversized artifacts and unsafe event sequences are refused", async () => {
  const { ctx } = context([
    fixture("big", { ...capture(), payload: "x".repeat(2 * 1024 * 1024) }),
    fixture("unsafe", capture([event(Number.MAX_SAFE_INTEGER + 1)])),
  ]);
  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "2 MiB content cap");
  assertStringIncludes(result.markdown, "invalid event metadata");
  assertEquals(result.json.lanes?.length, 0);
});

Deno.test("invalid report selections return a safe incomplete marker", async () => {
  const { ctx } = context([], { correlationId: "" });
  assert((await report.execute(ctx)).json.incomplete);
});

Deno.test("unknown stream identity prevents deduplication and known metadata conflicts remain visible", async () => {
  const { ctx } = context([
    fixture("unknown", capture([event(), event()], null)),
    fixture("unknown", capture([event()], null), 2),
    fixture(
      "known",
      capture([event(), {
        ...event(),
        metadata: { ...event().metadata, causationId: "another-command" },
      }]),
    ),
  ]);
  const result = await report.execute(ctx);
  assertEquals(result.json.lanes?.map((l) => l.events.length), [2, 1, 2]);
  assertStringIncludes(
    result.markdown,
    "conflicting metadata at the same stream sequence",
  );
});

Deno.test("investigation performs no network calls and rejects other model types", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("network forbidden");
  };
  try {
    const { ctx } = context([fixture("a")]);
    await report.execute(ctx);
    ctx.definitionRepository.findByNameGlobal = () =>
      Promise.resolve({
        definition: { id: "a" },
        type: { normalized: "@gklijs/skilj-graphql" },
      });
    const result = await report.execute(ctx);
    assertStringIncludes(result.markdown, "source model unavailable");
    assertEquals(result.json.lanes?.length, 0);
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
