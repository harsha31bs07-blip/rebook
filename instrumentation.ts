export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPruning } = await import("./lib/store");
    const { resumeStalePreparations, startWarmPool } = await import("./lib/demo/createWorkspace");
    await resumeStalePreparations(undefined, true);
    startPruning();
    void startWarmPool().catch(() => {
      console.error("Workspace startup recovery failed");
    });
  }
}
