/**
 * SkilJ 0.3.0 GraphQL operations, schema discovery, command debugging and
 * capability-token creation. Authentication is an IdP JWT resolving to an
 * active SkilJ Role, separate from REST capability tokens.
 * @module
 */
import { z } from "npm:zod@4";
import {
  buildClientSchema,
  buildSchema,
  findBreakingChanges,
  findDangerousChanges,
  getIntrospectionQuery,
  getOperationAST,
  getVariableValues,
  GraphQLError,
  type IntrospectionQuery,
  lexicographicSortSchema,
  parse,
  printSchema,
  validate,
} from "npm:graphql@16.11.0";
import {
  GlobalArgsSchema as RestGlobals,
  request,
  type SkiljContext,
} from "./skilj.ts";

/** GraphQL connection settings; endpoint includes /graphql and any proxy prefix. */
export const GlobalArgsSchema = RestGlobals.omit({
  baseUrl: true,
  maxRetries: true,
}).extend({
  namingPrefix: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]*)?$/).optional()
    .describe(
      "SkilJ federation naming prefix, e.g. ledger; built-in operations apply the server's root/type naming rules",
    ),
  endpoint: z.string().url().describe(
    "Full GraphQL endpoint, e.g. https://skilj.example.com/graphql",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "IdP bearer JWT resolving to an active SkilJ Role; store in a vault",
  ),
});

/** Fields used from the Swamp execution context. */
export interface GraphqlContext extends Omit<SkiljContext, "globalArgs"> {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  createFileWriter?(spec: string, name: string): {
    writeText(text: string): Promise<{ name: string }>;
  };
}

/** An operation document with JSON variables, supporting named multi-operation documents. */
export const ExecuteArgsSchema = z.object({
  document: z.string().min(1).max(1_000_000),
  variables: z.record(z.string(), z.unknown()).default({}),
  operationName: z.string().min(1).optional(),
});

/** Check an operation against an introspected or SDL schema without executing it. */
export const ValidateOperationArgsSchema = ExecuteArgsSchema.extend({
  schema: z.record(z.string(), z.unknown()).optional().describe(
    "Introspection schema, __schema result, or data.__schema envelope; otherwise reuse the stored schema resource",
  ),
  schemaSdl: z.string().min(1).optional().describe(
    "Schema definition language text, as an alternative to introspection JSON",
  ),
}).refine(
  (args) => args.schema === undefined || args.schemaSdl === undefined,
  "Supply schema or schemaSdl, not both",
);

const ErrorSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  locations: z.array(
    z.object({ line: z.number().int(), column: z.number().int() }),
  ).optional(),
});
const EnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(ErrorSchema).optional(),
}).refine(
  (body) =>
    (body.data !== undefined && body.data !== null) ||
    (body.errors?.length ?? 0) > 0,
  "Expected GraphQL data or errors",
);
const CommandSummarySchema = z.object({
  accepted: z.boolean(),
  wouldBeEventCount: z.number().int().nonnegative(),
  matchingEventCount: z.number().int().nonnegative(),
  matchingEventsTruncated: z.boolean(),
});
const ResultSchema = z.object({
  commandSummary: CommandSummarySchema.nullable().default(null),
  succeeded: z.boolean(),
  errorCount: z.number(),
  // Arbitrary operations can return capability secrets and private fields.
  // Swamp vaults the opaque values before persisting the result resource.
  data: z.record(z.string(), z.unknown()).nullable().meta({ sensitive: true }),
  errors: z.array(ErrorSchema).meta({ sensitive: true }),
});

async function operation(
  context: GraphqlContext,
  args: z.infer<typeof ExecuteArgsSchema>,
) {
  let document;
  try {
    document = parse(args.document, { maxTokens: 10000 });
  } catch {
    throw new Error(
      "Invalid GraphQL document syntax; use validateOperation for protected diagnostics",
    );
  }
  const selected = getOperationAST(document, args.operationName);
  if (!selected) {
    throw new Error(
      "Select a valid GraphQL operationName when the document has multiple operations",
    );
  }
  if (selected.operation === "subscription") {
    throw new Error(
      "Subscriptions require a graphql-transport-ws client; HTTP execution supports queries and mutations",
    );
  }
  context.logger.info("Executing SkilJ GraphQL operation");
  const body = await request(
    {
      ...context,
      globalArgs: {
        ...context.globalArgs,
        baseUrl: context.globalArgs.endpoint,
        maxRetries: 0,
      },
    },
    "POST",
    context.globalArgs.endpoint,
    {
      body: {
        query: args.document,
        variables: args.variables,
        operationName: args.operationName,
      },
      // An arbitrary document may mutate state. Never infer safety from text.
      retry: false,
      sensitiveResponse: true,
    },
  );
  const result = EnvelopeSchema.parse(body);
  context.logger.info(
    "SkilJ GraphQL operation completed ({errorCount} errors)",
    { errorCount: result.errors?.length ?? 0 },
  );
  return result;
}

const IntrospectionDocument = getIntrospectionQuery({
  descriptions: true,
  specifiedByUrl: true,
  directiveIsRepeatable: true,
  schemaDescription: true,
  inputValueDeprecation: true,
});

function clientSchema(raw: Record<string, unknown>) {
  // Accept a raw __schema object, a standard result, or its HTTP envelope.
  const data = raw.data && typeof raw.data === "object"
    ? raw.data as Record<string, unknown>
    : raw;
  const schema = data.__schema ?? data;
  return buildClientSchema(
    { __schema: schema } as unknown as IntrospectionQuery,
  );
}

/** Capability-token creation, with explicit event-read start options. */
export const CreateAccessTokenArgsSchema = z.object({
  kind: z.enum(["command", "eventRead", "externalEvent", "directCreation"]),
  boundedContext: z.string().min(1),
  typeName: z.string().min(1),
  scope: z.string().optional(),
  startFrom: z.enum(["BEGINNING", "LATEST", "AT_SEQUENCE", "AT_TIME"])
    .optional(),
  startAtSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .optional(),
  startAtTime: z.iso.datetime({ offset: true }).optional(),
}).superRefine((args, ctx) => {
  const sequence = args.startAtSequence !== undefined;
  const time = args.startAtTime !== undefined;
  if (
    args.kind !== "eventRead" &&
    (args.startFrom !== undefined || sequence || time)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Start options apply only to eventRead tokens",
    });
  } else if (
    args.startFrom === "AT_SEQUENCE"
      ? !sequence || time
      : args.startFrom === "AT_TIME"
      ? !time || sequence
      : sequence || time
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "AT_SEQUENCE requires only startAtSequence; AT_TIME requires only startAtTime; BEGINNING/LATEST forbid both",
    });
  }
});

/** Revoke one capability by ID without fetching or returning its secret. */
export const RevokeAccessTokenArgsSchema = z.object({
  tokenId: z.string().min(1),
});

function rootName(context: GraphqlContext, name: string) {
  const prefix = context.globalArgs.namingPrefix ?? "";
  return prefix
    ? prefix[0].toLowerCase() + prefix.slice(1) + name[0].toUpperCase() +
      name.slice(1)
    : name;
}

function typeName(context: GraphqlContext, name: string) {
  const prefix = context.globalArgs.namingPrefix ?? "";
  return prefix ? prefix[0].toUpperCase() + prefix.slice(1) + name : name;
}

async function introspection(context: GraphqlContext) {
  const data = requireData(
    await operation(context, {
      document: IntrospectionDocument,
      variables: {},
      operationName: "IntrospectionQuery",
    }),
  );
  return z.record(z.string(), z.unknown()).parse(data.__schema);
}

/** Compare captured or SDL schemas; an omitted after schema reads the deployment. */
export const CompareSchemaArgsSchema = z.object({
  before: z.union([z.string().min(1), z.record(z.string(), z.unknown())])
    .optional(),
  after: z.union([z.string().min(1), z.record(z.string(), z.unknown())])
    .optional(),
});

/** Page the administrator's proposal queue; payloads require an explicit opt-in. */
export const ListCommandProposalsArgsSchema = z.object({
  boundedContext: z.string().min(1),
  commandTypeName: z.string().min(1).optional(),
  status: z.enum([
    "ALL",
    "PENDING",
    "APPROVING",
    "APPROVED",
    "REJECTED",
    "EXPIRED",
    "FORGOTTEN",
  ]).default("PENDING"),
  after: z.string().min(1).optional(),
  maxPages: z.number().int().min(1).max(100).default(1),
  includePayloads: z.boolean().default(false),
});

/** A specific proposal must be selected for an approval decision. */
export const ApproveCommandArgsSchema = z.object({
  boundedContext: z.string().min(1),
  proposalId: z.string().min(1),
});

/** An explicit rejection may include a private operator reason. */
export const RejectCommandArgsSchema = ApproveCommandArgsSchema.extend({
  reason: z.string().min(1).optional().meta({ sensitive: true }),
});

const ProposalMetadataSchema = z.object({
  id: z.string().min(1),
  boundedContext: z.string().min(1),
  commandTypeName: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().nullable(),
  cursor: z.string().min(1),
});
const ProposalDetailsSchema = ProposalMetadataSchema.extend({
  payload: z.string().meta({ sensitive: true }),
  rejectionReason: z.string().nullable().meta({ sensitive: true }),
});
const ProposalListSchema = z.object({
  boundedContext: z.string(),
  commandTypeName: z.string().nullable(),
  status: z.string().nullable(),
  proposals: z.array(ProposalMetadataSchema),
  count: z.number().int(),
  pages: z.number().int(),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});
const ProposalDecisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  proposalId: z.string(),
  boundedContext: z.string(),
  commandTypeName: z.string(),
  status: z.string(),
  accepted: z.boolean(),
  triggeredEventSequences: z.array(z.number().int().nonnegative()),
  rejectionKind: z.string().nullable(),
  rejectionReason: z.string().nullable().meta({ sensitive: true }),
});
const SchemaChangeSchema = z.object({
  type: z.string(),
  description: z.string(),
});
const SchemaDiffSchema = z.object({
  changed: z.boolean(),
  compatible: z.boolean(),
  breakingCount: z.number().int(),
  dangerousCount: z.number().int(),
  // Default-value diffs can contain private values; reports expose counts only.
  breakingChanges: z.array(SchemaChangeSchema).meta({ sensitive: true }),
  dangerousChanges: z.array(SchemaChangeSchema).meta({ sensitive: true }),
});

async function decideProposal(
  action: "approve" | "reject",
  args: z.infer<typeof RejectCommandArgsSchema>,
  context: GraphqlContext,
) {
  const reject = action === "reject";
  const data = requireData(
    await operation(context, {
      document:
        `mutation DecideProposal($boundedContext: String!, $proposalId: ID!${
          reject ? ", $reason: String" : ""
        }) {
      decision: ${
          rootName(context, reject ? "rejectCommand" : "approveCommand")
        }(boundedContext: $boundedContext, proposalId: $proposalId${
          reject ? ", reason: $reason" : ""
        }) {
        accepted triggeredEventSequences rejectionReason rejectionKind
        proposal { id boundedContext commandTypeName status }
      }
    }`,
      variables: {
        boundedContext: args.boundedContext,
        proposalId: args.proposalId,
        ...(reject ? { reason: args.reason ?? null } : {}),
      },
      operationName: "DecideProposal",
    }),
  );
  const decision = z.object({
    accepted: z.boolean(),
    triggeredEventSequences: z.array(z.number().int().nonnegative()).nullable(),
    rejectionReason: z.string().nullable(),
    rejectionKind: z.string().nullable(),
    proposal: z.object({
      id: z.literal(args.proposalId),
      boundedContext: z.literal(args.boundedContext),
      commandTypeName: z.string().min(1),
      status: z.string().min(1),
    }),
  }).parse(data.decision);
  if (reject && decision.accepted) {
    throw new Error(
      "SkilJ rejection unexpectedly reported an accepted command",
    );
  }
  if (decision.accepted && decision.triggeredEventSequences === null) {
    throw new Error(
      "SkilJ approval omitted the accepted command's event sequences",
    );
  }
  if (!decision.accepted && decision.triggeredEventSequences?.length) {
    throw new Error(
      "SkilJ rejected outcome unexpectedly included stored events; inspect the proposal before trying again",
    );
  }
  const result = ProposalDecisionSchema.parse({
    action,
    proposalId: decision.proposal.id,
    boundedContext: decision.proposal.boundedContext,
    commandTypeName: decision.proposal.commandTypeName,
    status: decision.proposal.status,
    accepted: decision.accepted,
    triggeredEventSequences: decision.triggeredEventSequences ?? [],
    rejectionReason: decision.rejectionReason,
    rejectionKind: decision.rejectionKind,
  });
  context.logger.info("Recorded proposal decision ({accepted})", {
    accepted: result.accepted,
  });
  return {
    dataHandles: [
      await context.writeResource(
        "proposalDecision",
        `decision-${result.proposalId}`,
        result,
      ),
    ],
  };
}

/** Default-schema admin dry run, revealing would-be and matching events. */
export const DebugCommandArgsSchema = z.object({
  boundedContext: z.string().min(1),
  commandTypeName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

function requireData(body: z.infer<typeof EnvelopeSchema>) {
  if (body.errors?.length || !body.data) {
    // Avoid echoing arbitrary server messages, which can contain input secrets.
    throw new Error(
      `SkilJ GraphQL returned ${
        body.errors?.length ?? 0
      } error(s); use execute to capture the protected error envelope`,
    );
  }
  return body.data;
}

/** GraphQL companion to the REST model, packaged in @gklijs/skilj. */
export const model = {
  type: "@gklijs/skilj-graphql",
  version: "2026.11.07.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.11.07.1",
    description: "Initial GraphQL connection schema",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  files: {
    schemaSdl: {
      description:
        "Sorted GraphQL SDL for frontend type generation and readable schema diffs",
      contentType: "text/plain",
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    schemaExport: {
      description:
        "GraphQL introspection JSON for frontend code generators (data.__schema envelope)",
      contentType: "application/json",
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  resources: {
    schemaDiff: {
      description:
        "Schema compatibility counts with protected change descriptions",
      schema: SchemaDiffSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    commandProposals: {
      description:
        "Scoped proposal metadata and a bounded paging cursor; no payloads",
      schema: ProposalListSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    proposalDetails: {
      description:
        "Explicitly requested proposal payload and rejection reason, protected in a per-proposal vault slot",
      schema: ProposalDetailsSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    proposalDecision: {
      description:
        "Operator decision and actual command outcome; approval may still be rejected by domain rules",
      schema: ProposalDecisionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    operationValidation: {
      description:
        "Offline operation validation and variable coercion; diagnostics are vault-protected",
      schema: z.object({
        valid: z.boolean(),
        errorCount: z.number().int().nonnegative(),
        operationType: z.enum(["query", "mutation", "subscription"]).nullable(),
        operationName: z.string().nullable(),
        errors: z.array(ErrorSchema).meta({ sensitive: true }),
      }),
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    tokenRevocation: {
      description:
        "Revoked capability ID, concrete GraphQL type, status and revocation time; no credential",
      schema: z.object({
        id: z.string(),
        tokenType: z.string(),
        status: z.literal("REVOKED"),
        revokedAt: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    graphqlResult: {
      description:
        "GraphQL success flag and vault-protected data/errors, including partial responses",
      schema: ResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    graphqlSchema: {
      description:
        "Introspection data for frontend code generation and operation discovery",
      schema: z.object({ schema: z.record(z.string(), z.unknown()) }),
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    accessToken: {
      description:
        "Created REST capability token; credential is persisted through Swamp's vault",
      schema: z.object({
        id: z.string(),
        kind: CreateAccessTokenArgsSchema.shape.kind,
        boundedContext: z.string(),
        typeName: z.string(),
        credential: z.string().meta({ sensitive: true }),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    compareSchema: {
      description:
        "Compare schema compatibility; before defaults to the stored schema, after defaults to a fresh deployment read without overwriting the baseline",
      arguments: CompareSchemaArgsSchema,
      execute: async (
        raw: z.input<typeof CompareSchemaArgsSchema>,
        context: GraphqlContext,
      ) => {
        const args = CompareSchemaArgsSchema.parse(raw);
        const stored = args.before === undefined && context.readResource
          ? await context.readResource("schema")
          : null;
        const before = args.before ??
          stored?.schema as Record<string, unknown> | undefined;
        if (before === undefined) {
          throw new Error(
            "Run introspect to capture a baseline or supply before; comparison never overwrites the stored schema",
          );
        }
        const decode = (
          input: string | Record<string, unknown>,
          label: string,
        ) => {
          try {
            return typeof input === "string"
              ? buildSchema(input)
              : clientSchema(input);
          } catch {
            throw new Error(
              `Invalid ${label} schema; supply valid SDL or a complete introspection result`,
            );
          }
        };
        const oldSchema = decode(before, "baseline");
        const newSchema = decode(
          args.after ?? await introspection(context),
          "comparison",
        );
        const breakingChanges = findBreakingChanges(oldSchema, newSchema);
        const dangerousChanges = findDangerousChanges(oldSchema, newSchema);
        const result = SchemaDiffSchema.parse({
          changed: printSchema(lexicographicSortSchema(oldSchema)) !==
            printSchema(lexicographicSortSchema(newSchema)),
          compatible: breakingChanges.length === 0,
          breakingCount: breakingChanges.length,
          dangerousCount: dangerousChanges.length,
          breakingChanges,
          dangerousChanges,
        });
        context.logger.info(
          "Compared GraphQL schemas ({breakingCount} breaking, {dangerousCount} potentially risky changes)",
          {
            breakingCount: result.breakingCount,
            dangerousCount: result.dangerousCount,
          },
        );
        return {
          dataHandles: [
            await context.writeResource("schemaDiff", "schemaDiff", result),
          ],
        };
      },
    },
    listCommandProposals: {
      description:
        "List scoped command proposals with bounded pagination; payloads are fetched only when includePayloads is true",
      arguments: ListCommandProposalsArgsSchema,
      execute: async (
        raw: z.input<typeof ListCommandProposalsArgsSchema>,
        context: GraphqlContext,
      ) => {
        const args = ListCommandProposalsArgsSchema.parse(raw);
        const proposals: z.infer<typeof ProposalMetadataSchema>[] = [];
        const details: z.infer<typeof ProposalDetailsSchema>[] = [];
        const ids = new Set<string>();
        const cursors = new Set(args.after ? [args.after] : []);
        let cursor = args.after ?? null;
        let pages = 0;
        let hasMore = false;
        const status = args.status === "ALL" ? null : args.status;
        do {
          const data = requireData(
            await operation(context, {
              document:
                `query Proposals($boundedContext: String!, $commandTypeName: String, $status: ${
                  typeName(context, "CommandProposalStatus")
                }, $after: String) {
              proposals: ${
                  rootName(context, "commandProposals")
                }(boundedContext: $boundedContext, commandTypeName: $commandTypeName, status: $status, after: $after) {
                id boundedContext commandTypeName status createdAt expiresAt cursor ${
                  args.includePayloads ? "payload rejectionReason" : ""
                }
              }
            }`,
              variables: {
                boundedContext: args.boundedContext,
                commandTypeName: args.commandTypeName ?? null,
                status,
                after: cursor,
              },
              operationName: "Proposals",
            }),
          );
          const page = z.array(
            args.includePayloads
              ? ProposalDetailsSchema
              : ProposalMetadataSchema,
          ).parse(data.proposals);
          pages++;
          for (const item of page) {
            if (
              item.boundedContext !== args.boundedContext ||
              (args.commandTypeName &&
                item.commandTypeName !== args.commandTypeName)
            ) {
              throw new Error(
                "SkilJ returned a proposal outside the requested context or command type",
              );
            }
            if (ids.has(item.id) || cursors.has(item.cursor)) {
              throw new Error(
                "SkilJ returned duplicate proposals or a repeated proposal cursor",
              );
            }
            ids.add(item.id);
            cursors.add(item.cursor);
            proposals.push(ProposalMetadataSchema.parse(item));
            if (args.includePayloads) {
              details.push(ProposalDetailsSchema.parse(item));
            }
          }
          hasMore = page.length > 0;
          if (page.length) cursor = page.at(-1)!.cursor;
        } while (hasMore && pages < args.maxPages);
        const result = ProposalListSchema.parse({
          boundedContext: args.boundedContext,
          commandTypeName: args.commandTypeName ?? null,
          status,
          proposals,
          count: proposals.length,
          pages,
          nextCursor: cursor,
          truncated: hasMore && pages >= args.maxPages,
        });
        const detailHandles = [];
        for (const detail of details) {
          detailHandles.push(
            await context.writeResource(
              "proposalDetails",
              `proposal-${detail.id}`,
              detail,
            ),
          );
        }
        const handle = await context.writeResource(
          "commandProposals",
          "proposals",
          result,
        );
        context.logger.info("Listed {count} command proposals", {
          count: result.count,
        });
        return { dataHandles: [handle, ...detailHandles] };
      },
    },
    approveCommand: {
      description:
        "Explicitly approve one proposal using an admin Role; command rules run at decision time, and may reject it. Never retried",
      arguments: ApproveCommandArgsSchema,
      execute: (
        args: z.infer<typeof ApproveCommandArgsSchema>,
        context: GraphqlContext,
      ) =>
        decideProposal(
          "approve",
          ApproveCommandArgsSchema.parse(args),
          context,
        ),
    },
    rejectCommand: {
      description:
        "Explicitly reject one proposal using an admin Role with an optional private reason. Never retried",
      arguments: RejectCommandArgsSchema,
      execute: (
        args: z.infer<typeof RejectCommandArgsSchema>,
        context: GraphqlContext,
      ) =>
        decideProposal("reject", RejectCommandArgsSchema.parse(args), context),
    },
    validateOperation: {
      description:
        "Validate GraphQL fields, selection sets, operation names and variables without executing resolvers; reuse an introspected schema or supply SDL",
      arguments: ValidateOperationArgsSchema,
      execute: async (
        args: z.infer<typeof ValidateOperationArgsSchema>,
        context: GraphqlContext,
      ) => {
        args = ValidateOperationArgsSchema.parse(args);
        const stored =
          args.schema === undefined && args.schemaSdl === undefined &&
            context.readResource
            ? await context.readResource("schema")
            : null;
        const raw = args.schema ??
          stored?.schema as Record<string, unknown> | undefined;
        if (raw === undefined && args.schemaSdl === undefined) {
          throw new Error(
            "Run introspect first or supply schema/schemaSdl; validation never fetches or executes an operation",
          );
        }
        const errors: GraphQLError[] = [];
        let selected = null;
        try {
          const schema = args.schemaSdl !== undefined
            ? buildSchema(args.schemaSdl)
            : clientSchema(raw!);
          const document = parse(args.document, { maxTokens: 10000 });
          errors.push(
            ...validate(schema, document, undefined, { maxErrors: 50 }),
          );
          selected = getOperationAST(document, args.operationName);
          if (!selected) {
            errors.push(
              new GraphQLError(
                "Select a valid operationName when the document contains multiple operations",
              ),
            );
          }
          if (selected && errors.length === 0) {
            const coerced = getVariableValues(
              schema,
              selected.variableDefinitions ?? [],
              args.variables,
              { maxErrors: 50 },
            );
            if (coerced.errors) errors.push(...coerced.errors);
          }
        } catch (error) {
          errors.push(
            error instanceof GraphQLError ? error : new GraphQLError(
              error instanceof Error ? error.message : "Invalid schema",
            ),
          );
        }
        const result = model.resources.operationValidation.schema.parse({
          valid: errors.length === 0,
          errorCount: errors.length,
          operationType: selected?.operation ?? null,
          operationName: selected?.name?.value ?? null,
          errors: errors.map((error) => error.toJSON()),
        });
        context.logger.info(
          "Validated GraphQL operation ({errorCount} errors)",
          { errorCount: result.errorCount },
        );
        return {
          dataHandles: [
            await context.writeResource(
              "operationValidation",
              "validation",
              result,
            ),
          ],
        };
      },
    },
    exportSchemaSdl: {
      description:
        "Export sorted GraphQL SDL; supply introspection JSON to reuse a captured schema, or fetch the deployed schema",
      arguments: z.object({
        schema: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (
        args: { schema?: Record<string, unknown> },
        context: GraphqlContext,
      ) => {
        if (!context.createFileWriter) {
          throw new Error(
            "Swamp file-writer support is required to export a schema",
          );
        }
        const schema = clientSchema(
          args.schema ?? await introspection(context),
        );
        const text = printSchema(lexicographicSortSchema(schema)) + "\n";
        return {
          dataHandles: [
            await context.createFileWriter("schemaSdl", "schema.graphql")
              .writeText(text),
          ],
        };
      },
    },
    execute: {
      description:
        "Execute a GraphQL query or mutation with variables; inspect succeeded/errorCount even for HTTP 200. Never automatically retried",
      arguments: ExecuteArgsSchema,
      execute: async (
        args: z.infer<typeof ExecuteArgsSchema>,
        context: GraphqlContext,
      ) => {
        const body = await operation(context, args);
        const errors = body.errors ?? [];
        const result = ResultSchema.parse({
          succeeded: errors.length === 0,
          errorCount: errors.length,
          data: body.data ?? null,
          errors,
        });
        return {
          dataHandles: [
            await context.writeResource("graphqlResult", "graphql", result),
          ],
        };
      },
    },
    introspect: {
      description:
        "Fetch the deployed GraphQL schema for frontend tooling; requires server introspection to be enabled",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: GraphqlContext,
      ) => {
        const schema = await introspection(context);
        return {
          dataHandles: [
            await context.writeResource("graphqlSchema", "schema", { schema }),
          ],
        };
      },
    },
    exportSchema: {
      description:
        "Export a standard GraphQL introspection JSON file for frontend tooling without manual envelope conversion",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: GraphqlContext,
      ) => {
        if (!context.createFileWriter) {
          throw new Error(
            "Swamp file-writer support is required to export a schema",
          );
        }
        const schema = await introspection(context);
        const writer = context.createFileWriter("schemaExport", "schema.json");
        return {
          dataHandles: [
            await writer.writeText(
              JSON.stringify({ data: { __schema: schema } }, null, 2) + "\n",
            ),
          ],
        };
      },
    },
    revokeAccessToken: {
      description:
        "Revoke a REST capability by ID using an admin Role; does not return its secret. Never automatically retried",
      arguments: RevokeAccessTokenArgsSchema,
      execute: async (
        args: z.infer<typeof RevokeAccessTokenArgsSchema>,
        context: GraphqlContext,
      ) => {
        const fragments = [
          "CommandToken",
          "EventReadToken",
          "ExternalEventToken",
          "DirectCreationToken",
        ]
          .map((name) =>
            `... on ${typeName(context, name)} { id status revokedAt }`
          ).join("\n");
        const data = requireData(
          await operation(context, {
            document: `mutation RevokeToken($tokenId: ID!) { token: ${
              rootName(context, "revokeToken")
            }(tokenId: $tokenId) { __typename ${fragments} } }`,
            variables: { tokenId: args.tokenId },
            operationName: "RevokeToken",
          }),
        );
        const token = z.object({
          id: z.literal(args.tokenId),
          __typename: z.string(),
          status: z.literal("REVOKED"),
          revokedAt: z.string(),
        }).parse(data.token);
        return {
          dataHandles: [
            await context.writeResource("tokenRevocation", "revocation", {
              id: token.id,
              tokenType: token.__typename,
              status: token.status,
              revokedAt: token.revokedAt,
            }),
          ],
        };
      },
    },
    createAccessToken: {
      description:
        "Create a scoped REST capability token using an admin Role; vault-protects the returned <id>.<secret> credential. Never retried",
      arguments: CreateAccessTokenArgsSchema,
      execute: async (
        args: z.infer<typeof CreateAccessTokenArgsSchema>,
        context: GraphqlContext,
      ) => {
        args = CreateAccessTokenArgsSchema.parse(args);
        const field = rootName(
          context,
          {
            command: "createCommandToken",
            eventRead: "createEventReadToken",
            externalEvent: "createExternalEventToken",
            directCreation: "createDirectCreationToken",
          }[args.kind],
        );
        const typeArg = args.kind === "command"
          ? "commandTypeName"
          : "eventTypeName";
        const readDeclarations = args.kind === "eventRead"
          ? `, $startFrom: ${
            typeName(context, "EventReadStartPosition")
          }, $startAtSequence: Int, $startAtTime: String`
          : "";
        const readArguments = args.kind === "eventRead"
          ? ", startFrom: $startFrom, startAtSequence: $startAtSequence, startAtTime: $startAtTime"
          : "";
        const data = requireData(
          await operation(context, {
            document:
              `mutation CreateToken($boundedContext: String!, $typeName: String!, $scope: String${readDeclarations}) {
            token: ${field}(boundedContext: $boundedContext, ${typeArg}: $typeName, scope: $scope${readArguments}) { id secret }
          }`,
            variables: {
              boundedContext: args.boundedContext,
              typeName: args.typeName,
              scope: args.scope ?? null,
              ...(args.kind === "eventRead"
                ? {
                  startFrom: args.startFrom ?? null,
                  startAtSequence: args.startAtSequence ?? null,
                  startAtTime: args.startAtTime ?? null,
                }
                : {}),
            },
            operationName: "CreateToken",
          }),
        );
        const token = z.object({
          id: z.string().min(1),
          secret: z.string().min(1).meta({ sensitive: true }),
        }).parse(data.token);
        return {
          dataHandles: [
            await context.writeResource("accessToken", `token-${token.id}`, {
              id: token.id,
              kind: args.kind,
              boundedContext: args.boundedContext,
              typeName: args.typeName,
              credential: `${token.id}.${token.secret}`,
            }),
          ],
        };
      },
    },
    debugCommand: {
      description:
        "Admin-only GraphQL dry run showing would-be events and scoped matching history, without storing a command",
      arguments: DebugCommandArgsSchema,
      execute: async (
        args: z.infer<typeof DebugCommandArgsSchema>,
        context: GraphqlContext,
      ) => {
        const body = await operation(context, {
          document:
            `query DebugCommand($boundedContext: String!, $commandTypeName: String!, $payload: String!) {
            dryRunCommand: ${
              rootName(context, "dryRunCommand")
            }(boundedContext: $boundedContext, commandTypeName: $commandTypeName, payload: $payload) {
              accepted rejectionReason rejectionKind events { eventTypeName payload }
              matchingEvents { sequence eventTypeName payload } matchingEventsTruncated
            }
          }`,
          variables: { ...args, payload: JSON.stringify(args.payload) },
          operationName: "DebugCommand",
        });
        const errors = body.errors ?? [];
        let commandSummary = null;
        if (errors.length === 0) {
          const command = z.object({
            accepted: z.boolean(),
            events: z.array(z.unknown()),
            matchingEvents: z.array(z.unknown()),
            matchingEventsTruncated: z.boolean(),
          }).parse(body.data?.dryRunCommand);
          commandSummary = {
            accepted: command.accepted,
            wouldBeEventCount: command.events.length,
            matchingEventCount: command.matchingEvents.length,
            matchingEventsTruncated: command.matchingEventsTruncated,
          };
        }
        const result = ResultSchema.parse({
          commandSummary,
          succeeded: errors.length === 0,
          errorCount: errors.length,
          data: body.data ?? null,
          errors,
        });
        return {
          dataHandles: [
            await context.writeResource("graphqlResult", "debug", result),
          ],
        };
      },
    },
  },
};
