import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULTS, parseArgs, parseUrl } from '../src/args.js';
import { UsageError } from '../src/errors.js';

describe('parseArgs — valid input', () => {
  it('applies the documented defaults with only a URL', () => {
    const options = parseArgs(['https://example.com/a.jpg']);
    assert.equal(options.url.href, 'https://example.com/a.jpg');
    assert.equal(options.requests, DEFAULTS.requests);
    assert.equal(options.requests, 10, 'the task asks for 10 requests by default');
    assert.equal(options.timeoutMs, DEFAULTS.timeoutMs);
    assert.equal(options.maxRedirects, DEFAULTS.maxRedirects);
    assert.equal(options.cacheBust, true);
    assert.equal(options.keepAlive, false);
    assert.equal(options.json, false);
  });

  it('accepts long and short flags', () => {
    const long = parseArgs(['http://a.b/c', '--requests', '3', '--timeout', '500', '--max-redirects', '2']);
    const short = parseArgs(['http://a.b/c', '-n', '3', '-t', '500', '-r', '2']);
    assert.deepEqual(
      { n: long.requests, t: long.timeoutMs, r: long.maxRedirects },
      { n: short.requests, t: short.timeoutMs, r: short.maxRedirects },
    );
    assert.equal(long.requests, 3);
  });

  it('accepts boolean switches in any order, before or after the URL', () => {
    const options = parseArgs(['--json', '--no-cache-bust', 'http://a.b/c', '--keep-alive']);
    assert.equal(options.json, true);
    assert.equal(options.cacheBust, false);
    assert.equal(options.keepAlive, true);
    assert.equal(options.url.href, 'http://a.b/c');
  });

  it('allows zero redirects (an explicit "do not follow")', () => {
    assert.equal(parseArgs(['http://a.b/c', '-r', '0']).maxRedirects, 0);
  });

  it('returns help without requiring a URL', () => {
    for (const flag of ['-h', '--help']) {
      const options = parseArgs([flag]);
      assert.equal(options.help, true);
      assert.equal(options.url, null);
    }
  });

  it('keeps an existing query string on the target URL', () => {
    const options = parseArgs(['https://cdn.test/img?v=2&token=abc']);
    assert.equal(options.url.searchParams.get('token'), 'abc');
  });
});

describe('parseArgs — invalid input', () => {
  const rejects = (argv, fragment) => {
    assert.throws(
      () => parseArgs(argv),
      (error) => {
        assert.ok(error instanceof UsageError, `expected UsageError, got ${error.name}`);
        assert.match(error.message, fragment);
        return true;
      },
      `expected ${JSON.stringify(argv)} to be rejected`,
    );
  };

  it('requires a URL', () => rejects([], /URL is required/));
  it('rejects a non-URL argument', () => rejects(['not a url'], /not a valid URL/));
  it('rejects a bare hostname without a scheme', () => rejects(['example.com/a.jpg'], /not a valid URL/));
  it('rejects non-http protocols', () => {
    rejects(['ftp://example.com/a.jpg'], /only http and https/);
    rejects(['file:///etc/hosts'], /only http and https/);
  });
  it('rejects a second positional argument', () =>
    rejects(['http://a.b/c', 'http://d.e/f'], /unexpected extra argument/));
  it('rejects unknown flags', () => rejects(['http://a.b/c', '--turbo'], /unknown option/));

  it('rejects non-numeric counts', () => {
    rejects(['http://a.b/c', '-n', 'ten'], /positive integer/);
    rejects(['http://a.b/c', '-n', ''], /positive integer/);
    rejects(['http://a.b/c', '-n', '1.5'], /positive integer/);
    rejects(['http://a.b/c', '-n', '10abc'], /positive integer/);
  });

  it('rejects zero and negative counts', () => {
    rejects(['http://a.b/c', '-n', '0'], /at least 1/);
    // "-5" is parsed as a flag, not a value — either message is a refusal,
    // the point is that it never silently becomes a request count.
    rejects(['http://a.b/c', '-n', '-5'], /unknown option|positive integer/);
  });

  it('rejects a flag with no value at the end of argv', () => {
    rejects(['http://a.b/c', '-n'], /requires a value/);
    rejects(['http://a.b/c', '--timeout'], /requires a value/);
  });

  it('rejects a zero timeout, which would fail every request', () =>
    rejects(['http://a.b/c', '-t', '0'], /at least 1/));
});

describe('parseUrl', () => {
  it('normalises the URL', () => {
    assert.equal(parseUrl('HTTP://Example.COM/A').href, 'http://example.com/A');
  });
  it('throws UsageError on garbage', () => {
    assert.throws(() => parseUrl('://'), UsageError);
  });
});
