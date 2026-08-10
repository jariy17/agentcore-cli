import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createEvaluateOnDemandHandler } from "./evaluate";

// ondemand runs quick, client-side evaluations that block and print results (no
// job id). Today it exposes `evaluate`; `simulate` (dataset replay) is a later
// phase. A bare invocation opens the interactive TUI, matching the siblings.
export function createOnDemandHandler(core: Core, io: AppIO): Router {
  return new Router("ondemand", "run quick client-side evaluations")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createEvaluateOnDemandHandler(core, io));
}
