# @gklijs/skilj

A swamp model for the REST surface of a running
[SkilJ](https://codeberg.org/gklijs/SkilJ) deployment. SkilJ is a Rust library
for event-sourced applications on Postgres that uses Dynamic Consistency
Boundaries (DCB) instead of fixed aggregates.

With this model a swamp workflow can trigger commands, check whether a command
would be accepted, read events with a client-tracked cursor or a
server-tracked consume cursor, acknowledge consumed events, feed events in
from outside systems, and report parked broker deliveries.

## Methods

| Method                | Route                         | Token kind             |
| --------------------- | ----------------------------- | ---------------------- |
| `triggerCommand`      | `POST /v1/commands/trigger`   | `CommandToken`         |
| `dryRunCommand`       | `POST /v1/commands/dry-run`   | `CommandToken`         |
| `fetchEvents`         | `GET /v1/events`              | `EventReadToken`       |
| `consumeEvents`       | `GET /v1/events/consume`      | `EventReadToken`       |
| `acknowledgeEvents`   | `POST /v1/events/consume/ack` | `EventReadToken`       |
| `ingestExternalEvent` | `POST /v1/events/external`    | `ExternalEventToken`   |
| `createDirectEvent`   | `POST /v1/events/direct`      | `DirectCreationToken`  |
| `reportParkedDelivery`| `POST /v1/parked-deliveries`  | `ExternalEventToken` or `CommandToken` |

SkilJ tokens are capability-scoped: one token covers one route kind for one
command or event type. Create one model instance per token. Calling a method
the token doesn't cover fails with `wrong_token_variant` (HTTP 403).

A command that `decide()` rejects is a normal outcome in SkilJ (HTTP 200), so
`triggerCommand` records it with `accepted: false` instead of failing. Use a
workflow assert or a CEL guard on `accepted` when a rejection should stop the
run.

`fetchEvents` is the client-tracked read: pass the previous `nextCursor` back
as `after` (plus its `epoch` when it isn't inside the cursor). `consumeEvents`
is the server-tracked alternative: the cursor lives in SkilJ, advances itself,
and nothing is passed back. Pick the first consume call's `mode` (`auto` moves
the cursor on, `manual` holds a claim until `acknowledgeEvents`); afterwards
the cursor's own mode applies and a different mode is refused. `manual` cursors
are single-consumer: a second consume while a claim is live gets an empty
batch.

`reportParkedDelivery` is a bridge's "I gave up retrying this inbound
delivery" report, authenticated with the same token the delivery itself used
(`kind` says which). `request` is the verbatim original POST body, and
`idempotencyKey` is the original `Idempotency-Key` header when there was one -
never together with a watermark `dedupe` cursor inside `request`.

Side-effect-free calls and writes protected by an idempotency key or dedupe
cursor retry transient failures (timeouts, HTTP 408/429/502-504) with
backoff, up to `maxRetries` (default 2). Unprotected writes are never
retried, so a retry can't store anything twice.

## Setup

Store the token (`<id>.<secret>`) in a vault, then create a model for it:

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

## Reports

Every method run emits `@gklijs/skilj-report`: a one-screen operator summary
(accepted/rejected, counts, stored sequences) with the
`swamp data get <model> <artifact>` pointer for the full resource.

## Data

- `commandResult` (instances `trigger` and `dryRun`): `accepted`,
  `triggeredEventSequences`, `rejectionReason`, `rejectionKind`,
  `deduplicated`, `correlationId`, `dryRun`.
- `events`: `events[]` (sequence, eventType, payload, tags, metadata), the
  event type's name, schema and schema version, `epoch`, `nextCursor`, `pages`
  and `truncated`.
- `consumedEvents` (instance `consume`): the same event-type envelope as
  `events` plus the `mode` the call consumed under and `count`.
- `ack` (instance `ack`): the acknowledged `sequence` and its `epoch`.
- `eventWrite` (instances `external` and `direct`): `sequence` and
  `redelivered`.
- `parkedDelivery` (instance `parked`): the stored delivery `id`, `kind`,
  `source` and `identifier`.

## License

MIT
