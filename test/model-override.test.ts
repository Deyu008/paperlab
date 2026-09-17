import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelOverride, writeModelOverride, applyModelOverride } from "../src/core/model-override.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveModel } from "../src/core/models.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-model-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("model override", () => {
  it("round-trips a validated override", () => {
    writeModelOverride(base, "writer", { provider: "deepseek", model: "deepseek-v4-flash" });
    writeModelOverride(base, "default", { provider: "zai-coding-cn", model: "glm-5.3-flash" });
    const override = readModelOverride(base);
    expect(override.writer).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(override.default).toEqual({ provider: "zai-coding-cn", model: "glm-5.3-flash" });
  });

  it("rejects unknown provider/model", () => {
    expect(() => writeModelOverride(base, "writer", { provider: "nope", model: "x" })).toThrow(/unknown provider/);
    expect(() =>
      writeModelOverride(base, "writer", { provider: "deepseek", model: "not-a-model" }),
    ).toThrow(/unknown model/);
    expect(readModelOverride(base)).toEqual({});
  });

  it("applies over config: default first, then per-role", () => {
    writeModelOverride(base, "default", { provider: "deepseek", model: "deepseek-v4-flash" });
    writeModelOverride(base, "reviewer", { provider: "zai-coding-cn", model: "glm-5.3" });
    const patched = applyModelOverride(DEFAULT_CONFIG, base);
    expect(patched.models.default.model).toBe("deepseek-v4-flash");
    expect(patched.models.reviewer).toEqual({ provider: "zai-coding-cn", model: "glm-5.3" });
    // Untouched role falls back to the overridden default.
    expect(patched.models.phd).toBeUndefined();
    // Resolves through the real catalog.
    expect(resolveModel(patched.models.reviewer!).id).toBe("glm-5.3");
    // Original config object unmodified.
    expect(DEFAULT_CONFIG.models.default.model).toBe("deepseek-v4-flash");
  });

  it("no override file = config unchanged (same reference)", () => {
    expect(applyModelOverride(DEFAULT_CONFIG, base)).toBe(DEFAULT_CONFIG);
  });

  it("corrupt override file is ignored", () => {
    writeFileSync(join(base, "model-override.json"), "{broken");
    expect(applyModelOverride(DEFAULT_CONFIG, base)).toBe(DEFAULT_CONFIG);
    expect(readFileSync(join(base, "model-override.json"), "utf8")).toBe("{broken");
  });
});
