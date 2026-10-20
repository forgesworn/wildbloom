// Every user-visible string on the sender page lives here, so the plain-language
// audit has one file to read. It follows the recipient page's tone and rules
// (src/get/copy.ts): British English, sentence case, no exclamation marks, and
// none of the technical terms a person sending a file should never meet. The
// person at the computer is always "they" or "them". No time or speed is ever
// promised: the page does not know either. Curly quotes and the ellipsis are
// deliberate.

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
    stop: "Stop",
    tryAgain: RECIPIENT.buttons.tryAgain,
    yes: RECIPIENT.buttons.yes,
    no: RECIPIENT.buttons.no,
    chooseFile: "Choose a file",
    chooseAnother: "Choose another file",
  },
  hide: {
    label: "Don't show them my internet address",
    hint: "Their computer won't show it, and sending can be slower. The server that passes the file on is theirs, so they could still find it.",
    theirs: "They're hiding their own internet address from you too.",
  },
  timeLeft: RECIPIENT.timeLeft,
  theyNeed: "They need Wildbloom open while you do this.",
  reconnecting: "The connection dropped. Trying again…",
  announce: {
    connected: RECIPIENT.announce.connected,
    asking: (name: string): string => `Asking them to accept ${name}.`,
    sending: (name: string): string => `Sending ${name}.`,
    progress: (percent: number): string => `Sending ${percent}% complete.`,
    sent: "Sent.",
  },
  progressLabel: (done: string, total: string): string => `${done} of ${total}`,
  progressName: "Sending progress",
  screens: {
    unsupported: { h1: "This browser can't send the file", body: "Try an up-to-date version of Safari, Chrome, Edge or Firefox." },
    incomplete: { h1: "This link isn't complete", body: "Ask them to send it again, or make sure you copied all of it." },
    expired: { h1: "This link has expired", body: "Links work for 10 minutes. Ask them to start again." },
    words: { h1: "Send a file", body: "Type the 4 words they told you." },
    connecting: { h1: "Connecting", body: "Keep this page open." },
    waiting: { h1: "Waiting for them", body: "Ask them to keep Wildbloom open. Keep this page open." },
    wrongWords: {
      h1: "Those words didn't work",
      body: "The link has stopped working to keep things safe. Ask them to start again. They'll get a new link and new words.",
    },
    used: { h1: "This link has already been used", body: "Each link works for one person. Ask them to start again." },
    network: { h1: "Can't connect right now", body: "Check your internet connection, then try again." },
    check: { h1: "Check these words with them", body: "They'll read you 3 words. Do they match?" },
    mismatch: {
      h1: "Nothing was sent",
      body: "The words didn't match, so nothing was set up. Tell them and ask them to start again.",
    },
    confirming: { h1: "Waiting for them", body: "They need to confirm the words on their computer. Keep this page open." },
    choose: {
      h1: "Choose a file",
      body: (limit: string): string => `It's locked on this phone and sent to their computer, and it's not stored on any server. Up to ${limit}.`,
    },
    asking: {
      h1: "Waiting for them to accept",
      body: (name: string): string => `They need to say yes to ${name} on their computer. Keep this page open.`,
    },
    declined: { h1: "They said no", body: "Nothing was sent." },
    linking: { h1: "Connecting to them", body: "Keep this page open." },
    sending: {
      h1: (name: string): string => `Sending ${name}`,
      body: "Keep this page open until it's sent.",
    },
    sent: {
      h1: "Sent",
      body: (name: string): string => `${name} is on their computer. You can close this page.`,
    },
    tooBig: {
      h1: "This file is too big",
      body: (limit: string): string => `You can send up to ${limit}.`,
    },
    empty: { h1: "That file is empty", body: "There's nothing in it to send." },
    unreadable: {
      h1: "That file couldn't be read",
      body: "Your phone couldn't open it. Try again, or choose another file.",
    },
    cannotHide: {
      h1: "Can't hide your address",
      body: "Nothing was sent. Ask them to start again, and leave “Don't show them my internet address” off.",
    },
    noRoom: {
      h1: "Their computer can't keep this file",
      body: "It may be full. Nothing was kept. Ask them to make some space, then start again.",
    },
    connectFailed: {
      h1: "Couldn't connect to them",
      body: "Your phone and their computer couldn't find a way to connect. Nothing was sent. Ask them to start again with a new link.",
    },
    lost: {
      h1: "The connection was lost",
      body: "Nothing was kept on their computer. Ask them to start again with a new link.",
    },
    theyStopped: {
      h1: "They stopped this",
      body: "Nothing was kept. Ask them to start again if you still want to send it.",
    },
    failed: {
      h1: "Sending stopped",
      body: "Something went wrong and nothing was kept. Ask them to start again with a new link.",
    },
    cancelled: { h1: "You stopped this", body: "Nothing was kept. Ask them to start again if you still want to send the file." },
    invalid: {
      h1: "This link can't be used",
      body: "The details from them weren't in the form this page expects. Ask them to start again.",
    },
  },
} as const;
