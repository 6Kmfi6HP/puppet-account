export interface E2eePins {
  /** Static X-Wing HPKE public key (base64url). Needed for login seal; optional for reveal-only. */
  hpkePk?: string;
  /** Static HPKE kid — required to open reveal-leg responses. */
  hpkeKid: string;
  manifestPk?: string;
  manifestPkPq?: string;
}

export interface RegisterOptions {
  /** API origin, e.g. https://freesocks.org */
  baseUrl?: string;
  /** Optional referral code (FSR-…) */
  referralCode?: string;
  /** Connection mode id (default: freedom-ws). Use "all" for every available mode. */
  modeId?: string;
  /**
   * Multiple connection modes: the account is switched through each one and a
   * subscription is regenerated per mode. Takes precedence over modeId.
   */
  modes?: string[];
  /** Node location code, or null for automatic */
  location?: string | null;
  /** Skip regenerate — only create the account number */
  accountOnly?: boolean;
  /**
   * Pre-minted Cap token. When set, no browser Cap solve is attempted.
   * Useful for TG bots that obtain tokens elsewhere.
   */
  captchaToken?: string;
  /** Cap solve strategy when captchaToken is absent (default: browser). */
  captcha?: 'browser' | 'none' | 'pow';
  /** Playwright headed mode (default true — headless is blocked by Cap instrumentation). */
  headed?: boolean;
  /** Explicit E2EE pins; when omitted the SDK discovers them from the SPA bundle. */
  pins?: E2eePins;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface RegisterResult {
  accountId: string;
  tier: {
    slug: string;
    name: string;
    monthlyTrafficGb: number;
    deviceLimit: number;
    backend: string;
  };
  referralApplied?: boolean;
  popSessionToken?: string;
  /** Session cookie value for `fs_session` (signed). */
  sessionCookie: string;
  subscriptionUrl?: string;
  shortUuid?: string;
  modeId?: string;
  /**
   * Per-mode subscription results when registering with `modes` (order matches
   * the requested modes). Empty when a single mode was used.
   */
  modeResults?: Array<{
    modeId: string;
    subscriptionUrl: string;
    shortUuid: string;
  }>;
}

export interface PublicConfig {
  captcha: { apiEndpoint: string; siteKey: string };
  backends: {
    defaultBackend: string;
    userChoiceEnabled?: boolean;
  };
  connectionModes: Array<{
    id: string;
    available: boolean;
    isDefault?: boolean;
  }>;
}

export class SdkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}
