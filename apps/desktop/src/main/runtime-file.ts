import {
  runtimeDescriptorSchema,
  type RuntimeDescriptor,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  rename,
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
    await rename(temporary, path);
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
