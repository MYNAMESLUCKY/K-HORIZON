// Live smoke test for the new fetch_webpage pipeline.
// Spins up a local HTTP server with a sample HTML page (links, code, tables,
// header/nav/footer) and exercises the actual `ToolManager` code path.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'http';
import { ToolManager } from '../tool-manager';

const sampleHtml = `<!doctype html>
<html lang="en">
<head><title>Smoke Test Page</title></head>
<body>
  <header>
    <nav>
      <a href="/home">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Welcome to the smoke test</h1>
    <p>This page exercises <a href="https://example.com/cheerio">the cheerio parser</a> and verifies that links survive.</p>
    <p>Inline code looks like this: <code>npm install cheerio</code>.</p>
    <pre><code class="language-ts">import * as cheerio from 'cheerio';
const $ = cheerio.load(html);</code></pre>
    <table>
      <tr><th>Feature</th><th>Status</th></tr>
      <tr><td>Links</td><td>preserved</td></tr>
      <tr><td>Tables</td><td>preserved</td></tr>
    </table>
    <p><img alt="cheerio logo" src="/img/cheerio.png"/></p>
  </main>
  <footer>copyright 2026</footer>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/sample.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(sampleHtml);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetch_webpage live smoke', () => {
  it('returns parsed markdown with links, code, tables, images', async () => {
    const result = await ToolManager.execute('fetch_webpage', { url: `${baseUrl}/sample.html` });

    // Links preserved
    expect(result).toContain('[the cheerio parser](https://example.com/cheerio)');
    // Inline code preserved
    expect(result).toContain('`npm install cheerio`');
    // Fenced code block with language tag
    expect(result).toContain('```ts');
    expect(result).toContain("import * as cheerio");
    expect(result).toContain('```');
    // Tables converted to pipe markdown
    expect(result).toContain('| Feature | Status |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| Links | preserved |');
    // Images preserved as ![alt](src)
    expect(result).toContain('![cheerio logo](/img/cheerio.png)');
    // Header/footer stripped because <main> exists
    expect(result).not.toContain('copyright 2026');
    expect(result).not.toContain('/home');
  }, 20000);

  it('rejects non-HTML content-type with a clean error', async () => {
    const orig = global.fetch;
    global.fetch = (async () =>
      new Response('binary data', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;
    try {
      const result = await ToolManager.execute('fetch_webpage', { url: 'http://example.com/file.pdf' });
      expect(result).toContain('fetch_webpage only supports HTML pages');
      expect(result).toContain('application/pdf');
    } finally {
      global.fetch = orig;
    }
  });
});