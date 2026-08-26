const HEX = "0123456789abcdef";

export async function sha256Hex(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  let bytes: ArrayBuffer;
  if (input instanceof Blob) {
    bytes = await input.arrayBuffer();
  } else if (input instanceof Uint8Array) {
    bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  } else {
    bytes = input;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let result = "";
  for (const byte of digest) result += HEX.charAt(byte >>> 4) + HEX.charAt(byte & 0x0f);
  return result;
}
