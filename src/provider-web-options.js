'use strict';

const SELECTORS = Object.freeze({
  deepseek: [
    'button:has-text("DeepThink")', 'button:has-text("深度思考")',
    '[role="button"]:has-text("DeepThink")', '[role="button"]:has-text("深度思考")',
  ],
  doubao: [
    'button:has-text("深度思考")', 'button:has-text("Deep thinking")',
    '[role="button"]:has-text("深度思考")', '[role="button"]:has-text("Deep thinking")',
  ],
});

function selected(locator) {
  return locator.evaluate(element => {
    const value = element.getAttribute('aria-pressed') || element.getAttribute('aria-checked') ||
      element.getAttribute('data-state');
    if (['true', 'on', 'checked', 'active'].includes(String(value).toLowerCase())) return true;
    return /(^|\s)(active|selected|checked|on)(\s|$)/i.test(String(element.className || ''));
  });
}

async function applyProviderMode(page, model, mode) {
  const selectors = SELECTORS[model];
  if (!selectors) throw new Error(`Unsupported provider mode model: ${model}`);
  if (!['default', 'thinking'].includes(mode)) throw new Error(`Unsupported provider mode: ${mode}`);
  for (const selector of selectors) {
    const located = page.locator(selector);
    const control = typeof located.first === 'function' ? located.first() : located;
    if (!control || typeof control.isVisible !== 'function') continue;
    if (!await control.isVisible().catch(() => false)) continue;
    const isSelected = await selected(control).catch(() => false);
    const shouldSelect = mode === 'thinking';
    if (isSelected !== shouldSelect) await control.click({ timeout: 3000 });
    return true;
  }
  return false;
}

module.exports = { applyProviderMode };
