import { describe, expect, it } from "vitest";
import { codingBounds, decodeParts, encodeParts } from "../src/core/erasure.js";

const bytes = async (blob: Blob): Promise<number[]> => [...new Uint8Array(await blob.arrayBuffer())];
function combinations(values: number[], count: number): number[][] {
  if (!count) return [[]];
  return values.flatMap((value, i) => combinations(values.slice(i + 1), count - 1).map((rest) => [value, ...rest]));
}

describe("version 1 systematic erasure layout", () => {
  it("matches an independent polynomial/Lagrange interpolation vector, including zero padding", async () => {
    // Independently computed without the implementation's log tables or matrix
    // inversion: polynomial multiplication modulo 0x11d, Lagrange at x=0..4.
    const parts = await encodeParts(new Blob([new Uint8Array(Array.from({ length: 11 }, (_, i) => i))]), 3, 5);
    expect(await Promise.all(parts.map(bytes))).toEqual([
      [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 0], [12, 13, 14, 4], [16, 17, 18, 41],
    ]);
  });

  it("recovers every threshold subset, including parity-only recovery", async () => {
    for (const [required, total] of [[2, 4], [3, 6], [4, 7], [7, 8], [15, 16]]) {
      const original = new Uint8Array(Array.from({ length: 137 }, (_, i) => (i * 73) % 256));
      const parts = await encodeParts(new Blob([original]), required!, total!);
      for (const subset of combinations(parts.map((_, i) => i), required!)) {
        const recovered = await decodeParts(subset.reverse().map((index) => ({ index, blob: parts[index]! })), required!, total!, original.length);
        expect(await bytes(recovered)).toEqual([...original]);
      }
    }
  });

  it("crosses stripe boundaries without changing layout", async () => {
    const original = new Uint8Array(2 * 65536 + 19).map((_, i) => i % 251);
    const parts = await encodeParts(new Blob([original]), 2, 4);
    const recovered = await decodeParts([{ index: 2, blob: parts[2]! }, { index: 3, blob: parts[3]! }], 2, 4, original.length);
    expect(await bytes(recovered)).toEqual([...original]);
  });

  it("refuses invalid parameters, insufficient/duplicate parts and wrong lengths", async () => {
    for (const parameters of [[1, 4], [2, 2], [2, 17], [2.5, 4], [NaN, 4]]) expect(() => codingBounds(...parameters as [number, number])).toThrow();
    await expect(encodeParts(new Blob(["a"]), 2, 4)).rejects.toThrow();
    const blob = new Blob(["abcd"]);
    for (const parts of [[], [{ index: 0, blob }, { index: 0, blob }], [{ index: 0, blob }, { index: 4, blob }]]) {
      await expect(decodeParts(parts, 2, 4, 8)).rejects.toThrow();
    }
    await expect(decodeParts([{ index: 0, blob }, { index: 1, blob }], 2, 4, 4)).rejects.toThrow();
  });

  it("honours cancellation before and during coding", async () => {
    const controller = new AbortController();
    const promise = encodeParts(new Blob([new Uint8Array(300000)]), 2, 4, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
    await expect(decodeParts([{ index: 0, blob: new Blob(["ab"]) }, { index: 1, blob: new Blob(["cd"]) }], 2, 4, 4, controller.signal)).rejects.toThrow();
  });
});
