import { spawn } from "node:child_process";
import net from "node:net";

export const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/**
 * Starts the production build with `next start` on a free loopback port and exactly the given
 * environment (plus PATH/HOME). Resolves once /api/health answers. `output` collects stdout+stderr.
 */
export async function startApp(env) {
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, output, stop };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`next start did not become healthy:\n${output.join("")}`);
}

/** Telemetry lines the route printed (one JSON object per generation attempt). */
export const generationEvents = (output) =>
  output
    .join("")
    .split("\n")
    .filter((line) => line.startsWith('{"event":"generation"'))
    .map((line) => JSON.parse(line));
