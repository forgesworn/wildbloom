# Accessibility evidence

Wildbloom's production browser journey runs axe-core WCAG A/AA rules against
the initial page, prepared encrypted publication, verified recovery result,
Tor-only profile and plaintext opt-out state. The same journey runs in system
Chrome on Windows, Linux and macOS, Playwright Firefox on Linux and Playwright
WebKit on macOS.

The browser gate also proves that keyboard traversal reaches the signer action
in document order, using Option-Tab for macOS WebKit's default Safari behaviour,
and that focus has a visible three-pixel indicator. The recovery key can be
revealed and hidden with Enter, and active upload and download requests can be
cancelled from the keyboard. Checkbox and radio controls have a minimum 24 by
24 CSS-pixel target; their surrounding labels remain clickable.

The same gate scans a 320 CSS-pixel layout and refuses horizontal document
overflow. System Chrome also runs the initial state with forced colours active,
requires the media query to match, retains the focus indicator and repeats the
WCAG scan. This checks responsive and forced-colour mechanics, not the human
quality of 400% zoom or a particular operating-system colour palette.

These checks catch semantic, contrast, target-size, focus and keyboard
regressions. They are not a screen reader or human usability review.

Before public deployment, complete and record:

- VoiceOver with Safari on macOS;
- NVDA with current Firefox or Chrome on Windows;
- 200% and 400% zoom in branded browsers;
- human review of Windows forced-colours and macOS increased-contrast modes;
- error, cancellation, recovery-key and public-publication announcements as
  actually spoken;
- a keyboard-only review by someone who did not build the interface.
