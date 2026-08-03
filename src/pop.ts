/**
 * Node PoP session using WebCrypto Ed25519 — same scheme as the browser Worker
 * (src/client/lib/pop-worker.ts). Prefer WebCrypto over noble for wire parity.
 */
import { bytesToB64Url, normalizePath } from './crypto/envelope.ts';
import {
  buildPopMessage,
  digestB64Url,
  POP_ALG_ED,
  POP_ALG_FIELD,
  POP_HOST_HEADER,
  POP_NONCE_HEADER,
  POP_PUBKEY_FIELD,
  POP_SIG_HEADER,
  POP_TS_HEADER,
  POP_VERSION,
  POP_VERSION_HEADER,
  signEd25519,
} from './crypto/pop.ts';

export class PopSession {
  readonly privateKey: CryptoKey;
  readonly publicKeyB64: string;
  readonly alg = POP_ALG_ED;
  sessionToken = '';
  /** serverNow - localNow, from /healthz (SPA does the same). */
  private tsOffsetMs = 0;

  private constructor(privateKey: CryptoKey, publicKeyB64: string) {
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKeyB64;
  }

  static async create(): Promise<PopSession> {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    return new PopSession(kp.privateKey, bytesToB64Url(pubRaw));
  }

  /** Sync clock skew against the server (call once after construction). */
  async syncTime(baseUrl: string, signal?: AbortSignal): Promise<void> {
    try {
      const t0 = Date.now();
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/healthz`, {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { timestamp?: string };
      const serverMs = body.timestamp ? Date.parse(body.timestamp) : NaN;
      if (!Number.isFinite(serverMs)) return;
      const t1 = Date.now();
      this.tsOffsetMs = serverMs - (t0 + (t1 - t0) / 2);
    } catch {
      /* keep 0 */
    }
  }

  /** Fields folded into session-establish bodies (create / login). */
  enrollmentFields(): Record<string, string> {
    return {
      [POP_PUBKEY_FIELD]: this.publicKeyB64,
      [POP_ALG_FIELD]: this.alg,
    };
  }

  setSessionToken(token: string | undefined): void {
    this.sessionToken = token ?? '';
  }

  async signHeaders(opts: {
    method: string;
    path: string;
    host: string;
    body: string;
    respEph?: string;
    query?: string;
  }): Promise<Record<string, string>> {
    const ts = Math.round(Date.now() + this.tsOffsetMs);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceB64 = bytesToB64Url(nonce);
    const bodyHashB64 = await digestB64Url(new TextEncoder().encode(opts.body));
    const msg = buildPopMessage({
      version: POP_VERSION,
      method: opts.method,
      path: normalizePath(opts.path),
      query: opts.query,
      host: opts.host,
      respEph: opts.respEph ?? '',
      sessionToken: this.sessionToken,
      bodyHashB64,
      ts,
      nonceB64,
    });
    const sig = await signEd25519(this.privateKey, msg);
    return {
      [POP_SIG_HEADER]: bytesToB64Url(sig),
      [POP_TS_HEADER]: String(ts),
      [POP_NONCE_HEADER]: nonceB64,
      [POP_VERSION_HEADER]: POP_VERSION,
      [POP_HOST_HEADER]: opts.host,
    };
  }
}
