// Every user-visible string on the sender page lives here, so the plain-language
// audit has one file to read. It follows the recipient page's tone and rules
// (src/get/copy.ts): British English, sentence case, no exclamation marks, and
// none of the technical terms a person sending a file should never meet. The
// person who asked is always "they" or "them". Curly quotes and the ellipsis
// are deliberate.

import { COPY as RECIPIENT } from "../get/copy.js";

export { formatBytes, formatClock } from "../get/copy.js";

export const COPY = {
  brand: RECIPIENT.brand,
  footer: RECIPIENT.footer,
  aboutLink: RECIPIENT.aboutLink,
  titleSuffix: RECIPIENT.titleSuffix,
  noScript: "This page needs JavaScript to send the file. Turn it on, or try another browser.",
  offlineBanner: RECIPIENT.offlineBanner,
  wordsLabel: RECIPIENT.wordsLabel,
  checkWordsLabel: "Words to compare with theirs",
  words: RECIPIENT.words,
  buttons: {
    continue: RECIPIENT.buttons.continue,
    cancel: RECIPIENT.buttons.cancel,
    tryAgain: RECIPIENT.buttons.tryAgain,
    yes: RECIPIENT.buttons.yes,
    no: RECIPIENT.buttons.no,
    chooseFile: "Choose a file",
    chooseAnother: "Choose another file",
  },
  timeLeft: RECIPIENT.timeLeft,
  theyNeed: "They need Wildbloom open while you do this.",
  retrying: "The connection dropped. Trying again…",
  announce: {
    connected: RECIPIENT.announce.connected,
    preparing: (name: string): string => `Locking ${name} on this phone.`,
    progress: (percent: number): string => `Sending ${percent}% complete.`,
    sent: "Sent.",
  },
  progressLabel: (done: string, total: string): string => `${done} of ${total}`,
  progressName: "Sending progress",
  screens: {
    unsupported: { h1: "This browser can't send the file", body: "Try an up-to-date version of Safari, Chrome, Edge or Firefox." },
    incomplete: { h1: "This link isn't complete", body: "Ask them to send it again, or make sure you copied all of it." },
    expired: { h1: "This link has expired", body: "Links work for 10 minutes. Ask them to send you a new request." },
    words: { h1: "Send a file", body: "Type the 4 words they told you." },
    connecting: { h1: "Connecting", body: "Keep this page open." },
    waiting: { h1: "Waiting for them", body: "Ask them to keep Wildbloom open. Keep this page open." },
    wrongWords: {
      h1: "Those words didn't work",
      body: "The link has stopped working to keep things safe. Ask them to send you a new request. They'll get a new link and new words.",
    },
    used: { h1: "This link has already been used", body: "Each link works for one person. Ask them to send you a new request." },
    network: { h1: "Can't connect right now", body: "Check your internet connection, then try again." },
    check: { h1: "Check these words with them", body: "They'll read you 3 words. Do they match?" },
    mismatch: {
      h1: "Nothing was sent",
      body: "The words didn't match, so nothing was set up. Tell them and ask them to send you a new request.",
    },
    confirming: { h1: "Waiting for them", body: "They need to confirm the words on their computer. Keep this page open." },
    choose: {
      h1: "Choose a file",
      body: (limit: string): string => `It's locked on this phone before it's sent, so only they can open it. Up to ${limit}.`,
    },
    preparing: {
      h1: "Getting it ready",
      body: (name: string): string => `Locking ${name} on this phone.`,
    },
    sending: {
      h1: (name: string): string => `Sending ${name}`,
      body: "Keep this page open until it's sent.",
    },
    sent: {
      h1: "Sent",
      body: (name: string): string => `${name} has reached their storage. You can close this page.`,
    },
    tooBig: {
      h1: "This file is too big",
      body: (limit: string): string => `You can send up to ${limit}.`,
    },
    empty: { h1: "That file is empty", body: "There's nothing in it to send." },
    unreadable: {
      h1: "That file couldn't be prepared",
      body: "Your phone couldn't read it all. Try again, or choose another file.",
    },
    noRoom: {
      h1: "Their storage can't take this file",
      body: "It may be full. Ask them to make some space, or send a smaller file.",
    },
    stopped: { h1: "Sending stopped", body: "Check your internet connection, then try again." },
    stoppedClock: {
      h1: "Sending stopped",
      body: "Check your internet connection and that this phone's date and time are right, then try again.",
    },
    ended: { h1: "This request has ended", body: "Ask them to send you a new request." },
    cancelled: { h1: "You stopped this", body: "Nothing was sent. Ask them to send you a new request if you still want to send the file." },
    invalid: {
      h1: "This request can't be used",
      body: "The details from them weren't in the form this page expects. Ask them to send you a new request.",
    },
  },
} as const;
