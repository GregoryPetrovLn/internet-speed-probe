import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { HttpError, RequestError, TimeoutError } from './errors.js';

/** Status codes we follow. 304 is deliberately absent — it is not a redirect. */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** 2xx statuses that are defined to have no body, so there is nothing to time. */
const BODILESS_CODES = new Set([204, 304]);

const CACHE_BUSTER_PARAM = '_sp';

/**
 * Query parameters that suggest the URL is signed, where adding anything would
 * break the signature: AWS/GCS/Azure pre-signed forms and common token names.
 */
const SIGNED_PARAM_PATTERN =
  /^(?:x-amz-|x-goog-|x-obs-|x-oss-)|^(?:signature|sig|sp|sv|se|sr|st|skoid|token|access_token|expires|expiry|policy|credential|awsaccesskeyid|hash|md5|verify|key)$/i;

function looksSigned(url) {
  for (const name of url.searchParams.keys()) {
    if (SIGNED_PARAM_PATTERN.test(name)) return true;
  }
  return false;
}

/**
 * Adds a unique query parameter so that neither the local cache nor an
 * intermediate CDN edge can serve request #2..#10 from a warm cache — that
 * would measure cache latency instead of network throughput.
 * Returns a copy; the caller's URL object is never mutated.
 */
export function withCacheBuster(url, nonce = randomUUID()) {
  const copy = new URL(url);
  copy.searchParams.set(CACHE_BUSTER_PARAM, nonce);
  return copy;
}

/**
 * One agent per protocol, shared by every request of a run.
 *
 * Per protocol, not one for the whole run: a redirect may switch http <-> https,
 * and Node rejects an agent whose protocol does not match the transport
 * ("Protocol \"https:\" not supported. Expected \"http:\"").
 *
 * keepAlive is OFF by default on purpose: with a reused socket, request #1 pays
 * for DNS + TCP + TLS and #2..#10 do not, so the numbers are not comparable and
 * the average is biased. maxCachedSessions: 0 closes the same loophole one level
 * down — otherwise an https.Agent caches the TLS session and requests #2..#10
 * get an abbreviated handshake even with keepAlive off. --keep-alive measures
 * the other, equally valid scenario (a warm connection), so both are explicit.
 */
export function createAgentPool({ keepAlive = false } = {}) {
  const agents = new Map();
  return {
    for(url) {
      const protocol = url.protocol;
      let agent = agents.get(protocol);
      if (!agent) {
        const Agent = protocol === 'https:' ? https.Agent : http.Agent;
        agent = new Agent(
          keepAlive ? { keepAlive: true } : { keepAlive: false, maxCachedSessions: 0 },
        );
        agents.set(protocol, agent);
      }
      return agent;
    },
    destroy() {
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
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
    agents,
    nonce,
  } = options;

  // A standalone call gets its own pool so that it never silently falls back to
  // Node's global agent, which has keepAlive on and would reuse sockets.
  const pool = agents ?? createAgentPool({ keepAlive: false });
  const ownsPool = agents === undefined;

  const bustNonce = nonce ?? randomUUID();
  let currentUrl = cacheBust ? withCacheBuster(targetUrl, bustNonce) : new URL(targetUrl);

  const start = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;

  let activeRequest = null;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    activeRequest?.destroy();
  }, timeoutMs);
  // Do not let a pending deadline keep the event loop (and the CLI) alive.
  deadline.unref();

  try {
    for (let redirects = 0; ; redirects += 1) {
      const attemptUrl = currentUrl;
      const res = await new Promise((resolve, reject) => {
        const transport = attemptUrl.protocol === 'https:' ? https : http;
        const req = transport.request(
          attemptUrl,
          {
            method: 'GET',
            agent: pool.for(attemptUrl),
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
        const next = new URL(location, attemptUrl); // resolves relative redirects
        // Bust the cache on the redirect target too — an origin redirecting to a
        // CDN/object-store URL is the common shape, and that final URL is the one
        // that would otherwise be served warm for requests #2..#10. Signed URLs
        // are left byte-for-byte intact, since an extra parameter breaks them.
        currentUrl = cacheBust && !looksSigned(next) ? withCacheBuster(next, bustNonce) : next;
        continue;
      }

      if (res.statusCode >= 400) {
        res.resume();
        throw new HttpError(res.statusCode, res.statusMessage, attemptUrl.href);
      }

      // 204/304 are < 400 but carry no body. Measuring them would report a
      // 0-byte "download"; a 304 in particular is a cache hit, not a transfer.
      if (BODILESS_CODES.has(res.statusCode)) {
        res.resume();
        throw new RequestError(
          `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim() +
            ' carries no body — nothing to measure',
          { url: attemptUrl.href },
        );
      }

      const rawLength = res.headers['content-length'];
      const contentLength = rawLength === undefined ? null : Number(rawLength);
      const expectedLength = Number.isFinite(contentLength) ? contentLength : null;

      const { bytes, ttfbMs } = await new Promise((resolve, reject) => {
        let received = 0;
        let firstByteMs = null;
        /** Describes how far a dropped connection got, for a usable message. */
        const shortfall = () =>
          expectedLength === null
            ? `after ${received} bytes`
            : `with ${received} of ${expectedLength} bytes`;

        res.on('data', (chunk) => {
          // Only the size is kept: the body may be hundreds of megabytes and
          // buffering it would turn a speed test into an OOM test.
          if (firstByteMs === null) firstByteMs = elapsedMs();
          received += chunk.length;
        });
        res.on('end', () => resolve({ bytes: received, ttfbMs: firstByteMs ?? elapsedMs() }));
        // Node's parser aborts the stream when the body is shorter than the
        // announced Content-Length, so a truncated download arrives here rather
        // than at the length check below — hence the byte counts in the message.
        res.on('aborted', () =>
          reject(
            timedOut
              ? new TimeoutError(timeoutMs, attemptUrl.href)
              : new RequestError(`incomplete body: connection aborted ${shortfall()}`, {
                  url: attemptUrl.href,
                }),
          ),
        );
        res.on('error', (err) =>
          reject(
            timedOut
              ? new TimeoutError(timeoutMs, attemptUrl.href)
              : new RequestError(`${err.message} (${shortfall()})`, {
                  url: attemptUrl.href,
                  cause: err,
                }),
          ),
        );
      });

      const totalMs = elapsedMs();

      // Defensive: a clean 'end' that still fell short of Content-Length would
      // mean a silently truncated download. Node normally aborts first (see
      // above), so this is a backstop, not the primary guard.
      if (expectedLength !== null && bytes !== expectedLength) {
        throw new RequestError(
          `incomplete body: got ${bytes} bytes, Content-Length announced ${expectedLength}`,
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
    if (ownsPool) pool.destroy();
  }
}
