/**
 * Method-scoped report for `@gklijs/skilj`: renders each method run as a
 * short operator-facing summary with the data artifact pointer, so a
 * workflow run shows what the SkilJ call did without opening the raw
 * resource rows.
 *
 * @module
 */

/** A resource data artifact produced during method execution. */
interface DataHandle {
  name: string;
  specName: string;
  version: number;
}

/** Context provided by swamp when executing a method-scoped report. */
interface MethodReportContext {
  modelType: string;
  modelId: string;
  definition: { name: string };
  methodName: string;
  methodArgs: Record<string, unknown>;
  executionStatus: string;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      type: string,
      id: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
}

type Rec = Record<string, unknown>;

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.length > 8
      ? `${v.slice(0, 8).map((x) => String(x)).join(", ")} (+${v.length - 8})`
      : v.map((x) => String(x)).join(", ");
  }
  return "…";
}

async function loadFirst(
  context: MethodReportContext,
): Promise<Rec | null> {
  const handle = context.dataHandles.find((h) =>
    h.specName !== undefined && h.name !== undefined
  );
  if (!handle) return null;
  let raw: Uint8Array | null;
  try {
    raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle.name,
      handle.version,
    );
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Rec
      : null;
  } catch {
    return null;
  }
}

function commandSummary(data: Rec): string[] {
  if (data.pendingApproval === true) {
    return [
      `Awaiting approval; proposal \`${
        String(data.proposalId ?? "?")
      }\`. No command events stored.`,
    ];
  }
  if (data.accepted === true) {
    const seqs = Array.isArray(data.triggeredEventSequences)
      ? data.triggeredEventSequences.map((s) => String(s)).join(", ")
      : "—";
    const dedup = data.deduplicated === true ? " (deduplicated replay)" : "";
    return [`Accepted${dedup}; stored event(s): ${seqs || "—"}.`];
  }
  return [
    `Rejected (${String(data.rejectionKind ?? "unknown")}): ${
      String(data.rejectionReason ?? "no reason given")
    }.`,
  ];
}

function eventsSummary(data: Rec): string[] {
  const events = Array.isArray(data.events) ? data.events : [];
  const lines = [
    `${events.length} event(s) of \`${String(data.eventTypeName ?? "?")}\` ` +
    `(schema v${String(data.eventTypeSchemaVersion ?? "?")}, epoch \`${
      String(data.epoch ?? "?")
    }\`, ${String(data.pages ?? 1)} page(s)${
      data.truncated === true ? ", truncated" : ""
    }).`,
  ];
  for (const e of events.slice(0, 10)) {
    const r = e as Rec;
    lines.push(
      `- #${String(r.sequence ?? "?")} \`${String(r.eventType ?? "?")}\``,
    );
  }
  if (events.length > 10) lines.push(`- … and ${events.length - 10} more`);
  if (data.nextCursor) {
    lines.push(`Continue after \`${String(data.nextCursor)}\`.`);
  }
  return lines;
}

function consumedSummary(
  data: Rec,
  methodArgs: Record<string, unknown>,
): string[] {
  const lines = eventsSummary(data);
  lines[0] += ` Consumed under \`${
    String(data.mode ?? methodArgs.mode ?? "cursor's own")
  }\` mode.`;
  if ((data.mode ?? methodArgs.mode) === "manual") {
    lines.push(
      "Acknowledge the last served sequence and epoch with acknowledgeEvents.",
    );
  }
  return lines;
}

function eventWriteSummary(data: Rec): string[] {
  if (data.redelivered === true) {
    return [
      `Redelivery recognised; ${
        data.sequence === null
          ? "watermark hit, no new event stored."
          : `already stored as #${String(data.sequence)}.`
      }`,
    ];
  }
  return [`Stored as event #${String(data.sequence ?? "?")}.`];
}

/** SkilJ method report definition. */
export const report = {
  name: "@gklijs/skilj-report",
  description:
    "Operator summary of a SkilJ method run: outcome, counts, and the data artifact pointer",
  scope: "method" as const,
  labels: ["skilj", "event-sourcing", "summary"],
  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const lines: string[] = [
      `# SkilJ ${context.methodName}`,
      ``,
      `**Model**: ${context.definition.name} (\`${context.modelType}\`)`,
      `**Status**: ${context.executionStatus}`,
      ``,
    ];
    const data = context.executionStatus === "succeeded"
      ? await loadFirst(context)
      : null;
    if (
      context.modelType === "@gklijs/skilj-graphql" &&
      (context.methodName === "exportSchema" ||
        context.methodName === "exportSchemaSdl") &&
      context.executionStatus === "succeeded"
    ) {
      lines.push(
        context.methodName === "exportSchemaSdl"
          ? "Exported sorted GraphQL SDL for frontend tooling."
          : "Exported GraphQL introspection JSON for frontend tooling.",
      );
    } else if (!data) {
      lines.push(
        context.executionStatus === "succeeded"
          ? `No data artifact to summarise.`
          : `The method did not succeed, so there is nothing to summarise - ` +
            `see @swamp/method-summary for the failure detail.`,
      );
    } else if (context.methodName === "triggerCommand") {
      lines.push(...commandSummary({ ...data, dryRun: false }));
    } else if (context.methodName === "dryRunCommand") {
      lines.push(
        `Dry run (nothing stored): ${commandSummary(data)[0]}`,
      );
    } else if (context.methodName === "fetchEvents") {
      lines.push(...eventsSummary(data));
    } else if (context.methodName === "consumeEvents") {
      lines.push(...consumedSummary(data, context.methodArgs));
    } else if (context.methodName === "acknowledgeEvents") {
      lines.push(
        `Cursor acknowledged up to #${String(data.sequence ?? "?")}` +
          (data.epoch ? ` (epoch \`${String(data.epoch)}\`).` : `.`),
      );
    } else if (
      context.methodName === "ingestExternalEvent" ||
      context.methodName === "createDirectEvent"
    ) {
      lines.push(...eventWriteSummary(data));
    } else if (context.modelType === "@gklijs/skilj-graphql") {
      if (context.methodName === "compareSchema") {
        lines.push(
          `Schema ${data.changed === true ? "changed" : "unchanged"}; ${
            String(data.breakingCount)
          } breaking and ${
            String(data.dangerousCount)
          } potentially risky change(s). ${
            data.compatible === true
              ? "No known breaking changes."
              : "Existing clients may break."
          } Change details are vault-protected.`,
        );
      } else if (context.methodName === "listCommandProposals") {
        lines.push(
          `${String(data.count)} proposal(s) in ${String(data.pages)} page(s)${
            data.truncated === true ? " (truncated; more may follow)" : ""
          }. No approval decision made.`,
        );
      } else if (
        context.methodName === "approveCommand" ||
        context.methodName === "rejectCommand"
      ) {
        lines.push(
          context.methodName === "rejectCommand"
            ? `Rejected proposal \`${
              String(data.proposalId)
            }\`; no command executed.`
            : `Processed approval for proposal \`${
              String(data.proposalId)
            }\`; command ${
              data.accepted === true ? "accepted" : "rejected by domain rules"
            }, ${
              (data.triggeredEventSequences as unknown[] | undefined)?.length ??
                0
            } event(s).`,
        );
      } else if (context.methodName === "validateOperation") {
        lines.push(
          `GraphQL operation ${
            data.valid === true ? "is valid" : "is invalid"
          }; ${
            String(data.errorCount)
          } validation error(s). No operation executed.`,
        );
      } else if (context.methodName === "revokeAccessToken") {
        lines.push(
          `Revoked token \`${String(data.id)}\` (${
            String(data.tokenType)
          }) at ${String(data.revokedAt)}.`,
        );
      } else if (context.methodName === "debugCommand" && data.commandSummary) {
        const summary = data.commandSummary as Rec;
        lines.push(
          `Dry run ${summary.accepted === true ? "accepted" : "rejected"}; ${
            String(summary.wouldBeEventCount)
          } would-be event(s), ${
            String(summary.matchingEventCount)
          } matching event(s)${
            summary.matchingEventsTruncated === true
              ? " (history truncated)"
              : ""
          }. Nothing stored in SkilJ.`,
        );
      } else if (context.methodName === "introspect") {
        lines.push("Recorded GraphQL schema for frontend tooling.");
      } else if (context.methodName === "createAccessToken") {
        lines.push(
          `Created ${String(data.kind)} token \`${
            String(data.id)
          }\`; credential protected by the vault.`,
        );
      } else {
        lines.push(
          `GraphQL ${
            data.succeeded === true ? "succeeded" : "returned errors"
          }; ${
            String(data.errorCount ?? 0)
          } error(s). Data and errors are vault-protected; inspect the result before continuing.`,
        );
      }
    } else if (
      context.methodName === "triggerCommands" ||
      context.methodName === "ingestExternalEvents"
    ) {
      lines.push(
        context.methodName === "triggerCommands"
          ? `${String(data.count)} command(s): ${
            String(data.accepted)
          } accepted, ${String(data.rejected)} rejected, ${
            String(data.pending)
          } awaiting approval, ${String(data.failed)} failed.`
          : `${String(data.count)} event(s): ${String(data.stored)} stored, ${
            String(data.redelivered)
          } redelivered, ${String(data.failed)} failed.`,
      );
      const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
      for (const [index, item] of outcomes.slice(0, 10).entries()) {
        const outcome = item as Rec;
        const error = outcome.error as Rec | undefined;
        lines.push(
          `- Item ${index + 1}: ` +
            (error
              ? `HTTP ${String(error.status)} (${String(error.code)}): ${
                fmtValue(error.message)
              }`
              : context.methodName === "triggerCommands"
              ? commandSummary(outcome)[0]
              : eventWriteSummary(outcome)[0]),
        );
      }
      if (outcomes.length > 10) {
        lines.push(`- … and ${outcomes.length - 10} more`);
      }
    } else if (context.methodName === "searchUsedTags") {
      lines.push(
        `${String(data.count)} used tag value(s) for \`${
          String(data.key)
        }\` (prefix \`${String(data.prefix)}\`).`,
      );
    } else if (context.methodName === "reportParkedDelivery") {
      lines.push(
        `Parked delivery stored as \`${String(data.id ?? "?")}\` ` +
          `(${String(data.kind ?? "?")}, ${String(data.source ?? "?")}:${
            String(data.identifier ?? "?")
          }).`,
      );
    } else {
      lines.push(`Recorded ${fmtValue(data)}.`);
    }
    const handles = context.dataHandles.filter((h) => h.specName);
    if (handles.length) {
      lines.push(``, `## Data`, ``);
      for (const h of handles) {
        lines.push(
          `- **${h.specName}** \`${h.name}\`: \`swamp data get ${context.definition.name} ${h.name} --json\``,
        );
      }
    }
    context.logger.info("skilj-report: summarised {method}", {
      method: context.methodName,
    });
    return {
      markdown: lines.join("\n"),
      json: {
        method: context.methodName,
        status: context.executionStatus,
        artifacts: handles.map((h) => ({ spec: h.specName, name: h.name })),
      },
    };
  },
};
