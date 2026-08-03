/**
 * Cap PoW solver (challenge → WASM solve → redeem).
 *
 * Production FreeSocks Cap REQUIRES a valid instrumentation (`instr`) response
 * minted inside a real browser iframe. Pure PoW redeem is rejected with
 * `missing_instrumentation_response`. This module is kept for:
 *   - self-hosted Cap without instrumentation
 *   - integration tests mirroring repo/convex/lib/captcha.integration.test.ts
 */
import * as capWasm from '@cap.js/wasm/node/cap_wasm.js';
import { SdkError } from '../types.ts';

/** Deterministic seeded RNG — verbatim from @cap.js/widget. */
export function prng(seed: string, length: number): string {
  function fnv1a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
  let state = fnv1a(seed);
  let result = '';
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  while (result.length < length) result += next().toString(16).padStart(8, '0');
  return result.substring(0, length);
}

type Challenge = [salt: string, target: string];

interface ChallengeResp {
  token: string;
  format?: number;
  challenges?: Challenge[];
  challenge?: { c: number; s: number; d: number };
  instrumentation?: string;
}

export interface CapPowOptions {
  /** Absolute Cap base, e.g. https://freesocks.org/cap/d84145bde2 */
  endpoint: string;
  /** Optional instrumentation blob to attach as `instr` (almost always needed in prod). */
  instr?: unknown;
  signal?: AbortSignal;
}

/** Run Cap challenge→solve→redeem. Fails on production FreeSocks without valid `instr`. */
export async function mintCapTokenPow(opts: CapPowOptions): Promise<string> {
  const base = opts.endpoint.replace(/\/$/, '') + '/';
  const chRaw = await fetch(`${base}challenge`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'user-agent': DEFAULT_UA },
  });
  if (!chRaw.ok) throw new SdkError(`Cap challenge HTTP ${chRaw.status}`, 'cap.challenge_failed', chRaw.status);
  const ch = (await chRaw.json()) as ChallengeResp;

  let challenges: Challenge[];
  if (ch.format === 2 && Array.isArray(ch.challenges)) {
    challenges = ch.challenges;
  } else if (ch.challenge) {
    const { c, s, d } = ch.challenge;
    challenges = Array.from({ length: c }, (_v, k) => {
      const i = k + 1;
      return [prng(`${ch.token}${i}`, s), prng(`${ch.token}${i}d`, d)] as Challenge;
    });
  } else {
    throw new SdkError(`Unrecognized Cap challenge shape`, 'cap.challenge_shape', undefined, ch);
  }

  const solutions = challenges.map(([salt, target]) => Number(capWasm.solve_pow(salt, target)));
  const body: Record<string, unknown> = { token: ch.token, solutions };
  if (opts.instr !== undefined) body.instr = opts.instr;

  const rRaw = await fetch(`${base}redeem`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', 'user-agent': DEFAULT_UA },
    body: JSON.stringify(body),
  });
  const r = (await rRaw.json()) as { success?: boolean; token?: string; error?: string; reason?: string };
  if (!r.success || !r.token) {
    throw new SdkError(
      `Cap redeem failed: ${r.error ?? r.reason ?? JSON.stringify(r)}`,
      'cap.redeem_failed',
      rRaw.status,
      r,
    );
  }
  return r.token;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
