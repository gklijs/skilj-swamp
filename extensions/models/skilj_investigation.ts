/** Configuration entry point for a local, read-only investigation report. @module */
import { z } from "npm:zod@4";
import { InvestigationArgsSchema } from "../lib/investigation.ts";

/** Accept explicit evidence selections without contacting SkilJ. */
export const model = {
  type: "@gklijs/skilj-investigation",
  version: "2026.11.17.1",
  globalArguments: z.object({}),
  reports: ["@gklijs/skilj-correlation-timeline"],
  methods: {
    investigate: {
      description:
        "Report captured correlation evidence from explicit artifact versions; no network calls",
      arguments: InvestigationArgsSchema,
      execute(args: z.infer<typeof InvestigationArgsSchema>) {
        InvestigationArgsSchema.parse(args);
        return Promise.resolve({ dataHandles: [] });
      },
    },
  },
};
