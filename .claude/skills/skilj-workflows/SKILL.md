---
name: skilj-workflows
description: >
  Build Swamp workflows with @gklijs/skilj: commands and approvals, ordered
  batches, event pagination, manual acknowledgement and external ingestion.
  Use when orchestrating SkilJ calls or wiring their result data in Swamp.
---

# SkilJ workflows

Inspect the installed model schema before authoring a workflow. Use Swamp's YAML
DAG and validate it with `swamp workflow validate <name>` before executing it.
For vault-backed connections, load the sibling `skilj-setup` skill when
available.

`data.latest` takes the artifact name, not its spec: REST command results use
`dryRun` and `trigger`; GraphQL results use `graphql` and `debug`; validation
uses `validation`; consumed batches use `consume`. Use `data.findBySpec` when
you actually need to enumerate every record of a spec.

## Branch on business outcomes

A successful HTTP request or method run does not mean a command was accepted.
Read `data.latest("<model>", "trigger").attributes`:

- `pendingApproval: true`: no command events stored; `proposalId` identifies the
  proposal awaiting an administrator's decision through GraphQL.
- `accepted: false` without pending approval: business rejection; inspect
  `rejectionKind` and `rejectionReason`.
- `accepted: true`: use `triggeredEventSequences` and `correlationId` to verify
  the result. `deduplicated: true` means replay of an earlier accepted outcome.

A REST `dryRunCommand` predicts acceptance but reserves nothing; concurrent
changes and approval policies still affect the subsequent trigger. Put
assertions on the trigger's `accepted` result when the workflow needs stored
events.

Use a stable, operation-specific `idempotencyKey` for a trigger that may be
retried. Do not reuse that key for a different payload.

## Batch without losing per-item failures

`triggerCommands` accepts `commands[]`, each with its own payload, optional
idempotency key and trace IDs. `ingestExternalEvents` accepts `events[]`, each
in the single-ingestion argument shape. Both accept `stopAtFirstFailure` and
return one ordered `outcomes[]` entry per input. A batch is not an atomic
transaction.

Resources `batchCommands` and `batchEvents` contain `failed`; command batches
also contain `accepted`, `rejected`, `pending`, and event batches `stored`,
`redelivered`. Per-item HTTP errors have `{error:{status,code,message}}`;
`not_processed` means skipped after a prior failure. Assert the required counts
instead of relying on the method's run status. Command business rejections
remain outcomes, not HTTP errors.

The server enforces its configured item limit; the extension does not split a
batch silently. Automatic transient retries require protection on every item:
command idempotency keys, or external-event keys/dedupe watermarks. A top-level
HTTP idempotency key does not cover a batch. External batches default to
`stopAtFirstFailure: true` so a later source watermark cannot skip a failed
event. Keep source partitions in their original order.

## Pick the cursor ownership

`fetchEvents` is a read: it follows `nextCursor` for up to `maxPages`. Continue
with the returned `events.nextCursor`; it includes the epoch. Keep filters,
correlation ID and any `upToSequence` bound consistent when continuing a read.
`truncated: true` means another page may follow, not that one is guaranteed. A
changed epoch invalidates the old position; inspect the reset before restarting.

`consumeEvents` changes a server cursor, even though it uses GET. Choose `auto`
or `manual` on its first call; subsequent calls use that cursor's mode. An auto
call advances before downstream processing. A manual call holds a claim until
acknowledged or the claim lease expires. Only one consumer gets a live manual
claim; another call may return an empty batch.

For reliable processing: consume manually, process each event idempotently, then
call `acknowledgeEvents` with the last successfully handled sequence and the
**epoch from that consumed batch**. Don't acknowledge failed downstream work.
The extension never retries consume automatically; a lost response must not skip
a batch. A repeated acknowledgement of the same sequence is safe to retry.

Use resources already emitted by earlier steps through CEL; don't refetch events
only to reconstruct data the run already has.

## GraphQL in a workflow

`execute` and `debugCommand` record `graphqlResult.succeeded` and `errorCount`.
Assert `succeeded` before depending on their data: GraphQL may return HTTP 200
with errors and partial data. Business rejection inside `dryRunCommand` is still
separate from GraphQL operation success. Generic GraphQL data/errors and created
credentials are vault-protected; use structured references for downstream calls.

For admin dry runs, `graphqlResult.commandSummary.accepted` distinguishes domain
acceptance from operation success without loading private history. Guard on
`succeeded` first because the summary is null when GraphQL returns errors.

Use bundled `@gklijs/skilj-command-and-verify` when a workflow should verify an
arbitrary command payload. It asserts that the event reader saw an emitted
sequence, rather than treating any successful read as proof of the command.
Choose an event-read token for the expected emitted type and owner scope. An
accepted command producing no events fails this verification intentionally.

For frontend checks, `validateOperation` writes `operationValidation.valid`;
assert it before continuing. It checks against the captured schema without
executing the operation and does not guarantee server authorization.

## Review and decide command proposals

`listCommandProposals` defaults to `PENDING`; supply `boundedContext`,
optionally `commandTypeName`, and bounded `maxPages`. Read the `proposals`
artifact's metadata and `truncated`. Continue with `after: nextCursor` and
unchanged filters. `status: ALL` includes decided/expired/forgotten proposals. A
changing queue is not a consistent snapshot across pages.

Only request `includePayloads: true` when payload inspection is needed. Private
fields are saved in separate `proposal-<id>` artifacts rather than indexed vault
slots inside the list, so list ordering cannot mix proposal payloads. Payloads
are JSON strings, not structured REST objects.

Call `approveCommand` or `rejectCommand` only when the user's task includes that
specific decision. Use the proposal ID and bounded context. The server enforces
approver Role and self-approval restrictions. Do not approve every listed item,
relax its policy, or treat a pending trigger as permission to approve it.

Read `data.latest("<admin>", "decision-" + inputs.proposalId).attributes` for
the outcome. Approval re-runs domain rules: a successful API call may still have
`accepted: false`. Guard on that flag before depending on emitted sequences.
Rejection reasons are protected. These decision mutations never retry; after an
ambiguous transport failure inspect proposal state before deciding again.
