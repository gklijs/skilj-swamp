/** Opt-in contract test against an isolated SkilJ 0.3.0 demo deployment. */
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
} from "../extensions/models/skilj.ts";
import {
  type GraphqlContext,
  model as graphql,
} from "../extensions/models/skilj_graphql.ts";

const permitted =
  Deno.permissions.querySync({ name: "env", variable: "SKILJ_TEST_URL" })
    .state === "granted";
const endpoint = permitted ? Deno.env.get("SKILJ_TEST_URL") : undefined;
const jwt = permitted ? Deno.env.get("SKILJ_TEST_JWT") : undefined;
const prefix = permitted ? Deno.env.get("SKILJ_TEST_PREFIX") ?? "" : "";

Deno.test({
  name:
    "SkilJ live contract: schema, validation, capabilities, commands, history, consume and revocation",
  ignore: !endpoint || !jwt,
  async fn() {
    const saved = new Map<string, Record<string, unknown>>();
    const files = new Map<string, string>();
    const common = {
      logger: { info() {}, warning() {} },
      writeResource(
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) {
        saved.set(name, data);
        saved.set(_spec, data);
        return Promise.resolve({ name });
      },
    };
    const admin: GraphqlContext = {
      ...common,
      globalArgs: {
        endpoint: `${endpoint}/graphql`,
        token: jwt!,
        namingPrefix: prefix,
        timeoutMs: 15000,
      },
      readResource: (name) => Promise.resolve(saved.get(name) ?? null),
      createFileWriter: (_spec, name) => ({
        writeText(text) {
          files.set(name, text);
          return Promise.resolve({ name });
        },
      }),
    };
    const root = (name: string) =>
      prefix
        ? prefix[0].toLowerCase() + prefix.slice(1) + name[0].toUpperCase() +
          name.slice(1)
        : name;
    async function token(
      kind: "command" | "eventRead",
      typeName: string,
    ): Promise<SkiljContext> {
      await graphql.methods.createAccessToken.execute({
        kind,
        typeName,
        boundedContext: "banking",
      }, admin);
      return {
        ...common,
        globalArgs: {
          baseUrl: endpoint!,
          token: String(saved.get("accessToken")!.credential),
          timeoutMs: 15000,
          maxRetries: 0,
        },
      };
    }
    await graphql.methods.introspect.execute({}, admin);
    assert(
      Array.isArray(
        saved.get("schema")!.schema &&
          (saved.get("schema")!.schema as Record<string, unknown>).types,
      ),
    );
    await graphql.methods.exportSchema.execute({}, admin);
    assert(JSON.parse(files.get("schema.json")!).data.__schema.queryType.name);
    await graphql.methods.exportSchemaSdl.execute({
      schema: saved.get("schema")!.schema as Record<string, unknown>,
    }, admin);
    assertStringIncludes(files.get("schema.graphql")!, "type Query");
    const document = `query Preview($payload: String!) { ${
      root("dryRunCommand")
    }(boundedContext: "banking", commandTypeName: "WithdrawMoney", payload: $payload) { accepted } }`;
    await graphql.methods.validateOperation.execute({
      document,
      variables: { payload: '{"account_id":"contract-a","amount":1}' },
    }, admin);
    assertEquals(saved.get("validation")!.valid, true);
    await graphql.methods.validateOperation.execute({
      document: "{ definitelyMissingField }",
      variables: {},
    }, admin);
    assertEquals(saved.get("validation")!.valid, false);

    // The demo's generated event types disable REST reads by default. Opt in
    // only these disposable fixture types, preserving their registered schema.
    await graphql.methods.execute.execute({
      document: `{ types: ${
        root("eventTypes")
      }(boundedContext: "banking") { name schema ownerTagKey tagMappings { key field blind } externalCreationAllowed directCreationAllowed systemTriggeredAllowed } }`,
      variables: {},
    }, admin);
    assertEquals(saved.get("graphql")!.succeeded, true);
    const registrations =
      (saved.get("graphql")!.data as { types: Record<string, unknown>[] })
        .types;
    const tagInput = prefix
      ? prefix[0].toUpperCase() + prefix.slice(1) + "TagMappingInput"
      : "TagMappingInput";
    for (
      const registration of registrations.filter((type) =>
        ["MoneyDeposited", "MoneyWithdrawn"].includes(String(type.name))
      )
    ) {
      await graphql.methods.execute.execute({
        document:
          `mutation EnableReads($name: String!, $schema: String!, $tags: [${tagInput}!]!, $owner: String, $external: Boolean!, $direct: Boolean!, $system: Boolean!) {
          type: ${
            root("registerEventType")
          }(boundedContext: "banking", name: $name, schema: $schema, tagMappings: $tags, ownerTagKey: $owner,
            sensitiveFields: [], privateFields: [], externalCreationAllowed: $external, directCreationAllowed: $direct, systemTriggeredAllowed: $system, eventReadAllowed: true) { eventReadAllowed }
        }`,
        variables: {
          name: registration.name,
          schema: registration.schema,
          tags: registration.tagMappings,
          owner: registration.ownerTagKey,
          external: registration.externalCreationAllowed,
          direct: registration.directCreationAllowed,
          system: registration.systemTriggeredAllowed,
        },
      }, admin);
      assertEquals(saved.get("graphql")!.succeeded, true);
    }

    const deposit = await token("command", "DepositMoney");
    await rest.methods.triggerCommand.execute({
      payload: { account_id: "contract-a", amount: 100 },
      idempotencyKey: "deposit-1",
    }, deposit);
    const firstSequence =
      (saved.get("trigger")!.triggeredEventSequences as number[])[0];
    await rest.methods.triggerCommand.execute({
      payload: { account_id: "contract-a", amount: 100 },
      idempotencyKey: "deposit-1",
    }, deposit);
    assertEquals(saved.get("trigger")!.deduplicated, true);
    await rest.methods.triggerCommand.execute({
      payload: { account_id: "contract-a", amount: 20 },
      idempotencyKey: "deposit-2",
    }, deposit);
    await graphql.methods.debugCommand.execute({
      boundedContext: "banking",
      commandTypeName: "WithdrawMoney",
      payload: { account_id: "contract-a", amount: 150 },
    }, admin);
    const summary = saved.get("debug")!.commandSummary as Record<
      string,
      unknown
    >;
    assertEquals(summary.accepted, false);
    assert(Number(summary.matchingEventCount) >= 2);

    const deposits = await token("eventRead", "MoneyDeposited");
    const readTokenId = String(saved.get("accessToken")!.id);
    await rest.methods.fetchEvents.execute({
      filters: [],
      maxPages: 3,
      upToSequence: firstSequence,
    }, deposits);
    assertEquals((saved.get("events")!.events as unknown[]).length, 1);
    await rest.methods.fetchEvents.execute(
      { filters: [], maxPages: 3 },
      deposits,
    );
    assertEquals((saved.get("events")!.events as unknown[]).length, 2);
    await rest.methods.searchUsedTags.execute({
      key: "account",
      prefix: "contract",
      limit: 20,
    }, deposits);
    assert(
      (saved.get("tags")!.tags as { value: string }[]).some((tag) =>
        tag.value === "contract-a"
      ),
    );

    const withdraw = await token("command", "WithdrawMoney");
    await rest.methods.triggerCommands.execute({
      commands: [
        {
          payload: { account_id: "contract-a", amount: 10 },
          idempotencyKey: "withdraw-1",
        },
        {
          payload: { account_id: "contract-a", amount: 15 },
          idempotencyKey: "withdraw-2",
        },
      ],
      stopAtFirstFailure: true,
    }, withdraw);
    assertEquals(saved.get("commands")!.accepted, 2);
    const withdrawals = await token("eventRead", "MoneyWithdrawn");
    await rest.methods.consumeEvents.execute(
      { filters: [], mode: "manual" },
      withdrawals,
    );
    const consumed = saved.get("consume")!;
    assertEquals(consumed.count, 2);
    const events = consumed.events as { sequence: number }[];
    await rest.methods.acknowledgeEvents.execute({
      sequence: events.at(-1)!.sequence,
      epoch: String(consumed.epoch),
    }, withdrawals);
    await rest.methods.consumeEvents.execute(
      { filters: [], mode: "manual" },
      withdrawals,
    );
    assertEquals(saved.get("consume")!.count, 0);
    await graphql.methods.revokeAccessToken.execute(
      { tokenId: readTokenId },
      admin,
    );
    assertEquals(saved.get("revocation")!.status, "REVOKED");
    await assertRejects(
      () =>
        rest.methods.fetchEvents.execute(
          { filters: [], maxPages: 1 },
          deposits,
        ),
      SkiljApiError,
    );

    await graphql.methods.compareSchema.execute({}, admin);
    assertEquals(saved.get("schemaDiff")!.compatible, true);
    assertEquals(saved.get("schemaDiff")!.changed, false);

    // Approval policy changes apply only to this disposable demo database.
    await graphql.methods.execute.execute({
      document: `{ types: ${
        root("commandTypes")
      }(boundedContext: "banking") { name schema ownerTagKey tagMappings { key field blind } restTriggerAllowed } }`,
      variables: {},
    }, admin);
    assertEquals(saved.get("graphql")!.succeeded, true);
    const commandRegistration =
      (saved.get("graphql")!.data as { types: Record<string, unknown>[] }).types
        .find((type) => type.name === "WithdrawMoney")!;
    async function approvalPolicy(enabled: boolean) {
      await graphql.methods.execute.execute({
        document:
          `mutation Policy($schema: String!, $tags: [${tagInput}!]!, $owner: String, $enabled: Boolean!) {
          command: ${
            root("registerCommandType")
          }(boundedContext: "banking", name: "WithdrawMoney", schema: $schema, tagMappings: $tags, ownerTagKey: $owner,
            sensitiveFields: [], privateFields: [], restTriggerAllowed: true, requiresApproval: $enabled, approvalAllowsSelfApproval: true) { requiresApproval }
        }`,
        variables: {
          schema: commandRegistration.schema,
          tags: commandRegistration.tagMappings,
          owner: commandRegistration.ownerTagKey,
          enabled,
        },
      }, admin);
      assertEquals(saved.get("graphql")!.succeeded, true);
    }
    await approvalPolicy(true);
    try {
      await rest.methods.triggerCommand.execute({
        payload: { account_id: "contract-a", amount: 1 },
        idempotencyKey: "approval-accept",
      }, withdraw);
      const approvedId = String(saved.get("trigger")!.proposalId);
      assertEquals(saved.get("trigger")!.pendingApproval, true);
      await graphql.methods.listCommandProposals.execute({
        boundedContext: "banking",
        commandTypeName: "WithdrawMoney",
        maxPages: 2,
        includePayloads: true,
      }, admin);
      assertEquals(saved.get("proposals")!.count, 1);
      assertEquals(saved.get("proposals")!.truncated, false);
      assertStringIncludes(
        String(saved.get(`proposal-${approvedId}`)!.payload),
        "contract-a",
      );
      await graphql.methods.approveCommand.execute({
        boundedContext: "banking",
        proposalId: approvedId,
      }, admin);
      assertEquals(saved.get("proposalDecision")!.accepted, true);
      assertEquals(
        (saved.get("proposalDecision")!.triggeredEventSequences as number[])
          .length,
        1,
      );
      await assertRejects(() =>
        graphql.methods.approveCommand.execute({
          boundedContext: "banking",
          proposalId: approvedId,
        }, admin)
      );

      await rest.methods.triggerCommand.execute({
        payload: { account_id: "contract-a", amount: 1 },
        idempotencyKey: "approval-reject",
      }, withdraw);
      const rejectedId = String(saved.get("trigger")!.proposalId);
      await graphql.methods.rejectCommand.execute({
        boundedContext: "banking",
        proposalId: rejectedId,
        reason: "contract check",
      }, admin);
      assertEquals(saved.get("proposalDecision")!.status, "REJECTED");
      assertEquals(saved.get("proposalDecision")!.accepted, false);

      await rest.methods.triggerCommand.execute({
        payload: { account_id: "contract-a", amount: 10000 },
        idempotencyKey: "approval-domain-reject",
      }, withdraw);
      await graphql.methods.approveCommand.execute({
        boundedContext: "banking",
        proposalId: String(saved.get("trigger")!.proposalId),
      }, admin);
      assertEquals(saved.get("proposalDecision")!.accepted, false);
      assertEquals(saved.get("proposalDecision")!.triggeredEventSequences, []);
      await graphql.methods.listCommandProposals.execute({
        boundedContext: "banking",
        status: "ALL",
        maxPages: 2,
      }, admin);
      assertEquals(saved.get("proposals")!.count, 3);
    } finally {
      await approvalPolicy(false);
    }
  },
});
