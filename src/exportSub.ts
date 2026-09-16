/**
 * CLI helpers: persist the subscriptionURL (one per line) and/or the raw
 * subscription body (HTTP GET of the URL) to a txt file.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SdkError } from './types.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Append one line (no dedup, no overwrite) ending with \n; parent dirs are created. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, 'utf8');
}

/**
 * Raw body of an HTTP GET on the subscription URL. Plain fetch semantics on
 * the URL's own origin (no internal cookie / origin / referer headers — the
 * link is a public bearer token). Follows redirects.
 */
export async function fetchSubscriptionBody(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA }, signal });
  } catch (e) {
    throw new SdkError(
      `Subscription fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      'sub.fetch_failed',
    );
  }
  if (!res.ok) {
    throw new SdkError(`Subscription fetch returned HTTP ${res.status}`, 'sub.http', res.status);
  }
  const body = await res.text();
  if (body.length === 0) {
    throw new SdkError('Subscription fetch returned an empty body', 'sub.empty');
  }
  return body;
}
