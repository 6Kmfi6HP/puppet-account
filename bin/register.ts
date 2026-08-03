#!/usr/bin/env bun
/**
 * CLI: register a FreeSocks free account without manually opening the website.
 *
 *   bun run bin/register.ts
 *   bun run bin/register.ts --account-only
 *   bun run bin/register.ts --token <capToken>
 *   bun run bin/register.ts --headless   # usually fails Cap instrumentation
 */
import { registerAccount, SdkError } from '../src/index.ts';

function usage(): never {
  console.error(`Usage: fs-register [options]

Options:
  --base-url <url>       API origin (default https://freesocks.org)
  --referral <code>      Optional FSR-… referral code
  --mode <id>            Connection mode (default: catalog default / freedom-ws)
  --location <code>      Node location preference (or "auto")
  --account-only         Skip connection-mode + regenerate
  --token <capToken>     Use a pre-minted Cap token (no browser)
  --headed / --headless  Cap browser mode (default: headed)
  --json                 Print machine-readable JSON only
  -h, --help             Show help
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
      headed,
    });

    if (jsonOnly) {
      console.log(JSON.stringify(result, null, 2));
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
  } catch (e) {
    if (e instanceof SdkError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.details) console.error(e.details);
      process.exit(1);
    }
    throw e;
  }
}

await main();
