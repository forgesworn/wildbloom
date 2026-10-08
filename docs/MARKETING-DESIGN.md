# Marketing design review — 8 October 2026

## Problem and intended journey

The previous overview was approximately 12,126 CSS pixels tall at a 1440px
viewport. Protocol diagrams and comparisons appeared before the core recovery
story, repeated copy made the benefits hard to scan, and the navigation offered
seven competing destinations. Download information mixed product introductions,
release notes and acceptance evidence.

The revised journey is: understand the benefit → try a recovery example → see
how storage and recovery work → choose browser, desktop node or Archipelago.
The hero explicitly identifies a public preview and the need for a storage node
and signer. Recovery also has a direct route for existing users.

## Design decisions

- Warm paper background, forest-green hero and a local SVG botanical/storage
  illustration. System fonts and local assets only; no font service, tracking,
  analytics, remote imagery or animation dependency.
- Three marketing navigation links plus the client action. All destinations
  remain present on small screens. The client keeps its dark workspace.
- Benefits before protocols. Shorter sections, open editorial layouts, a
  practical layout comparison and clear installation choices.
- A local 2-of-4 example uses real buttons with pressed states, keyboard support
  and a polite status announcement. It demonstrates the recovery boundary, not
  actual storage or erasure coding. It accesses no node, signer or persistence.
- Native disclosure controls hold detailed answers about privacy, recovery,
  owner repair and preview readiness. Limits are also visible beside relevant
  choices: preview status, receipt/key requirements, independent failure risks,
  source-file limit and differing installer versions.
- Retired the older marketing styles and diagrams; keep the marketing palette
  and responsive rules in `src/marketing.css`, separate from workspace styles.

## Verification

The production browser acceptance script now checks the marketing journey in
addition to its existing encrypted upload/recovery checks:

- Keyboard transition across the recovery threshold, complete example node loss
  and recovery back to the initial two available parts.
- No remote requests, sockets or NIP-07 calls during marketing interaction.
- Valid local destinations; client controls remain hidden on the overview.
- WCAG A/AA scans of the overview, failed recovery state and expanded FAQ.
- Reflow and accessibility at 320, 390 and 768 CSS pixels.
- Visible online state in forced colours; reduced-motion preference supported.

Desktop and mobile screenshots were inspected from the actual production build,
including the hero, storage example, installation choices and client entry.
These are automated and visual maintainer checks, not independent accessibility
certification or a substitute for human assistive-technology testing.
