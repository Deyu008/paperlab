import { describe, it, expect } from "vitest";
import {
  aggregateMetrics,
  validateMetricRecord,
  renderMetricsJson,
  renderMetricsTable,
} from "../src/tools/metrics.ts";

describe("validateMetricRecord", () => {
  it("accepts complete records and honest failures", () => {
    expect(validateMetricRecord({ experiment: "e", metric: "auc", value: 0.7, higher_is_better: true })).toBeNull();
    expect(validateMetricRecord({ experiment: "e", metric: "auc", value: null, higher_is_better: true })).toBeNull();
  });

  it("rejects malformed records with field-specific errors", () => {
    expect(validateMetricRecord({ metric: "x", value: 1, higher_is_better: true })).toMatch(/experiment/);
    expect(validateMetricRecord({ experiment: "e", metric: "x", value: "0.7", higher_is_better: true })).toMatch(/value/);
    expect(validateMetricRecord({ experiment: "e", metric: "x", value: 1 })).toMatch(/higher_is_better/);
    expect(validateMetricRecord("nope")).toMatch(/not a JSON object/);
  });
});

describe("aggregateMetrics", () => {
  it("last value wins, run counts accumulate, sorted output", () => {
    const result = aggregateMetrics([
      JSON.stringify({ experiment: "b", metric: "acc", value: 0.6, higher_is_better: true }),
      JSON.stringify({ experiment: "a", metric: "auc", value: 0.8, higher_is_better: true }),
      JSON.stringify({ experiment: "b", metric: "acc", value: 0.65, higher_is_better: true }),
      JSON.stringify({ experiment: "a", metric: "auc", value: 0.82, higher_is_better: true }),
    ].join("\n"));
    expect(result.invalidLines).toEqual([]);
    expect(result.totalLines).toBe(4);
    const a = result.metrics.find((m) => m.experiment === "a")!;
    expect(a.value).toBe(0.82);
    expect(a.runs).toBe(2);
    // sorted: a before b
    expect(result.metrics[0]!.experiment).toBe("a");
  });

  it("quarantines invalid lines instead of dropping silently", () => {
    const result = aggregateMetrics(
      [
        JSON.stringify({ experiment: "ok", metric: "m", value: 1, higher_is_better: false }),
        "{broken json",
        JSON.stringify({ experiment: "", metric: "m", value: 1, higher_is_better: false }),
      ].join("\n"),
    );
    expect(result.metrics).toHaveLength(1);
    expect(result.invalidLines).toHaveLength(2);
    expect(result.invalidLines[0]).toMatchObject({ error: "invalid JSON" });
    expect(result.invalidLines[1]!.error).toContain("experiment");
  });

  it("renders json and table views", () => {
    const result = aggregateMetrics(
      JSON.stringify({ experiment: "e", metric: "auc", value: 0.9, higher_is_better: true, notes: "n=100" }) + "\n",
    );
    const json = renderMetricsJson(result);
    expect(JSON.parse(json).metrics).toHaveLength(1);
    expect(renderMetricsTable(result.metrics)).toContain("e | auc | 0.9 | ↑ | 1 | n=100");
    expect(renderMetricsTable([])).toBe("(no metrics recorded)");
  });
});
