import { describe, it, expect } from "vitest";
import { loadConfig, modelRefForRole, DEFAULT_CONFIG } from "../src/config.ts";

describe("loadConfig", () => {
  it("returns defaults for an empty document", () => {
    const { config, errors } = loadConfig("");
    expect(errors).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("parses model refs and role overrides", () => {
    const { config, errors } = loadConfig(`
models:
  default: { provider: deepseek, model: deepseek-v4-flash }
  writer: { provider: zai, model: glm-4.7 }
`);
    expect(errors).toEqual([]);
    expect(config.models.default).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(config.models.writer).toEqual({ provider: "zai", model: "glm-4.7" });
    expect(modelRefForRole(config, "writer")).toEqual({ provider: "zai", model: "glm-4.7" });
    // No reviewer override → falls back to default.
    expect(modelRefForRole(config, "reviewer")).toEqual(config.models.default);
  });

  it("collects errors instead of throwing", () => {
    const { errors } = loadConfig(`
models:
  default: { provider: 3, model: "" }
  unknownrole: { provider: x, model: y }
sandbox: nasa
budgets:
  writeup: { reflections: 99 }
`);
    expect(errors.some((e) => e.includes("models.default.provider"))).toBe(true);
    expect(errors.some((e) => e.includes("models.default.model"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown role"))).toBe(true);
    expect(errors.some((e) => e.includes("sandbox"))).toBe(true);
    expect(errors.some((e) => e.includes("budgets.writeup.reflections"))).toBe(true);
  });

  it("applies budget overrides", () => {
    const { config, errors } = loadConfig(`
budgets:
  literature: { target_papers: 20, max_searches: 5 }
  review: { accept_threshold: 7.5 }
`);
    expect(errors).toEqual([]);
    expect(config.budgets.literature.target_papers).toBe(20);
    expect(config.budgets.literature.max_searches).toBe(5);
    expect(config.budgets.review.accept_threshold).toBe(7.5);
  });

  it("rejects malformed YAML with a parse error", () => {
    const { errors } = loadConfig("models: [unclosed");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("YAML parse error");
  });
});
