import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

interface DecodedPng {
  alpha: number[];
  dpi: number | null;
  height: number;
  width: number;
}

const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
};

const decodeRgbaPng = async (path: string): Promise<DecodedPng> => {
  const input = await readFile(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let dpi: number | null = null;
  const compressed: Buffer[] = [];

  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === "pHYs" && data[8] === 1) {
      dpi = data.readUInt32BE(0) * 0.0254;
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  const source = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset];
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = source[sourceOffset + x] ?? 0;
      const left = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const above =
        y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= 4
          ? (pixels[(y - 1) * stride + x - 4] ?? 0)
          : 0;
      const value =
        filter === 0
          ? raw
          : filter === 1
            ? raw + left
            : filter === 2
              ? raw + above
              : filter === 3
                ? raw + Math.floor((left + above) / 2)
                : raw + paeth(left, above, upperLeft);
      pixels[y * stride + x] = value & 0xff;
    }
    sourceOffset += stride;
  }

  const alpha: number[] = [];
  for (let index = 3; index < pixels.length; index += 4) {
    alpha.push(pixels[index] ?? 0);
  }
  return { alpha, dpi, height, width };
};

const assetPath = (name: string): string =>
  new URL(`../assets/${name}`, import.meta.url).pathname;

describe("macOS tray assets", () => {
  it.each([
    ["trayTemplate.png", 16],
    ["trayTemplate@2x.png", 32],
  ])("%s contains transparent negative space", async (name, size) => {
    const image = await decodeRgbaPng(assetPath(name));

    expect(image).toMatchObject({ width: size, height: size });
    expect(image.alpha.some((alpha) => alpha === 0)).toBe(true);
    expect(image.alpha.some((alpha) => alpha > 0)).toBe(true);
  });

  it("marks the Retina template as 144 DPI", async () => {
    const image = await decodeRgbaPng(
      assetPath("trayTemplate@2x.png"),
    );

    expect(image.dpi).not.toBeNull();
    expect(image.dpi ?? 0).toBeCloseTo(144, 0);
  });
});
