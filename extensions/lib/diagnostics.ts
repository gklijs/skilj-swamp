/** Safe, static SkilJ 0.4.0 diagnostics shared by models and reports. */
import { z } from "npm:zod@4";

/** Only this metadata may cross from a failed call into a report. */
export const DiagnosticSchema = z.object({
  surface: z.enum(["rest", "graphql"]),
  status: z.number().int().min(100).max(599).nullable(),
  code: z.string().nullable(),
  transport: z.enum(["timeout", "unavailable"]).nullable(),
  effect: z.enum(["read", "write", "consume"]),
  protected: z.boolean(),
});
/** Sanitized request metadata, independent of private error envelopes. */
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

const authCodes = [
  "missing_credential",
  "malformed_credential",
  "unrecognised_credential",
  "unrecognised_subject",
  "unauthenticated",
  "malformed_jwt",
  "jwt_missing_key_id",
  "unknown_signing_key",
  "jwt_verification_failed",
  "missing_subject_claim",
];
const accessCodes = [
  "token_not_active",
  "grant_not_active",
  "role_not_active",
  "insufficient_access_level",
  "unscoped_admin_required",
  "grant_scope_mismatch",
  "grant_bounded_context_mismatch",
  "capability_not_held",
];
const graphqlCodes = [
  ...authCodes,
  ...accessCodes,
  "epoch_changed",
  "event_read_not_allowed",
  "no_identity_provider_configured",
  "jwks_fetch_failed",
];
const restPairs: Record<string, number> = {
  wrong_token_variant: 403,
  event_read_not_allowed: 403,
  epoch_changed: 409,
  missing_credential: 401,
  malformed_credential: 401,
  unrecognised_credential: 401,
  unrecognised_subject: 401,
  not_processed: 409,
  token_not_active: 403,
  grant_not_active: 403,
  role_not_active: 403,
  insufficient_access_level: 403,
  unscoped_admin_required: 403,
  grant_scope_mismatch: 403,
  grant_bounded_context_mismatch: 403,
};

/** Drop arbitrary codes and never classify an unrecognised status/code pair. */
export function sanitizeDiagnostic(input: Diagnostic): Diagnostic {
  const code = input.code;
  return {
    ...input,
    code: code &&
        (input.surface === "rest"
          ? restPairs[code] === input.status
          : input.status === 200 && graphqlCodes.includes(code))
      ? code
      : null,
  };
}

/** Recovery advice contains no server text, payloads or credentials. */
export function explainDiagnostic(raw: Diagnostic) {
  const d = sanitizeDiagnostic(raw);
  let category = "unknown";
  let explanation = "The failure is not in the known error contract.";
  let nextStep =
    "Inspect authorized server telemetry and the data pointers before deciding whether to retry.";
  if (d.transport) {
    category = d.transport;
    explanation = d.transport === "timeout"
      ? "The request timed out."
      : "The transport failed.";
    nextStep = "Check endpoint reachability and authorized server telemetry.";
  } else if (d.code === "wrong_token_variant") {
    category = "wrong_capability";
    explanation = "The capability kind does not authorize this route.";
    nextStep =
      "Select a capability for the invoked operation and required scope.";
  } else if (d.code === "event_read_not_allowed") {
    category = "reads_disabled";
    explanation = "REST event reads are disabled for this event type.";
    nextStep =
      "Ask the deployment operator to review eventReadAllowed; issuing another read token does not enable reads.";
  } else if (
    d.code && authCodes.includes(d.code) || d.status === 401 && d.code === null
  ) {
    category = "authentication";
    explanation = "The server did not authenticate the credential.";
    nextStep =
      "Check the vault credential and server authentication configuration. For GraphQL, obtain a current IdP JWT and verify its active Role mapping; decoded JWT claims alone do not prove validity or expiry.";
  } else if (d.code && accessCodes.includes(d.code)) {
    category = "authorization";
    explanation =
      "The token, Role or grant is inactive or lacks required access.";
    nextStep =
      "Ask an authorized administrator to review the active token, Role, grant and operation scope.";
  } else if (d.code === "epoch_changed") {
    category = "epoch_changed";
    explanation =
      "The database epoch changed; the old cursor cannot safely continue.";
    nextStep =
      "Reconcile the checkpoint with the deployment operator and establish a cursor for the current epoch; do not blindly consume again or acknowledge an old epoch.";
  } else if (d.status === 429) {
    category = "rate_limit";
    explanation = "The service rate limited this request.";
    nextStep = "Honor Retry-After and the operation's existing retry policy.";
  } else if (d.status === 408 || d.status === 504) {
    category = "timeout";
    explanation = "The server or gateway reported a timeout.";
    nextStep = "Check authorized server telemetry before another attempt.";
  } else if (
    [502, 503].includes(d.status ?? 0) || d.code === "jwks_fetch_failed"
  ) {
    category = "unavailable";
    explanation = "The service or an authentication dependency is unavailable.";
    nextStep =
      "Check deployment health and honor Retry-After and the existing retry policy.";
  } else if (d.code === "no_identity_provider_configured") {
    category = "authentication_configuration";
    explanation = "The deployment has no configured identity provider.";
    nextStep = "Ask the deployment operator to configure the trusted IdP.";
  } else if (d.code === "not_processed") {
    category = "not_processed";
    explanation = "This batch item was not attempted.";
    nextStep =
      "Resolve preceding item failures and inspect each outcome before submitting any item again.";
  }
  const outcomeUncertain = d.effect !== "read" &&
    (d.transport !== null || d.status === null || d.status >= 500 ||
      d.status === 408 || d.status >= 200 && d.status < 300 ||
      d.surface === "graphql");
  if (outcomeUncertain) {
    nextStep += d.effect === "consume"
      ? " The consume cursor may have advanced; reconcile served events and checkpoint state before another consume."
      : d.protected
      ? " Reconcile the outcome first; any authorized retry must retain the original payload and idempotency key or dedupe identity. Never generate a new key for this operation."
      : " This write has no verified replay protection; reconcile its outcome before any replay to avoid duplicate effects.";
  }
  return {
    ...d,
    category,
    explanation,
    nextStep,
    outcomeUncertain,
    documentation: "https://github.com/gklijs/skilj-swamp#troubleshooting",
  };
}

/** A closed metadata envelope survives Swamp's errorMessage transport on failure. */
export function diagnosticMessage(raw: Diagnostic): string {
  const d = sanitizeDiagnostic(raw);
  const detail = explainDiagnostic(d);
  return `SkilJ ${
    d.status === null ? "transport" : `HTTP ${d.status}`
  }: ${detail.explanation} [skilj-diagnostic:${JSON.stringify(d)}]`;
}

/** Parse only our exact generated envelope; never echo arbitrary error messages. */
export function diagnosticFromMessage(message?: string): Diagnostic | null {
  const match = message?.match(/\[skilj-diagnostic:(\{[^\n]*\})\]$/);
  if (!match) return null;
  try {
    const d = sanitizeDiagnostic(DiagnosticSchema.parse(JSON.parse(match[1])));
    return diagnosticMessage(d) === message ? d : null;
  } catch {
    return null;
  }
}
