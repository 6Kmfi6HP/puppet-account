/**
 * Cap token via real Chromium — required for production FreeSocks because Cap
 * instrumentation rejects pure-protocol PoW (see research report §6).
 *
 * Opens /get-account, clicks the Cap widget, intercepts /cap/.../redeem.
 * Headed mode by default: headless is detected as automated_browser.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { SdkError } from '../types.ts';

export interface BrowserCapOptions {
  baseUrl: string;
  /** Default true. Cap instrumentation blocks typical headless fingerprints. */
  headed?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function mintCapTokenBrowser(opts: BrowserCapOptions): Promise<string> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const headed = opts.headed !== false;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let browser: Browser | null = null;
  try {
    browser = await chromium
      .launch({
        headless: !headed,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
      })
      .catch(() =>
        chromium.launch({
          headless: !headed,
          args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check'],
        }),
      );
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
    });

    const page = await context.newPage();
    const tokenPromise = waitForRedeemToken(page, timeoutMs, opts.signal);

    await page.goto(`${base}/get-account`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('cap-widget', { timeout: Math.min(30_000, timeoutMs) }).catch(() => undefined);
    await sleep(800);
    await tryClickCap(page);
    await sleep(1500);
    await tryClickCap(page);

    const token = await tokenPromise;
    return token;
  } catch (e) {
    if (e instanceof SdkError) throw e;
    throw new SdkError(
      `Cap browser solve failed: ${e instanceof Error ? e.message : String(e)}`,
      'cap.browser_failed',
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryClickCap(page: Page): Promise<boolean> {
  const selectors = [
    'cap-widget',
    'button:has-text("verify")',
    'button:has-text("human")',
    '[data-cap-api-endpoint]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: 5_000 });
        return true;
      } catch {
        /* try next */
      }
    }
  }
  // Shadow / internal button inside cap-widget
  try {
    await page.locator('cap-widget').first().click({ timeout: 5_000, force: true });
    return true;
  } catch {
    return false;
  }
}

function waitForRedeemToken(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new SdkError('Timed out waiting for Cap redeem token', 'cap.timeout'));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new SdkError('Aborted', 'aborted'));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    page.on('response', async (res) => {
      try {
        if (!/\/cap\/[^/]+\/redeem\/?$/.test(new URL(res.url()).pathname)) return;
        const status = res.status();
        if (status < 200 || status >= 300) {
          const body = await res.text().catch(() => '');
          if (!settled && /instr|Blocked|automated/i.test(body)) {
            settled = true;
            clearTimeout(timer);
            reject(
              new SdkError(
                `Cap instrumentation blocked redeem (${status}): ${body.slice(0, 200)}`,
                'cap.instr_blocked',
                status,
              ),
            );
          }
          return;
        }
        const j = (await res.json()) as { success?: boolean; token?: string };
        if (j.success && j.token && !settled) {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(j.token);
        }
      } catch {
        /* ignore parse races */
      }
    });
  });
}
