// Systematic Reed–Solomon over GF(256), primitive polynomial 0x11d.
// Versioned layout: docs/POOL-STORAGE.md. Coding provides availability, not secrecy.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, value = 1; i < 255; i += 1) {
  EXP[i] = value;
  LOG[value] = i;
  value <<= 1;
  if (value & 256) value ^= 0x11d;
}
for (let i = 255; i < 510; i += 1) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number): number => a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
const inverse = (a: number): number => EXP[255 - LOG[a]!]!;
type Matrix = number[][];

export function codingBounds(required: number, total: number): void {
  if (!Number.isInteger(required) || !Number.isInteger(total) || required < 2 || required >= total || total > 16) {
    throw new Error("Erasure coding needs 2–15 required parts and up to 16 total parts, with at least one spare part.");
  }
}

function invert(matrix: Matrix): Matrix {
  const size = matrix.length;
  const work = matrix.map((row, r) => [...row, ...Array.from({ length: size }, (_, c) => Number(r === c))]);
  for (let col = 0; col < size; col += 1) {
    const pivot = work.findIndex((row, r) => r >= col && row[col] !== 0);
    if (pivot < 0) throw new Error("Parts do not form an invertible coding matrix.");
    [work[col], work[pivot]] = [work[pivot]!, work[col]!];
    const row = work[col]!;
    const scale = inverse(row[col]!);
    for (let c = 0; c < size * 2; c += 1) row[c] = mul(row[c]!, scale);
    for (let r = 0; r < size; r += 1) {
      if (r === col) continue;
      const factor = work[r]![col]!;
      for (let c = 0; c < size * 2; c += 1) work[r]![c] = work[r]![c]! ^ mul(factor, row[c]!);
    }
  }
  return work.map((row) => row.slice(size));
}

function generator(required: number, total: number): Matrix {
  codingBounds(required, total);
  const vandermonde = Array.from({ length: total }, (_, r) => {
    const row = [1];
    for (let c = 1; c < required; c += 1) row.push(mul(row[c - 1]!, r));
    return row;
  });
  const topInverse = invert(vandermonde.slice(0, required));
  return vandermonde.map((row) => Array.from({ length: required }, (_, col) =>
    row.reduce((sum, value, i) => sum ^ mul(value, topInverse[i]![col]!), 0)));
}

function combine(coefficients: number[], inputs: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(size);
  for (let i = 0; i < inputs.length; i += 1) {
    const coefficient = coefficients[i]!;
    if (!coefficient) continue;
    const input = inputs[i]!;
    for (let pos = 0; pos < input.length; pos += 1) output[pos] = output[pos]! ^ mul(coefficient, input[pos]!);
  }
  return output;
}

async function checkpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // Yield to cancellation/input between bounded stripes, including in browsers.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

const STRIPE_BYTES = 64 * 1024;
export async function encodeParts(blob: Blob, required: number, total: number, signal?: AbortSignal): Promise<Blob[]> {
  const matrix = generator(required, total);
  if (!Number.isSafeInteger(blob.size) || blob.size < required) throw new Error("Payload is too small to split.");
  const size = Math.ceil(blob.size / required);
  const outputs: BlobPart[][] = Array.from({ length: total }, () => []);
  for (let offset = 0; offset < size; offset += STRIPE_BYTES) {
    await checkpoint(signal);
    const count = Math.min(STRIPE_BYTES, size - offset);
    const data = await Promise.all(Array.from({ length: required }, async (_, i) => {
      const start = i * size + offset;
      return new Uint8Array(await blob.slice(start, Math.min(start + count, (i + 1) * size)).arrayBuffer());
    }));
    for (let i = 0; i < total; i += 1) outputs[i]!.push(combine(matrix[i]!, data, count));
  }
  signal?.throwIfAborted();
  return outputs.map((parts) => new Blob(parts, { type: "application/octet-stream" }));
}

export async function decodeParts(
  parts: ReadonlyArray<{ index: number; blob: Blob }>, required: number, total: number, length: number, signal?: AbortSignal,
): Promise<Blob> {
  const matrix = generator(required, total);
  if (!Number.isSafeInteger(length) || length < required || parts.length !== required
    || new Set(parts.map((part) => part.index)).size !== required
    || parts.some((part) => !Number.isInteger(part.index) || part.index < 0 || part.index >= total
      || part.blob.size !== Math.ceil(length / required))) {
    throw new Error("Wrong part count, index or size for reconstruction.");
  }
  const decoding = invert(parts.map((part) => matrix[part.index]!));
  const size = Math.ceil(length / required);
  const output: BlobPart[][] = Array.from({ length: required }, () => []);
  for (let offset = 0; offset < size; offset += STRIPE_BYTES) {
    await checkpoint(signal);
    const count = Math.min(STRIPE_BYTES, size - offset);
    const data = await Promise.all(parts.map(async (part) => new Uint8Array(await part.blob.slice(offset, offset + count).arrayBuffer())));
    for (let i = 0; i < required; i += 1) output[i]!.push(combine(decoding[i]!, data, count));
  }
  signal?.throwIfAborted();
  return new Blob(output.map((part) => new Blob(part))).slice(0, length);
}
