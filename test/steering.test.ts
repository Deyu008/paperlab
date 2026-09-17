import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SteeringMailbox, withSteering, consumerId } from "../src/core/steering.ts";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "paperlab-steer-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("SteeringMailbox", () => {
  it("delivers a targeted message to the right consumer exactly once", () => {
    const box = new SteeringMailbox(base);
    box.post("03-experiment", "drop the n=1000 stratum, double seeds instead");
    expect(box.pending("03-experiment", "mlengineer")).toHaveLength(1);
    const first = box.drain("03-experiment", "mlengineer");
    expect(first).toContain("drop the n=1000 stratum");
    expect(first).toContain("HUMAN STEERING");
    // Second drain: consumed.
    expect(box.drain("03-experiment", "mlengineer")).toBeNull();
    // Phase-keyed target reaches other roles in the same phase too.
    expect(box.drain("03-experiment", "postdoc")).toContain("n=1000");
  });

  it("phase-keyed messages reach every role in that phase", () => {
    const box = new SteeringMailbox(base);
    box.post("05-paper", "add error bars to every plot");
    expect(box.drain("05-paper", "writer")).toContain("error bars");
    // writer consumed; a different consumer in same phase also receives it
    expect(box.drain("05-paper", "reviewer")).toContain("error bars");
    expect(box.drain("06-review", "ac")).toBeNull();
  });

  it("any-target messages reach all consumers once each", () => {
    const box = new SteeringMailbox(base);
    box.post("any", "global note");
    expect(box.drain("01-literature", "phd")).toContain("global note");
    expect(box.drain("03-experiment", "mlengineer")).toContain("global note");
    expect(box.drain("03-experiment", "mlengineer")).toBeNull();
  });

  it("role-targeted messages match by role name", () => {
    const box = new SteeringMailbox(base);
    box.post("writer", "keep tables, add one figure");
    expect(box.drain("05-paper", "writer")).toContain("one figure");
    expect(box.drain("05-paper", "mlengineer")).toBeNull();
  });

  it("drains multiple pending messages in one block", () => {
    const box = new SteeringMailbox(base);
    box.post("any", "first");
    box.post("any", "second");
    const block = box.drain("02-plan", "phd");
    expect(block).toContain("first");
    expect(block).toContain("second");
  });

  it("persists across instances (separate processes)", () => {
    new SteeringMailbox(base).post("any", "persisted");
    const reopened = new SteeringMailbox(base);
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.drain("01-literature", "phd")).toContain("persisted");
  });

  it("withSteering formats the injection", () => {
    expect(withSteering(null, "hello")).toBe("hello");
    expect(withSteering("⚙ STEER", "hello")).toBe("⚙ STEER\n\n---\n\nhello");
    expect(consumerId("a", "b")).toBe("a:b");
  });
});
