# @gklijs/skilj

Swamp models and bundled skills for the REST and GraphQL surfaces of a running
[SkilJ](https://github.com/gklijs/SkilJ) deployment. SkilJ is a Rust library for
event-sourced applications on Postgres that uses Dynamic Consistency Boundaries
(DCB) instead of fixed aggregates.

Targets **SkilJ 0.3.0**. The package includes `@gklijs/skilj` for REST
capability calls and `@gklijs/skilj-graphql` for Role-authenticated operations,
token issuance, command debugging and frontend schema discovery. The extension
uses CalVer (`2026.11.07.1`); that version is independent of SkilJ's release
number.

With this model a swamp workflow can trigger commands, check whether a command
would be accepted, read events with a client-tracked cursor or a server-tracked
consume cursor, acknowledge consumed events, feed events in from outside
systems, and report parked broker deliveries.

## Methods

| Method                 | Route                             | Token kind                             |
| ---------------------- | --------------------------------- | -------------------------------------- |
| `triggerCommand`       | `POST /v1/commands/trigger`       | `CommandToken`                         |
| `triggerCommands`      | `POST /v1/commands/trigger/batch` | `CommandToken`                         |
| `searchUsedTags`       | `GET /v1/events/tags`             | `EventReadToken`                       |
| `ingestExternalEvents` | `POST /v1/events/external/batch`  | `ExternalEventToken`                   |
| `dryRunCommand`        | `POST /v1/commands/dry-run`       | `CommandToken`                         |
| `fetchEvents`          | `GET /v1/events`                  | `EventReadToken`                       |
| `consumeEvents`        | `GET /v1/events/consume`          | `EventReadToken`                       |
| `acknowledgeEvents`    | `POST /v1/events/consume/ack`     | `EventReadToken`                       |
| `ingestExternalEvent`  | `POST /v1/events/external`        | `ExternalEventToken`                   |
| `createDirectEvent`    | `POST /v1/events/direct`          | `DirectCreationToken`                  |
| `reportParkedDelivery` | `POST /v1/parked-deliveries`      | `ExternalEventToken` or `CommandToken` |

SkilJ tokens are capability-scoped: one token covers one route kind for one
command or event type. Create one model instance per token. Calling a method the
token doesn't cover fails with `wrong_token_variant` (HTTP 403).

A trigger requiring approval returns `pendingApproval: true` and `proposalId`.
It has not stored command events; handle it separately from a rejection. An
admin approves or rejects proposals through GraphQL.

A command that `decide()` rejects is a normal outcome in SkilJ (HTTP 200), so
`triggerCommand` records it with `accepted: false` instead of failing. Use a
workflow assert or a CEL guard on `accepted` when a rejection should stop the
run.

`fetchEvents` is the client-tracked read: pass the previous `nextCursor` back as
`after` (plus its `epoch` when it isn't inside the cursor). `consumeEvents` is
the server-tracked alternative: the cursor lives in SkilJ, advances itself, and
nothing is passed back. Pick the first consume call's `mode` (`auto` moves the
cursor on, `manual` holds a claim until `acknowledgeEvents`); afterwards the
cursor's own mode applies and a different mode is refused. `manual` cursors are
single-consumer: a second consume while a claim is live gets an empty batch.

`reportParkedDelivery` is a bridge's "I gave up retrying this inbound delivery"
report, authenticated with the same token the delivery itself used (`kind` says
which). `request` is the verbatim original POST body, and `idempotencyKey` is
the original `Idempotency-Key` header when there was one - never together with a
watermark `dedupe` cursor inside `request`.

Batches return ordered per-item `outcomes`, including errors such as
`not_processed`. They are not atomic: inspect `failed`, `rejected` and `pending`
counts before continuing a workflow. External batches default to
`stopAtFirstFailure: true` to preserve source watermarks. The server enforces
its configured batch size; the extension does not split requests automatically.

Side-effect-free calls and writes protected by an idempotency key or dedupe
cursor retry transient failures (timeouts, HTTP 408/429/502-504) with backoff,
up to `maxRetries` (default 2). Unprotected writes are never retried. A batch
retries only when every item has its own protection. `consumeEvents` is never
automatically retried: its GET changes server cursor state and a lost response
could otherwise skip a batch. GraphQL operations are never automatically
retried.

## Setup

Store the token (`<id>.<secret>`) in an existing vault, then create a model for
it. Discover vaults with `swamp vault search --json`; a newly initialized Swamp
repo usually has `default`. If needed, create one with
`swamp vault create local_encryption my-vault --json`. `vault put` prompts with
hidden input; scripts can pipe a value on stdin without putting it in arguments:

```bash
swamp vault put my-vault skilj-withdraw-token
swamp model create @gklijs/skilj withdraw \
  --global-arg baseUrl=https://skilj.example.com \
  --global-arg 'token=${{ vault.get("my-vault", "skilj-withdraw-token") }}'
```

## Usage

Trigger a command with an idempotency key, so retries are deduplicated:

```bash
swamp model method run withdraw triggerCommand \
  --input '{"payload":{"wallet_id":"w1","amount":25},"idempotencyKey":"withdraw-w1-1"}'
```

Read events, following the cursor for up to five pages:

```bash
swamp model method run withdrawn-events fetchEvents \
  --input '{"filters":["amount:greater_than:100"],"maxPages":5}'
```

Continue from where the last read stopped in a workflow step:

```yaml
- name: read-more
  task:
    type: model_method
    modelIdOrName: withdrawn-events
    methodName: fetchEvents
    inputs:
      after: ${{ data.latest("withdrawn-events", "events").attributes.nextCursor }}
```

Or consume from the server-tracked cursor and acknowledge the batch:

```bash
swamp model method run withdrawn-events consumeEvents \
  --input '{"filters":["amount:greater_than:100"],"mode":"manual"}'
swamp model method run withdrawn-events acknowledgeEvents \
  --input '{"sequence":41}'
```

## GraphQL and token creation

GraphQL authenticates with an **IdP JWT resolving to an active SkilJ Role**, not
a REST capability token. The deployment must configure its identity provider.
Store the JWT in a vault and use the full endpoint URL:

```bash
swamp vault put my-vault skilj-role-jwt
swamp model create @gklijs/skilj-graphql skilj-admin \
  --global-arg endpoint=https://skilj.example.com/graphql \
  --global-arg 'token=${{ vault.get("my-vault", "skilj-role-jwt") }}'
```

| Method              | Purpose                                                                       | Resource          |
| ------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `execute`           | Query or mutation document with JSON `variables` and optional `operationName` | `graphqlResult`   |
| `introspect`        | Deployed schema, including generated projection types, inputs and enums       | `graphqlSchema`   |
| `debugCommand`      | Admin dry run with would-be events and matching history                       | `graphqlResult`   |
| `createAccessToken` | Issue a REST capability; requires an admin context mapping                    | `accessToken`     |
| `revokeAccessToken` | Revoke a capability by ID without returning its secret                        | `tokenRevocation` |
| `exportSchema`      | Standard introspection JSON file for frontend tools                           | `schemaExport`    |

`validateOperation` checks fields, selection sets, named operations and variable
values without executing a query or mutation. Run `introspect` first to capture
`graphqlSchema`, or supply `schemaSdl` / introspection `schema` explicitly:

```bash
swamp model method run skilj-admin introspect
swamp model method run skilj-admin validateOperation \
  --input '{"document":"query TypeName { __typename }","operationName":"TypeName"}'
swamp model method run skilj-admin exportSchemaSdl
```

Validation reuses the captured schema and makes **no network request**. Its
`operationValidation.valid` and `errorCount` are safe for workflow guards;
detailed errors are vault-protected because variable errors can include private
values. Validation cannot predict authorization, domain rejection, custom-scalar
semantics or concurrent server changes. Refresh introspection after changing the
deployment.

`exportSchemaSdl` writes sorted `schema.graphql` (`schemaSdl`), useful for type
generation and readable schema diffs. It can accept a captured `schema` to avoid
refetching. These methods use the pinned
[GraphQL.js reference implementation](https://www.graphql-js.org/api-v16/utilities/).

`exportSchema` writes a standard introspection envelope as the `schema.json`
file artifact (`schemaExport`), ready for GraphQL code generators. `introspect`
keeps the schema as a structured resource. `revokeAccessToken` revokes a
capability by ID and records its status without requesting its secret.

Before issuing a capability, ensure `.swamp.yaml` has `defaultVault` set to an
available output vault (new repositories normally use `default`). The JWT's
input vault and sensitive outputs' default vault can differ. Verify output vault
access before creation, since a token can be issued even if subsequently saving
its credential fails.

Issue a scoped capability token without printing its secret:

```bash
swamp model method run skilj-admin createAccessToken \
  --input '{"kind":"command","boundedContext":"Bank","typeName":"Withdraw","scope":"owner-1"}'
```

Kinds are `command`, `eventRead`, `externalEvent` and `directCreation`.
Event-read tokens also accept `startFrom`: `BEGINNING` (server default),
`LATEST`, `AT_SEQUENCE` with `startAtSequence`, or `AT_TIME` with an RFC3339
`startAtTime`. Invalid combinations are rejected before the creation request:

```bash
swamp model method run skilj-admin createAccessToken \
  --input '{"kind":"eventRead","boundedContext":"Bank","typeName":"Withdrawn","startFrom":"AT_SEQUENCE","startAtSequence":500}'
```

Once a replacement token has been stored and its consumers have switched over,
revoke the old token by its ID when retiring it is part of the requested work:

```bash
swamp model method run skilj-admin revokeAccessToken --input '{"tokenId":"old-token-id"}'
```

Revocation uses the caller's admin mapping on the token's context. It is never
automatically retried; the server reports authorization and already-revoked
outcomes. It does not delete vault entries or replace any consumer's credential.
`accessToken.credential` is sensitive: Swamp stores it through the output vault
before persisting data. A REST model can reference it directly:

```text
${{ data.latest("skilj-admin", "token-ISSUED_TOKEN_ID").attributes.credential }}
```

Replace `token-ISSUED_TOKEN_ID` with the resource name returned by creation.
Each issued token gets its own `token-<id>` resource and vault slot, so issuing
another token cannot overwrite an existing connection's credential. Retain that
exact resource name or vault reference for a long-lived connection. Existing
tokens can be stored and rotated with `swamp vault put`; no separate storage
extension is needed. Token creation isn't retried after ambiguous failures.

Generic GraphQL calls accept arbitrary documents and variables. Malformed or
ambiguous documents and selected subscriptions are rejected before any HTTP
request; subscription validation remains available through `validateOperation`.
GraphQL can return HTTP 200 with errors and partial data: check
`graphqlResult.succeeded` and `errorCount`. These method runs still complete
successfully so workflows can inspect their result. Add a CEL assertion on
`succeeded` when errors should stop the run. The generic `data` and `errors`
fields are vault-protected because they may include newly issued secrets or
private payloads. Reports omit them. The output vault must exist and be allowed
by any workflow `vaults:` list.

For frontend work, run `introspect` to capture `graphqlSchema.schema`. This is
the `__schema` object; wrap it as `{"__schema": ...}` for tooling that expects
an introspection result. Inspect the actual schema before writing operations:
generated projection fields depend on the application. Introspection must be
enabled. Browser clients should use IdP login with an appropriate Role; admin
JWTs and machine capability tokens belong outside public frontend bundles.

For a federated deployment, set `namingPrefix` to the prefix configured by SkilJ
(for example, `ledger`). Token creation, revocation and command debugging apply
SkilJ's root-field and type naming rules. Generic `execute` documents use the
deployed names exactly as written. HTTP queries and mutations are supported;
subscriptions need a separate WebSocket client.

## Proposals and explicit approval decisions

Use `listCommandProposals` to review an admin-scoped queue. It defaults to
`PENDING`, supports a command-type filter, and follows cursors for up to
`maxPages`. Choose `status: "ALL"` for decided, expired or forgotten proposals:

```bash
swamp model method run skilj-admin listCommandProposals \
  --input '{"boundedContext":"Bank","commandTypeName":"Withdraw","maxPages":3}'
```

The `proposals` artifact contains metadata, counts, `nextCursor` and
`truncated`. A non-empty final page at the configured cap means more may follow.
Continue with that cursor and the same filters. Listings are not a
transactionally consistent snapshot while proposals are being decided.

Payloads are omitted from the request by default. With `includePayloads: true`,
the method emits separate `proposal-<id>` artifacts with vault-protected payload
and rejection reason. Each proposal has its own vault slot, so reordering a page
cannot replace another proposal's private data. The summary list remains free of
payloads. GraphQL proposal payloads are JSON strings.

When the requested work includes deciding a **specific proposal**, use:

```bash
swamp model method run skilj-admin approveCommand \
  --input '{"boundedContext":"Bank","proposalId":"PROPOSAL_ID"}'
swamp model method run skilj-admin rejectCommand \
  --input '{"boundedContext":"Bank","proposalId":"PROPOSAL_ID","reason":"Duplicate request"}'
```

Choose the appropriate action; these are alternatives. The Role needs the
server's required admin mapping and any configured approver role. Listing a
proposal never approves it. These mutations are never automatically retried; a
timeout can leave a completed decision, so inspect the proposal before
submitting another decision. The extension does not relax self-approval policy.

A successful `approveCommand` call can still return `accepted: false`: SkilJ
runs the command's current domain rules at approval time. Inspect
`decision-<id>.accepted`, `status` and `triggeredEventSequences`, and guard on
acceptance before depending on events. Rejection reasons are vault-protected;
reports show outcomes and counts.

## Schema compatibility for frontend changes

`compareSchema` compares the captured `schema` baseline with a fresh read of the
running deployment. It **does not overwrite** that baseline:

```bash
swamp model method run skilj-api introspect
# After an independently authorized deployment change:
swamp model method run skilj-api compareSchema
```

Or supply `before` and `after` explicitly as SDL strings or introspection JSON
(raw schema, `__schema` result or HTTP envelope). With both supplied, comparison
makes no HTTP requests. Sorted schemas avoid flagging definition ordering alone
as a change.

Read `data.latest("skilj-api", "schemaDiff").attributes`: `changed` indicates
any printed schema change, `compatible` means no known breaking changes, and
`breakingCount`/`dangerousCount` distinguish breaks from potentially risky
changes such as enum additions or changed argument defaults. Gate on both
`compatible` and `dangerousCount == 0` when the frontend requires stricter
review. Descriptions of individual changes are vault-protected because
default-value diffs can include private values. Reports contain only summary
counts.

Compatibility analysis does not detect resolver behavior, authorization changes
or custom-scalar semantics. Refresh the baseline with `introspect` deliberately
after reviewing an accepted change, rather than losing it during comparison.

## Debugging

Use a REST dry run for acceptance only. With a GraphQL admin model, inspect the
would-be events and the scoped history used in the decision:

```bash
swamp model method run skilj-admin debugCommand \
  --input '{"boundedContext":"Bank","commandTypeName":"Withdraw","payload":{"wallet_id":"w1","amount":25}}'
```

The result includes `matchingEventsTruncated`; matching history is scoped and
capped. A separate, non-sensitive `commandSummary` exposes acceptance, would-be
and matching event counts, and history truncation for reports and CEL guards. It
is null on ordinary `execute` results or GraphQL errors. A dry run reserves
nothing and does not guarantee a later trigger.

On either model, `debug: true` logs HTTP method, route, attempt, status and
elapsed milliseconds. View these with `--log --show-properties`. Request
diagnostics omit headers, query values and bodies; domain-outcome logs and
server error messages can still include business values. Requests automatically
propagate Swamp's W3C trace headers. Optional `traceparent` (version 00) and
`tracestate` globals can override that context. An explicit parent does not
inherit an unrelated tracestate. Domain `correlationId` remains separate.

Swamp cancellation aborts in-flight requests and retry waits immediately.
Retryable REST calls honor `Retry-After` seconds and HTTP dates. If the server
asks for more than 30 seconds, the method surfaces the HTTP error instead of
retrying early. GraphQL HTTP error messages withhold response bodies, since
those may contain credentials or private fields.

For REST history inspection:

```bash
swamp model method run withdrawn-events fetchEvents \
  --input '{"correlationId":"order-123","upToSequence":500,"maxPages":5}'
swamp model method run withdrawn-events searchUsedTags \
  --input '{"key":"wallet_id","prefix":"w","limit":20}'
```

`upToSequence` reads history as known at that sequence, inclusive. Tag discovery
uses a literal prefix, and both methods respect the token's event type and owner
scope. Keep the same as-of bound when following `nextCursor` across runs.

## Reusable command verification

`@gklijs/skilj-command-and-verify` accepts `commandModel`, `eventsModel`, an
arbitrary structured `payload`, and a stable `idempotencyKey`. It dry-runs the
command, triggers it, checks acceptance and emitted sequences, then asserts that
the reader actually returned an event produced by that command. A reader
pointing to the wrong type or owner scope fails verification. The existing
`@gklijs/withdraw-and-verify` example now performs the same sequence assertion.
Neither workflow approves pending proposals automatically.

For example, supply these workflow inputs using
`swamp workflow run
@gklijs/skilj-command-and-verify --stdin`:

```json
{
  "commandModel": "withdraw",
  "eventsModel": "withdrawn-events",
  "payload": { "wallet_id": "w1", "amount": 25 },
  "idempotencyKey": "withdraw-w1-25-1"
}
```

Event reads require both an event-read token **and** the registered event type's
`eventReadAllowed` opt-in. `event_read_not_allowed` is a server configuration
outcome, not a missing token. Configure this intentionally in the application;
issuing a token does not enable public reads for its type.

Event and consume responses must contain a valid envelope. The client rejects
missing batches, epochs and schema fields, duplicated/out-of-order sequences,
regressing or wrong-epoch cursors, and unsafe numeric sequences. Sequences are
safe JavaScript integers; larger ones are refused rather than rounded into an
incorrect acknowledgement. HTTP redirects are refused so a POST's private body
is not forwarded to another endpoint.

## Bundled skills

Installed with the extension, following the same packaging as `@gklijs/vados`:

- `skilj-setup`: credentials, vault storage/rotation and capability issuance.
- `skilj-workflows`: outcome guards, ordered batches, cursors and
  acknowledgements.
- `skilj-debug`: HTTP tracing, command decisions and historical reads.
- `skilj-frontend`: schema export, operation design and browser authentication.

## Reports

Every method run emits `@gklijs/skilj-report`: a one-screen operator summary
(accepted/rejected, counts, stored sequences) with the
`swamp data get <model> <artifact>` pointer for the full resource.

## Referencing results in CEL

`data.latest(model, name)` takes the **artifact name**, which can differ from
its resource spec. Use `"dryRun"` for a REST dry run and `"trigger"` for a
trigger; both have spec `commandResult`. Similarly, GraphQL results use
`"graphql"` or `"debug"`, validation uses `"validation"`, and introspection uses
`"schema"`. Use `data.findBySpec(model, spec)` to enumerate a spec's records.
Token artifacts have a unique `token-<id>` name.

```text
${{ data.latest("withdraw", "trigger").attributes.accepted }}
${{ data.latest("skilj-admin", "validation").attributes.valid }}
```

## Data

- `commandResult` (instances `trigger` and `dryRun`): `accepted`,
  `triggeredEventSequences`, `rejectionReason`, `rejectionKind`, `deduplicated`,
  `correlationId`, `dryRun`, `pendingApproval`, `proposalId`.
- `events`: `events[]` (sequence, eventType, payload, tags, metadata), the event
  type's name, schema and schema version, `epoch`, `nextCursor`, `pages` and
  `truncated`.
- `consumedEvents` (instance `consume`): the same event-type envelope as
  `events` plus the `mode` the call consumed under and `count`.
- `ack` (instance `ack`): the acknowledged `sequence` and its `epoch`.
- `eventWrite` (instances `external` and `direct`): `sequence` and
  `redelivered`.
- `parkedDelivery` (instance `parked`): the stored delivery `id`, `kind`,
  `source` and `identifier`.

- `batchCommands` (instance `commands`): ordered `outcomes`, `count`,
  `accepted`, `rejected`, `pending`, `failed`.
- `batchEvents` (instance `externalBatch`): ordered `outcomes`, `count`,
  `stored`, `redelivered`, `failed`.
- `usedTags` (instance `tags`): `key`, `prefix`, `tags[]`, `count`, `truncated`
  (`true` when the requested limit was hit; otherwise `null` because the server
  provides no completeness/continuation signal).
- `graphqlResult` (instances `graphql` and `debug`): `succeeded`, `errorCount`,
  `commandSummary` (nullable), sensitive `data` and `errors`.
- `tokenRevocation` (instance `revocation`): `id`, `tokenType`, `status`,
  `revokedAt`.
- `schemaExport` (file `schema.json`): standard `data.__schema` introspection
  JSON.
- `graphqlSchema` (instance `schema`): the introspected `schema` object.
- `accessToken` (instance `token-<issued-id>`): `id`, `kind`, `boundedContext`,
  `typeName`, sensitive `credential` in `<id>.<secret>` form.

- `schemaSdl` (file `schema.graphql`): sorted schema definition language.
- `operationValidation` (instance `validation`): `valid`, `errorCount`,
  `operationType`, `operationName`, sensitive `errors`.
- `schemaDiff` (instance `schemaDiff`): `changed`, `compatible`,
  `breakingCount`, `dangerousCount`, sensitive `breakingChanges` and
  `dangerousChanges`.
- `commandProposals` (instance `proposals`): metadata `proposals[]`, `count`,
  `pages`, `nextCursor`, `truncated`, and the applied context/type/status
  filters.
- `proposalDetails` (instance `proposal-<id>`): metadata plus sensitive
  `payload` and `rejectionReason`, emitted only when requested.
- `proposalDecision` (instance `decision-<id>`): `action`, `proposalId`,
  context, command type, `status`, `accepted`, `triggeredEventSequences`,
  `rejectionKind`, sensitive `rejectionReason`.

## Development

Use the bundled Deno executable, or a compatible Deno 2 installation:

```bash
~/.swamp/deno/deno task test
~/.swamp/deno/deno task check
~/.swamp/deno/deno task lint
~/.swamp/deno/deno task fmt:check
swamp workflow validate @gklijs/skilj-command-and-verify --json
swamp extension quality manifest.yaml --json
```

Unit tests mock HTTP responses. The GraphQL reference library reads `NODE_ENV`,
so the test task grants that one environment read. Inline versioned imports are
intentional: Swamp bundles extensions independently of this repository's Deno
configuration. The lockfile makes local tests reproducible; the published
GraphQL dependency is pinned in its import.

For the live contract test, use Docker with a cached `postgres:17-alpine` image
and a **SkilJ v0.3.0 demo server binary**, built in the SkilJ checkout with
`cargo build --locked -p skilj-demo --bin server`:

```bash
python3 scripts/test-live.py --server /path/to/SkilJ/target/debug/server
```

The runner creates and cleans up its own Postgres container and temporary Swamp
repository. It starts the demo with a test IdP, uses generated credentials, opts
only its fixture event types into REST reads, and exercises both direct clients
and Swamp's bundled runtime. Coverage includes schema/SDL export, offline
validation, token creation/revocation, idempotent and batched commands,
historical reads, tag discovery, manual consume/ack and the command verification
workflow. The default prefix is `ledger`; use `--prefix ''` to exercise
unprefixed names. It never connects to an existing application's database.

The live test was run against the local SkilJ 0.3.0 demo and PostgreSQL 17.

## License

MIT
