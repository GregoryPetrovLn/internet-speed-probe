#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { parseArgs, USAGE } from './src/args.js';
import { createAgent, downloadOnce } from './src/download.js';
import { UsageError } from './src/errors.js';
import { formatBytes, formatDuration, formatSpeed, speedOf, summarize } from './src/stats.js';

/**
 * Runs the N sequential measurements.
 *
 * Strictly sequential (plain await in a for-loop, never Promise.all): parallel
 * requests would share the same link and each would report a fraction of the
 * real speed. A failing request does not abort the run — we keep the remaining
 * attempts and report how many succeeded.
 *
 * @param {object} options parsed CLI options
 * @param {(event:object)=>void} [onProgress] called after every attempt
 */
export async function runProbe(options, onProgress = () => {}) {
  const agent = createAgent(options.url, { keepAlive: options.keepAlive });
  const samples = [];
  const failures = [];

  try {
    for (let i = 1; i <= options.requests; i += 1) {
      try {
        const sample = await downloadOnce(options.url, {
          timeoutMs: options.timeoutMs,
          maxRedirects: options.maxRedirects,
          cacheBust: options.cacheBust,
          agent,
        });
        samples.push(sample);
        onProgress({ index: i, total: options.requests, ok: true, sample });
      } catch (error) {
        failures.push({ index: i, error });
        onProgress({ index: i, total: options.requests, ok: false, error });
      }
    }
  } finally {
    // With keepAlive the agent holds an idle socket open, which would keep the
    // process from exiting.
    agent.destroy?.();
  }

  return { summary: summarize(samples, failures.length), samples, failures };
}

function printProgress(event) {
  const prefix = `[${String(event.index).padStart(String(event.total).length)}/${event.total}]`;
  if (!event.ok) {
    console.log(`${prefix} failed: ${event.error.message}`);
    return;
  }
  const { sample } = event;
  console.log(
    `${prefix} ${formatBytes(sample.bytes).padStart(9)} in ${formatDuration(sample.totalMs).padStart(8)}` +
      `  ->  ${formatSpeed(speedOf(sample))}`,
  );
}

function printReport(options, { summary, samples, failures }) {
  const first = samples[0];
  console.log('');
  console.log('Results');
  console.log(`  successful requests  ${summary.successCount} of ${options.requests}`);
  if (summary.failedCount > 0) {
    console.log(`  failed requests      ${summary.failedCount}`);
    // Group identical messages so 10 identical DNS errors are one line.
    const grouped = new Map();
    for (const { error } of failures) {
      grouped.set(error.message, (grouped.get(error.message) ?? 0) + 1);
    }
    for (const [message, count] of grouped) {
      console.log(`    ${count}x ${message}`);
    }
  }
  if (summary.successCount === 0) {
    console.log('\nNo successful request, nothing to measure.');
    return;
  }
  console.log(`  total downloaded     ${formatBytes(summary.totalBytes)} (${summary.totalBytes} bytes)`);
  console.log(`  per request          ${formatBytes(summary.avgBytes)}`);
  console.log(`  total time           ${formatDuration(summary.totalMs)}`);
  console.log('');
  console.log(`  average request      ${formatDuration(summary.avgMs)}`);
  console.log(`  median / min / max   ${formatDuration(summary.medianMs)} / ${formatDuration(summary.minMs)} / ${formatDuration(summary.maxMs)}`);
  console.log(`  average TTFB         ${formatDuration(summary.avgTtfbMs)}`);
  console.log('');
  console.log(`  download speed       ${formatSpeed(summary.megabitsPerSecond)}`);
  if (first?.redirects > 0) {
    console.log('');
    console.log(`  followed ${first.redirects} redirect(s), final URL: ${first.finalUrl}`);
  }
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!options.json) {
    console.log(`Target:   ${options.url.href}`);
    console.log(
      `Settings: ${options.requests} sequential requests, ${options.timeoutMs} ms timeout, ` +
        `cache-bust ${options.cacheBust ? 'on' : 'off'}, keep-alive ${options.keepAlive ? 'on' : 'off'}`,
    );
    console.log('');
  }

  const result = await runProbe(options, options.json ? () => {} : printProgress);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          url: options.url.href,
          requests: options.requests,
          ...result.summary,
          failures: result.failures.map((f) => ({ index: f.index, error: f.error.message })),
          samples: result.samples.map((s) => ({
            bytes: s.bytes,
            totalMs: s.totalMs,
            ttfbMs: s.ttfbMs,
            status: s.status,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printReport(options, result);
  }

  return result.summary.successCount === 0 ? 1 : 0;
}

// Only run when executed directly, so tests can import main() safely.
// pathToFileURL (not a hand-built `file://` + path) is required: a path with
// spaces or other reserved characters is percent-encoded in import.meta.url,
// and string concatenation would silently never match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Unexpected failure: ${error?.stack ?? error}`);
      process.exit(1);
    },
  );
}
