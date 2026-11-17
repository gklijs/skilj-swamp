import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { InvestigationArgsSchema } from "../lib/investigation.ts";
import { model } from "./skilj_investigation.ts";
const source = (model: string) => ({ model, artifact: "events", version: 1 });
Deno.test("selection validation requires correlation, exact versions and hard limits; entry method performs no I/O", async () => {
  const args = { correlationId: "c1", sources: [source("a")] };
  assertEquals(InvestigationArgsSchema.parse(args).maxRows, 200);
  for (
    const change of [
      { correlationId: "" },
      { sources: [] },
      { sources: [{ model: "a", artifact: "events" }] },
      { maxRows: 1001 },
      { maxArtifacts: 101 },
      { sources: Array.from({ length: 101 }, () => source("a")) },
    ]
  ) assert(!InvestigationArgsSchema.safeParse({ ...args, ...change }).success);
  assertEquals(
    await model.methods.investigate.execute(
      InvestigationArgsSchema.parse(args),
    ),
    { dataHandles: [] },
  );
  await assertRejects(async () => {
    await model.methods.investigate.execute({
      ...InvestigationArgsSchema.parse(args),
      correlationId: "",
    });
  });
});
