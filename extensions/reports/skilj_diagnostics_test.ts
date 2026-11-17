import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  model as rest,
  SkiljApiError,
  type SkiljContext,
} from "../models/skilj.ts";
import {
  type GraphqlContext,
  model as graphql,
} from "../models/skilj_graphql.ts";
import { diagnosticFromMessage } from "../lib/diagnostics.ts";
import { report } from "./skilj_report.ts";

const secret = "SENTINEL_PRIVATE_CREDENTIAL_PAYLOAD_REASON";

function harness() {
  const logs: unknown[] = [];
  const artifacts: {
    name: string;
    specName: string;
    version: number;
    data: Record<string, unknown>;
  }[] = [];
  const context: SkiljContext = {
    globalArgs: {
      baseUrl: "https://skilj.example/",
      token: secret,
      timeoutMs: 100,
      maxRetries: 1,
      debug: true,
    },
    logger: {
      info: (message, props) => logs.push({ message, props }),
      warning: (message, props) => logs.push({ message, props }),
    },
    writeResource(specName, name, data) {
      artifacts.push({ specName, name, version: 1, data });
      return Promise.resolve({ name });
    },
  };
  const graphqlContext: GraphqlContext = {
    ...context,
    globalArgs: {
      endpoint: "https://skilj.example/graphql",
      token: secret,
      timeoutMs: 100,
      debug: true,
    },
  };
  async function summarize(
    methodName: string,
    error?: Error,
    isGraphql = false,
  ) {
    const result = await report.execute({
      modelType: isGraphql ? "@gklijs/skilj-graphql" : "@gklijs/skilj",
      modelId: "test",
      definition: { name: "test" },
      methodName,
      methodArgs: { payload: secret },
      executionStatus: error ? "failed" : "succeeded",
      errorMessage: error?.message,
      dataHandles: artifacts,
      dataRepository: {
        getContent: (_type, _id, name) =>
          Promise.resolve(
            new TextEncoder().encode(JSON.stringify(
              artifacts.find((a) => a.name === name)?.data,
            )),
          ),
      },
      logger: context.logger,
    });
    assert(
      !JSON.stringify({ result, logs, message: error?.message }).includes(
        secret,
      ),
    );
    assertStringIncludes(result.markdown, "Troubleshooting");
    return result;
  }
  return { context, graphqlContext, artifacts, logs, summarize };
}

Deno.test("REST failure reports classify allowlisted pairs before any artifact exists", async () => {
  const original = globalThis.fetch;
  try {
    for (
      const [status, code, category] of [
        [401, "unrecognised_credential", "authentication"],
        [403, "wrong_token_variant", "wrong_capability"],
        [403, "event_read_not_allowed", "reads_disabled"],
        [403, "token_not_active", "authorization"],
        [409, "epoch_changed", "epoch_changed"],
        [429, secret, "rate_limit"],
        [503, secret, "unavailable"],
        [418, secret, "unknown"],
        [400, "wrong_token_variant", "unknown"],
        [403, "capability_not_held", "unknown"],
      ] as const
    ) {
      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(
          new Response(JSON.stringify({ code, message: secret }), { status }),
        );
      };
      const h = harness();
      const error = await assertRejects(
        () =>
          rest.methods.triggerCommand.execute(
            { payload: { secret } },
            h.context,
          ),
        SkiljApiError,
      );
      assertEquals(error.status, status);
      assertEquals(calls, 1);
      assertEquals(h.artifacts.length, 0);
      const result = await h.summarize("triggerCommand", error);
      const diagnostics = result.json.diagnostics as Record<string, unknown>[];
      assertEquals(diagnostics[0].category, category);
      assert(
        typeof diagnostics[0].nextStep === "string" &&
          diagnostics[0].nextStep.length > 20,
      );
      if (code === secret) assertEquals(diagnostics[0].code, null);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("timed out writes retain retry policy and original protection guidance", async () => {
  const original = globalThis.fetch;
  try {
    for (const protectedWrite of [false, true]) {
      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.reject(new DOMException(secret, "TimeoutError"));
      };
      const h = harness();
      const error = await assertRejects(
        () =>
          rest.methods.triggerCommand.execute({
            payload: { secret },
            ...(protectedWrite ? { idempotencyKey: secret } : {}),
          }, h.context),
        Error,
      );
      assertEquals(calls, protectedWrite ? 2 : 1);
      assertEquals(h.artifacts.length, 0);
      const result = await h.summarize("triggerCommand", error);
      const d = (result.json.diagnostics as Record<string, unknown>[])[0];
      assertEquals(d.category, "timeout");
      assertEquals(d.protected, protectedWrite);
      assertEquals(d.outcomeUncertain, true);
      assertStringIncludes(
        result.markdown,
        protectedWrite
          ? "Never generate a new key"
          : "no verified replay protection",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("malformed successful responses leave write outcomes uncertain", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(secret)));
  try {
    const h = harness();
    const error = await assertRejects(
      () =>
        rest.methods.triggerCommand.execute({ payload: { secret } }, h.context),
      SkiljApiError,
    );
    const result = await h.summarize("triggerCommand", error);
    assertEquals(h.artifacts.length, 0);
    const d = (result.json.diagnostics as Record<string, unknown>[])[0];
    assertEquals(d.category, "unknown");
    assertEquals(d.outcomeUncertain, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("lost consume response is never retried and reports an uncertain cursor", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.reject(new TypeError(secret));
  };
  try {
    const h = harness();
    const error = await assertRejects(
      () => rest.methods.consumeEvents.execute({ filters: [] }, h.context),
      Error,
    );
    const result = await h.summarize("consumeEvents", error);
    assertEquals(calls, 1);
    assertStringIncludes(result.markdown, "cursor may have advanced");
    assertEquals(
      (result.json.diagnostics as Record<string, unknown>[])[0].effect,
      "consume",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("GraphQL partial data keeps raw errors protected and publishes only safe codes", async () => {
  const original = globalThis.fetch;
  try {
    for (const document of ["query { secret }", "mutation { secret }"]) {
      let calls = 0;
      const errors = [
        {
          message: secret,
          path: [secret],
          extensions: { code: "jwt_verification_failed", private: secret },
        },
        { message: secret, extensions: { code: secret } },
      ];
      globalThis.fetch = () => {
        calls++;
        return Promise.resolve(
          new Response(JSON.stringify({ data: { private: secret }, errors })),
        );
      };
      const h = harness();
      await graphql.methods.execute.execute(
        { document, variables: { secret } },
        h.graphqlContext,
      );
      assertEquals(calls, 1);
      assertEquals(h.artifacts[0].data.succeeded, false);
      assertEquals(h.artifacts[0].data.errors, errors);
      assertEquals(h.artifacts[0].data.data, { private: secret });
      const result = await h.summarize("execute", undefined, true);
      const ds = result.json.diagnostics as Record<string, unknown>[];
      assertEquals(ds.map((d) => d.category), ["authentication", "unknown"]);
      assertEquals(ds[0].outcomeUncertain, document.startsWith("mutation"));
      assertStringIncludes(
        result.markdown,
        "decoded JWT claims alone do not prove validity",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("built-in GraphQL failure reports auth codes without normal artifacts", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          errors: [{
            message: secret,
            extensions: { code: "jwt_verification_failed", private: secret },
          }],
        }),
      ),
    );
  try {
    const h = harness();
    const error = await assertRejects(
      () => graphql.methods.introspect.execute({}, h.graphqlContext),
      Error,
    );
    assertEquals(h.artifacts.length, 0);
    const result = await h.summarize("introspect", error, true);
    assertEquals(
      (result.json.diagnostics as Record<string, unknown>[])[0].category,
      "authentication",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("business rejection and batch errors omit private text from reports and logs", async () => {
  const original = globalThis.fetch;
  try {
    const h = harness();
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            accepted: false,
            rejectionKind: secret,
            rejectionReason: secret,
          }),
        ),
      );
    await rest.methods.triggerCommand.execute(
      { payload: { secret } },
      h.context,
    );
    assertEquals(h.artifacts[0].data.rejectionReason, secret);
    const result = await h.summarize("triggerCommand");
    assertStringIncludes(result.markdown, "Rejected by domain rules");
    h.artifacts.length = 0;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            outcomes: [{
              error: {
                status: 403,
                code: "wrong_token_variant",
                message: secret,
              },
            }],
          }),
        ),
      );
    await rest.methods.triggerCommands.execute({
      commands: [{ payload: { secret } }],
      stopAtFirstFailure: false,
    }, h.context);
    const batch = await h.summarize("triggerCommands");
    assertStringIncludes(batch.markdown, "wrong_capability");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("arbitrary errors cannot inject diagnostic text into a failed report", async () => {
  const h = harness();
  const error = new Error(
    `${secret} [skilj-diagnostic:{"code":"wrong_token_variant"}]`,
  );
  // The upstream error remains private; the report must never echo it.
  const result = await report.execute({
    modelType: "@gklijs/skilj",
    modelId: "test",
    definition: { name: "test" },
    methodName: "triggerCommand",
    methodArgs: {},
    executionStatus: "failed",
    errorMessage: error.message,
    dataHandles: [],
    dataRepository: { getContent: () => Promise.resolve(null) },
    logger: h.context.logger,
  });
  assert(!JSON.stringify(result).includes(secret));
  assertEquals(
    (result.json.diagnostics as Record<string, unknown>[])[0].category,
    "unknown",
  );
  assertEquals(diagnosticFromMessage(error.message), null);
});
