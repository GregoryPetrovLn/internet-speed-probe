import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { HttpError, RequestError, TimeoutError } from './errors.js';

/** Status codes we follow. 304 is deliberately absent — it is not a redirect. */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const CACHE_BUSTER_PARAM = '_sp';

/**
 * Adds a unique query parameter so that neither the browser-less local cache
 * nor an intermediate CDN edge can serve request #2..#10 from a warm cache —
 * that would measure cache latency instead of network throughput.
 * Returns a copy; the caller's URL object is never mutated.
 */
export function withCacheBuster(url, nonce = randomUUID()) {
  const copy = new URL(url);
  copy.searchParams.set(CACHE_BUSTER_PARAM, nonce);
  return copy;
}

/**
 * Creates the agent shared by every request of a run.
 *
 * keepAlive is OFF by default on purpose: with a reused socket, request #1 pays
 * for DNS + TCP + TLS and #2..#10 do not, so the numbers are not comparable and
 * the average is biased. Opting into --keep-alive measures the other, equally
 * valid scenario (a warm connection), so both are offered explicitly.
 */
export function createAgent(url, { keepAlive = false } = {}) {
  const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ keepAlive });
}

/**
 * Downloads the resource once, following redirects, and measures it.
 *
 * Timing notes:
 *  - the clock starts before DNS resolution, so `totalMs` is the full
 *    user-visible cost: DNS + TCP + TLS + redirects + server think time + body;
 *  - `ttfbMs` is marked on the first body byte of the final response, so
 *    `totalMs - ttfbMs` is the part that actually depends on bandwidth;
 *  - `timeoutMs` is a deadline for the whole operation, not a per-socket idle
 *    timeout, so a server trickling one byte per second cannot stall us forever.
 *
 * @returns {Promise<{bytes:number,totalMs:number,ttfbMs:number,status:number,
 *                    finalUrl:string,redirects:number,contentLength:number|null}>}
 */
export async function downloadOnce(targetUrl, options = {}) {
  const {
    timeoutMs = 30_000,
    maxRedirects = 5,
    cacheBust = true,
    agent,
    nonce,
  } = options;

  // The cache buster is applied to the URL the user gave us only. Redirect
  // targets are left byte-for-byte intact: they are often pre-signed (S3 &c.)
  // and an extra query parameter would invalidate the signature.
  let currentUrl = cacheBust ? withCacheBuster(targetUrl, nonce) : new URL(targetUrl);

  const start = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;

  let activeRequest = null;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    activeRequest?.destroy();
  }, timeoutMs);
  // Do not let a pending deadline keep the event loop (and the CLI) alive.
  deadline.unref?.();

  try {
    for (let redirects = 0; ; redirects += 1) {
      const attemptUrl = currentUrl;
      const res = await new Promise((resolve, reject) => {
        const transport = attemptUrl.protocol === 'https:' ? https : http;
        const req = transport.request(
          attemptUrl,
          {
            method: 'GET',
            agent,
            headers: {
              // Ask every hop in the chain for a fresh copy.
              'cache-control': 'no-cache',
              pragma: 'no-cache',
              // No compression: "bytes downloaded" must equal bytes on the wire,
              // and a gzipped body would report the inflated size instead.
              'accept-encoding': 'identity',
              accept: '*/*',
              'user-agent': 'internet-speed-probe/1.0',
            },
          },
          resolve,
        );
        activeRequest = req;
        req.on('error', (err) => {
          reject(
            timedOut
              ? new TimeoutError(timeoutMs, attemptUrl.href)
              : new RequestError(err.message, { url: attemptUrl.href, cause: err }),
          );
        });
        req.end();
      });

      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume(); // drain, otherwise the socket is never released
        if (redirects >= maxRedirects) {
          throw new RequestError(`too many redirects (> ${maxRedirects})`, {
            url: attemptUrl.href,
          });
        }
        const location = res.headers.location;
        if (!location) {
          throw new RequestError(`HTTP ${res.statusCode} without a Location header`, {
            url: attemptUrl.href,
          });
        }
        currentUrl = new URL(location, attemptUrl); // resolves relative redirects
        continue;
      }

      if (res.statusCode >= 400) {
        res.resume();
        throw new HttpError(res.statusCode, res.statusMessage, attemptUrl.href);
      }

      const rawLength = res.headers['content-length'];
      const contentLength = rawLength === undefined ? null : Number(rawLength);

      const { bytes, ttfbMs } = await new Promise((resolve, reject) => {
        let received = 0;
        let firstByteMs = null;
        res.on('data', (chunk) => {
          // Only the size is kept: the body may be hundreds of megabytes and
          // buffering it would turn a speed test into an OOM test.
          if (firstByteMs === null) firstByteMs = elapsedMs();
          received += chunk.length;
        });
        res.on('end', () => resolve({ bytes: received, ttfbMs: firstByteMs ?? elapsedMs() }));
        res.on('aborted', () =>
          reject(
            timedOut
              ? new TimeoutError(timeoutMs, attemptUrl.href)
              : new RequestError('connection aborted mid-body', { url: attemptUrl.href }),
          ),
        );
        res.on('error', (err) =>
          reject(
            timedOut
              ? new TimeoutError(timeoutMs, attemptUrl.href)
              : new RequestError(err.message, { url: attemptUrl.href, cause: err }),
          ),
        );
      });

      const totalMs = elapsedMs();

      // A body shorter than the advertised length means we measured a truncated
      // download; reporting its speed would be wrong, so fail the attempt.
      if (contentLength !== null && Number.isFinite(contentLength) && bytes !== contentLength) {
        throw new RequestError(
          `incomplete body: got ${bytes} bytes, Content-Length announced ${contentLength}`,
          { url: attemptUrl.href },
        );
      }

      return {
        bytes,
        totalMs,
        ttfbMs,
        status: res.statusCode,
        finalUrl: attemptUrl.href,
        redirects,
        contentLength,
      };
    }
  } finally {
    clearTimeout(deadline);
    activeRequest = null;
  }
}
