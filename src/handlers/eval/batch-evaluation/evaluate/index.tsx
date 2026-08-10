import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import type { SessionMetadataShape } from "@aws-sdk/client-bedrock-agentcore";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils";
import {
  SESSION_SOURCE_FLAGS,
  BATCH_SOURCE_FLAGS,
  resolveSessionSource,
} from "../../sessionSource";

// createEvaluateBatchEvaluationHandler wires `batch-evaluation evaluate`: an
// async, service-side evaluation over existing sessions. The source flags are
// shared with `ondemand evaluate` (SESSION_SOURCE_FLAGS + BATCH_SOURCE_FLAGS);
// only the job-specific flags (--name, --description, --kms-key-arn) are local.
export const createEvaluateBatchEvaluationHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "evaluate",
    description: "evaluate existing sessions service-side (async; returns a job id)",
    flags: [
      ...SESSION_SOURCE_FLAGS,
      ...BATCH_SOURCE_FLAGS,
      flag("evaluator", "evaluator id(s) to apply", z.array(z.string()).optional()),
      flag(
        "ground-truth",
        "session ground truth (JSON SessionMetadataShape[]; inline, file://<path>, or -)",
        z.string().optional(),
      ),
      flag("name", "batch evaluation name (must be unique in the account)", z.string().optional()),
      flag("description", "optional description", z.string().optional()),
      flag("kms-key-arn", "KMS key to encrypt evaluation data at rest", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags["evaluator"] || flags["evaluator"].length === 0) {
        throw new InputValidationError(
          "required option '--evaluator <evaluator...>' not specified",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      // resolveSessionSource owns the shared logic: resolves --data-source-config
      // JSON, picks the arm (agent / online-eval / raw), validates the filters.
      const source = await resolveSessionSource(flags, resolver, { allowBatchArms: true });

      const groundTruth = parseJsonFlag<SessionMetadataShape[]>(
        "ground-truth",
        await resolver.resolveText("ground-truth", flags["ground-truth"]),
      );

      const response = await core.eval.startBatchEvaluation(
        {
          name: flags["name"],
          description: flags["description"],
          evaluatorIds: flags["evaluator"],
          source,
          groundTruth,
          kmsKeyArn: flags["kms-key-arn"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
