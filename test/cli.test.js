import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startServer } from './helpers/server.js';

const CLI = fileURLToPath(new URL('../speedtest.js', import.meta.url));

/** Runs the real CLI as a child process and never throws on a non-zero exit. */
function run(args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr, killed: Boolean(error?.killed) });
    });
  });
}

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

describe('CLI — happy path', () => {
  it('prints a report and exits 0', async () => {
    const { code, stdout } = await run([server.url('/bytes?size=50000').href, '-n', '3']);
    assert.equal(code, 0);
    assert.match(stdout, /successful requests\s+3 of 3/);
    assert.match(stdout, /download speed\s+[\d.]+ Mbit\/s \([\d.]+ MB\/s\)/);
    assert.match(stdout, /total downloaded\s+150\.00 kB \(150000 bytes\)/);
    assert.match(stdout, /average request/);
    assert.match(stdout, /\[1\/3\]/, 'per-request progress is printed');
    assert.match(stdout, /\[3\/3\]/);
  });

  it('makes exactly N requests, strictly one at a time', async () => {
    server.requests.length = 0;
    server.concurrency.max = 0;
    const { code } = await run([server.url('/chunked?size=20000&chunks=4&delay=15').href, '-n', '4']);
    assert.equal(code, 0);
    assert.equal(server.requests.length, 4, 'exactly 4 requests reached the server');
    assert.equal(server.concurrency.max, 1, 'requests must not overlap — parallel would skew speed');
  });

  it('emits machine-readable JSON with --json and nothing else on stdout', async () => {
    const { code, stdout } = await run([server.url('/bytes?size=10000').href, '-n', '2', '--json']);
    assert.equal(code, 0);
    const report = JSON.parse(stdout); // throws if progress lines leaked into stdout
    assert.equal(report.successCount, 2);
    assert.equal(report.failedCount, 0);
    assert.equal(report.totalBytes, 20000);
    assert.equal(report.samples.length, 2);
    assert.ok(report.megabitsPerSecond > 0);
    assert.ok(
      Math.abs(report.megabitsPerSecond - report.megabytesPerSecond * 8) < 1e-9,
      'the two units must agree',
    );
  });

  it('defaults to 10 requests when -n is omitted', async () => {
    server.requests.length = 0;
    const { code, stdout } = await run([server.url('/bytes?size=512').href, '--json']);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).successCount, 10);
    assert.equal(server.requests.length, 10);
  });

  it('prints help and exits 0', async () => {
    const { code, stdout } = await run(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: speed-probe/);
    assert.match(stdout, /--requests/);
  });

  it('follows a redirect and says so', async () => {
    const { code, stdout } = await run([
      server.url('/redirect?to=/bytes%3Fsize%3D4096').href,
      '-n',
      '1',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /followed 1 redirect/);
  });
});

describe('CLI — failure handling', () => {
  it('exits 2 with usage on stderr for a bad URL', async () => {
    const { code, stderr, stdout } = await run(['not-a-url']);
    assert.equal(code, 2);
    assert.match(stderr, /not a valid URL/);
    assert.match(stderr, /Usage: speed-probe/);
    assert.equal(stdout, '', 'usage errors must not pollute stdout');
  });

  it('exits 2 when no URL is given', async () => {
    const { code, stderr } = await run([]);
    assert.equal(code, 2);
    assert.match(stderr, /URL is required/);
  });

  it('exits 2 on an invalid request count', async () => {
    const { code, stderr } = await run(['http://127.0.0.1:1/x', '-n', 'many']);
    assert.equal(code, 2);
    assert.match(stderr, /positive integer/);
  });

  it('exits 1 when every request fails, and groups the reasons', async () => {
    const { code, stdout } = await run([server.url('/status?code=404').href, '-n', '3']);
    assert.equal(code, 1);
    assert.match(stdout, /failed requests\s+3/);
    assert.match(stdout, /3x HTTP 404/, 'identical errors are grouped, not repeated');
    assert.match(stdout, /No successful request/);
  });

  it('keeps going after a failure and reports a partial run', async () => {
    // The route 500s twice, then serves 512 bytes: 3 of 5 must succeed.
    const { code, stdout } = await run([server.url('/flaky?fail=2&size=512').href, '-n', '5']);
    assert.equal(code, 0, 'a partial run is still a usable measurement');
    assert.match(stdout, /successful requests\s+3 of 5/);
    assert.match(stdout, /failed requests\s+2/);
    assert.match(stdout, /total downloaded\s+1\.54 kB \(1536 bytes\)/);
  });

  it('does not hang when the server never finishes the body', async () => {
    const { code, stdout, killed } = await run(
      [server.url('/never-ends').href, '-n', '2', '-t', '400'],
      { timeout: 10_000 },
    );
    assert.equal(killed, false, 'the CLI must exit on its own, not be killed');
    assert.equal(code, 1);
    assert.match(stdout, /timed out after 400 ms/);
  });

  it('exits promptly on connection refused rather than retrying forever', async () => {
    const started = Date.now();
    const { code, stdout } = await run(['http://127.0.0.1:1/x', '-n', '2'], { timeout: 15_000 });
    assert.equal(code, 1);
    assert.match(stdout, /failed requests\s+2/);
    assert.ok(Date.now() - started < 10_000, 'should fail fast');
  });
});
