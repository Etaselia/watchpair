export async function terminateChildProcess(
  child,
  { graceMs = 3_000, forceMs = 1_000 } = {},
) {
  if (!child || child.exitCode !== null) return;

  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);

  if (!graceful && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, forceMs)),
    ]);
  }
}
