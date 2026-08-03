/**
 * Smoke: Cap challenge → WASM PoW (does NOT redeem successfully on production
 * FreeSocks — instrumentation is required). Useful to verify @cap.js/wasm loads.
 */
import { prng } from './pow.ts';
import * as capWasm from '@cap.js/wasm/node/cap_wasm.js';

const base = (process.env.FS_BASE ?? 'https://freesocks.org').replace(/\/$/, '');
const siteKey = process.env.FS_SITE_KEY ?? 'd84145bde2';

const chRaw = await fetch(`${base}/cap/${siteKey}/challenge`, {
  method: 'POST',
  headers: {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    origin: base,
    referer: `${base}/get-account`,
  },
});
const ch = (await chRaw.json()) as {
  token?: string;
  challenge?: { c: number; s: number; d: number };
  error?: string;
};
if (!ch.challenge || !ch.token) {
  console.error('unexpected challenge', chRaw.status, ch);
  process.exit(1);
}
const { c, s, d } = ch.challenge;
const challenges = Array.from({ length: c }, (_v, k) => {
  const i = k + 1;
  return [prng(`${ch.token}${i}`, s), prng(`${ch.token}${i}d`, d)] as const;
});
const t0 = Date.now();
const solutions = challenges.map(([salt, target]) => Number(capWasm.solve_pow(salt, target)));
console.log(
  JSON.stringify({
    ok: true,
    challenges: challenges.length,
    ms: Date.now() - t0,
    sample: solutions.slice(0, 3),
    note: 'Production redeem still needs browser instrumentation (instr).',
  }),
);
