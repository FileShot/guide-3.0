'use strict';

/**
 * Browser-side script for injecting data-ref attributes and building snapshot text.
 * Must stay in sync with browserManager._ensureRefs() output shape.
 */
function buildSnapshotInPage() {
  const selectors = [
    'input', 'button', 'a', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]',
    '[contenteditable]', 'summary', 'details',
    'iframe', 'form',
  ];
  const seen = new Set();
  const all = [];

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.offsetParent !== null) return true;
    if (el.type === 'hidden') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (style.position === 'fixed' || style.position === 'sticky') return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const tryCollect = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if (!isVisible(el)) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const role = el.getAttribute?.('role') || '';
    const href = el.href || el.getAttribute?.('href') || '';
    const isInteractiveTag = /^(a|button|input|select|textarea|iframe|form|summary|details)$/.test(tag);
    const isInteractiveRole = /^(button|link|textbox|combobox|checkbox|radio|tab|menuitem|option)$/.test(role);
    if (isInteractiveTag || isInteractiveRole || el.isContentEditable) all.push(el);
  };

  const walkTree = (root) => {
    if (!root) return;
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.matches?.(selectors.join(','))) tryCollect(child);
      if (child.shadowRoot) walkTree(child.shadowRoot);
      walkTree(child);
    }
  };

  walkTree(document.documentElement);

  const collectPageText = (root, parts) => {
    if (!root) return;
    if (root.nodeType === 1 && root !== document.documentElement) {
      const tag = root.tagName?.toLowerCase?.() || '';
      if (!/^(script|style|noscript)$/i.test(tag)) {
        const t = (root.innerText || '').trim();
        if (t && t.length < 8000) parts.push(t);
      }
    }
    const kids = root.children || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.shadowRoot) collectPageText(c.shadowRoot, parts);
      collectPageText(c, parts);
    }
  };

  const pageTextParts = [];
  collectPageText(document.body || document.documentElement, pageTextParts);
  const lines = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    el.setAttribute('data-ref', String(i));
    const tag = el.tagName.toLowerCase();
    const type = el.type || '';
    const name = el.name || el.id || '';
    const placeholder = el.placeholder || '';
    const value = el.value || '';
    const role = el.getAttribute('role') || '';
    const textLimit = (tag === 'a' || role === 'link') ? 200 : 120;
    const text = (el.textContent || '').trim().substring(0, textLimit);
    const hrefVal = el.href || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const titleAttr = el.getAttribute('title') || '';
    const imgAlt = (!text && el.querySelector)
      ? (el.querySelector('img')?.getAttribute('alt') || '') : '';
    const isSubmit = (type === 'submit' && tag === 'input') || (tag === 'button' && el.form !== null && type !== 'button' && type !== 'reset');
    let desc = `[ref=${i}] <${tag}`;
    if (type) desc += ` type="${type}"`;
    if (name) desc += ` name="${name}"`;
    if (role) desc += ` role="${role}"`;
    if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
    if (titleAttr) desc += ` title="${titleAttr.substring(0, 80)}"`;
    if (placeholder) desc += ` placeholder="${placeholder}"`;
    if (value && type !== 'password') desc += ` value="${value.substring(0, 50)}"`;
    if (hrefVal) desc += ` href="${hrefVal.substring(0, 150)}"`;
    desc += '>';
    if (text && type !== 'password' && tag !== 'input') {
      let cleanText = text;
      if (tag === 'a' || role === 'link') {
        cleanText = cleanText.replace(/,?\s+\d{4}\.\w+-\w+\.\d+\.\d+$/g, '');
        cleanText = cleanText.replace(/,?\s+Ends\s+\w+\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*[AP]M$/i, '');
      }
      desc += ` ${cleanText}`;
    } else if (imgAlt) desc += ` [img: ${imgAlt.substring(0, 120)}]`;
    if (isSubmit) desc += ' [SUBMIT]';
    if (tag === 'select') desc += ' [SELECT]';
    lines.push(desc);
  }

  const pageText = (pageTextParts.length
    ? [...new Set(pageTextParts)].join('\n')
    : (document.body?.innerText || '')).substring(0, 50000);

  const iframeTexts = [];
  try {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc && iframeDoc.body) {
          const src = iframe.src || iframe.getAttribute('src') || '';
          const iframeText = (iframeDoc.body.innerText || '').trim();
          if (iframeText.length > 0) {
            const iframeInteractive = iframeDoc.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]');
            const iframeElCount = iframeInteractive.length;
            const scrollH = iframeDoc.body.scrollHeight || 0;
            const clientH = iframeDoc.body.clientHeight || 0;
            const scrollable = scrollH > clientH;
            const scrollPct = clientH > 0 ? Math.round((clientH / scrollH) * 100) : 100;
            const scrollNote = scrollable ? `, scrollable: ${scrollPct}% visible — use browser_scroll to see more` : '';
            iframeTexts.push(`--- iframe content (${iframeElCount} interactive elements, src="${src.substring(0, 120)}"${scrollNote}) ---\n${iframeText.substring(0, 20000)}`);
          }
        }
      } catch {
        const src = iframe.src || iframe.getAttribute('src') || '';
        if (src) iframeTexts.push(`--- iframe (cross-origin, cannot access content, src="${src.substring(0, 120)}") ---`);
      }
    }
  } catch {}

  const fullPageText = iframeTexts.length > 0
    ? pageText + '\n\n' + iframeTexts.join('\n\n')
    : pageText;

  return {
    elementList: lines.join('\n'),
    pageText: fullPageText,
    elementCount: all.length,
    refCount: all.length,
  };
}

module.exports = { buildSnapshotInPage };
