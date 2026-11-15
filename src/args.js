import { UsageError } from './errors.js';

export const DEFAULTS = Object.freeze({
  requests: 10,
  timeoutMs: 30_000,
  maxRedirects: 5,
  cacheBust: true,
  keepAlive: false,
  json: false,
});

export const USAGE = `Usage: speed-probe <url> [options]

Measures download speed by requesting <url> sequentially N times,
waiting for each response to be fully received.

Options:
  -n, --requests <n>    number of sequential requests      (default: ${DEFAULTS.requests})
  -t, --timeout <ms>    deadline for one whole request      (default: ${DEFAULTS.timeoutMs})
  -r, --max-redirects <n>  redirect hops to follow          (default: ${DEFAULTS.maxRedirects})
      --no-cache-bust   do not append a unique query param  (default: appended)
      --keep-alive      reuse the TCP connection between requests
      --json            print one JSON object instead of a report
  -h, --help            show this help

Examples:
  speed-probe https://speed.hetzner.de/100MB.bin
  speed-probe https://example.com/big.jpg -n 5 --json`;

/**
 * Parses a positive integer from a CLI flag. Rejects "", "abc", "1.5", "-3"
 * and "10abc" — Number() alone would silently accept some of those as NaN
 * and parseInt() would happily read "10abc" as 10.
 */
function parsePositiveInt(raw, flag) {
  if (raw === undefined) throw new UsageError(`${flag} requires a value`);
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < 1) throw new UsageError(`${flag} must be at least 1, got "${raw}"`);
  return value;
}

/** Parses a non-negative integer (redirect count may legitimately be 0). */
function parseNonNegativeInt(raw, flag) {
  if (raw === undefined) throw new UsageError(`${flag} requires a value`);
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`${flag} must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * @param {string[]} argv raw args without [node, script]
 * @returns {{url: URL, requests: number, timeoutMs: number, maxRedirects: number,
 *            cacheBust: boolean, keepAlive: boolean, json: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  let urlArg;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-n':
      case '--requests':
        options.requests = parsePositiveInt(argv[++i], arg);
        break;
      case '-t':
      case '--timeout':
        options.timeoutMs = parsePositiveInt(argv[++i], arg);
        break;
      case '-r':
      case '--max-redirects':
        options.maxRedirects = parseNonNegativeInt(argv[++i], arg);
        break;
      case '--no-cache-bust':
        options.cacheBust = false;
        break;
      case '--keep-alive':
        options.keepAlive = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option "${arg}"`);
        if (urlArg !== undefined) {
          throw new UsageError(`unexpected extra argument "${arg}"`);
        }
        urlArg = arg;
    }
  }

  if (options.help) return { ...options, url: null };
  if (urlArg === undefined) throw new UsageError('a target URL is required');

  options.url = parseUrl(urlArg);
  return options;
}

/** Accepts only http(s) — ftp:// or file:// would not measure network download. */
export function parseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`only http and https are supported, got "${url.protocol}"`);
  }
  return url;
}
