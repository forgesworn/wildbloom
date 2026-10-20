import { LIMITS } from "./config.js";

/**
 * The binary frames on the data channel (wildbloom-direct/1, "Data channel and
 * frames"). Big-endian, first byte the type. In `to-drop` the page is the
 * sender and Drop the receiver, but nothing here names a device: a frame is read
 * for the role that sent it.
 */

export type Role = "sender" | "receiver";

export const FRAME_TYPE = Object.freeze({ data: 1, ack: 2, end: 3, kept: 4, stop: 5 });

/** 1 a person cancelled, 2 a protocol, connection or verification failure, 3 no storage. */
export type StopCode = 1 | 2 | 3;

export type Frame =
  | { readonly type: "data"; readonly offset: number; readonly bytes: Uint8Array }
  | { readonly type: "ack"; readonly next: number }
  | { readonly type: "end"; readonly sha256: Uint8Array; readonly size: number }
  | { readonly type: "kept" }
  | { readonly type: "stop"; readonly code: StopCode };

/** A frame that is not allowed. The reader sends STOP 2 and closes. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export const DATA_HEADER_BYTES = 9;
export const END_FRAME_BYTES = 41;

function writeU64(view: DataView, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Offsets and sizes are whole numbers up to 2^53 - 1.");
  view.setUint32(at, Math.floor(value / 2 ** 32), false);
  view.setUint32(at + 4, value % 2 ** 32, false);
}

function readU64(view: DataView, at: number): number {
  const high = view.getUint32(at, false);
  if (high > 0x1f_ffff) throw new FrameError("An offset or size is beyond 2^53 - 1.");
  return high * 2 ** 32 + view.getUint32(at + 4, false);
}

export function encodeData(offset: number, bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || DATA_HEADER_BYTES + bytes.length > LIMITS.frameBytes) throw new RangeError("A DATA frame holds 1 to 65,527 bytes.");
  const frame = new Uint8Array(DATA_HEADER_BYTES + bytes.length);
  frame[0] = FRAME_TYPE.data;
  writeU64(new DataView(frame.buffer), 1, offset);
  frame.set(bytes, DATA_HEADER_BYTES);
  return frame;
}

export function encodeAck(next: number): Uint8Array {
  const frame = new Uint8Array(9);
  frame[0] = FRAME_TYPE.ack;
  writeU64(new DataView(frame.buffer), 1, next);
  return frame;
}

export function encodeEnd(sha256: Uint8Array, size: number): Uint8Array {
  if (sha256.length !== 32) throw new RangeError("END carries a 32-byte SHA-256.");
  const frame = new Uint8Array(END_FRAME_BYTES);
  frame[0] = FRAME_TYPE.end;
  frame.set(sha256, 1);
  writeU64(new DataView(frame.buffer), 33, size);
  return frame;
}

export function encodeKept(): Uint8Array {
  return new Uint8Array([FRAME_TYPE.kept]);
}

export function encodeStop(code: StopCode): Uint8Array {
  return new Uint8Array([FRAME_TYPE.stop, code]);
}

/**
 * Reads one binary message sent by `from`. DATA and END come only from the
 * sender, ACK and KEPT only from the receiver, and STOP from either. Type 6 is
 * reserved for a later resume, and an unknown STOP reason reads as 2.
 */
export function decodeFrame(from: Role, frame: Uint8Array): Frame {
  if (frame.length === 0) throw new FrameError("An empty message.");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  switch (frame[0]) {
    case FRAME_TYPE.data:
      if (from !== "sender") throw new FrameError("DATA from the receiver.");
      if (frame.length <= DATA_HEADER_BYTES || frame.length > LIMITS.frameBytes) throw new FrameError("A DATA frame of the wrong length.");
      return { type: "data", offset: readU64(view, 1), bytes: frame.subarray(DATA_HEADER_BYTES) };
    case FRAME_TYPE.ack:
      if (from !== "receiver") throw new FrameError("ACK from the sender.");
      if (frame.length !== 9) throw new FrameError("An ACK frame of the wrong length.");
      return { type: "ack", next: readU64(view, 1) };
    case FRAME_TYPE.end:
      if (from !== "sender") throw new FrameError("END from the receiver.");
      if (frame.length !== END_FRAME_BYTES) throw new FrameError("An END frame of the wrong length.");
      return { type: "end", sha256: frame.slice(1, 33), size: readU64(view, 33) };
    case FRAME_TYPE.kept:
      if (from !== "receiver") throw new FrameError("KEPT from the sender.");
      if (frame.length !== 1) throw new FrameError("A KEPT frame of the wrong length.");
      return { type: "kept" };
    case FRAME_TYPE.stop: {
      if (frame.length !== 2) throw new FrameError("A STOP frame of the wrong length.");
      const code = frame[1];
      return { type: "stop", code: code === 1 || code === 3 ? code : 2 };
    }
    default:
      throw new FrameError("An unknown frame type.");
  }
}
