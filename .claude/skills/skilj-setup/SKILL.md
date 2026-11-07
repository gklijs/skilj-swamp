---
name: skilj-setup
description: >
  Set up @gklijs/skilj in Swamp, store or rotate SkilJ tokens in vaults,
  create REST capability tokens through GraphQL, and connect a Role JWT.
  Use for SkilJ authentication and token setup, not unrelated secret storage.
---

# SkilJ connections and tokens

This extension targets SkilJ 0.3.0. Discover existing definitions with
`swamp model search --json` and vaults with `swamp vault search --json` before
creating anything. Inspect model arguments with
`swamp model type describe @gklijs/skilj --json` or
`swamp model type describe @gklijs/skilj-graphql --json`. Confirm CLI details
with `swamp help <command>` when needed.

## Choose the credential

- REST model `@gklijs/skilj`: a capability token in `<id>.<secret>` form. One
  model per token, event/command type and owner scope. Command tokens cover
  trigger, batch trigger and REST dry run; event-read tokens cover fetch,
  consume, ack and tag discovery. External and direct writes have separate
  kinds.
- GraphQL model `@gklijs/skilj-graphql`: an IdP JWT resolving to an active SkilJ
  Role. The deployment needs its identity provider configured. A REST capability
  token cannot authenticate GraphQL. Admin operations need an admin mapping on
  the bounded context; frontend reads can use a Role with read access.

## Store an existing credential

Reuse an appropriate existing vault (often `default`). If none exists, scaffold
one with `swamp vault create local_encryption skilj --json`; don't hand-author
vault IDs. Have the user enter the secret through the hidden prompt:

```bash
swamp vault put default skilj-withdraw-token
swamp model create @gklijs/skilj withdraw \
  --global-arg baseUrl=https://skilj.example.com \
  --global-arg 'token=${{ vault.get("default", "skilj-withdraw-token") }}'
```

For automation, pipe the value from its authorized source on stdin to
`swamp vault put`; avoid literal credentials in command arguments, chat,
checked-in YAML or reports. Use `swamp vault list-keys default --json` to check
presence without reading values. For rotation, replace the same key so existing
model references resolve the new value. Local encryption secrets are per
machine; a clone does not contain them. A workflow with a `vaults:` allow-list
must include all vaults used by the models and sensitive outputs.

For GraphQL, store the JWT similarly, then create:

```bash
swamp model create @gklijs/skilj-graphql skilj-admin \
  --global-arg endpoint=https://skilj.example.com/graphql \
  --global-arg 'token=${{ vault.get("default", "skilj-role-jwt") }}'
```

`endpoint` is the complete URL, including any proxy prefix. `baseUrl` on the
REST model is the prefix before `/v1`. Use separate definitions for different
roles.

## Issue a REST token from GraphQL

Before issuance, check that `.swamp.yaml` names an available `defaultVault` for
sensitive outputs, and that it is allowed by the workflow's vault list. An input
JWT in one vault does not configure the output vault. If saving a newly issued
credential fails, inspect the server and retire the unused token before issuing
a replacement; do not assume the mutation was rolled back.

When token issuance is in the user's requested scope, run `createAccessToken` on
an authorized GraphQL model. It creates a real capability, so choose the
required kind, bounded context, type and optional owner scope; avoid issuing
broader capabilities than the task calls for.

```bash
swamp model method run skilj-admin createAccessToken \
  --input '{"kind":"command","boundedContext":"Bank","typeName":"Withdraw","scope":"owner-1"}'
```

Kinds: `command`, `eventRead`, `externalEvent`, `directCreation`. The result's
`accessToken.credential` is marked sensitive: Swamp stores it in the configured
output vault before persisting the resource. Wire the protected field to a REST
model's token argument without printing it:

```text
${{ data.latest("skilj-admin", "token-ISSUED_TOKEN_ID").attributes.credential }}
```

Replace `token-ISSUED_TOKEN_ID` with the exact artifact name returned by the
creation run. Each capability has its own `token-<id>` resource and vault slot,
so creating another capability cannot overwrite its credential. Keep that
specific record name or vault reference for long-lived connections. Enumerate
stored token artifacts with `data.findBySpec("skilj-admin", "accessToken")`;
`data.latest` takes an artifact name, not the spec name. Issuance is never
retried: a timeout can mean the token was created but the response was lost.
Inspect the server before issuing another.

## Start an event reader at the right position

`createAccessToken` with `kind: eventRead` accepts `startFrom`: `BEGINNING`,
`LATEST`, `AT_SEQUENCE` (requires only `startAtSequence`), or `AT_TIME`
(requires only RFC3339 `startAtTime`). Omitted means the server's beginning
default. Start options on other token kinds and conflicting options are refused
locally.

## Retire a capability

When the user requests token retirement or rotation, switch and verify consumers
before revoking the old capability. Call `revokeAccessToken` with the **old
token ID**, using a Role with an admin mapping on that token's context. The
method records `tokenRevocation` without requesting the secret. It does not
remove vault entries or update consumers, and never retries automatically. Do
not revoke an existing token merely because a replacement was created.

For a prefixed federation schema, set the GraphQL model's `namingPrefix` to the
server's configured prefix, e.g. `ledger`. Built-in token and debug methods
apply the server's field/type naming rules. Generic `execute` documents must use
the deployed names themselves. Use `listCommandProposals`, `approveCommand` and
`rejectCommand` for approval operations. Listing does not grant permission to
decide a proposal; a Role with the required admin/approver mapping must perform
the explicitly requested action.

A valid event-read capability does not enable reads on a disabled event type.
`event_read_not_allowed` means the application registration needs an intentional
`eventReadAllowed` opt-in. Do not keep issuing replacement tokens or change type
permissions merely to suppress that error.
