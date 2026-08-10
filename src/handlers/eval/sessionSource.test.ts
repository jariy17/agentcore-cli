import { test, expect, describe } from "bun:test";
import { resolveSessionSource, toSessionFilter } from "./sessionSource";
import { SourceResolver } from "../../io";
import { InputValidationError } from "../../errors";

// A SourceResolver whose stdin is never read — none of these tests use `-`.
function resolver(): SourceResolver {
  return new SourceResolver({ stdin: process.stdin });
}

const BATCH = { allowBatchArms: true } as const;
const ONDEMAND = { allowBatchArms: false } as const;

describe("resolveSessionSource — arm selection", () => {
  test("no source arm throws", async () => {
    await expect(resolveSessionSource({}, resolver(), BATCH)).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test("two arms (agent + online-eval) throws", async () => {
    await expect(
      resolveSessionSource({ agent: "a", "online-eval": "oe" }, resolver(), BATCH),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("agent arm resolves", async () => {
    const v = await resolveSessionSource(
      { agent: "runtime-1", "lookback-days": 7 },
      resolver(),
      BATCH,
    );
    expect(v).toEqual({
      origin: "agent",
      agent: "runtime-1",
      endpoint: undefined,
      window: { kind: "lookback", lookbackDays: 7 },
      sessionIds: undefined,
    });
  });

  test("online-eval arm resolves", async () => {
    const v = await resolveSessionSource({ "online-eval": "oe-1" }, resolver(), BATCH);
    expect(v).toEqual({
      origin: "online-eval",
      onlineEvaluationConfigId: "oe-1",
      window: undefined,
    });
  });

  test("raw data-source-config arm resolves and passes JSON through", async () => {
    const raw = JSON.stringify({
      cloudWatchLogs: { logGroupNames: ["/lg"], serviceNames: ["svc"] },
    });
    const v = await resolveSessionSource({ "data-source-config": raw }, resolver(), BATCH);
    expect(v).toEqual({
      origin: "raw",
      dataSourceConfig: { cloudWatchLogs: { logGroupNames: ["/lg"], serviceNames: ["svc"] } },
    });
  });
});

describe("resolveSessionSource — batch-arm gating & filter rules", () => {
  test("ondemand rejects --online-eval (treated as no arm)", async () => {
    await expect(
      resolveSessionSource({ "online-eval": "oe" }, resolver(), ONDEMAND),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("--session-ids with --online-eval throws", async () => {
    await expect(
      resolveSessionSource({ "online-eval": "oe", "session-ids": ["s1"] }, resolver(), BATCH),
    ).rejects.toThrow(/session-ids/);
  });

  test("--endpoint with --online-eval throws", async () => {
    await expect(
      resolveSessionSource({ "online-eval": "oe", endpoint: "prod" }, resolver(), BATCH),
    ).rejects.toThrow(/endpoint/);
  });

  test("filter flags with --data-source-config throw", async () => {
    const raw = JSON.stringify({ cloudWatchLogs: { logGroupNames: ["/lg"], serviceNames: ["s"] } });
    await expect(
      resolveSessionSource({ "data-source-config": raw, "lookback-days": 7 }, resolver(), BATCH),
    ).rejects.toThrow(/data-source-config/);
  });

  test("lookback + explicit window throws", async () => {
    await expect(
      resolveSessionSource(
        {
          agent: "a",
          "lookback-days": 7,
          "start-time": "2026-01-01T00:00:00Z",
          "end-time": "2026-01-02T00:00:00Z",
        },
        resolver(),
        BATCH,
      ),
    ).rejects.toThrow(/either/);
  });

  test("half window (start without end) throws", async () => {
    await expect(
      resolveSessionSource({ agent: "a", "start-time": "2026-01-01T00:00:00Z" }, resolver(), BATCH),
    ).rejects.toThrow(/together/);
  });

  test("start after end throws", async () => {
    await expect(
      resolveSessionSource(
        { agent: "a", "start-time": "2026-01-02T00:00:00Z", "end-time": "2026-01-01T00:00:00Z" },
        resolver(),
        BATCH,
      ),
    ).rejects.toThrow(/before/);
  });

  test("explicit window + session ids resolve on the agent arm", async () => {
    const v = await resolveSessionSource(
      {
        agent: "a",
        endpoint: "prod",
        "start-time": "2026-01-01T00:00:00Z",
        "end-time": "2026-01-02T00:00:00Z",
        "session-ids": ["s1", "s2"],
      },
      resolver(),
      BATCH,
    );
    expect(v).toEqual({
      origin: "agent",
      agent: "a",
      endpoint: "prod",
      window: {
        kind: "explicit",
        startTime: new Date("2026-01-01T00:00:00Z"),
        endTime: new Date("2026-01-02T00:00:00Z"),
      },
      sessionIds: ["s1", "s2"],
    });
  });
});

describe("toSessionFilter", () => {
  test("undefined window → undefined", () => {
    expect(toSessionFilter(undefined)).toBeUndefined();
  });

  test("explicit window passes through", () => {
    const startTime = new Date("2026-01-01T00:00:00Z");
    const endTime = new Date("2026-01-02T00:00:00Z");
    expect(toSessionFilter({ kind: "explicit", startTime, endTime })).toEqual({
      startTime,
      endTime,
    });
  });

  test("lookback materializes a start before end", () => {
    const filter = toSessionFilter({ kind: "lookback", lookbackDays: 7 });
    expect(filter).toBeDefined();
    const spanMs = +filter!.endTime - +filter!.startTime;
    expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
