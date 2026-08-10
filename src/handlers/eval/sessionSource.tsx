import z from "zod";
import { flag } from "../../router";
import { InputValidationError } from "../../errors";
import { parseJsonFlag } from "../utils";
import type { SourceResolver } from "../../io";
import type { DataSourceConfig } from "@aws-sdk/client-bedrock-agentcore";

// SessionWindow is the resolved time filter. A lookback resolves eagerly to a
// start relative to "now" when the SDK request is built (see toSessionFilter).
export type SessionWindow =
  { kind: "lookback"; lookbackDays: number } | { kind: "explicit"; startTime: Date; endTime: Date };

// SessionSourceValue is what resolveSessionSource produces. `origin` discriminates
// which dataSourceConfig arm Core builds; `window` is the shared time filter
// (absent means "all available sessions").
export type SessionSourceValue =
  // `agent` is a harness id or runtime id; Core resolves it to the runtime + log group.
  | {
      origin: "agent";
      agent: string;
      endpoint?: string;
      window?: SessionWindow;
      sessionIds?: string[];
    }
  | { origin: "online-eval"; onlineEvaluationConfigId: string; window?: SessionWindow }
  // Raw escape hatch: a full DataSourceConfig supplied via --data-source-config,
  // already parsed from JSON. Passed through to the API untouched.
  | { origin: "raw"; dataSourceConfig: DataSourceConfig };

// SESSION_SOURCE_FLAGS: the --agent arm + the time/id filters shared by BOTH the
// on-demand and batch `evaluate` commands. Spread into each handler's `flags`.
export const SESSION_SOURCE_FLAGS = [
  flag(
    "agent",
    "source: harness id or runtime id whose sessions to evaluate",
    z.string().optional(),
  ),
  flag(
    "endpoint",
    "runtime endpoint qualifier (default DEFAULT; only with --agent)",
    z.string().optional(),
  ),
  flag(
    "lookback-days",
    "time filter: sessions from the last N days",
    z.coerce.number().int().positive().optional(),
  ),
  flag(
    "start-time",
    "time filter: window start (ISO-8601, with --end-time)",
    z.string().optional(),
  ),
  flag("end-time", "time filter: window end (ISO-8601, with --start-time)", z.string().optional()),
  flag(
    "session-ids",
    "filter: specific session ids (only with --agent)",
    z.array(z.string()).optional(),
  ),
] as const;

// BATCH_SOURCE_FLAGS: source arms only batch supports. On-demand omits these — it
// gathers spans client-side, so it has no service-side config to point at.
export const BATCH_SOURCE_FLAGS = [
  flag(
    "online-eval",
    "source: evaluate sessions an online-eval config already sampled",
    z.string().optional(),
  ),
  flag(
    "data-source-config",
    "source: raw DataSourceConfig JSON (inline, file://<path>, or -); escape hatch",
    z.string().optional(),
  ),
] as const;

type SourceFlags = {
  agent?: string;
  endpoint?: string;
  "online-eval"?: string;
  "data-source-config"?: string;
  "lookback-days"?: number;
  "start-time"?: string;
  "end-time"?: string;
  "session-ids"?: string[];
};

// resolveSessionSource picks the source arm and validates the filters legal for
// it. It is async because --data-source-config is JSON resolved via SourceResolver
// (inline / file:// / stdin), the same way online-eval/create resolves its JSON
// flags. `allowBatchArms` is false for on-demand, which supports only --agent.
export async function resolveSessionSource(
  flags: SourceFlags,
  source: SourceResolver,
  { allowBatchArms }: { allowBatchArms: boolean },
): Promise<SessionSourceValue> {
  const hasAgent = flags["agent"] !== undefined;
  const hasOnlineEval = allowBatchArms && flags["online-eval"] !== undefined;
  const rawConfig = allowBatchArms
    ? parseJsonFlag<DataSourceConfig>(
        "data-source-config",
        await source.resolveText("data-source-config", flags["data-source-config"]),
      )
    : undefined;
  const hasRaw = rawConfig !== undefined;

  const armCount = [hasAgent, hasOnlineEval, hasRaw].filter(Boolean).length;
  if (armCount !== 1) {
    const arms = allowBatchArms
      ? "'--agent', '--online-eval', or '--data-source-config'"
      : "'--agent'";
    throw new InputValidationError(`specify exactly one source: ${arms}`);
  }

  if (hasRaw) {
    // The raw config is self-contained; the ergonomic filter flags don't apply.
    if (
      flags["lookback-days"] !== undefined ||
      flags["start-time"] !== undefined ||
      flags["end-time"] !== undefined ||
      (flags["session-ids"]?.length ?? 0) > 0 ||
      flags["endpoint"] !== undefined
    ) {
      throw new InputValidationError(
        "filter flags cannot be combined with '--data-source-config' (put them in the JSON)",
      );
    }
    return { origin: "raw", dataSourceConfig: rawConfig! };
  }

  const window = resolveWindow(flags);
  const hasIds = (flags["session-ids"]?.length ?? 0) > 0;

  if (hasOnlineEval) {
    // The online-eval arm has no sessionIds filter and no endpoint.
    if (hasIds)
      throw new InputValidationError("'--session-ids' cannot be used with '--online-eval'");
    if (flags["endpoint"])
      throw new InputValidationError("'--endpoint' can only be used with '--agent'");
    return { origin: "online-eval", onlineEvaluationConfigId: flags["online-eval"]!, window };
  }

  return {
    origin: "agent",
    agent: flags["agent"]!,
    endpoint: flags["endpoint"],
    window,
    sessionIds: hasIds ? flags["session-ids"] : undefined,
  };
}

// resolveWindow validates the time filter: at most one of lookback or an explicit
// window, and the window halves must come together.
function resolveWindow(flags: SourceFlags): SessionWindow | undefined {
  const hasLookback = flags["lookback-days"] !== undefined;
  const hasWindow = flags["start-time"] !== undefined || flags["end-time"] !== undefined;
  if (hasLookback && hasWindow) {
    throw new InputValidationError(
      "specify either --lookback-days or --start-time/--end-time, not both",
    );
  }
  if (hasLookback) return { kind: "lookback", lookbackDays: flags["lookback-days"]! };
  if (hasWindow) {
    if (flags["start-time"] === undefined || flags["end-time"] === undefined) {
      throw new InputValidationError("--start-time and --end-time must be provided together");
    }
    const startTime = new Date(flags["start-time"]);
    const endTime = new Date(flags["end-time"]);
    if (Number.isNaN(+startTime) || Number.isNaN(+endTime)) {
      throw new InputValidationError("--start-time and --end-time must be ISO-8601 timestamps");
    }
    if (+startTime >= +endTime) {
      throw new InputValidationError("--start-time must be before --end-time");
    }
    return { kind: "explicit", startTime, endTime };
  }
  return undefined; // no time filter — all available sessions
}

// toSessionFilter resolves a SessionWindow into the SDK's { startTime, endTime }
// SessionFilterConfig, materializing a lookback relative to now.
export function toSessionFilter(
  window: SessionWindow | undefined,
): { startTime: Date; endTime: Date } | undefined {
  if (!window) return undefined;
  if (window.kind === "explicit") return { startTime: window.startTime, endTime: window.endTime };
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - window.lookbackDays * 24 * 60 * 60 * 1000);
  return { startTime, endTime };
}
