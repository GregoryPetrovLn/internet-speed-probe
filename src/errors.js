/**
 * Typed errors so the CLI can tell apart "the user typed something wrong"
 * (exit code 2, print usage) from "the network/server misbehaved"
 * (exit code 1, keep going with the remaining requests).
 */

/** Bad command line input: unknown flag, missing URL, non-numeric count. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Anything that made a single measurement unusable. Carries the attempt URL. */
export class RequestError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message, { cause });
    this.name = 'RequestError';
    this.url = url;
  }
}

/** Server answered, but with a status we cannot measure (4xx/5xx). */
export class HttpError extends RequestError {
  constructor(status, statusMessage, url) {
    super(`HTTP ${status} ${statusMessage ?? ''}`.trim(), { url });
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The whole request (including redirects and body) exceeded the deadline. */
export class TimeoutError extends RequestError {
  constructor(timeoutMs, url) {
    super(`timed out after ${timeoutMs} ms`, { url });
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
