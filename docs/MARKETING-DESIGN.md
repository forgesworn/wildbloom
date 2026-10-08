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


## Reflow and contrast correction — 8 October 2026

The first review was insufficient: page-level overflow and default-state axe
checks missed component overflow and a hover-specific contrast failure. This
follow-up tests the rendered production build, including open FAQ content.

| Finding | WCAG 2.2 reference | Correction |
| --- | --- | --- |
| Hero recovery link became dark green on its dark background when hovered: 1.07:1 | 1.4.3 Contrast (Minimum) | Reduce the generic hover selector's specificity; the hero hover is now white, 12.02:1 |
| Enlarged text escaped cards and grid tracks at mobile and intermediate desktop widths | 1.4.4 Resize Text; 1.4.10 Reflow | Content-aware grid columns, shrinkable children, wrapping controls, bounded gutters; remove clipping masks |
| Offline node outline was too faint | 1.4.11 Non-text Contrast | Darken the dashed outline: 3.78:1 against the panel; online outline is 3.23:1 against its fill |
| Small supporting copy became unnecessarily tiny on mobile | Readability improvement | Use a 0.8rem floor instead of shrinking labels to 0.6–0.7rem; stack crowded tablet layouts earlier |
| Text-spacing and interactive colours were missing from the earlier checks | 1.4.12 Text Spacing; 2.4.7 Focus Visible | Add repeatable production-browser regression checks |

`marketing-accessibility.mjs`, called by the normal browser smoke test, checks
18 widths from 320 to 1920 CSS pixels, including both sides of the 420, 960 and
1000px breakpoints. Each width is checked with normal type, 200% root text size,
WCAG text-spacing overrides (1.5 line height, 2em paragraph spacing, 0.12em
letter spacing and 0.16em word spacing), and enlarged text plus spacing together.
Text ranges are checked against their enclosing components, not just the page.
320 CSS pixels also covers the reflow width equivalent to a 1280px desktop at
400% browser zoom; root text scaling is a separate text-resize stress test.

Hover scans cover each link/button style, downloads, both node states and FAQ
summaries. Keyboard focus must be visible and at least 3:1 against its surround;
node boundaries must also meet 3:1. Focus colours measure 5.08:1 or better on the
light panels and 8.57:1 on the hero. Existing keyboard recovery, expanded FAQ,
forced-colour and no-unrequested-network checks remain in place.

Local Chrome, Firefox and WebKit production journeys passed. Viewport screenshots
were reviewed at 320, 390, 768, 1024 and 1440px, including recovery, installation,
FAQ and closing actions. These are maintainer and automated checks, not a full
WCAG conformance certification. Real screen-reader and physical mobile-device
acceptance remain separate from desktop browser-engine testing.

References: [WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[Text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html),
[Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
