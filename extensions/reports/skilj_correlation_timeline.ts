/** Bounded correlation investigation over explicitly selected captured artifacts. @module */
import { InvestigationArgsSchema } from "../lib/investigation.ts";

interface Context {
  executionStatus: string;
  methodArgs: Record<string, unknown>;
  definitionRepository: {
    findByNameGlobal(
      name: string,
    ): Promise<
      { definition: { id: string }; type: { normalized: string } } | null
    >;
  };
  dataRepository: {
    findByName(
      type: string,
      id: string,
      name: string,
      version: number,
    ): Promise<
      {
        version: number;
        tags: Record<string, string>;
      } | null
    >;
    getContent(
      type: string,
      id: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null>;
  };
}

type Rec = Record<string, unknown>;
function record(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Rec
    : {};
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}
function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
// Escape all Markdown syntax, HTML and controls in captured identifiers.
function display(value: unknown): string {
  return String(value ?? "unknown").replace(
    // deno-lint-ignore no-control-regex -- captured identifiers must not inject controls
    /[&<>"'`*_\[\]\\|#()!\r\n\x00-\x1f\x7f]/g,
    (c) => `&#${c.charCodeAt(0)};`,
  );
}
interface Evidence {
  model: string;
  artifact: string;
  version: number;
  modelId: string | null;
  spec: string | null;
  epoch: string | null;
  pointer: string;
  warnings: string[];
  missingCorrelationIds: number;
  unrelatedRows: number;
}
interface EventRow {
  sequence: number;
  eventType: string;
  correlationId: string;
  causationId: string | null;
  sources: number[];
}
interface Lane {
  model: string;
  modelId: string;
  epoch: string | null;
  eventTypeName: string | null;
  events: EventRow[];
}

/** Captured evidence only: never fetches events, retries commands or infers causation. */
export const report = {
  name: "@gklijs/skilj-correlation-timeline",
  description:
    "Correlation timeline of selected captured command/event artifacts with evidence gaps",
  scope: "method" as const,
  labels: ["skilj", "correlation", "investigation"],
  async execute(context: Context) {
    const parsed = InvestigationArgsSchema.safeParse(context.methodArgs);
    if (context.executionStatus !== "succeeded" || !parsed.success) {
      return {
        markdown:
          "# SkilJ correlation timeline\n\nIncomplete evidence: investigation requires valid explicit correlation and source selections.",
        json: {
          incomplete: true,
          warnings: ["invalid investigation selection"],
        },
      };
    }
    const args = parsed.data;
    const warnings: string[] = [];
    const sources: Evidence[] = [];
    const commands: Array<{
      source: number;
      correlationId: string;
      status: string;
      dryRun: boolean | null;
      triggeredEventSequences: number[];
    }> = [];
    const lanes: Lane[] = [];
    let remaining = args.maxRows;
    if (args.sources.length > args.maxArtifacts) {
      warnings.push("artifact cap reached; selected sources omitted");
    }
    for (const selection of args.sources.slice(0, args.maxArtifacts)) {
      const source: Evidence = {
        ...selection,
        modelId: null,
        spec: null,
        epoch: null,
        pointer: `swamp data get '${
          selection.model.replaceAll("'", "'\\''")
        }' '${
          selection.artifact.replaceAll("'", "'\\''")
        }' --version ${selection.version} --json`,
        warnings: [],
        missingCorrelationIds: 0,
        unrelatedRows: 0,
      };
      const sourceIndex = sources.length;
      sources.push(source);
      if (remaining === 0) {
        source.warnings.push("row cap reached; artifact not read");
        continue;
      }
      try {
        const found = await context.definitionRepository.findByNameGlobal(
          selection.model,
        );
        if (!found || found.type.normalized !== "@gklijs/skilj") {
          source.warnings.push("source model unavailable");
          continue;
        }
        const definition = found.definition;
        source.modelId = definition.id;
        const artifact = await context.dataRepository.findByName(
          "@gklijs/skilj",
          definition.id,
          selection.artifact,
          selection.version,
        );
        if (!artifact || artifact.version !== selection.version) {
          source.warnings.push("artifact version unavailable");
          continue;
        }
        source.spec = artifact.tags.specName ?? null;
        if (
          !["commandResult", "events", "consumedEvents"].includes(
            source.spec ?? "",
          )
        ) {
          source.warnings.push("unsupported artifact spec");
          continue;
        }
        const raw = await context.dataRepository.getContent(
          "@gklijs/skilj",
          definition.id,
          selection.artifact,
          selection.version,
        );
        if (!raw) {
          source.warnings.push("artifact content unavailable");
          continue;
        }
        if (raw.byteLength > 2 * 1024 * 1024) {
          source.warnings.push("artifact exceeds 2 MiB content cap");
          continue;
        }
        const data = record(JSON.parse(new TextDecoder().decode(raw)));
        const rows = source.spec === "commandResult" ? [data] : data.events;
        if (!Array.isArray(rows)) {
          source.warnings.push("invalid event envelope");
          continue;
        }
        if (source.spec !== "commandResult") {
          source.epoch = identifier(data.epoch);
          if (!source.epoch) {
            source.warnings.push("epoch missing; capture kept separate");
          }
          if (data.truncated === true) {
            source.warnings.push("captured input truncated");
          }
        }
        if (rows.length > remaining) {
          source.warnings.push("row cap reached; captured rows omitted");
        }
        const selected = rows.slice(0, remaining);
        remaining -= selected.length;
        for (const rawRow of selected) {
          const row = record(rawRow);
          const metadata = source.spec === "commandResult"
            ? row
            : record(row.metadata);
          const correlationId = identifier(metadata.correlationId);
          if (!correlationId) {
            source.missingCorrelationIds++;
            continue;
          }
          if (correlationId !== args.correlationId) {
            source.unrelatedRows++;
            continue;
          }
          if (source.spec === "commandResult") {
            const seqs = row.triggeredEventSequences;
            if (
              !Array.isArray(seqs) || !seqs.every(sequence) ||
              seqs.length > 1000
            ) {
              source.warnings.push(
                "invalid or capped command sequence metadata",
              );
            }
            commands.push({
              source: sourceIndex,
              correlationId,
              status: row.pendingApproval === true
                ? "pending"
                : row.accepted === true
                ? "accepted"
                : row.accepted === false
                ? "rejected"
                : "unknown",
              dryRun: typeof row.dryRun === "boolean" ? row.dryRun : null,
              triggeredEventSequences: Array.isArray(seqs)
                ? seqs.slice(0, 1000).filter(sequence)
                : [],
            });
            continue;
          }
          const eventType = identifier(row.eventType);
          if (!sequence(row.sequence) || !eventType) {
            source.warnings.push("invalid event metadata");
            continue;
          }
          const typeName = identifier(data.eventTypeName);
          if (!typeName) {
            source.warnings.push(
              "event stream type missing; capture kept separate",
            );
          }
          // A model identifies one capability-scoped stream. Never merge across models,
          // epochs or unknown stream identities, even if sequences happen to agree.
          let lane = source.epoch && typeName
            ? lanes.find((l) =>
              l.modelId === definition.id && l.epoch === source.epoch &&
              l.eventTypeName === typeName
            )
            : lanes.find((l) =>
              l.events.some((e) => e.sources.includes(sourceIndex))
            );
          if (!lane) {
            lane = {
              model: selection.model,
              modelId: definition.id,
              epoch: source.epoch,
              eventTypeName: typeName,
              events: [],
            };
            lanes.push(lane);
          }
          const event: EventRow = {
            sequence: row.sequence,
            eventType,
            correlationId,
            causationId: identifier(metadata.causationId),
            sources: [sourceIndex],
          };
          const duplicate = source.epoch && typeName &&
            lane.events.find((e) =>
              e.sequence === event.sequence &&
              e.eventType === event.eventType &&
              e.correlationId === event.correlationId &&
              e.causationId === event.causationId
            );
          if (duplicate) {
            if (!duplicate.sources.includes(sourceIndex)) {
              duplicate.sources.push(sourceIndex);
            }
          } else {
            if (
              source.epoch && typeName &&
              lane.events.some((e) => e.sequence === event.sequence)
            ) {
              source.warnings.push(
                "conflicting metadata at the same stream sequence",
              );
            }
            lane.events.push(event);
          }
        }
      } catch {
        source.warnings.push("artifact unavailable or invalid JSON");
      }
      if (source.missingCorrelationIds) {
        source.warnings.push("captured rows lack correlation IDs");
      }
      source.warnings = [...new Set(source.warnings)];
    }
    if (!commands.length) warnings.push("no matching command result captured");
    if (!lanes.length) {
      warnings.push(
        "no matching events captured; absence does not establish command failure",
      );
    }
    for (const lane of lanes) {
      lane.events.sort((a, b) => a.sequence - b.sequence);
    }
    const incomplete = warnings.length > 0 ||
      sources.some((s) => s.warnings.length > 0);
    const lines = [
      "# SkilJ correlation timeline",
      "",
      `Correlation: ${display(args.correlationId)}`,
      "",
      "Captured evidence, not complete history. Absence of an event does not establish command failure.",
      "Lanes are ordered only within their source stream and epoch; there is no global sequence clock. Shared correlation identifies a group, not a causal edge. Command results have no stream epoch; their sequences are not joined to event lanes.",
      "",
      `Evidence gaps: ${
        incomplete
          ? "incomplete evidence (see markers below)"
          : "none detected in selected captures; history completeness unknown"
      }.`,
      "",
      "## Commands",
      "",
    ];
    for (const command of commands) {
      lines.push(
        `- [source ${command.source + 1}] ${command.status}; dry run: ${
          command.dryRun ?? "unknown"
        }; stored sequences: ${
          command.triggeredEventSequences.join(", ") || "none"
        }`,
      );
    }
    lanes.forEach((lane, index) => {
      lines.push(
        "",
        `## Lane ${index + 1}: ${display(lane.model)} / ${
          display(lane.eventTypeName)
        } / epoch ${display(lane.epoch)}`,
        "",
      );
      for (const e of lane.events) {
        lines.push(
          `- #${e.sequence} ${display(e.eventType)}; correlation ${
            display(e.correlationId)
          }; causation ${display(e.causationId)}; sources ${
            e.sources.map((s) => s + 1).join(", ")
          }`,
        );
      }
    });
    lines.push("", "## Evidence sources", "");
    sources.forEach((s, i) => {
      lines.push(
        `- Source ${i + 1}: ${display(s.model)} (${display(s.modelId)}), ${
          display(s.artifact)
        } v${s.version}, spec ${display(s.spec)}, epoch ${
          display(s.epoch)
        }. Pointer: ${
          display(s.pointer)
        }. Missing correlation IDs: ${s.missingCorrelationIds}; unrelated rows: ${s.unrelatedRows}.`,
      );
      for (const warning of s.warnings) {
        lines.push(`  - Incomplete evidence: ${warning}.`);
      }
    });
    for (const warning of warnings) {
      lines.push(`- Incomplete evidence: ${warning}.`);
    }
    return {
      markdown: lines.join("\n"),
      json: {
        correlationId: args.correlationId,
        capturedEvidenceOnly: true,
        incomplete,
        warnings,
        limits: {
          maxArtifacts: args.maxArtifacts,
          maxRows: args.maxRows,
          maxArtifactBytes: 2 * 1024 * 1024,
        },
        sources,
        commands,
        lanes,
      },
    };
  },
};
