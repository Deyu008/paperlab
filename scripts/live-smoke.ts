/**
 * Minimal live request through pi (one turn, a few hundred tokens) to verify
 * the zai-coding-cn endpoint + key. All HTTP is issued by pi-ai.
 */
import { loadConfigFromDisk } from "../src/config.ts";
import { resolveRoleModel } from "../src/core/models.ts";
import { createRoleSession } from "../src/core/agent.ts";

const { config, errors } = loadConfigFromDisk("config.yaml");
if (errors.length) throw new Error(errors.join("; "));
const model = resolveRoleModel(config, "phd");
console.log(`model: ${model.provider}/${model.id}`);

const session = await createRoleSession({ systemPrompt: "You are a test echo.", cwd: process.cwd(), model });
try {
  await session.prompt("Reply with exactly: OK-paperlab");
  console.log("reply:", session.lastAssistantText()?.slice(0, 80));
  console.log("usage:", session.usage());
} finally {
  session.session.dispose();
}
