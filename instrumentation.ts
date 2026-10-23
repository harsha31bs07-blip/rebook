export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DEMO_WARM_POOL === "1") {
    const { startWarmPool } = await import("./lib/demo/createWorkspace");
    void startWarmPool();
  }
}
