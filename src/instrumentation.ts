/**
 * Next.js instrumentation hook — runs once per server boot (dev + standalone).
 * Arms the Telegram bot supervisor when a bot token is configured, so a
 * crashed bot comes back on its own instead of waiting for an admin page visit.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startBotSupervisor } = await import("./lib/ytd/botsupervisor");
    startBotSupervisor();
  } catch (e) {
    console.warn("[instrumentation] bot supervisor failed to start:", (e as Error).message);
  }
}
