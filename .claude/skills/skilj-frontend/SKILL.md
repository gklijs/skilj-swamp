---
name: skilj-frontend
description: >
  Explore a SkilJ GraphQL API for frontend development using @gklijs/skilj-graphql:
  export its schema, design typed operations, inspect generated projections and
  connect browser authentication. Use for a SkilJ-backed frontend, not generic
  website building or SkilJ server deployment.
---

# Frontends backed by SkilJ

Use the deployed schema as the contract. SkilJ generates projection types from
registered application types; field names, filters and nullability are specific
to the running application.

## Export the contract

On an existing `@gklijs/skilj-graphql` model, run:

```bash
swamp model method run skilj-api exportSchema
```

The `schemaExport` file artifact named `schema.json` contains the standard
`{"data":{"__schema": ...}}` introspection envelope. Feed its downloaded/local
file to the frontend project's GraphQL code generator; keep the exported schema
with that project's normal generated-artifact conventions. No JWT is included.
The schema can contain domain descriptions, so follow the project's existing
rules about committing or publishing it. Use `introspect` instead when a Swamp
workflow needs the schema as structured `graphqlSchema.schema` data.

Inspect the schema's query fields, generated projection types, arguments, input
objects, enums and nullability before proposing operations. Use the project's
existing GraphQL client and code generator if present; don't replace its stack
merely to connect SkilJ. If introspection is disabled, obtain the approved
schema artifact rather than attempting to change server settings.

For SDL-based tooling, `exportSchemaSdl` emits sorted `schema.graphql`. It can
reuse a supplied introspection `schema`; otherwise it captures the deployment.

## Validate before exercising an operation

Run `introspect`, then `validateOperation` with a document, optional
`operationName` and structured variables. Validation reuses the stored schema
without network calls or resolver execution. It checks field names, selection
sets, input values and variable requirements. Alternatively provide `schemaSdl`
or introspection `schema` (raw schema, `__schema` result, or HTTP envelope). Do
not supply both schema formats. On a schema change, refresh the captured
contract before validating again.

Inspect `operationValidation.valid` and `errorCount` via the artifact:
`data.latest("skilj-api", "validation").attributes.valid`. `data.latest` takes
the artifact name (`validation`), not the spec name (`operationValidation`).
Detailed diagnostics are vault-protected: invalid variable values may appear in
errors. A valid document can still fail authorization or domain rules when
executed. Subscription operations can be validated, but HTTP `execute` refuses
them.

## Exercise the intended operation

Use `execute` with a named document and structured `variables`, then inspect
`graphqlResult.succeeded` and `errorCount`. HTTP 200 with errors can still carry
partial data. Never concatenate user inputs into the GraphQL source text.
GraphQL command payloads often use a JSON **string**, while REST expects a JSON
object: confirm the deployed argument type and serialize exactly once.

Generic result `data` and `errors` are vault-protected and are suitable for
structured downstream references. Do not paste private fixture data into public
frontend source or storybook examples. Create or execute mutations only when the
requested work includes those side effects; schema discovery alone does not
require submitting a domain command.

For federation, introspection returns the actual deployed names. `namingPrefix`
on the Swamp model applies only to its built-in token/debug methods; documents
sent to `execute` use their own explicit field names.

## Connect the browser

Use the application's IdP login flow and a Role JWT with the access the user
needs. A REST capability token does not authenticate GraphQL. Keep an admin
connection in Swamp separate from the browser's Role. Do not embed admin JWTs,
JWT signing secrets or machine capability credentials in browser code or public
environment variables. SkilJ still enforces Role access mappings and owner
scopes on every request; frontend visibility controls do not grant data access.

Treat domain rejection and pending approval separately from GraphQL operation
errors. Generate loading, empty, partial-error and rejected-command states from
real response shapes. Choose the project's established refresh strategy after a
mutation; a transport success alone does not prove a command stored events.

The Swamp model supports HTTP queries and mutations. Browser subscriptions use a
separate `graphql-transport-ws` connection with a Role JWT in the
connection-init `Authorization` value (`Bearer <jwt>`). Renew authentication
through the IdP and reconnect as needed; an expired JWT ends the subscription.
Discover subscription field names and arguments from the exported schema.

## Compare an API change with the captured contract

Use `compareSchema` before replacing an existing `schema` baseline. With omitted
`before`, it reuses the stored schema; with omitted `after`, it reads the
current deployment. It never updates the baseline. Supply both as SDL or
introspection JSON for an entirely offline comparison.

Read the `schemaDiff` artifact's `changed`, `compatible`, `breakingCount` and
`dangerousCount`. Enum additions and argument-default changes can require client
review even when `compatible` is true. Individual change descriptions are
vault-protected because schema defaults can contain private values. Sorted SDL
comparison ignores declaration ordering. This check cannot establish resolver,
authorization or custom-scalar behavior. Capture a new baseline deliberately
with `introspect` after reviewing the change.
