/**
 * FreeSocks HTTP client: cookie jar + reveal-leg E2EE + PoP signing.
 *
 * Registration uses route policy REVEAL (plaintext request + sealed response).
 * Authenticated follow-ups (connection-mode, regenerate) send fs_session cookie
 * and PoP headers when a session key was enrolled at create time.
 */
import {
  RESP_EPH_FIELD,
  isSealedWire,
  normalizePath,
  bytesToB64Url,
  routePolicy,
} from './crypto/envelope.ts';
import { clientOpenResponse } from './crypto/channel.ts';
import { generateEphemeralKeyPair, serializePublicKey } from './crypto/hpke.ts';
import { PopSession } from './pop.ts';
import type { E2eePins, PublicConfig } from './types.ts';
import { SdkError } from './types.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MEMBER_COOKIE = 'fs_session';

export class FreeSocksClient {
  readonly baseUrl: string;
  readonly host: string;
  readonly pins: E2eePins;
  readonly pop: PopSession;
  private cookies = new Map<string, string>();

  constructor(opts: { baseUrl: string; pins: E2eePins; pop: PopSession }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.host = new URL(this.baseUrl).host;
    this.pins = opts.pins;
    this.pop = opts.pop;
  }

  static async create(opts: { baseUrl: string; pins: E2eePins }): Promise<FreeSocksClient> {
    const client = new FreeSocksClient({ ...opts, pop: await PopSession.create() });
    await client.pop.syncTime(client.baseUrl);
    return client;
  }

  get sessionCookie(): string | undefined {
    return this.cookies.get(MEMBER_COOKIE);
  }

  async getConfig(signal?: AbortSignal): Promise<PublicConfig> {
    return this.requestJson<PublicConfig>('GET', '/api/v1/config', undefined, {
      signal,
      auth: false,
      reveal: false,
    });
  }

  async createAccount(
    body: {
      captchaToken: string;
      backend?: string;
      referralCode?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    accountId: string;
    tier: {
      slug: string;
      name: string;
      monthlyTrafficGb: number;
      deviceLimit: number;
      backend: string;
    };
    authenticated: true;
    referralApplied?: boolean;
    popSessionToken?: string;
  }> {
    const payload = {
      ...body,
      ...this.pop.enrollmentFields(),
    };
    const res = await this.requestJson<{
      accountId: string;
      tier: {
        slug: string;
        name: string;
        monthlyTrafficGb: number;
        deviceLimit: number;
        backend: string;
      };
      authenticated: true;
      referralApplied?: boolean;
      popSessionToken?: string;
    }>('POST', '/api/v1/account', payload, { signal, auth: false, reveal: true });
    this.pop.setSessionToken(res.popSessionToken);
    return res;
  }

  async setConnectionMode(
    modeId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; modeId: string }> {
    return this.requestJson('POST', '/api/v1/account/connection-mode', { modeId }, {
      signal,
      auth: true,
      reveal: false,
    });
  }

  async regenerate(
    opts: {
      location?: string | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ subscriptionUrl: string; shortUuid: string }> {
    const body: Record<string, unknown> = { confirm: true };
    if (opts.location !== undefined) body.location = opts.location;
    return this.requestJson('POST', '/api/v1/account/regenerate', body, {
      signal: opts.signal,
      auth: true,
      reveal: true,
    });
  }

  private async requestJson<T>(
    method: string,
    path: string,
    bodyObj: unknown | undefined,
    opts: { signal?: AbortSignal; auth: boolean; reveal: boolean },
  ): Promise<T> {
    const policy = routePolicy(path, method);
    const m = method.toUpperCase();
    const needsReveal = opts.reveal || policy?.response === 'reveal';

    let wireBody: string | undefined =
      bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
    let respEphPriv: CryptoKey | undefined;
    let respEphPubB64: string | undefined;
    let headersRevealEph: string | undefined;

    if (needsReveal) {
      const eph = await generateEphemeralKeyPair();
      respEphPriv = eph.privateKey;
      respEphPubB64 = bytesToB64Url(await serializePublicKey(eph.publicKey));
      if (m === 'GET' || m === 'HEAD') {
        // Reveal-leg ephemeral rides the x-fs-resp-eph header on GET (and is
        // bound into the PoP message via that header value).
        headersRevealEph = respEphPubB64;
      } else {
        // POST/PATCH: ephemeral is inside the JSON body. PoP bodyHash covers it;
        // the PoP message's respEph field stays '' (server only reads the header).
        const merged: Record<string, unknown> = {
          ...((bodyObj as object) ?? {}),
          [RESP_EPH_FIELD]: respEphPubB64,
        };
        wireBody = JSON.stringify(merged);
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': UA,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/get-account`,
    };
    if (wireBody !== undefined) headers['content-type'] = 'application/json';
    if (headersRevealEph) headers['x-fs-resp-eph'] = headersRevealEph;

    if (opts.auth) {
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
      if (this.pop.sessionToken) {
        const popHeaders = await this.pop.signHeaders({
          method: m,
          path: normalizePath(path),
          host: this.host,
          body: wireBody ?? '',
          // Only bind respEph into PoP when it was sent as a header (GET reveal).
          respEph: headersRevealEph,
        });
        Object.assign(headers, popHeaders);
      }
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: m,
        headers,
        body: wireBody,
        signal: opts.signal,
        redirect: 'manual',
      });
    } catch (e) {
      throw new SdkError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
        'network',
      );
    }

    this.ingestCookies(res.headers.getSetCookie?.() ?? setCookieFallback(res.headers));

    let json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } })?.error;
      throw new SdkError(
        err?.message ?? `HTTP ${res.status}`,
        err?.code ?? `http.${res.status}`,
        res.status,
        json,
      );
    }

    if (respEphPriv && isSealedWire(json)) {
      json = await clientOpenResponse({
        serverKid: this.pins.hpkeKid,
        method: m,
        path,
        respEphPriv,
        wire: json,
      });
    }

    return json as T;
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private ingestCookies(setCookies: string[]): void {
    for (const raw of setCookies) {
      const first = raw.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!value || /Max-Age=0/i.test(raw) || value === 'deleted') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

function setCookieFallback(headers: Headers): string[] {
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}
