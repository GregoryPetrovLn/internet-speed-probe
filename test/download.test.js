import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAgentPool, downloadOnce, withCacheBuster } from '../src/download.js';
import { HttpError, RequestError, TimeoutError } from '../src/errors.js';
import { findClosedPort, startServer } from './helpers/server.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server.close();
});

describe('downloadOnce — successful measurement', () => {
  it('counts exactly the bytes the server sent', async () => {
    const result = await downloadOnce(server.url('/bytes?size=65536'), { timeoutMs: 5000 });
    assert.equal(result.bytes, 65536);
    assert.equal(result.status, 200);
    assert.equal(result.contentLength, 65536);
    assert.equal(result.redirects, 0);
  });

  it('counts bytes of a chunked response with no Content-Length', async () => {
    const result = await downloadOnce(server.url('/chunked?size=40000&chunks=8'), {
      timeoutMs: 5000,
    });
    assert.equal(result.bytes, 40000);
    assert.equal(result.contentLength, null);
  });

  it('measures a non-zero duration with ttfb <= total', async () => {
    const result = await downloadOnce(server.url('/bytes?size=1048576'), { timeoutMs: 10000 });
    assert.ok(result.totalMs > 0, `expected a positive duration, got ${result.totalMs}`);
    assert.ok(
      result.ttfbMs <= result.totalMs + 1e-6,
      `ttfb ${result.ttfbMs} must not exceed total ${result.totalMs}`,
    );
  });

  it('attributes a slow server to TTFB, not to bandwidth', async () => {
    // 8 bytes, but the headers only come after 150 ms: TTFB must carry the wait.
    const result = await downloadOnce(server.url('/slow-headers?delay=150'), { timeoutMs: 5000 });
    assert.equal(result.bytes, 8);
    assert.ok(result.ttfbMs >= 140, `expected ttfb >= 140 ms, got ${result.ttfbMs}`);
    assert.ok(result.totalMs >= result.ttfbMs);
  });

  it('waits for the complete body, not just the headers', async () => {
    // 4 chunks, 60 ms apart: anything that resolved on headers would return early.
    const result = await downloadOnce(server.url('/chunked?size=4000&chunks=4&delay=60'), {
      timeoutMs: 5000,
    });
    assert.equal(result.bytes, 4000);
    assert.ok(result.totalMs >= 180, `expected >= 180 ms of streaming, got ${result.totalMs}`);
  });

  it('accepts an empty body without crashing', async () => {
    const result = await downloadOnce(server.url('/empty'), { timeoutMs: 5000 });
    assert.equal(result.bytes, 0);
    assert.equal(result.status, 200);
  });

  it('sends cache-defeating headers and no compression', async () => {
    server.requests.length = 0;
    await downloadOnce(server.url('/bytes?size=16'), { timeoutMs: 5000 });
    const sent = server.requests.at(-1).headers;
    assert.equal(sent['cache-control'], 'no-cache');
    assert.equal(
      sent['accept-encoding'],
      'identity',
      'a gzipped body would make "bytes downloaded" differ from bytes on the wire',
    );
  });

  it('adds a unique cache-busting parameter per request by default', async () => {
    server.requests.length = 0;
    await downloadOnce(server.url('/bytes?size=16'), { timeoutMs: 5000 });
    await downloadOnce(server.url('/bytes?size=16'), { timeoutMs: 5000 });
    const [first, second] = server.requests.map((r) => r.query.get('_sp'));
    assert.ok(first, 'expected a _sp parameter');
    assert.notEqual(first, second, 'each request must look unique to caches');
    assert.equal(server.requests[0].query.get('size'), '16', 'existing query is preserved');
  });

  it('omits the cache-busting parameter when disabled', async () => {
    server.requests.length = 0;
    await downloadOnce(server.url('/bytes?size=16'), { timeoutMs: 5000, cacheBust: false });
    assert.equal(server.requests.at(-1).query.get('_sp'), null);
  });

  it('does not mutate the caller\'s URL object', async () => {
    const url = server.url('/bytes?size=16');
    const before = url.href;
    await downloadOnce(url, { timeoutMs: 5000 });
    assert.equal(url.href, before);
  });

  it('follows a redirect and measures only the final resource', async () => {
    const result = await downloadOnce(server.url('/redirect?to=/bytes%3Fsize%3D256'), {
      timeoutMs: 5000,
    });
    assert.equal(result.bytes, 256);
    assert.equal(result.redirects, 1);
    assert.match(result.finalUrl, /\/bytes/);
  });

  it('follows a chain of redirects up to the limit', async () => {
    const result = await downloadOnce(server.url('/redirect-chain?n=3'), {
      timeoutMs: 5000,
      maxRedirects: 5,
    });
    assert.equal(result.bytes, 128);
    assert.equal(result.redirects, 3);
  });

  it('follows 301, 303, 307 and 308 as well as 302', async () => {
    for (const code of [301, 302, 303, 307, 308]) {
      const result = await downloadOnce(
        server.url(`/redirect?code=${code}&to=/bytes%3Fsize%3D64`),
        { timeoutMs: 5000 },
      );
      assert.equal(result.bytes, 64, `status ${code} should have been followed`);
    }
  });

  it('reuses one socket with keep-alive and still measures correctly', async () => {
    const url = server.url('/bytes?size=4096');
    const agents = createAgentPool({ keepAlive: true });
    try {
      for (let i = 0; i < 3; i += 1) {
        const result = await downloadOnce(url, { timeoutMs: 5000, agents });
        assert.equal(result.bytes, 4096);
      }
    } finally {
      agents.destroy();
    }
  });
});

describe('downloadOnce — failures', () => {
  it('throws HttpError with the status for 4xx', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/status?code=404'), { timeoutMs: 5000 }),
      (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 404);
        assert.match(error.message, /HTTP 404/);
        return true;
      },
    );
  });

  it('throws HttpError for 5xx', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/status?code=503'), { timeoutMs: 5000 }),
      (error) => error instanceof HttpError && error.status === 503,
    );
  });

  it('gives up on a redirect loop instead of hanging', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/redirect-loop'), { timeoutMs: 5000, maxRedirects: 3 }),
      (error) => {
        assert.ok(error instanceof RequestError);
        assert.match(error.message, /too many redirects/);
        return true;
      },
    );
  });

  it('refuses to follow a redirect when maxRedirects is 0', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/redirect?to=/bytes%3Fsize%3D8'), {
        timeoutMs: 5000,
        maxRedirects: 0,
      }),
      /too many redirects/,
    );
  });

  it('rejects a 3xx without a Location header', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/redirect-no-location'), { timeoutMs: 5000 }),
      /without a Location header/,
    );
  });

  it('times out on a response that never ends', async () => {
    const started = Date.now();
    await assert.rejects(
      () => downloadOnce(server.url('/never-ends'), { timeoutMs: 300 }),
      (error) => {
        assert.ok(error instanceof TimeoutError, `got ${error.name}: ${error.message}`);
        assert.equal(error.timeoutMs, 300);
        return true;
      },
    );
    // The deadline must cover the body, not just the socket going idle.
    assert.ok(Date.now() - started < 3000, 'timeout should fire promptly');
  });

  it('times out while the body is still trickling in', async () => {
    await assert.rejects(
      () => downloadOnce(server.url('/chunked?size=10000&chunks=50&delay=50'), { timeoutMs: 250 }),
      TimeoutError,
    );
  });

  it('fails on a connection refused', async () => {
    const port = await findClosedPort();
    await assert.rejects(
      () => downloadOnce(new URL(`http://127.0.0.1:${port}/x`), { timeoutMs: 2000 }),
      (error) => {
        assert.ok(error instanceof RequestError);
        assert.match(error.message, /ECONNREFUSED|connect/i);
        return true;
      },
    );
  });

  it('fails on an unresolvable host', async () => {
    await assert.rejects(
      () =>
        downloadOnce(new URL('http://nonexistent.invalid-tld-for-tests./x'), { timeoutMs: 5000 }),
      (error) => {
        assert.ok(error instanceof RequestError, `got ${error.name}`);
        return true;
      },
    );
  });

  it('rejects a body shorter than the announced Content-Length', async () => {
    // Either the stream aborts or our own length check fires; both must fail
    // loudly, because reporting the speed of a truncated download is a lie.
    await assert.rejects(
      () => downloadOnce(server.url('/short-body'), { timeoutMs: 5000 }),
      (error) => {
        assert.ok(error instanceof RequestError, `got ${error.name}`);
        assert.match(error.message, /incomplete body/);
        return true;
      },
    );
  });
});

describe('withCacheBuster', () => {
  it('returns a copy and keeps existing parameters', () => {
    const url = new URL('https://a.b/c?x=1');
    const busted = withCacheBuster(url, 'nonce-1');
    assert.equal(url.href, 'https://a.b/c?x=1');
    assert.equal(busted.searchParams.get('x'), '1');
    assert.equal(busted.searchParams.get('_sp'), 'nonce-1');
  });

  it('overwrites its own parameter instead of stacking duplicates', () => {
    const once = withCacheBuster(new URL('https://a.b/c'), 'n1');
    const twice = withCacheBuster(once, 'n2');
    assert.equal(twice.searchParams.getAll('_sp').length, 1);
    assert.equal(twice.searchParams.get('_sp'), 'n2');
  });
});

describe('agent pool — cross-protocol redirects (regression)', () => {
  it('hands out an agent matching each protocol', () => {
    const pool = createAgentPool({ keepAlive: false });
    try {
      const forHttp = pool.for(new URL('http://a.b/'));
      const forHttps = pool.for(new URL('https://a.b/'));
      assert.notEqual(forHttp, forHttps, 'one agent cannot serve both protocols');
      assert.equal(forHttp.protocol, 'http:');
      assert.equal(forHttps.protocol, 'https:');
      assert.equal(pool.for(new URL('http://c.d/')), forHttp, 'agents are reused per protocol');
      assert.equal(
        forHttps.maxCachedSessions,
        0,
        'TLS session caching would give requests 2..N an abbreviated handshake',
      );
    } finally {
      pool.destroy();
    }
  });

  it('keeps the TLS session cache when --keep-alive is requested', () => {
    const pool = createAgentPool({ keepAlive: true });
    try {
      assert.equal(pool.for(new URL('https://a.b/')).keepAlive, true);
    } finally {
      pool.destroy();
    }
  });

  it('follows an http -> https redirect instead of failing on the agent protocol', async () => {
    // The whole point: a single agent built from the original URL made Node
    // throw `Protocol "https:" not supported. Expected "http:"` on every
    // http://-to-https:// redirect, which is most of the real web. Here the
    // https target is a closed port, so reaching a connection-level failure
    // (and a typed RequestError) proves the request was actually attempted.
    const closed = await findClosedPort();
    await assert.rejects(
      () =>
        downloadOnce(server.url(`/redirect?to=${encodeURIComponent(`https://127.0.0.1:${closed}/x`)}`), {
          timeoutMs: 5000,
        }),
      (error) => {
        assert.ok(error instanceof RequestError, `expected a typed error, got ${error.name}`);
        assert.doesNotMatch(
          error.message,
          /Protocol .* not supported/,
          'the agent must match the protocol of the hop being requested',
        );
        assert.match(error.message, /ECONNREFUSED|connect/i);
        return true;
      },
    );
  });
});

describe('bodiless responses (regression)', () => {
  for (const code of [204, 304]) {
    it(`reports ${code} as having nothing to measure, not as a corrupt body`, async () => {
      await assert.rejects(
        () => downloadOnce(server.url(`/status?code=${code}`), { timeoutMs: 5000 }),
        (error) => {
          assert.ok(error instanceof RequestError);
          assert.match(error.message, new RegExp(`HTTP ${code}.*nothing to measure`));
          assert.doesNotMatch(error.message, /incomplete body/);
          return true;
        },
      );
    });
  }
});

describe('redirect cache busting (regression)', () => {
  it('busts the cache on the redirect target too', async () => {
    // An origin redirecting to a CDN is the common shape; without this the
    // final (cacheable) URL was byte-identical on every request.
    server.requests.length = 0;
    await downloadOnce(server.url('/redirect?to=/bytes%3Fsize%3D32'), { timeoutMs: 5000 });
    await downloadOnce(server.url('/redirect?to=/bytes%3Fsize%3D32'), { timeoutMs: 5000 });
    const finals = server.requests.filter((r) => r.path === '/bytes');
    assert.equal(finals.length, 2);
    assert.ok(finals[0].query.get('_sp'), 'the redirect target must be busted as well');
    assert.notEqual(finals[0].query.get('_sp'), finals[1].query.get('_sp'));
  });

  it('leaves a signed redirect target untouched', async () => {
    // Adding a parameter to a pre-signed URL invalidates the signature.
    server.requests.length = 0;
    const signed = '/bytes?size=32&X-Amz-Signature=deadbeef';
    await downloadOnce(server.url(`/redirect?to=${encodeURIComponent(signed)}`), {
      timeoutMs: 5000,
    });
    const final = server.requests.find((r) => r.path === '/bytes');
    assert.equal(final.query.get('X-Amz-Signature'), 'deadbeef');
    assert.equal(final.query.get('_sp'), null, 'a signed URL must not be modified');
  });

  it('allows exactly maxRedirects hops and rejects the next one', async () => {
    const ok = await downloadOnce(server.url('/redirect-chain?n=2'), {
      timeoutMs: 5000,
      maxRedirects: 2,
    });
    assert.equal(ok.redirects, 2, '-r 2 must allow 2 hops');
    await assert.rejects(
      () => downloadOnce(server.url('/redirect-chain?n=3'), { timeoutMs: 5000, maxRedirects: 2 }),
      /too many redirects/,
      '-r 2 must reject the 3rd hop',
    );
  });
});

describe('TTFB is really measured (regression)', () => {
  it('separates first-byte latency from body streaming time', async () => {
    // 4 chunks 60 ms apart: the first byte arrives early, the body takes ~3x
    // longer. Asserting only ttfb <= total would pass even if ttfb were
    // copied from total, so pin the ratio.
    const result = await downloadOnce(server.url('/chunked?size=4000&chunks=4&delay=60'), {
      timeoutMs: 5000,
    });
    assert.ok(
      result.ttfbMs < result.totalMs / 2,
      `ttfb ${result.ttfbMs.toFixed(1)} ms should be well under half of total ${result.totalMs.toFixed(1)} ms`,
    );
  });

  it('charges a slow-to-respond server to latency, not to the body', async () => {
    const result = await downloadOnce(server.url('/slow-headers?delay=150'), { timeoutMs: 5000 });
    assert.ok(result.ttfbMs >= 140);
    assert.ok(
      result.totalMs - result.ttfbMs < 50,
      'an 8-byte body must not account for the 150 ms wait',
    );
  });
});
