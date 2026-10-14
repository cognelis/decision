import {
  runtimeDescriptorSchema,
  type RuntimeDescriptor,
} from "@cognelis/decision-protocol";
import { renameReplacing } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export const writeRuntimeDescriptor = async (
  path: string,
  input: unknown,
): Promise<void> => {
  const descriptor: RuntimeDescriptor = runtimeDescriptorSchema.parse(input);
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, JSON.stringify(descriptor), {
      encoding: "utf8",
      mode: 0o600,
    });
    // The bridge reads this file on every hook: on Windows, open for a moment, it refused the rename once and
    // the app would not start.
    await renameReplacing(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const removeRuntimeDescriptor = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
};

export const writeObsidianSearchShutdownMarker = async (
  path: string,
  pid: number = process.pid,
): Promise<void> => {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Invalid Obsidian shutdown marker process");
  }
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ closed: true, pid, version: 1 }),
      { encoding: "utf8", mode: 0o600 },
    );
    await renameReplacing(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};
