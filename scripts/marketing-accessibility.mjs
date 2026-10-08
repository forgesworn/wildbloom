// Component bounds catch clipped/overlapping card text that a page-level
// scrollWidth assertion and axe cannot detect. Run against the production CSS.
export async function assertMarketingReflow(page) {
  const initialViewport = page.viewportSize();
  const originalStyles = await page.evaluate(() => {
    const elements = [document.documentElement, ...document.querySelectorAll('body *:not(svg):not(svg *)')];
    return elements.map((element) => element.getAttribute('style'));
  });
  try {
    for (const width of [320, 375, 390, 420, 421, 520, 760, 768, 820, 959, 960, 961, 1000, 1001, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['normal', 'spacing', 'large', 'large-spacing']) {
        await page.evaluate(({ mode, originalStyles }) => {
          const elements = [document.documentElement, ...document.querySelectorAll('body *:not(svg):not(svg *)')];
          elements.forEach((element, index) => {
            const original = originalStyles[index];
            if (original === null) element.removeAttribute('style');
            else element.setAttribute('style', original);
          });
          if (mode.includes('large')) document.documentElement.style.fontSize = '200%';
          if (mode.includes('spacing')) {
            for (const element of elements.slice(1)) {
              element.style.setProperty('line-height', '1.5', 'important');
              element.style.setProperty('letter-spacing', '0.12em', 'important');
              element.style.setProperty('word-spacing', '0.16em', 'important');
              if (element.tagName === 'P') element.style.setProperty('margin-bottom', '2em', 'important');
            }
          }
        }, { mode, originalStyles });
        const problems = await page.evaluate(() => {
          const issues = [];
          if (document.documentElement.scrollWidth > innerWidth) issues.push('page scrolls horizontally');
          const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const element = node.parentElement;
            if (!node.textContent.trim() || !element.checkVisibility() || element.closest('svg')) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const bounds of range.getClientRects()) {
              for (let ancestor = element; ancestor && ancestor.tagName !== 'BODY'; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                const box = ancestor.getBoundingClientRect();
                // Two CSS pixels allow fractional glyph rounding, not clipped words.
                if (style.display !== 'inline' && (bounds.right > box.right + 2 || bounds.left < box.left - 2)) {
                  issues.push(`${node.textContent.trim().slice(0, 45)} escapes ${ancestor.id || ancestor.className || ancestor.tagName}`);
                  break;
                }
                if (['hidden', 'clip'].includes(style.overflowY) && (bounds.bottom > box.bottom + 2 || bounds.top < box.top - 2)) {
                  issues.push(`clipped text: ${node.textContent.trim().slice(0, 45)}`);
                  break;
                }
              }
            }
          }
          return [...new Set(issues)];
        });
        if (problems.length) throw new Error(`Marketing ${width}px ${mode}: ${problems.slice(0, 8).join('; ')}`);
      }
    }
  } finally {
    await page.evaluate((originalStyles) => {
      [document.documentElement, ...document.querySelectorAll('body *:not(svg):not(svg *)')].forEach((element, index) => {
        if (originalStyles[index] === null) element.removeAttribute('style');
        else element.setAttribute('style', originalStyles[index]);
      });
    }, originalStyles);
    if (initialViewport) await page.setViewportSize(initialViewport);
  }
}

export async function assertMarketingInteractionColours(page, assertAccessible) {
  // A broad body hover selector previously beat the light-on-dark hero rule.
  // Exercise every visual family, including the outlined package CTA.
  for (const selector of ['.nav-client', '.hero-secondary', '.landing-hero .button-link', '.start-browser .button-link', '.button-link.secondary', '.download-link', '[data-demo-node][aria-pressed="false"]', '[data-demo-node][aria-pressed="true"]', '.faq-list summary']) {
    const target = page.locator(selector).first();
    await target.hover();
    await page.waitForTimeout(180); // complete the authored 150ms colour transition
    await assertAccessible(page, `Marketing hover ${selector}`);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await target.focus();
    const visibleFocus = await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
    });
    if (!visibleFocus) throw new Error(`Missing visible keyboard focus: ${selector}`);
    const nonTextContrast = await target.evaluate((element) => {
      function luminance(colour) {
        const channels = colour.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      function background(node) {
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          const value = getComputedStyle(ancestor).backgroundColor;
          if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return value;
        }
        throw new Error('No opaque marketing background');
      }
      function ratio(a, b) {
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      }
      const style = getComputedStyle(element);
      return {
        focus: ratio(style.outlineColor, background(element.parentElement)),
        boundary: element.matches('[data-demo-node]') ? ratio(style.borderTopColor, background(element)) : null,
      };
    });
    if (nonTextContrast.focus < 3 || (nonTextContrast.boundary !== null && nonTextContrast.boundary < 3)) {
      throw new Error(`Marketing non-text contrast below 3:1 for ${selector}: ${JSON.stringify(nonTextContrast)}`);
    }
  }
}
