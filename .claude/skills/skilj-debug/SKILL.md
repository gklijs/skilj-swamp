---
name: skilj-debug
description: >
  Diagnose SkilJ 0.4.0 calls with @gklijs/skilj and @gklijs/skilj-graphql:
  dry runs, DCB matching history, correlation traces, historical reads,
  GraphQL errors and schema introspection for frontend development.
---

# Debugging SkilJ and exploring its GraphQL API

Inspect the failed method's `@swamp/method-summary` and `@gklijs/skilj-report`
first; confirm retrieval syntax with `swamp help report get`. Distinguish
transport failure, authorization error, command rejection and pending approval.
An HTTP 200 can contain a business rejection or GraphQL errors.

## Safe failure guidance

Read the report's diagnostic category, sanitized status/code, next step and
write/cursor uncertainty before choosing another operation. Diagnostics classify
only known 0.4.0 codes and standard transport statuses. Unknown failures stay
`unknown`; never infer authentication validity or expiry from decoded JWT
claims. Use the
[troubleshooting table](https://github.com/gklijs/skilj-swamp#troubleshooting)
and its tagged server-source links for the exact contract.

- `wrong_capability`: select the required capability kind and scope.
- `reads_disabled`: have the deployment operator review `eventReadAllowed`;
  minting another read capability does not enable reads.
- `authentication` / `authorization`: check the vault credential, trusted IdP,
  active Role/token and grant/scope with the authorized administrator.
- `epoch_changed`: reconcile checkpoint and epoch before reading/consuming or
  acknowledging again. Never blindly replace an old checkpoint.
- `rate_limit`, `timeout`, `unavailable`: check authorized telemetry and honor
  Retry-After and the method's existing retry policy.

An uncertain write may already have taken effect. Reconcile first. Retain the
original payload and idempotency key or dedupe identity for any authorized
retry; never generate a new key to retry an old operation. Reconcile an
unprotected write before replay. A lost consume response may advance the cursor
or acquire a claim; inspect served events and checkpoint state before another
consume. GraphQL mutations may partially take effect despite errors; no GraphQL
method retries automatically. Do not run diagnostic probes that trigger commands
or advance consume cursors.

Failures before a normal artifact exists use a closed safe metadata envelope in
Swamp's supported report `errorMessage` context. GraphQL `execute` and
`debugCommand` also expose sanitized `diagnostics[]` alongside protected raw
`data`/`errors`. Built-in methods still throw on GraphQL errors. Reports never
echo arbitrary error text, GraphQL extensions, batch messages or private
rejection reasons. Inspect the existing data pointers only when authorized.

## REST diagnostics

Set the model's `debug: true`, then run with Swamp's `--log --show-properties`
options. HTTP diagnostics contain method, route, attempt, status and elapsed
milliseconds, excluding headers, query values and request/response bodies. A
null status means the request failed before response headers arrived. Rejection
logs and failure summaries omit private reasons and response bodies; use the
result data pointers for deeper authorized inspection.

Requests inherit Swamp's W3C trace context automatically. To override it,
provide a valid `traceparent` and optional `tracestate` in global arguments. An
explicit parent does not inherit a tracestate from a different trace. These are
transport trace headers; `correlationId` and `causationId` are separate domain
metadata.

For stored command events, use `fetchEvents` on the relevant event-read model
with `correlationId`. This token only sees its own event type and owner scope;
it is not a whole-system trace. `searchUsedTags` discovers visible values for a
tag key using a literal prefix (not a wildcard). Its `truncated` is true when
the requested limit is reached, otherwise null: the server supplies no total or
continuation cursor, so a short suggestion list does not prove completeness.
`upToSequence` on `fetchEvents` reads what was known at that sequence,
inclusive, including SkilJ's correction and retraction semantics. Keep the bound
across subsequent page calls.

## Explain a command with GraphQL

REST `dryRunCommand` reveals only acceptance/rejection. For matching history and
would-be events, use `debugCommand` on `@gklijs/skilj-graphql` with an admin
Role:

```bash
swamp model method run skilj-admin debugCommand \
  --input '{"boundedContext":"Bank","commandTypeName":"Withdraw","payload":{"wallet_id":"w1","amount":25}}'
```

This sends a read-only `dryRunCommand` query, converting the structured payload
to the JSON **string** the GraphQL argument expects. The protected result data
contains `dryRunCommand.accepted`, `rejectionReason`, `rejectionKind`, `events`
(would-be events), `matchingEvents` and `matchingEventsTruncated`. Matching
history is scoped and capped; an empty or truncated set isn't proof that no
conflicting events exist outside that result.

Use `graphqlResult.commandSummary` for acceptance, would-be event count,
matching event count and the history truncation flag without opening the
protected data. A GraphQL success does not mean the dry-run command was
accepted. On GraphQL errors the summary is null; inspect `errorCount` first.

For federation prefixes, set the GraphQL model's `namingPrefix`; built-in debug
and token operations apply SkilJ's naming rules. Custom `execute` documents must
use deployed names.

## Explore a frontend API

Run `exportSchema` to produce a standard introspection JSON file (`schema.json`)
for frontend tools. Use `introspect` to capture `graphqlSchema.schema` as a
resource. The stored object is `__schema`; wrap it as `{"__schema": ...}` for
tools that accept an introspection result (or `{"data":{"__schema": ...}}` for
an HTTP envelope). Inspect query fields, generated projection types, argument
types, input objects, enums and nullability before writing frontend operations.
The deployed schema reflects registered application types; don't invent generic
projection names. Introspection must be enabled by the server.

Use `execute` with `document`, structured `variables`, and `operationName` when
needed. Do not concatenate user values into a GraphQL document. Read
`graphqlResult.succeeded` and `errorCount` before using partial data. Data and
error arrays are stored through Swamp's vault; reports deliberately omit their
contents. An operation's success does not imply a domain command was accepted.
No GraphQL operation is automatically retried, including token creation.

For a browser frontend, use the application's IdP login and an appropriately
scoped Role JWT. Keep admin JWTs and issued machine capability credentials out
of public JavaScript bundles. The Swamp model is an operator/development client,
not a browser authentication proxy. Subscriptions require a GraphQL WebSocket
client (`graphql-transport-ws`); the model supports HTTP queries and mutations.

Swamp cancellation stops request bodies and retry waits. REST retries respect
`Retry-After`; requests asking for more than 30 seconds surface their HTTP error
so the caller can schedule a later attempt. GraphQL HTTP errors withhold
response bodies, including malformed success bodies. Inspect authorized server
telemetry for transport failures; a parsed HTTP 200 GraphQL error envelope
remains available through the protected result.

Treat malformed event envelopes and cursor/sequence errors as failures rather
than empty history. They can indicate a wrong proxy response or a broken server
contract. The extension rejects unsafe integer sequences before persisting a
batch; do not round a large sequence to fit an acknowledgement. Redirects are
refused for private POST bodies: configure the final endpoint URL explicitly.
Use `validateOperation` against a captured schema for field/variable problems
before executing a GraphQL operation.

When wiring CEL, use artifact names: `data.latest("<admin>", "debug")` for a
debug result and `data.latest("<admin>", "validation")` for validation. The spec
names `graphqlResult` and `operationValidation` are not data.latest keys.

For a command awaiting approval, use `listCommandProposals` on its admin
context. Do not retry the original trigger in an attempt to bypass approval.
Inspect the specific proposal with `includePayloads: true` when authorized;
private details live in `proposal-<id>`, while the `proposals` list contains
metadata. An approval may be rejected by domain rules at decision time; read
`decision-<id>.accepted`. Use `compareSchema` to investigate a frontend contract
regression while keeping the previously captured schema intact.
