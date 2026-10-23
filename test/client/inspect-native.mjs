import { chromium } from '../../client/node_modules/@playwright/test/index.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
for (const page of browser.contexts()[0].pages()) {
  console.log(JSON.stringify({ url: page.url(), text: await page.locator('body').innerText({ timeout: 5000 }), bridge: await page.evaluate(() => !!window.__TAURI_INTERNALS__) }));
  for (const frame of page.frames().slice(1)) console.log(JSON.stringify({ frame: frame.url(), text: (await frame.locator('body').innerText({ timeout: 5000 }).catch(error => error.message)).slice(0,4000) }));
}
process.exit(0);
