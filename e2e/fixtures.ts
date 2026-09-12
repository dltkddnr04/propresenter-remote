import { chromium, test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ browser, launchOptions }, use) => {
    const userDataDir = process.env.PP_E2E_USER_DATA_DIR;
    if (!userDataDir) {
      await use(await browser.newContext());
      return;
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      channel: process.env.PP_E2E_CHROME_PATH ? undefined : 'chrome',
      executablePath: process.env.PP_E2E_CHROME_PATH,
      headless: process.env.PP_E2E_HEADLESS === '1',
    });
    await use(context);
    await context.close();
  },
});
