import { describe, expect, test } from "bun:test";
import {
  StartBatchEvaluationCommand,
  type StartBatchEvaluationCommandInput,
} from "@aws-sdk/client-bedrock-agentcore";
import { GetAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { EvalClient } from "./eval";
import type { AwsClients } from "./types";
import type { StartBatchEvaluationInput } from "../handlers/eval/types";

const OPTIONS = { region: "us-west-2" };

// captureStart runs startBatchEvaluation against a stub that resolves an agent id
// to a runtime and records the StartBatchEvaluation command input.
async function captureStart(
  input: StartBatchEvaluationInput,
): Promise<StartBatchEvaluationCommandInput> {
  let captured: StartBatchEvaluationCommandInput | undefined;
  const send = async (command: unknown) => {
    if (command instanceof GetAgentRuntimeCommand) {
      return { agentRuntimeName: "orders-agent" };
    }
    if (command instanceof StartBatchEvaluationCommand) {
      captured = command.input;
      return { batchEvaluationId: "be-1", status: "RUNNING" };
    }
    throw new Error(`unexpected command: ${(command as object).constructor.name}`);
  };
  const client = { send } as never;
  const clients: AwsClients = {
    control: () => client,
    data: () => client,
    iam: () => client,
    logs: () => client,
  };
  await new EvalClient(clients).startBatchEvaluation(input, OPTIONS);
  if (!captured) throw new Error("StartBatchEvaluationCommand was not sent");
  return captured;
}

describe("EvalClient.startBatchEvaluation — dataSourceConfig mapping", () => {
  test("agent arm builds cloudWatchLogs with the runtime log group + service name", async () => {
    const input = await captureStart({
      name: "job-1",
      evaluatorIds: ["Builtin.Helpfulness"],
      source: {
        origin: "agent",
        agent: "orders-agent-abc123",
        endpoint: "prod",
        window: { kind: "lookback", lookbackDays: 7 },
        sessionIds: ["s1"],
      },
    });

    expect(input.batchEvaluationName).toBe("job-1");
    expect(input.evaluators).toEqual([{ evaluatorId: "Builtin.Helpfulness" }]);
    const cw = (input.dataSourceConfig as { cloudWatchLogs?: unknown }).cloudWatchLogs as {
      logGroupNames: string[];
      serviceNames: string[];
      filterConfig?: { sessionIds?: string[]; timeRange?: { startTime: Date; endTime: Date } };
    };
    expect(cw.logGroupNames).toEqual(["/aws/bedrock-agentcore/runtimes/orders-agent-abc123-prod"]);
    expect(cw.serviceNames).toEqual(["orders-agent.prod"]);
    expect(cw.filterConfig?.sessionIds).toEqual(["s1"]);
    expect(cw.filterConfig?.timeRange?.startTime).toBeInstanceOf(Date);
    expect(cw.filterConfig?.timeRange?.endTime).toBeInstanceOf(Date);
  });

  test("online-eval arm builds onlineEvaluationConfigSource with the config arn", async () => {
    const input = await captureStart({
      name: "job-2",
      evaluatorIds: ["Builtin.Correctness"],
      source: { origin: "online-eval", onlineEvaluationConfigId: "oe-arn-1" },
    });
    expect(input.dataSourceConfig).toEqual({
      onlineEvaluationConfigSource: { onlineEvaluationConfigArn: "oe-arn-1", timeRange: undefined },
    });
  });

  test("raw arm passes the DataSourceConfig through untouched", async () => {
    const raw = { cloudWatchLogs: { logGroupNames: ["/custom"], serviceNames: ["svc"] } };
    const input = await captureStart({
      name: "job-3",
      evaluatorIds: ["Builtin.Helpfulness"],
      source: { origin: "raw", dataSourceConfig: raw },
    });
    expect(input.dataSourceConfig).toEqual(raw);
  });

  test("ground truth maps to evaluationMetadata.sessionMetadata", async () => {
    const input = await captureStart({
      name: "job-4",
      evaluatorIds: ["Builtin.Helpfulness"],
      source: {
        origin: "raw",
        dataSourceConfig: { cloudWatchLogs: { logGroupNames: ["/x"], serviceNames: ["s"] } },
      },
      groundTruth: [{ sessionId: "s1" }],
    });
    expect(input.evaluationMetadata).toEqual({ sessionMetadata: [{ sessionId: "s1" }] });
  });
});
