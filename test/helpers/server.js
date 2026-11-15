import http from 'node:http';
import net from 'node:net';

/**
 * Local HTTP fixture. Every route exists to pin down one behaviour of
 * downloadOnce(); `server.requests` records what the client actually sent so
 * tests can assert on headers and cache-busting query parameters.
 */
export async function startServer() {
  const requests = [];
  /** Sockets we deliberately leave hanging, so we can free them on close(). */
  const hangingSockets = new Set();
  /** How many requests the probe had open at the same time. Must stay 1. */
  const concurrency = { active: 0, max: 0 };
  /** Per-path hit counter, so /flaky can fail deterministically. */
  const hits = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    concurrency.active += 1;
    concurrency.max = Math.max(concurrency.max, concurrency.active);
    res.on('close', () => {
      concurrency.active -= 1;
    });
    const num = (name, fallback) => {
      const raw = url.searchParams.get(name);
      return raw === null ? fallback : Number(raw);
    };

    switch (url.pathname) {
      // Fixed-size body with a correct Content-Length.
      case '/bytes': {
        const size = num('size', 1024);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
        res.end(Buffer.alloc(size, 0x61));
        return;
      }
      // Chunked body, no Content-Length, optional delay before the first byte.
      case '/chunked': {
        const size = num('size', 1024);
        const chunks = num('chunks', 4);
        const delay = num('delay', 0);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const per = Math.floor(size / chunks);
        let sent = 0;
        let i = 0;
        const tick = () => {
          if (i === chunks - 1) {
            res.end(Buffer.alloc(size - sent, 0x62));
            return;
          }
          res.write(Buffer.alloc(per, 0x62));
          sent += per;
          i += 1;
          setTimeout(tick, delay);
        };
        setTimeout(tick, delay);
        return;
      }
      case '/empty':
        res.writeHead(200, { 'content-length': 0 });
        res.end();
        return;
      // Headers arrive only after `delay` ms: separates TTFB from body time.
      case '/slow-headers': {
        setTimeout(() => {
          res.writeHead(200, { 'content-length': 8 });
          res.end(Buffer.alloc(8, 0x63));
        }, num('delay', 100));
        return;
      }
      // Sends headers then never finishes: used to trigger the deadline.
      case '/never-ends': {
        hangingSockets.add(res.socket);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(16, 0x64));
        return;
      }
      case '/redirect': {
        const to = url.searchParams.get('to') ?? '/bytes?size=256';
        res.writeHead(num('code', 302), { location: to });
        res.end();
        return;
      }
      // /redirect-chain?n=3 -> /redirect-chain?n=2 -> ... -> /bytes
      case '/redirect-chain': {
        const n = num('n', 1);
        res.writeHead(302, {
          location: n <= 1 ? '/bytes?size=128' : `/redirect-chain?n=${n - 1}`,
        });
        res.end();
        return;
      }
      case '/redirect-loop':
        res.writeHead(302, { location: '/redirect-loop' });
        res.end();
        return;
      case '/redirect-no-location':
        res.writeHead(302);
        res.end();
        return;
      // Fails the first `fail` requests, then succeeds: lets a test assert a
      // partial run (e.g. "8 of 10 succeeded") without any timing luck.
      case '/flaky': {
        const failFirst = num('fail', 1);
        if (hits.get('/flaky') <= failFirst) {
          res.writeHead(500);
          res.end('flaky');
          return;
        }
        const size = num('size', 512);
        res.writeHead(200, { 'content-length': size });
        res.end(Buffer.alloc(size, 0x65));
        return;
      }
      case '/status':
        res.writeHead(num('code', 500));
        res.end('nope');
        return;
      // Raw socket write: announces more bytes than it sends, then hangs up.
      // Cannot be done through ServerResponse, which enforces Content-Length.
      case '/short-body': {
        const socket = res.socket;
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n' + 'x'.repeat(100),
        );
        socket.end();
        return;
      }
      default:
        res.writeHead(404);
        res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    requests,
    concurrency,
    url: (path) => new URL(path, `http://127.0.0.1:${port}`),
    async close() {
      for (const socket of hangingSockets) socket.destroy();
      hangingSockets.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A port that is guaranteed to have nothing listening, for ECONNREFUSED. */
export async function findClosedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
