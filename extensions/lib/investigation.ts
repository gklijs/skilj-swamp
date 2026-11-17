/** Typed, bounded selection for the captured-evidence report. @module */
import { z } from "npm:zod@4";

/** Report inputs; versions are required so repeated reads select the same evidence. */
export const InvestigationArgsSchema = z.object({
  correlationId: z.string().min(1).max(256),
  sources: z.array(z.object({
    model: z.string().min(1).max(256),
    artifact: z.string().min(1).max(256),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })).min(1).max(100),
  maxArtifacts: z.number().int().min(1).max(100).default(20),
  maxRows: z.number().int().min(1).max(1000).default(200),
});
