/**
 * Human steering mailbox.
 *
 * The operator (via the web panel) posts messages targeted at a phase, a
 * role, or everyone. Agents consume them at prompt/tool boundaries: a
 * message is delivered to each (phase:role) consumer exactly once, formatted
 * as a priority instruction. The mailbox is a run artifact — the trail shows
 * when the human steered and what happened next.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SteeringMessage {
  id: string;
  ts: string;
  /** Phase key ("03-experiment"), role name, or "any". */
  target: string;
  text: string;
  /** `${phase}:${role}` ids that already received this message. */
  consumedBy: string[];
}

export function consumerId(phase: string, role: string): string {
  return `${phase}:${role}`;
}

export class SteeringMailbox {
  readonly path: string;

  constructor(runRoot: string) {
    this.path = join(runRoot, "steering.jsonl");
  }

  post(target: string, text: string): SteeringMessage {
    const message: SteeringMessage = {
      id: randomUUID().slice(0, 8),
      ts: new Date().toISOString(),
      target: target || "any",
      text: text.trim(),
      consumedBy: [],
    };
    mkdirSync(join(this.path, ".."), { recursive: true });
    appendFileSync(this.path, JSON.stringify(message) + "\n");
    return message;
  }

  private read(): SteeringMessage[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as SteeringMessage);
  }

  private write(messages: SteeringMessage[]): void {
    writeFileSync(this.path, messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : ""));
  }

  /** Unconsumed messages matching a consumer (its phase, its role, or "any"). */
  pending(phase: string, role: string): SteeringMessage[] {
    const consumer = consumerId(phase, role);
    return this.read().filter(
      (m) =>
        !m.consumedBy.includes(consumer) &&
        (m.target === "any" || m.target === phase || m.target === role),
    );
  }

  /** All messages (panel history view). */
  all(): SteeringMessage[] {
    return this.read();
  }

  /** Mark messages consumed by a consumer (called after delivery). */
  markConsumed(ids: string[], phase: string, role: string): void {
    if (ids.length === 0) return;
    const consumer = consumerId(phase, role);
    const messages = this.read();
    for (const m of messages) {
      if (ids.includes(m.id) && !m.consumedBy.includes(consumer)) {
        m.consumedBy.push(consumer);
      }
    }
    this.write(messages);
  }

  /** Drain: return the formatted steering block for a consumer, marking consumed. */
  drain(phase: string, role: string): string | null {
    const pending = this.pending(phase, role);
    if (pending.length === 0) return null;
    this.markConsumed(
      pending.map((m) => m.id),
      phase,
      role,
    );
    return [
      "⚙ HUMAN STEERING — priority instruction from the operator (overrides prior guidance where they conflict):",
      ...pending.map((m) => `  • [${m.ts.slice(11, 19)}${m.target !== "any" ? ` → ${m.target}` : ""}] ${m.text}`),
    ].join("\n");
  }
}

/** Prepend a steering block to a prompt (no-op when the mailbox is empty). */
export function withSteering(steering: string | null, prompt: string): string {
  return steering ? `${steering}\n\n---\n\n${prompt}` : prompt;
}
