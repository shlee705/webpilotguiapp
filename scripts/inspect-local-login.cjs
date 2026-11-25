'use strict';
const { chromium } = require('playwright-core');

async function main() {
  const target = new URL('http://127.0.0.1:5173/');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => {
      const request = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
        || request.isNavigationRequest() && new URL(request.url()).origin !== target.origin) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(target.href, { waitUntil: 'networkidle', timeout: 15000 });
    const inspect = () => page.evaluate(() => {
      const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      const describe = element => ({ tag: element.tagName, role: element.getAttribute('role'), typeAttribute: element.getAttribute('type'), type: element.type,
        label: (element.getAttribute('aria-label') || element.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
        href: element instanceof HTMLAnchorElement ? element.href : undefined, formOwner: Boolean(element.form), insideForm: Boolean(element.closest('form')) });
      return { title: document.title, url: location.href,
        controls: [...document.querySelectorAll('a[href],button,[role="button"],input[type="button"]')].filter(visible).slice(0, 90).map(describe),
        forms: [...document.querySelectorAll('form')].filter(visible).map(form => ({ method: form.method, action: form.action,
          fields: [...form.elements].filter(visible).map(element => ({ tag: element.tagName, type: element.type, name: element.name,
            placeholder: element.getAttribute('placeholder'), autocomplete: element.getAttribute('autocomplete'), label: element.tagName === 'BUTTON' ? element.textContent.trim() : undefined })) })) };
    });
    console.log(JSON.stringify({ stage: 'home', ...await inspect() }));
    if (process.argv.includes('--open-login')) {
      const entry = page.getByRole('button', { name: '로그인', exact: true }).or(page.getByRole('link', { name: '로그인', exact: true }));
      if (await entry.count() !== 1) throw new Error('Expected one visible login entry.');
      await entry.click();
      await page.getByText('로그인', { exact: true }).first().waitFor();
      console.log(JSON.stringify({ stage: 'login', ...await inspect() }));
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
