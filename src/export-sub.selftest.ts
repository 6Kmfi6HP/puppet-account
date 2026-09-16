/**
 * Offline selftest for the CLI txt export helpers (src/exportSub.ts):
 * local HTTP server, no external network.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLine, fetchSubscriptionBody } from './exportSub.ts';

const body = 'dm1lc3M6Ly9hYQpzczovL2IK'; // two proxy links, base64 (one line)

const server = createServer((req, res) => {
  assert.equal(req.headers.cookie, undefined, 'subscription fetch must not send cookies');
  if (req.url === '/empty') {
    res.writeHead(200).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const dir = await mkdtemp(join(tmpdir(), 'fs-export-sub-'));
try {
  // --save-link semantics: append two lines, no dedup.
  const linkPath = join(dir, 'nested', 'subs.txt');
  await appendLine(linkPath, `${base}/sub/1`);
  await appendLine(linkPath, `${base}/sub/2`);
  const lines = (await readFile(linkPath, 'utf8')).split('\n');
  assert.equal(lines.length, 3, 'expected 2 lines + trailing newline');
  assert.equal(lines[0], `${base}/sub/1`);
  assert.equal(lines[1], `${base}/sub/2`);

  // --save-content semantics: raw body of a cookie-less GET, appended.
  const contentPath = join(dir, 'content.txt');
  const fetched = await fetchSubscriptionBody(`${base}/sub/xyz`);
  assert.equal(fetched, body);
  await appendLine(contentPath, fetched);
  assert.equal(await readFile(contentPath, 'utf8'), `${body}\n`);

  // Empty body is a failure (no write).
  await assert.rejects(fetchSubscriptionBody(`${base}/empty`), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, 'sub.empty');
    return true;
  });
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, note: 'export-sub selftest passed' }));
