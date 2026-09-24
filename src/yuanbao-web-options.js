'use strict';

const { ENGINES } = require('./yuanbao-preferences');

/**
 * Apply the engine selected in the tray to Yuanbao's current chat page.
 * Yuanbao keeps Expert as the outer mode and nests the concrete model under
 * "Models". We deliberately do not select Skills or Deep Research here.
 */
async function applyYuanbaoEngine(page, engine) {
  const option = ENGINES[engine];
  if (!option) throw new Error(`Unsupported Yuanbao engine: ${engine}`);

  const switcher = page.locator([
    'button[aria-label="Switch model"]',
    'button[aria-label="切换模型"]',
  ].join(', ')).first();
  if (!await switcher.isVisible()) return false;

  await switcher.click({ timeout: 3000 });
  const selectModel = page.locator([
    '[role="menuitem"][aria-label="Select model"]',
    '[role="menuitem"][aria-label="选择模型"]',
  ].join(', ')).last();
  if (!await selectModel.isVisible()) {
    await page.keyboard.press('Escape');
    return false;
  }

  await selectModel.click({ timeout: 3000 });
  const target = page.locator('[role="menuitemradio"]:visible')
    .filter({ hasText: option.label })
    .last();
  if (!await target.isVisible()) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return false;
  }

  const selected = await target.getAttribute('aria-checked') === 'true';
  if (!selected) await target.click({ timeout: 3000 });
  else {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  return true;
}

module.exports = { applyYuanbaoEngine };
