# Accessibility evidence

Wildbloom's production browser journey runs axe-core WCAG A/AA rules against
the initial page, prepared encrypted publication, verified recovery result,
Tor-only profile and plaintext opt-out state. The same journey runs in system
Chrome on Windows, Linux and macOS, Playwright Firefox on Linux and Playwright
WebKit on macOS.

The browser gate also proves that keyboard traversal reaches the signer action
in document order, focus has a visible three-pixel indicator, the recovery key
can be revealed and hidden with Enter, and active upload and download requests
can be cancelled from the keyboard. Checkbox and radio controls have a minimum
24 by 24 CSS-pixel target; their surrounding labels remain clickable.

These checks catch semantic, contrast, target-size, focus and keyboard
regressions. They are not a screen reader or human usability review.

Before public deployment, complete and record:

- VoiceOver with Safari on macOS;
- NVDA with current Firefox or Chrome on Windows;
- 200% and 400% zoom and reflow;
- Windows forced-colours and macOS increased-contrast modes;
- error, cancellation, recovery-key and public-publication announcements as
  actually spoken;
- a keyboard-only review by someone who did not build the interface.
