/**
 * Discover static HPKE pins from the deployed SPA (e2ee chunk), so reveal-leg
 * responses can be opened without baking keys at build time.
 */
import type { E2eePins } from './types.ts';
import { SdkError } from './types.ts';
import pinsJson from './pins.freesocks.json' with { type: 'json' };

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Known production pins for freesocks.org (captured from live SPA e2ee chunk). */
export const FREESOCKS_ORG_PINS: E2eePins = pinsJson as E2eePins;

export async function discoverPins(baseUrl: string, signal?: AbortSignal): Promise<E2eePins> {
  const origin = baseUrl.replace(/\/$/, '');
  if (/freesocks\.org$/i.test(new URL(origin).hostname)) {
    try {
      return await scrapePins(origin, signal);
    } catch {
      return { ...FREESOCKS_ORG_PINS };
    }
  }
  return scrapePins(origin, signal);
}

async function scrapePins(origin: string, signal?: AbortSignal): Promise<E2eePins> {
  const htmlRes = await fetch(`${origin}/`, {
    headers: { 'user-agent': UA },
    signal,
  });
  if (!htmlRes.ok) {
    throw new SdkError(`Failed to fetch SPA index (${htmlRes.status})`, 'pins.index_failed', htmlRes.status);
  }
  const html = await htmlRes.text();
  const assets = [...html.matchAll(/\/assets\/(e2ee-[^"'\\\s]+\.js)/g)].map((m) => m[1]!);
  const candidates =
    assets.length > 0
      ? assets
      : [...html.matchAll(/\/assets\/([^"'\\\s]+\.js)/g)].map((m) => m[1]!);

  for (const name of candidates) {
    const url = `${origin}/assets/${name}`;
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal });
    if (!res.ok) continue;
    const js = await res.text();
    const pins = extractPinsFromBundle(js);
    if (pins) return pins;
  }
  throw new SdkError('Could not discover HPKE pins from SPA assets', 'pins.not_found');
}

/** Extract baked pin string literals from a minified e2ee chunk. */
export function extractPinsFromBundle(js: string): E2eePins | null {
  if (!js.includes('sealingEnabled') && !js.includes('e2eePins') && !js.includes('prepareOutbound')) {
    return null;
  }
  const kidMatch = js.match(/`([0-9a-f]{16})`/);
  if (!kidMatch) return null;
  const long = [...js.matchAll(/`([A-Za-z0-9_-]{800,})`/g)].map((m) => m[1]!);
  const hpkePk = long.find((s) => s.length >= 1500 && s.length <= 1800);
  const manifestPkPq = long.find((s) => s.length > 2000);
  const manifestPk = [...js.matchAll(/`([A-Za-z0-9_-]{40,50})`/g)]
    .map((m) => m[1]!)
    .find((s) => s.length === 43);
  return {
    hpkeKid: kidMatch[1]!,
    hpkePk,
    manifestPk,
    manifestPkPq,
  };
}
