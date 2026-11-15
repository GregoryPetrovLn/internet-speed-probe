import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  median,
  speedOf,
  summarize,
} from '../src/stats.js';

const sample = (bytes, totalMs, ttfbMs = totalMs / 2) => ({ bytes, totalMs, ttfbMs });

describe('summarize — arithmetic', () => {
  it('computes a known case exactly', () => {
    // 1 MB in 1 s => 1 MB/s => 8 Mbit/s. Two such requests must stay 8 Mbit/s.
    const s = summarize([sample(1e6, 1000), sample(1e6, 1000)]);
    assert.equal(s.successCount, 2);
    assert.equal(s.totalBytes, 2e6);
    assert.equal(s.totalMs, 2000);
    assert.equal(s.avgMs, 1000);
    assert.equal(s.megabytesPerSecond, 1);
    assert.equal(s.megabitsPerSecond, 8);
  });

  it('weights by bytes, not by request (total bytes / total time)', () => {
    // 1 B in 1 ms (1 kB/s) + 10 MB in 1 s. The mean of the two per-request
    // speeds would be ~5 MB/s; the honest throughput is 10e6/1.001 s.
    const s = summarize([sample(1, 1), sample(10e6, 1000)]);
    const expected = 10_000_001 / 1e6 / (1001 / 1000);
    assert.ok(Math.abs(s.megabytesPerSecond - expected) < 1e-9);
    assert.ok(s.megabytesPerSecond > 9.9 && s.megabytesPerSecond < 10.1);
  });

  it('reports median, min and max of request durations', () => {
    const s = summarize([sample(10, 50), sample(10, 10), sample(10, 30)]);
    assert.equal(s.minMs, 10);
    assert.equal(s.maxMs, 50);
    assert.equal(s.medianMs, 30);
  });

  it('averages TTFB independently of total time', () => {
    const s = summarize([sample(10, 100, 10), sample(10, 100, 30)]);
    assert.equal(s.avgTtfbMs, 20);
  });

  it('counts failures without letting them affect the averages', () => {
    const s = summarize([sample(1e6, 1000)], 9);
    assert.equal(s.successCount, 1);
    assert.equal(s.failedCount, 9);
    assert.equal(s.megabitsPerSecond, 8);
  });
});

describe('summarize — degenerate input', () => {
  it('survives zero successful samples', () => {
    const s = summarize([], 10);
    assert.equal(s.successCount, 0);
    assert.equal(s.failedCount, 10);
    assert.equal(s.totalBytes, 0);
    assert.equal(s.megabitsPerSecond, null, 'no samples means no speed, not NaN');
    assert.equal(s.avgMs, null);
    assert.equal(s.medianMs, null);
  });

  it('returns null instead of Infinity when total time is zero', () => {
    const s = summarize([sample(1000, 0)]);
    assert.equal(s.megabitsPerSecond, null);
    assert.equal(s.megabytesPerSecond, null);
    assert.equal(s.avgMs, 0);
  });

  it('handles an empty body (0 bytes) as 0 speed, not NaN', () => {
    const s = summarize([sample(0, 100)]);
    assert.equal(s.totalBytes, 0);
    assert.equal(s.megabitsPerSecond, 0);
  });

  it('does not blow the stack on many samples (Math.min spread limit)', () => {
    // Math.min(...durations) throws RangeError beyond ~100k arguments; a user
    // passing -n 200000 must still get a report.
    const many = Array.from({ length: 200_000 }, (_, i) => sample(1000, (i % 50) + 1));
    const s = summarize(many);
    assert.equal(s.successCount, 200_000);
    assert.equal(s.minMs, 1);
    assert.equal(s.maxMs, 50);
  });
});

describe('median', () => {
  it('averages the two middle values for even counts', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
  it('returns null for an empty array', () => {
    assert.equal(median([]), null);
  });
});

describe('formatting', () => {
  it('uses decimal SI byte units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1000), '1.00 kB');
    assert.equal(formatBytes(1_500_000), '1.50 MB');
    assert.equal(formatBytes(2.5e9), '2.50 GB');
  });

  it('switches from ms to s at one second', () => {
    assert.equal(formatDuration(999), '999 ms');
    assert.equal(formatDuration(1000), '1.00 s');
    assert.equal(formatDuration(null), 'n/a');
  });

  it('prints both Mbit/s and MB/s, with the factor of 8 between them', () => {
    assert.equal(formatSpeed(8), '8.00 Mbit/s (1.00 MB/s)');
    assert.equal(formatSpeed(null), 'n/a');
    assert.equal(formatSpeed(Infinity), 'n/a');
  });

  it('speedOf returns null for a zero duration', () => {
    assert.equal(speedOf({ bytes: 100, totalMs: 0 }), null);
    assert.equal(speedOf({ bytes: 1e6, totalMs: 1000 }), 8);
  });
});
