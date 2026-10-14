import { afterAll } from "vitest";
import { ManagedChildProcessRunner, stopManagedProcesses } from "../../src/main/model/cli/managed-child-process.js";

// Use the existing bounded process-group runner: execFile's timeout killed only Electron's root.
const runner = new ManagedChildProcessRunner();
const pending = new Set<Promise<unknown>>();
afterAll(async () => {
  stopManagedProcesses();
  await Promise.allSettled([...pending]);
});

export const runElectronCheck = async (
  executable: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => {
  const result = runner.run({
    executable, args, cwd: options.cwd, stdin: "", timeoutMs: options.timeout,
    maximumStdoutBytes: options.maxBuffer ?? 1024 * 1024,
    maximumStderrBytes: options.maxBuffer ?? 1024 * 1024,
    environment: options.env ?? process.env,
  });
  pending.add(result);
  try { return await result; } finally { pending.delete(result); }
};
