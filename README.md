# @gklijs/skilj

A swamp model for the REST surface of a running
[SkilJ](https://codeberg.org/gklijs/SkilJ) deployment. SkilJ is a Rust library
for event-sourced applications on Postgres that uses Dynamic Consistency
Boundaries (DCB) instead of fixed aggregates.

With this model a swamp workflow can trigger commands, check whether a command
would be accepted, read events, and feed events in from outside systems.

## Methods

| Method                | Route                         | Token kind             |
| --------------------- | ----------------------------- | ---------------------- |
| `triggerCommand`      | `POST /v1/commands/trigger`   | `CommandToken`         |
| `dryRunCommand`       | `POST /v1/commands/dry-run`   | `CommandToken`         |
| `fetchEvents`         | `GET /v1/events`              | `EventReadToken`       |
| `ingestExternalEvent` | `POST /v1/events/external`    | `ExternalEventToken`   |
| `createDirectEvent`   | `POST /v1/events/direct`      | `DirectCreationToken`  |

SkilJ tokens are capability-scoped: one token covers one route kind for one
command or event type. Create one model instance per token. Calling a method
the token doesn't cover fails with `wrong_token_variant` (HTTP 403).

A command that `decide()` rejects is a normal outcome in SkilJ (HTTP 200), so
`triggerCommand` records it with `accepted: false` instead of failing. Use a
workflow assert or a CEL guard on `accepted` when a rejection should stop the
run.

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

## Data

- `commandResult` (instances `trigger` and `dryRun`): `accepted`,
  `triggeredEventSequences`, `rejectionReason`, `rejectionKind`,
  `deduplicated`, `correlationId`, `dryRun`.
- `events`: `events[]` (sequence, eventType, payload, tags, metadata), the
  event type's name, schema and schema version, `epoch`, `nextCursor`, `pages`
  and `truncated`.
- `eventWrite` (instances `external` and `direct`): `sequence` and
  `redelivered`.

## License

MIT
