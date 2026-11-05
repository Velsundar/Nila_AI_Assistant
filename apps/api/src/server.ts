import { createApp } from "./app";
import { config } from "./config";
import { connectDb, disconnectDb } from "./db";
import { migrateLegacyCategories } from "./services/migrations";

async function main() {
  await connectDb();
  const m = await migrateLegacyCategories();
  if (m.expenses || m.budgetsRenamed || m.budgetsDropped) {
    console.log(`[api] Migrated legacy categories: ${m.expenses} expenses, ${m.budgetsRenamed} budgets renamed, ${m.budgetsDropped} duplicate budgets dropped`);
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] Nila API listening on http://localhost:${config.port} (LLM provider: ${config.llm.provider})`);
  });
  const shutdown = async () => {
    server.close();
    await disconnectDb().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[api] Failed to start:", err);
  process.exit(1);
});
