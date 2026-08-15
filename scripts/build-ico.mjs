import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const createIco = (images) => {
  if (!Array.isArray(images) || images.length === 0 || images.length > 65535) {
    throw new Error("ICO requires between 1 and 65535 images");
  }
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`Unsupported ICO image size: ${size}`);
    }
    if (!Buffer.isBuffer(data) || data.length === 0) {
      throw new Error(`ICO image ${size} is empty`);
    }
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
};

const main = async (arguments_) => {
  const [output, ...entries] = arguments_;
  if (output === undefined || entries.length === 0) {
    throw new Error("Usage: node scripts/build-ico.mjs output.ico size:path ...");
  }
  const images = await Promise.all(
    entries.map(async (entry) => {
      const separator = entry.indexOf(":");
      const size = Number(entry.slice(0, separator));
      const path = entry.slice(separator + 1);
      if (separator < 1 || path.length === 0) {
        throw new Error(`Invalid ICO image argument: ${entry}`);
      }
      return { size, data: await readFile(path) };
    }),
  );
  await writeFile(output, createIco(images), { mode: 0o644 });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
