import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { buildSchema, introspectionFromSchema } from "npm:graphql@16.11.0";
import { type GraphqlContext, model } from "./skilj_graphql.ts";

function fixture(body: unknown, status = 200, following: unknown[] = []) {
  const responses = [body, ...following];
  const calls: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  const files: { spec: string; name: string; text: string }[] = [];
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify(responses.length > 1 ? responses.shift() : responses[0]),
        { status },
      ),
    );
  };
  const ctx: GraphqlContext = {
    globalArgs: {
      endpoint: "https://skilj.example.com/api/graphql",
      token: "role.jwt",
      timeoutMs: 1000,
    },
    logger: { info() {}, warning() {} },
    createFileWriter(spec, name) {
      return {
        writeText(text) {
          files.push({ spec, name, text });
          return Promise.resolve({ name });
        },
      };
    },
    writeResource(spec, name, data) {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return {
    calls,
    written,
    files,
    ctx,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

Deno.test("GraphQL sends operation name, variables and JWT to the exact endpoint", async () => {
  const f = fixture({ data: { projection: { balance: 10 } } });
  try {
    const args = {
      document:
        "query Balance($id: String!) { projection(id: $id) { balance } }",
      variables: { id: "w1" },
      operationName: "Balance",
    };
    await model.methods.execute.execute(args, f.ctx);
    assertEquals(f.calls[0].url, f.ctx.globalArgs.endpoint);
    assertEquals(f.calls[0].headers.get("Authorization"), "Bearer role.jwt");
    assertEquals(f.calls[0].body, {
      query: args.document,
      variables: args.variables,
      operationName: "Balance",
    });
    assertEquals(f.written[0].data.succeeded, true);
    assertEquals(f.written[0].data.data, { projection: { balance: 10 } });
  } finally {
    f.restore();
  }
});

Deno.test("GraphQL preserves partial data and errors while flagging failure", async () => {
  const errors = [{
    message: "Denied",
    path: ["secret"],
    extensions: { code: "forbidden" },
  }];
  const f = fixture({ data: { public: 1, secret: null }, errors });
  try {
    await model.methods.execute.execute({
      document: "{ public secret }",
      variables: {},
    }, f.ctx);
    assertEquals(f.written[0].data.succeeded, false);
    assertEquals(f.written[0].data.errorCount, 1);
    assertEquals(f.written[0].data.errors, errors);
    assertEquals(f.written[0].data.data, { public: 1, secret: null });
  } finally {
    f.restore();
  }
});

Deno.test("GraphQL does not retry mutations or persist malformed responses", async () => {
  for (
    const [body, status] of [[{ code: "busy", message: "busy" }, 503], [{
      unrelated: true,
    }, 200]] as const
  ) {
    const f = fixture(body, status);
    try {
      await assertRejects(() =>
        model.methods.execute.execute({
          document: "mutation { createThing { id } }",
          variables: {},
        }, f.ctx)
      );
      assertEquals(f.calls.length, 1);
      assertEquals(f.written.length, 0);
    } finally {
      f.restore();
    }
  }
});

Deno.test("GraphQL introspection records a reusable frontend schema", async () => {
  const schema = { queryType: { name: "Query" }, types: [{ name: "Wallet" }] };
  const f = fixture({ data: { __schema: schema } });
  try {
    await model.methods.introspect.execute({}, f.ctx);
    assertEquals(f.written[0].spec, "graphqlSchema");
    assertEquals(f.written[0].data.schema, schema);
    assertStringIncludes(String(f.calls[0].body.query), "inputFields");
    assertStringIncludes(String(f.calls[0].body.query), "subscriptionType");
    assertStringIncludes(String(f.calls[0].body.query), "ofType");
  } finally {
    f.restore();
  }
});

Deno.test("GraphQL token creation uses the correct mutation and returns a vault-marked credential", async () => {
  for (
    const kind of [
      "command",
      "eventRead",
      "externalEvent",
      "directCreation",
    ] as const
  ) {
    const f = fixture({ data: { token: { id: "t1", secret: "s1" } } });
    try {
      await model.methods.createAccessToken.execute({
        kind,
        boundedContext: "Bank",
        typeName: "Withdraw",
        scope: "owner1",
      }, f.ctx);
      assertEquals(f.written[0].data.credential, "t1.s1");
      assertEquals(f.written[0].data.id, "t1");
      assertEquals(f.calls[0].body.variables, {
        boundedContext: "Bank",
        typeName: "Withdraw",
        scope: "owner1",
        ...(kind === "eventRead"
          ? { startFrom: null, startAtSequence: null, startAtTime: null }
          : {}),
      });
      assertStringIncludes(
        String(f.calls[0].body.query),
        kind === "command" ? "commandTypeName" : "eventTypeName",
      );
      assertEquals(
        model.resources.accessToken.schema.shape.credential.meta()?.sensitive,
        true,
      );
    } finally {
      f.restore();
    }
  }
});

Deno.test("GraphQL failed token creation does not emit credentials or server messages", async () => {
  const f = fixture({ errors: [{ message: "private-server-value" }] });
  try {
    const error = await assertRejects(
      () =>
        model.methods.createAccessToken.execute({
          kind: "command",
          boundedContext: "Bank",
          typeName: "Withdraw",
        }, f.ctx),
      Error,
    );
    assert(!error.message.includes("private-server-value"));
    assertEquals(f.written.length, 0);
    assertEquals(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

Deno.test("GraphQL debugCommand serializes payload as a JSON string and queries matching history", async () => {
  const f = fixture({
    data: {
      dryRunCommand: {
        accepted: true,
        events: [],
        matchingEvents: [],
        matchingEventsTruncated: false,
      },
    },
  });
  try {
    await model.methods.debugCommand.execute({
      boundedContext: "Bank",
      commandTypeName: "Withdraw",
      payload: { amount: 10 },
    }, f.ctx);
    assertEquals(
      (f.calls[0].body.variables as Record<string, unknown>).payload,
      '{"amount":10}',
    );
    assertStringIncludes(
      String(f.calls[0].body.query),
      "matchingEvents { sequence eventTypeName payload }",
    );
    assertEquals(f.written[0].name, "debug");
    assertEquals(
      model.resources.graphqlResult.schema.shape.data.meta()?.sensitive,
      true,
    );
    assertEquals(
      model.resources.graphqlResult.schema.shape.errors.meta()?.sensitive,
      true,
    );
  } finally {
    f.restore();
  }
});

Deno.test("prefixed schemas work for token creation and debug queries without changing result aliases", async () => {
  const f = fixture({
    data: {
      token: { id: "t1", secret: "s1" },
      dryRunCommand: {
        accepted: false,
        events: [],
        matchingEvents: [{ sequence: 4 }],
        matchingEventsTruncated: true,
      },
    },
  });
  f.ctx.globalArgs.namingPrefix = "Ledger2";
  try {
    await model.methods.createAccessToken.execute({
      kind: "eventRead",
      boundedContext: "Bank",
      typeName: "Withdrawn",
      startFrom: "AT_SEQUENCE",
      startAtSequence: 12,
    }, f.ctx);
    assertStringIncludes(
      String(f.calls[0].body.query),
      "ledger2CreateEventReadToken",
    );
    assertStringIncludes(
      String(f.calls[0].body.query),
      "$startFrom: Ledger2EventReadStartPosition",
    );
    assertEquals(
      (f.calls[0].body.variables as Record<string, unknown>).startAtSequence,
      12,
    );
    await model.methods.debugCommand.execute({
      boundedContext: "Bank",
      commandTypeName: "Withdraw",
      payload: {},
    }, f.ctx);
    assertStringIncludes(
      String(f.calls[1].body.query),
      "dryRunCommand: ledger2DryRunCommand",
    );
    assertEquals(f.written[1].data.commandSummary, {
      accepted: false,
      wouldBeEventCount: 0,
      matchingEventCount: 1,
      matchingEventsTruncated: true,
    });
  } finally {
    f.restore();
  }
});

Deno.test("invalid token start combinations fail before creating a capability", async () => {
  const f = fixture({ data: {} });
  try {
    for (
      const options of [
        { kind: "command", startFrom: "LATEST" },
        { kind: "eventRead", startFrom: "AT_SEQUENCE" },
        { kind: "eventRead", startFrom: "AT_TIME", startAtSequence: 1 },
        {
          kind: "eventRead",
          startFrom: "LATEST",
          startAtTime: "2026-11-07T10:00:00Z",
        },
        { kind: "eventRead", startAtSequence: 1 },
      ] as const
    ) {
      await assertRejects(() =>
        model.methods.createAccessToken.execute({
          boundedContext: "Bank",
          typeName: "Withdraw",
          ...options,
        }, f.ctx)
      );
    }
    assertEquals(f.calls.length, 0);
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("event readers can begin at an RFC3339 timestamp", async () => {
  const f = fixture({ data: { token: { id: "t1", secret: "s1" } } });
  try {
    await model.methods.createAccessToken.execute({
      kind: "eventRead",
      boundedContext: "Bank",
      typeName: "Withdrawn",
      startFrom: "AT_TIME",
      startAtTime: "2026-11-07T10:00:00+01:00",
    }, f.ctx);
    assertEquals(
      (f.calls[0].body.variables as Record<string, unknown>).startAtTime,
      "2026-11-07T10:00:00+01:00",
    );
  } finally {
    f.restore();
  }
});

Deno.test("revocation uses union fragments with prefixed names and never requests a secret", async () => {
  const f = fixture({
    data: {
      token: {
        __typename: "LedgerCommandToken",
        id: "t1",
        status: "REVOKED",
        revokedAt: "2026-11-07T10:00:00Z",
      },
    },
  });
  f.ctx.globalArgs.namingPrefix = "ledger";
  try {
    await model.methods.revokeAccessToken.execute({ tokenId: "t1" }, f.ctx);
    const document = String(f.calls[0].body.query);
    assertStringIncludes(document, "ledgerRevokeToken");
    assertStringIncludes(
      document,
      "... on LedgerCommandToken { id status revokedAt }",
    );
    assert(!document.includes("secret"));
    assertEquals(f.calls[0].body.variables, { tokenId: "t1" });
    assertEquals(f.written[0], {
      spec: "tokenRevocation",
      name: "revocation",
      data: {
        id: "t1",
        tokenType: "LedgerCommandToken",
        status: "REVOKED",
        revokedAt: "2026-11-07T10:00:00Z",
      },
    });
  } finally {
    f.restore();
  }
});

Deno.test("revocation refuses a response for a different token ID", async () => {
  const f = fixture({
    data: {
      token: {
        __typename: "CommandToken",
        id: "other",
        status: "REVOKED",
        revokedAt: "2026-11-07T10:00:00Z",
      },
    },
  });
  try {
    await assertRejects(() =>
      model.methods.revokeAccessToken.execute({ tokenId: "t1" }, f.ctx)
    );
    assertEquals(f.written.length, 0);
    assertEquals(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

Deno.test("exportSchema writes a standard codegen envelope as a file", async () => {
  const schema = { queryType: { name: "Query" }, types: [{ name: "Wallet" }] };
  const f = fixture({ data: { __schema: schema } });
  try {
    const result = await model.methods.exportSchema.execute({}, f.ctx);
    assertEquals(result.dataHandles, [{ name: "schema.json" }]);
    assertEquals(f.files[0].spec, "schemaExport");
    assertEquals(JSON.parse(f.files[0].text), { data: { __schema: schema } });
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("exportSchema writes no artifact on introspection errors", async () => {
  const f = fixture({ errors: [{ message: "Introspection disabled" }] });
  try {
    await assertRejects(
      () => model.methods.exportSchema.execute({}, f.ctx),
      Error,
      "GraphQL returned",
    );
    assertEquals(f.files.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("GraphQL HTTP failures withhold private response bodies", async () => {
  const f = fixture({ code: "private-code", message: "private-message" }, 400);
  try {
    const error = await assertRejects(
      () =>
        model.methods.execute.execute(
          { document: "{ field }", variables: {} },
          f.ctx,
        ),
      Error,
    );
    assertStringIncludes(error.message, "HTTP 400");
    assert(!error.message.includes("private-message"));
    assert(!error.message.includes("private-code"));
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

const frontendSdl = `
  type Query { wallet(id: ID!): Wallet! }
  type Mutation { deposit(id: ID!, amount: Int!): Wallet! }
  type Subscription { balanceChanged(id: ID!): Wallet! }
  type Wallet { id: ID!, balance: Int! }
`;

Deno.test("operation validation reuses captured schema without sending a query or mutation", async () => {
  const f = fixture({ data: {} });
  const schema = introspectionFromSchema(buildSchema(frontendSdl));
  f.ctx.readResource = (name) => {
    assertEquals(name, "schema");
    return Promise.resolve({ schema: schema.__schema });
  };
  try {
    await model.methods.validateOperation.execute({
      document:
        "mutation Add($id: ID!, $amount: Int!) { deposit(id: $id, amount: $amount) { ...Balance } } fragment Balance on Wallet { id balance }",
      variables: { id: "w1", amount: 5 },
      operationName: "Add",
    }, f.ctx);
    assertEquals(f.written[0].data.valid, true);
    assertEquals(f.written[0].data.operationType, "mutation");
    assertEquals(f.written[0].data.operationName, "Add");
    assertEquals(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("operation validation reports schema, selection, syntax and variable errors", async () => {
  for (
    const [document, variables] of [
      ['{ wallet(id: "w1") { missingField } }', {}],
      ['{ wallet(id: "w1") }', {}],
      ["query Read($id: ID!) { wallet(id: $id) { id } }", {}],
      [
        'mutation Add($amount: Int!) { deposit(id: "w1", amount: $amount) { id } }',
        { amount: "private-invalid-amount" },
      ],
      ["query { wallet(", {}],
    ] as const
  ) {
    const f = fixture({ data: {} });
    try {
      await model.methods.validateOperation.execute({
        schemaSdl: frontendSdl,
        document,
        variables,
      }, f.ctx);
      assertEquals(f.written[0].data.valid, false);
      assert(Number(f.written[0].data.errorCount) > 0);
      assertEquals(f.calls.length, 0);
      assertEquals(
        model.resources.operationValidation.schema.shape.errors.meta()
          ?.sensitive,
        true,
      );
    } finally {
      f.restore();
    }
  }
});

Deno.test("operation validation accepts each introspection envelope and selects named operations", async () => {
  const schema = introspectionFromSchema(buildSchema(frontendSdl));
  for (const supplied of [schema.__schema, schema, { data: schema }]) {
    const f = fixture({ data: {} });
    try {
      await model.methods.validateOperation.execute({
        schema: supplied as unknown as Record<string, unknown>,
        document: '{ wallet(id: "w1") { id } }',
        variables: {},
      }, f.ctx);
      assertEquals(f.written[0].data.valid, true);
    } finally {
      f.restore();
    }
  }
  const f = fixture({ data: {} });
  try {
    const document =
      'query One { wallet(id: "w1") { id } } query Two { wallet(id: "w2") { balance } }';
    await model.methods.validateOperation.execute({
      schemaSdl: frontendSdl,
      document,
      variables: {},
    }, f.ctx);
    assertEquals(f.written[0].data.valid, false);
    await model.methods.validateOperation.execute({
      schemaSdl: frontendSdl,
      document,
      variables: {},
      operationName: "Two",
    }, f.ctx);
    assertEquals(f.written[1].data.valid, true);
    assertEquals(f.written[1].data.operationName, "Two");
  } finally {
    f.restore();
  }
});

Deno.test("operation validation does not fetch a missing schema", async () => {
  const f = fixture({ data: {} });
  try {
    await assertRejects(
      () =>
        model.methods.validateOperation.execute({
          document: "{ __typename }",
          variables: {},
        }, f.ctx),
      Error,
      "Run introspect first",
    );
    assertEquals(f.calls.length, 0);
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("HTTP execution refuses subscriptions and ambiguous or malformed documents before network activity", async () => {
  const f = fixture({ data: {} });
  try {
    for (
      const document of [
        'subscription { balanceChanged(id: "w1") { balance } }',
        "query One { __typename } query Two { __typename }",
        "query Broken {",
      ]
    ) {
      await assertRejects(() =>
        model.methods.execute.execute({ document, variables: {} }, f.ctx)
      );
    }
    assertEquals(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("SDL export is sorted, reusable and can avoid network access", async () => {
  const f = fixture({ data: {} });
  const schema = introspectionFromSchema(buildSchema(frontendSdl));
  try {
    await model.methods.exportSchemaSdl.execute({
      schema: schema as unknown as Record<string, unknown>,
    }, f.ctx);
    assertEquals(f.files[0].name, "schema.graphql");
    assertStringIncludes(f.files[0].text, "type Wallet");
    const reconstructed = buildSchema(f.files[0].text);
    assert(reconstructed.getMutationType()?.getFields().deposit);
    assertEquals(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("issued credentials retain independent resource identities", async () => {
  const f = fixture({
    data: { token: { id: "first", secret: "first-secret" } },
  });
  try {
    await model.methods.createAccessToken.execute({
      kind: "command",
      boundedContext: "Bank",
      typeName: "Withdraw",
    }, f.ctx);
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { token: { id: "second", secret: "second-secret" } },
          }),
        ),
      );
    await model.methods.createAccessToken.execute({
      kind: "eventRead",
      boundedContext: "Bank",
      typeName: "Withdrawn",
    }, f.ctx);
    assertEquals(new Set(f.written.map((write) => write.name)).size, 2);
    assertEquals(f.written[0].data.credential, "first.first-secret");
    assertEquals(f.written[1].data.credential, "second.second-secret");
    assertEquals(f.written[0].spec, "accessToken");
    assertEquals(f.written[1].spec, "accessToken");
  } finally {
    f.restore();
  }
});

Deno.test("schema comparison identifies breaking and potentially risky changes without executing an operation", async () => {
  const f = fixture({ data: {} });
  try {
    await model.methods.compareSchema.execute({
      before:
        "enum Mode { A } type Query { old: String wallet(id: ID): String }",
      after: "enum Mode { A B } type Query { wallet(id: ID!): String }",
    }, f.ctx);
    assertEquals(f.calls.length, 0);
    const result = f.written[0].data;
    assertEquals(result.compatible, false);
    assertEquals(result.changed, true);
    assert(Number(result.breakingCount) >= 1);
    assertEquals(result.dangerousCount, 1);
    assertEquals(
      model.resources.schemaDiff.schema.shape.dangerousChanges.meta()
        ?.sensitive,
      true,
    );
  } finally {
    f.restore();
  }
});

Deno.test("schema comparison distinguishes additive changes and harmless definition ordering", async () => {
  const f = fixture({ data: {} });
  try {
    await model.methods.compareSchema.execute({
      before: "type Query { a: String }",
      after: "type Query { a: String b: Int }",
    }, f.ctx);
    assertEquals(f.written[0].data.changed, true);
    assertEquals(f.written[0].data.compatible, true);
    await model.methods.compareSchema.execute({
      before: "type Query { a: String b: Int }",
      after: "type Query { b: Int a: String }",
    }, f.ctx);
    assertEquals(f.written[1].data.changed, false);
  } finally {
    f.restore();
  }
});

Deno.test("comparing the deployment preserves the captured baseline", async () => {
  const before = introspectionFromSchema(
    buildSchema("type Query { old: String }"),
  );
  const after = introspectionFromSchema(
    buildSchema("type Query { replacement: String }"),
  );
  const f = fixture({ data: after });
  f.ctx.readResource = () => Promise.resolve({ schema: before.__schema });
  try {
    await model.methods.compareSchema.execute({}, f.ctx);
    assertEquals(f.calls.length, 1);
    assertEquals(f.written.length, 1);
    assertEquals(f.written[0].spec, "schemaDiff");
    assertEquals(f.written[0].data.compatible, false);
  } finally {
    f.restore();
  }
});

Deno.test("schema comparison rejects a missing or invalid baseline before network activity", async () => {
  const f = fixture({ data: {} });
  try {
    await assertRejects(
      () => model.methods.compareSchema.execute({}, f.ctx),
      Error,
      "baseline",
    );
    await assertRejects(() =>
      model.methods.compareSchema.execute({ before: "not a schema" }, f.ctx)
    );
    assertEquals(f.calls.length, 0);
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

const proposal = (id = "p1", cursor = "cursor-1") => ({
  id,
  cursor,
  boundedContext: "Bank",
  commandTypeName: "Withdraw",
  status: "PENDING",
  createdAt: "2026-11-07T10:00:00Z",
  expiresAt: null,
});
const decision = (accepted = true) => ({
  accepted,
  triggeredEventSequences: accepted ? [42] : null,
  rejectionKind: accepted ? null : "insufficient_funds",
  rejectionReason: accepted ? null : "private-balance",
  proposal: {
    id: "p1",
    boundedContext: "Bank",
    commandTypeName: "Withdraw",
    status: accepted ? "APPROVED" : "REJECTED",
  },
});

Deno.test("proposal listing follows cursors and keeps filters across pages", async () => {
  const f = fixture({ data: { proposals: [proposal()] } }, 200, [
    { data: { proposals: [proposal("p2", "cursor-2")] } },
    { data: { proposals: [] } },
  ]);
  f.ctx.globalArgs.namingPrefix = "ledger";
  try {
    await model.methods.listCommandProposals.execute({
      boundedContext: "Bank",
      commandTypeName: "Withdraw",
      maxPages: 5,
    }, f.ctx);
    assertEquals(
      f.calls.map((call) =>
        (call.body.variables as Record<string, unknown>).after
      ),
      [null, "cursor-1", "cursor-2"],
    );
    for (const call of f.calls) {
      assertStringIncludes(String(call.body.query), "ledgerCommandProposals");
      assertStringIncludes(
        String(call.body.query),
        "LedgerCommandProposalStatus",
      );
      assert(!String(call.body.query).includes("payload"));
      assertEquals(
        (call.body.variables as Record<string, unknown>).status,
        "PENDING",
      );
      assertEquals(
        (call.body.variables as Record<string, unknown>).commandTypeName,
        "Withdraw",
      );
    }
    assertEquals(f.written[0].data.count, 2);
    assertEquals(f.written[0].data.nextCursor, "cursor-2");
    assertEquals(f.written[0].data.truncated, false);
  } finally {
    f.restore();
  }
});

Deno.test("proposal listing exposes bounded results and supports all statuses", async () => {
  const f = fixture({
    data: { proposals: [{ ...proposal(), status: "FUTURE_STATUS" }] },
  });
  try {
    await model.methods.listCommandProposals.execute({
      boundedContext: "Bank",
      status: "ALL",
    }, f.ctx);
    assertEquals(f.written[0].data.truncated, true);
    assertEquals(f.written[0].data.status, null);
    assertEquals(
      (f.calls[0].body.variables as Record<string, unknown>).status,
      null,
    );
  } finally {
    f.restore();
  }
});

Deno.test("proposal payload inspection uses separate protected per-proposal records", async () => {
  const f = fixture({
    data: {
      proposals: [
        { ...proposal(), payload: '{"private":"one"}', rejectionReason: null },
        {
          ...proposal("p2", "cursor-2"),
          payload: '{"private":"two"}',
          rejectionReason: "private-reason",
        },
      ],
    },
  });
  try {
    const result = await model.methods.listCommandProposals.execute({
      boundedContext: "Bank",
      includePayloads: true,
    }, f.ctx);
    assertEquals(result.dataHandles[0].name, "proposals");
    const details = f.written.filter((write) =>
      write.spec === "proposalDetails"
    );
    assertEquals(details.map((write) => write.name), [
      "proposal-p1",
      "proposal-p2",
    ]);
    const metadata = f.written.find((write) =>
      write.spec === "commandProposals"
    )!;
    assert(!JSON.stringify(metadata).includes("private"));
    assertEquals(
      model.resources.proposalDetails.schema.shape.payload.meta()?.sensitive,
      true,
    );
    assertEquals(
      model.resources.proposalDetails.schema.shape.rejectionReason.meta()
        ?.sensitive,
      true,
    );
  } finally {
    f.restore();
  }
});

Deno.test("duplicate proposal pages and later API errors write no partial list or payloads", async () => {
  const item = { ...proposal(), payload: "{}", rejectionReason: null };
  for (
    const next of [{ data: { proposals: [item] } }, {
      errors: [{ message: "denied" }],
    }]
  ) {
    const f = fixture({ data: { proposals: [item] } }, 200, [next]);
    try {
      await assertRejects(() =>
        model.methods.listCommandProposals.execute({
          boundedContext: "Bank",
          includePayloads: true,
          maxPages: 2,
        }, f.ctx)
      );
      assertEquals(f.written.length, 0);
      assertEquals(f.calls.length, 2);
    } finally {
      f.restore();
    }
  }
});

Deno.test("proposal responses must match the requested context and command type", async () => {
  const f = fixture({ data: { proposals: [proposal()] } });
  try {
    await assertRejects(() =>
      model.methods.listCommandProposals.execute({
        boundedContext: "OtherBank",
      }, f.ctx)
    );
    await assertRejects(() =>
      model.methods.listCommandProposals.execute({
        boundedContext: "Bank",
        commandTypeName: "OtherCommand",
      }, f.ctx)
    );
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("approval uses prefixed admin mutation and records actual emitted sequences", async () => {
  const f = fixture({ data: { decision: decision() } });
  f.ctx.globalArgs.namingPrefix = "ledger";
  try {
    await model.methods.approveCommand.execute({
      boundedContext: "Bank",
      proposalId: "p1",
    }, f.ctx);
    assertStringIncludes(String(f.calls[0].body.query), "ledgerApproveCommand");
    assertEquals(f.calls[0].body.variables, {
      boundedContext: "Bank",
      proposalId: "p1",
    });
    assertEquals(f.written[0].data.accepted, true);
    assertEquals(f.written[0].data.triggeredEventSequences, [42]);
    assertEquals(f.written[0].name, "decision-p1");
  } finally {
    f.restore();
  }
});

Deno.test("an approval can be rejected by current domain rules without a transport failure", async () => {
  const f = fixture({ data: { decision: decision(false) } });
  try {
    await model.methods.approveCommand.execute({
      boundedContext: "Bank",
      proposalId: "p1",
    }, f.ctx);
    assertEquals(f.written[0].data.accepted, false);
    assertEquals(f.written[0].data.triggeredEventSequences, []);
    assertEquals(f.written[0].data.rejectionKind, "insufficient_funds");
    assertEquals(
      model.resources.proposalDecision.schema.shape.rejectionReason.meta()
        ?.sensitive,
      true,
    );
  } finally {
    f.restore();
  }
});

Deno.test("rejection forwards the operator reason without exposing it in public metadata", async () => {
  const f = fixture({
    data: {
      decision: {
        ...decision(false),
        rejectionKind: "rejected_by_approver",
        rejectionReason: "private-reason",
      },
    },
  });
  try {
    await model.methods.rejectCommand.execute({
      boundedContext: "Bank",
      proposalId: "p1",
      reason: "private-reason",
    }, f.ctx);
    assertStringIncludes(String(f.calls[0].body.query), "rejectCommand");
    assertEquals(
      (f.calls[0].body.variables as Record<string, unknown>).reason,
      "private-reason",
    );
    assertEquals(f.written[0].data.action, "reject");
    assertEquals(f.written[0].data.accepted, false);
  } finally {
    f.restore();
  }
});

Deno.test("approval identity mismatches and transient failures never emit a decision or retry", async () => {
  for (
    const [body, status] of [
      [{
        data: {
          decision: {
            ...decision(),
            proposal: { ...decision().proposal, id: "wrong-proposal" },
          },
        },
      }, 200],
      [{
        data: {
          decision: { ...decision(false), triggeredEventSequences: [42] },
        },
      }, 200],
      [
        {
          data: { decision: { ...decision(), triggeredEventSequences: null } },
        },
        200,
      ],
      [{ errors: [{ message: "temporarily unavailable" }] }, 503],
    ] as const
  ) {
    const f = fixture(body, status);
    try {
      await assertRejects(() =>
        model.methods.approveCommand.execute({
          boundedContext: "Bank",
          proposalId: "p1",
        }, f.ctx)
      );
      assertEquals(f.calls.length, 1);
      assertEquals(f.written.length, 0);
    } finally {
      f.restore();
    }
  }
});

Deno.test("invalid schema comparison input cannot leak private values in parser errors", async () => {
  const f = fixture({ data: {} });
  try {
    const error = await assertRejects(
      () =>
        model.methods.compareSchema.execute({
          before: { privateValue: "do-not-expose" },
          after: "type Query { ok: Boolean }",
        }, f.ctx),
      Error,
      "Invalid baseline schema",
    );
    assert(!error.message.includes("do-not-expose"));
    assertEquals(f.calls.length, 0);
    assertEquals(f.written.length, 0);
  } finally {
    f.restore();
  }
});
