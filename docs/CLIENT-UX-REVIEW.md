# Client usability review, 8 October 2026

## Findings and fixes

- Enlarged text escaped task links and panel headings. Workspace children can
  now shrink and wrap, action grids adapt to available space, and panel numbers
  keep their shape.
- Expanded node-service controls exposed two 20px consent checkboxes with
  insufficient adjacent spacing (WCAG 2.2 target-size failures). Consent controls
  are now 24px at the default font size, with consistent spacing.
- Consecutive fields were crowded and dark input boundaries were hard to see.
  Fields now have clearer separation, stronger outlines and explicit placeholder
  contrast. Body copy has a consistent line height.
- Recovery labels referred only to events even though the same local verifier
  accepts pool receipts. The summary, file label and instructions now explain
  both, including that local recovery needs no publishing layout or relay setup.
- The visible client now has a level-one heading followed by level-two task
  headings. The overview heading stays hidden while using the client.

## Evidence and limits

The production-browser journey checks all expanded client disclosures with axe
WCAG A/AA rules. The shared component-bound checker covers 18 viewport widths
from 320 to 1920px with normal type, 200% root text, WCAG text spacing and their
combination. Existing keyboard navigation, visible focus, forced colours,
encrypted upload, recovery-key saving, signed-record downloads and byte-verified
recovery remain in the release checks. Pool acceptance continues to load saved
receipts and recover without a publishing setup.

The live Chrome accessibility tree was inspected through the browser UI. Using
Return on the Recover task link moved focus to the recovery heading and opened
the saved-record controls. Screenshots of the production build were reviewed at
320, 390, 768 and 1440px. Tests use disposable browser profiles and synthetic
fixtures; no additional live payment or owner-file upload is part of this review.

Accessibility-tree inspection is not a spoken screen-reader test. VoiceOver
speech/rotor behaviour, physical mobile interaction and independently confirmed
browser-chrome zoom remain manual acceptance tasks. The text-resize stress test
must not be presented as those tests having passed. Bark/Heartwood soak testing
remains a separate task.

## Native Safari follow-up

On 8 October the live release from source `045e35a` was opened in Safari on
this Mac. Safari's own Page Menu confirmed **200%** page zoom. Screenshots of
the client introduction and recovery heading, instructions and first two
fields showed readable wrapping without visible clipping. Opening the recovery
URL expanded the saved-record controls in the accessibility tree. Safari's
Page Menu subsequently confirmed restoration to **100%**, and the temporary
review tab was closed.

This is a limited visual spot check. An initial blank render cleared after a
reload. Intermittent native-control failures prevented completion of the
keyboard/form interaction review. Neither 400% zoom nor spoken VoiceOver was
verified. Chrome's attempted zoom shortcut did not change the observed viewport
or device-pixel ratio and does not count as a real zoom result.
