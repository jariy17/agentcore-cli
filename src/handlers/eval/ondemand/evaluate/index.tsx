import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { SESSION_SOURCE_FLAGS, resolveSessionSource } from "../../sessionSource";

// createEvaluateOnDemandHandler wires `ondemand evaluate`: a synchronous,
// client-side evaluation that gathers spans from CloudWatch and prints scores.
// It shares SESSION_SOURCE_FLAGS with batch but omits the batch-only source arms
// (online-eval / raw data source), so it always resolves the --agent arm.
export const createEvaluateOnDemandHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions client-side (blocking; prints scores)",
    flags: [
      ...SESSION_SOURCE_FLAGS,
      flag("evaluator", "evaluator id(s) to apply", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["evaluator"] || flags["evaluator"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      const source = await resolveSessionSource(flags, resolver, { allowBatchArms: false });
      // allowBatchArms:false guarantees the agent arm, but narrow the type for TS.
      if (source.origin !== "agent") {
        throw new InputValidationError("on-demand evaluate requires '--agent'");
      }
      // On-demand must target a concrete set of sessions: the design requires a
      // session source (a time window or explicit ids), not "everything".
      if (!source.window && !(source.sessionIds && source.sessionIds.length > 0)) {
        throw new InputValidationError(
          "specify a session source: --session-ids, --lookback-days, or --start-time/--end-time",
        );
      }

      const result = await core.eval.evaluateOnDemand(
        {
          agent: source.agent,
          endpoint: source.endpoint,
          evaluatorIds: flags["evaluator"],
          window: source.window,
          sessionIds: source.sessionIds,
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });
