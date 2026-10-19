// Every user-visible string on the recipient page lives here (design spec 9.4),
// so the plain-language audit has one file to read. British English, sentence
// case, no exclamation marks. Curly quotes and the ellipsis are deliberate.

export const COPY = {
  brand: "Wildbloom",
  footer: "This is new software and hasn't been independently audited yet.",
  aboutLink: "About Wildbloom",
  titleSuffix: "Wildbloom",
  noScript: "This page needs JavaScript to open the file. Turn it on, or try another browser.",
  offlineBanner: "You're offline. Connect to the internet to continue.",
  wordsLabel: "The 4 words",
  checkWordsLabel: "Words to compare with the sender",
  words: {
    hint: (n: number): string => `${n} of 4 words`,
    empty: "Type the 4 words first.",
    wrongCount: (n: number): string => (n === 1 ? "That's 1 word. You need 4." : `That's ${n} words. You need 4.`),
    unknown: (word: string): string => `“${word}” isn't one of the words. Check the spelling.`,
    useSuggestion: (word: string): string => `Use “${word}”`,
  },
  buttons: {
    continue: "Continue",
    cancel: "Cancel",
    tryAgain: "Try again",
    yes: "Yes, they match",
    no: "No, they don't",
    download: "Download",
    saveAgain: "Save again",
  },
  timeLeft: (clock: string): string => `${clock} left`,
  senderNeeds: "The sender needs Wildbloom open while you do this.",
  announce: {
    connected: "Connected.",
    progress: (percent: number): string => `Download ${percent}% complete.`,
    downloaded: "Download complete. Checking the file.",
    saved: "Saved.",
  },
  progressLabel: (done: string, total: string): string => `${done} of ${total}`,
  progressName: "Download progress",
  screens: {
    r2: { h1: "This browser can't open the file", body: "Try an up-to-date version of Safari, Chrome, Edge or Firefox." },
    r3: { h1: "This link isn't complete", body: "Ask the sender to send it again, or make sure you copied all of it." },
    r4: { h1: "This link has expired", body: "Links work for 10 minutes. Ask the sender to share the file again." },
    r5: { h1: "Get your file", body: "Type the 4 words the sender told you." },
    r6: { h1: "Connecting to the sender", body: "Keep this page open." },
    r7: { h1: "Waiting for the sender", body: "Ask them to keep Wildbloom open. Keep this page open." },
    r8: {
      h1: "Those words didn't work",
      body: "The link has stopped working to keep the file safe. Ask the sender to share it again. They'll get a new link and new words.",
    },
    r9: { h1: "This link has already been used", body: "Each link works for one person. Ask the sender to share the file again." },
    r10: { h1: "Can't connect right now", body: "Check your internet connection, then try again." },
    r11: { h1: "The sender stopped sharing", body: "Ask them to share the file again if you still need it." },
    r12: { h1: "Check these words with the sender", body: "The sender will read you 3 words. Do they match?" },
    r13: {
      h1: "Nothing was sent",
      body: "The words didn't match, so the file wasn't sent. Tell the sender and ask them to share it again.",
    },
    r14: { h1: "Waiting for the sender", body: "They need to confirm the words on their computer. Keep this page open." },
    r15: { h1: "Your file is ready", body: "It's downloaded from the sender's storage and decrypted on this device." },
    r16: { h1: "Downloading" },
    r17: { h1: "Checking the file", body: "Making sure it's exactly what they sent." },
    r18: {
      h1: "Downloaded",
      body: (name: string): string =>
        `Your browser has saved ${name}. If you can't find it, look in your downloads or save it again. Keep this page open until the file has finished saving. Then you can close this page.`,
    },
    r19: { h1: "The file isn't available right now", body: "The sender's storage didn't respond. Try again in a few minutes." },
    r20: { h1: "This file is no longer shared", body: "Ask the sender to share it again if you still need it." },
    r21: {
      h1: "This file didn't pass its check",
      body: "It may have been damaged on the way, so it wasn't saved. Try again, or ask the sender to share it again.",
    },
    r22: { h1: "This file is too big for a browser", body: "Ask the sender to send it another way." },
    r23: { h1: "Your browser didn't save the file", body: "Try saving it again." },
    // Not in the design spec: the two states below had no copy, and are flagged in the build report.
    cancelled: { h1: "You stopped this", body: "Nothing was sent. Ask the sender to share the file again if you still need it." },
    invalid: {
      h1: "This file can't be opened",
      body: "The details from the sender weren't in the form this page expects. Ask them to share the file again.",
    },
  },
} as const;

/** Decimal units, matching Finder and phone storage screens. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** m:ss countdown text, never negative. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
