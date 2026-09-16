#!/usr/bin/env bun
/**
 * CLI: register a FreeSocks free account without manually opening the website.
 *
 *   bun run bin/register.ts
 *   bun run bin/register.ts --account-only
 *   bun run bin/register.ts --token <capToken>
 *   bun run bin/register.ts --headless   # usually fails Cap instrumentation
 *   bun run bin/register.ts --save-link links.txt --save-content subs.txt
 */
import { registerAccount, SdkError } from '../src/index.ts';
import { appendLine, fetchSubscriptionBody } from '../src/exportSub.ts';
import type { RegisterResult } from '../src/index.ts';

function usage(): never {
  console.error(`Usage: fs-register [options]

Options:
  --base-url <url>       API origin (default https://freesocks.org)
  --referral <code>      Optional FSR-… referral code
  --mode <id>            Connection mode (default: catalog default / freedom-ws)
  --location <code>      Node location preference (or "auto")
  --account-only         Skip connection-mode + regenerate
  --token <capToken>     Use a pre-minted Cap token (no browser)
  --pow                  Solve Cap purely in-protocol (no browser)
  --headed / --headless  Cap browser mode (default: headed)
  --json                 Print machine-readable JSON only
  --save-link <path>     Append subscriptionUrl to <path>, one line per URL
                         (append-only, no dedup)
  --save-content <path>  Append the subscription body (one HTTP GET of the
                         subscriptionUrl, no cookies) to <path>
  -h, --help             Show help

Save options need a subscriptionUrl and are skipped under --account-only (a
note goes to stderr and saves.* is false in --json output). A failed save is
reported on stderr / in the JSON "saves" fields and the process exits 3; the
account itself remains valid.
`);
  process.exit(2);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('-')) usage();
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) usage();

  const jsonOnly = argv.includes('--json');
  const headed = argv.includes('--headless') ? false : true;

  let saveFailed = false;
  try {
    const result = await registerAccount({
      baseUrl: argValue(argv, '--base-url'),
      referralCode: argValue(argv, '--referral'),
      modeId: argValue(argv, '--mode'),
      location: (() => {
        const loc = argValue(argv, '--location');
        if (loc === undefined) return undefined;
        return loc === 'auto' ? null : loc;
      })(),
      accountOnly: argv.includes('--account-only'),
      captchaToken: argValue(argv, '--token'),
      captcha: argv.includes('--pow') ? 'pow' : undefined,
      headed,
    });

    const saves = await saveSubscription(result, {
      linkPath: argValue(argv, '--save-link'),
      contentPath: argValue(argv, '--save-content'),
    });
    saveFailed = saves ? Object.values(saves).some((v) => v === false) : false;

    if (jsonOnly) {
      const out = saves ? { ...result, saves } : result;
      console.log(JSON.stringify(out, null, 2));
      if (saveFailed) process.exit(3);
      return;
    }

    console.log('Account created');
    console.log(`  accountId:  ${result.accountId}`);
    console.log(`  tier:       ${result.tier.name} (${result.tier.slug})`);
    console.log(`  backend:    ${result.tier.backend}`);
    if (result.modeId) console.log(`  mode:       ${result.modeId}`);
    if (result.shortUuid) console.log(`  shortUuid:  ${result.shortUuid}`);
    if (result.subscriptionUrl) {
      console.log(`  sub URL:    ${result.subscriptionUrl}`);
    }
    console.log(`  cookie:     fs_session=${result.sessionCookie.slice(0, 16)}…`);
    if (result.popSessionToken) {
      console.log(`  pop token:  ${result.popSessionToken.slice(0, 16)}…`);
    }
    console.log('\nSave the accountId — it is shown only once.');
    if (saveFailed) process.exit(3);
  } catch (e) {
    if (e instanceof SdkError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.details) console.error(e.details);
      process.exit(1);
    }
    throw e;
  }
}

interface SaveOptions {
  linkPath?: string;
  contentPath?: string;
}

/**
 * Persist the subscription link and/or its fetched body to txt files.
 * Returns undefined when neither option is given; failures are reported on
 * stderr and recorded as false (they never throw — the account stays valid).
 */
async function saveSubscription(
  result: RegisterResult,
  opts: SaveOptions,
): Promise<{ link: boolean; content: boolean } | undefined> {
  const saves = { link: false, content: false };
  if (!opts.linkPath && !opts.contentPath) return undefined;
  if (!result.subscriptionUrl) {
    console.error('Note: no subscriptionUrl (--account-only) — --save-link/--save-content skipped.');
    return saves;
  }

  if (opts.linkPath) {
    try {
      await appendLine(opts.linkPath, result.subscriptionUrl);
      saves.link = true;
    } catch (e) {
      console.error(`--save-link ${opts.linkPath}: ${errMessage(e)}`);
    }
  }

  if (opts.contentPath) {
    try {
      const body = await fetchSubscriptionBody(result.subscriptionUrl);
      await appendLine(opts.contentPath, body);
      saves.content = true;
    } catch (e) {
      console.error(`--save-content ${opts.contentPath}: ${errMessage(e)}`);
    }
  }

  return saves;
}

function errMessage(e: unknown): string {
  if (e instanceof SdkError) return `Error [${e.code}]: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

await main();
