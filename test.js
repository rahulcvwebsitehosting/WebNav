const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const extensionPath = path.resolve(__dirname, '.');
  console.log('Loading extension from:', extensionPath);

  const browser = await puppeteer.launch({
    headless: false, // Must be false to load extensions
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  // Wait for background page to find the extension ID
  let extId;
  const targets = await browser.targets();
  for (const target of targets) {
    if (target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')) {
      const url = new URL(target.url());
      extId = url.hostname;
      break;
    }
  }

  if (!extId) {
    // sometimes it takes a bit for the target to show up
    await new Promise(r => setTimeout(r, 2000));
    const targets2 = await browser.targets();
    for (const target of targets2) {
      if (target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')) {
        extId = new URL(target.url()).hostname;
        break;
      }
    }
  }

  if (!extId) {
    console.error('Could not find extension ID');
    await browser.close();
    return;
  }

  console.log('Extension ID:', extId);

  const page = await browser.newPage();
  const optionsUrl = `chrome-extension://${extId}/options/options.html`;
  console.log('Navigating to:', optionsUrl);
  await page.goto(optionsUrl);

  // Click add profile
  console.log('Clicking Add Profile...');
  await page.waitForSelector('#add-profile');
  await page.click('#add-profile');

  // Fill in the details
  console.log('Filling form...');
  await page.waitForSelector('#pf-base');
  
  // Clean the input before typing
  await page.evaluate(() => { document.getElementById('pf-base').value = ''; });
  await page.type('#pf-base', 'https://api.ollama.com/v1'); // We found this is the official cloud API
  
  await page.evaluate(() => { document.getElementById('pf-key').value = ''; });
  await page.type('#pf-key', 'd45e2a3b026143568857cb44329e0e53.hBFAoTYpQdwFU73XpG7DahJF');
  
  // Click fetch models
  console.log('Clicking Fetch Models...');
  await page.click('#pf-fetch-models');

  // Wait for status update
  await new Promise(r => setTimeout(r, 3000));
  
  const status = await page.evaluate(() => document.getElementById('pf-model-status').textContent);
  console.log('Status after fetch:', status);

  // Take a screenshot
  await page.screenshot({ path: 'screenshot.png' });
  console.log('Saved screenshot.png');

  await browser.close();
})();
