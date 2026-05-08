import "./loadEnv.ts"; // MUST stay as first import — populates process.env before llm.ts captures constants
import Fastify from "fastify";
import cors from "@fastify/cors";
import { corsOptions } from "./cors.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { runsRoutes } from "./routes/runs.ts";
import { compileRoutes } from "./routes/compile.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { exportRoutes } from "./routes/export.ts";
import { MODEL, LLM_BASE_URL, CONTEXT_WINDOW } from "./llm.ts";

const PORT = Number(process.env.PORT ?? 8787);

const app = Fastify({ logger: true });

await app.register(cors, corsOptions);
await app.register(tasksRoutes);
await app.register(runsRoutes);
await app.register(compileRoutes);
await app.register(settingsRoutes);
await app.register(exportRoutes);

app.get("/api/health", async () => ({
  ok: true,
  model: MODEL,
  llm_base_url: LLM_BASE_URL,
  context_window: CONTEXT_WINDOW,
}));

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`tickle server listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
