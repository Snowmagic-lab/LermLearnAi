/* Keep runtime-generated UI copy aligned with the LermLearn identity. */
(() => {
  const rename = (value) => typeof value === 'string' ? value.replace(/StudyFlow/g, 'LermLearn') : value;
  const updateNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const next = rename(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest('script,style')) return;
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      if (node.hasAttribute(attribute)) node.setAttribute(attribute, rename(node.getAttribute(attribute)));
    }
    for (const child of node.childNodes) updateNode(child);
  };
  const sync = () => updateNode(document.body);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
  new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(updateNode))).observe(document.documentElement, { childList: true, subtree: true });
})();
