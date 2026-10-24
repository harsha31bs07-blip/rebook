export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeStalePreparations, startWarmPool } = await import("./lib/demo/createWorkspace");
    void resumeStalePreparations(undefined, true).then(() => startWarmPool()).catch(() => {
      console.error("Workspace startup recovery failed");
    });
  }
}
