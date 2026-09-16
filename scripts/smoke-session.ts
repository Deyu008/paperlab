/**
 * Smoke: create a role session end-to-end (no LLM call — wiring only).
 * Run: npm run smoke:session
 */
import { createRoleSession } from "../src/core/agent.ts";
import { resolveRoleModel } from "../src/core/models.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const model = resolveRoleModel(DEFAULT_CONFIG, "phd");
console.log("model resolved:", model.provider, model.id);
const session = await createRoleSession({ role: "phd", cwd: process.cwd(), model });
console.log("session created; messages:", session.session.state.messages.length);
console.log("lastAssistantText:", session.lastAssistantText());
console.log("usage:", session.usage());
session.session.dispose();
console.log("OK");
