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
  return lines;
}

function consumedSummary(
  data: Rec,
  methodArgs: Record<string, unknown>,
): string[] {
  const lines = eventsSummary(data);
  lines[0] += ` Consumed under \`${
    String(data.mode ?? methodArgs.mode ?? "cursor's own")
  }\` mode - acknowledge with acknowledgeEvents when mode is manual.`;
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
    if (!data) {
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
