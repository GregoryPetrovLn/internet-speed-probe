/**
 * Aggregation and human formatting.
 *
 * Unit convention (also stated in the README): everything is decimal SI.
 *   1 kB = 1000 bytes, 1 MB = 1 000 000 bytes
 *   1 Mbit/s = 1 000 000 bits/s
 * Mbit/s is the headline figure because that is what ISPs advertise, and
 * MB/s is printed next to it because that is what a download dialog shows.
 */

export const BYTES_PER_MB = 1e6;
export const BITS_PER_BYTE = 8;

/** Median of a numeric array (mean of the two middle values when even). */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * @param {Array<{bytes:number,totalMs:number,ttfbMs:number}>} samples successful requests only
 * @param {number} failedCount requests that threw
 */
export function summarize(samples, failedCount = 0) {
  const base = {
    successCount: samples.length,
    failedCount,
    totalBytes: 0,
    totalMs: 0,
    avgMs: null,
    minMs: null,
    maxMs: null,
    medianMs: null,
    avgTtfbMs: null,
    avgBytes: null,
    megabitsPerSecond: null,
    megabytesPerSecond: null,
  };
  if (samples.length === 0) return base;

  const durations = samples.map((s) => s.totalMs);
  const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  const totalMs = durations.reduce((sum, ms) => sum + ms, 0);

  // Throughput is total bytes over total time, not the mean of per-request
  // speeds: averaging ratios would over-weight small or fast responses.
  // A zero/sub-nanosecond total (an empty body, say) has no defined speed,
  // so we report null instead of Infinity.
  const seconds = totalMs / 1000;
  const megabytesPerSecond = seconds > 0 ? totalBytes / BYTES_PER_MB / seconds : null;

  return {
    ...base,
    totalBytes,
    totalMs,
    avgMs: totalMs / samples.length,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    medianMs: median(durations),
    avgTtfbMs: samples.reduce((sum, s) => sum + s.ttfbMs, 0) / samples.length,
    avgBytes: totalBytes / samples.length,
    megabytesPerSecond,
    megabitsPerSecond: megabytesPerSecond === null ? null : megabytesPerSecond * BITS_PER_BYTE,
  };
}

/** Decimal SI byte sizes: 1 MB = 1e6 B, matching the Mbit/s convention. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

export function formatSpeed(megabitsPerSecond) {
  if (megabitsPerSecond === null || !Number.isFinite(megabitsPerSecond)) return 'n/a';
  const megabytesPerSecond = megabitsPerSecond / BITS_PER_BYTE;
  return `${megabitsPerSecond.toFixed(2)} Mbit/s (${megabytesPerSecond.toFixed(2)} MB/s)`;
}

/** Instant speed of a single request, used for the per-request progress line. */
export function speedOf({ bytes, totalMs }) {
  if (!(totalMs > 0)) return null;
  return (bytes * BITS_PER_BYTE) / BYTES_PER_MB / (totalMs / 1000);
}
