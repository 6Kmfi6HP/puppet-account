import { mintCapTokenBrowser } from './cap/browser.ts';
import { FreeSocksClient } from './client.ts';
import { discoverPins } from './pins.ts';
import type { RegisterOptions, RegisterResult } from './types.ts';
import { SdkError } from './types.ts';

const DEFAULT_BASE = 'https://freesocks.org';

/**
 * End-to-end FreeSocks free-account registration without a human opening the
 * website UI. Cap still needs a real Chromium (instrumentation); pass
 * `captchaToken` to skip the browser step when a token is obtained elsewhere
 * (e.g. a TG bot that already solved Cap).
 */
export async function registerAccount(opts: RegisterOptions = {}): Promise<RegisterResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const pins = opts.pins ?? (await discoverPins(baseUrl, opts.signal));
  if (!pins.hpkeKid) throw new SdkError('Missing HPKE kid (cannot open sealed responses)', 'pins.missing_kid');

  const client = await FreeSocksClient.create({ baseUrl, pins });
  const config = await client.getConfig(opts.signal);

  const captchaToken = await resolveCaptchaToken({
    ...opts,
    baseUrl,
    siteKey: config.captcha.siteKey,
    apiEndpoint: config.captcha.apiEndpoint,
  });

  const created = await client.createAccount(
    {
      captchaToken,
      ...(opts.referralCode ? { referralCode: opts.referralCode } : {}),
    },
    opts.signal,
  );

  if (!client.sessionCookie) {
    throw new SdkError('Account created but no fs_session cookie received', 'auth.no_cookie');
  }

  const result: RegisterResult = {
    accountId: created.accountId,
    tier: created.tier,
    referralApplied: created.referralApplied,
    popSessionToken: created.popSessionToken,
    sessionCookie: client.sessionCookie,
  };

  if (opts.accountOnly) return result;

  const modeId =
    opts.modeId ??
    config.connectionModes.find((m) => m.isDefault && m.available)?.id ??
    config.connectionModes.find((m) => m.available)?.id ??
    'freedom-ws';

  await client.setConnectionMode(modeId, opts.signal);
  result.modeId = modeId;

  const sub = await client.regenerate({
    location: opts.location,
    signal: opts.signal,
  });
  result.subscriptionUrl = sub.subscriptionUrl;
  result.shortUuid = sub.shortUuid;
  return result;
}

async function resolveCaptchaToken(opts: RegisterOptions & {
  baseUrl: string;
  siteKey: string;
  apiEndpoint: string;
}): Promise<string> {
  if (opts.captchaToken) return opts.captchaToken;
  if (opts.captcha === 'none') {
    throw new SdkError(
      'captchaToken required when captcha strategy is none',
      'cap.token_required',
    );
  }
  // Production Cap needs browser instrumentation — pure PoW is rejected.
  return mintCapTokenBrowser({
    baseUrl: opts.baseUrl,
    headed: opts.headed,
    signal: opts.signal,
  });
}
