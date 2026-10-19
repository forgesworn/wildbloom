import { describe, expect, it } from "vitest";
import { createDownloadedReply, DOWNLOADED_REPLY, type ReplyChannel } from "../src/get/reply.js";

interface FakeChannel extends ReplyChannel {
  readonly sent: Uint8Array[];
  disposed: number;
}

function fakeChannel(reply: () => Promise<void> = async () => undefined): FakeChannel {
  const channel: FakeChannel = {
    sent: [],
    disposed: 0,
    reply: async ({ payload }) => {
      channel.sent.push(payload);
      await reply();
    },
    dispose: () => { channel.disposed += 1; },
  };
  return channel;
}

describe("downloaded reply", () => {
  it("is the fixed v1 message, well inside the 1,024 byte limit", () => {
    expect(DOWNLOADED_REPLY).toBe('{"v":1,"event":"downloaded"}');
    expect(new TextEncoder().encode(DOWNLOADED_REPLY).byteLength).toBe(28);
    expect(JSON.parse(DOWNLOADED_REPLY)).toEqual({ v: 1, event: "downloaded" });
  });

  it("sends exactly those bytes once, then closes the channel", async () => {
    const channel = fakeChannel();
    const reply = createDownloadedReply(channel);
    await reply.send();
    expect(channel.sent).toHaveLength(1);
    expect(new TextDecoder().decode(channel.sent[0])).toBe('{"v":1,"event":"downloaded"}');
    expect(channel.disposed).toBe(1);
  });

  it("never sends a second time, even when asked again or while the first is still in flight", async () => {
    let release: () => void = () => undefined;
    const channel = fakeChannel(() => new Promise<void>((done) => { release = done; }));
    const reply = createDownloadedReply(channel);
    const first = reply.send();
    const second = reply.send();
    release();
    await Promise.all([first, second]);
    await reply.send();
    expect(channel.sent).toHaveLength(1);
  });

  it("swallows a failed reply, does not retry it, and still closes the channel", async () => {
    const channel = fakeChannel(async () => { throw Object.assign(new Error("expired"), { name: "ForegatherTransportError", kind: "expired" }); });
    const reply = createDownloadedReply(channel);
    await expect(reply.send()).resolves.toBeUndefined();
    await reply.send();
    expect(channel.sent).toHaveLength(1);
    expect(channel.disposed).toBe(1);
  });

  it("swallows a reply that throws before returning a promise", async () => {
    const channel: ReplyChannel = {
      reply: () => { throw new Error("Invalid pairing operation"); },
      dispose: () => undefined,
    };
    await expect(createDownloadedReply(channel).send()).resolves.toBeUndefined();
  });

  it("sends nothing once disposed", async () => {
    const channel = fakeChannel();
    const reply = createDownloadedReply(channel);
    reply.dispose();
    await reply.send();
    expect(channel.sent).toHaveLength(0);
    expect(channel.disposed).toBe(1);
  });

  it("closes a channel that was never used, once, however often it is disposed", () => {
    const channel = fakeChannel();
    const reply = createDownloadedReply(channel);
    reply.dispose();
    reply.dispose();
    expect(channel.disposed).toBe(1);
  });

  it("closes the channel when disposed while the reply is in flight", async () => {
    let release: () => void = () => undefined;
    const channel = fakeChannel(() => new Promise<void>((done) => { release = done; }));
    const reply = createDownloadedReply(channel);
    const pending = reply.send();
    reply.dispose();
    expect(channel.disposed).toBe(1);
    release();
    await pending;
    expect(channel.disposed).toBe(1);
  });

  it("does not fail when closing the channel throws", async () => {
    const channel: ReplyChannel = { reply: async () => undefined, dispose: () => { throw new Error("gone"); } };
    const reply = createDownloadedReply(channel);
    await expect(reply.send()).resolves.toBeUndefined();
    expect(() => reply.dispose()).not.toThrow();
  });
});
