/**
 * Unit + E2E tests for the Yandex web_search proxy.
 * Run with `node --test test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { loadConfig, effectiveBackend } from './lib/config.mjs'
import { extractQuery, buildResponse, MessagesRequestError } from './lib/messages.mjs'
import { parsePayload, parseDocsXml, YandexApiError } from './lib/yandex-api.mjs'
import { parseSerp, parseSerpItem, resolveYandexUrl, isCaptcha } from './lib/yandex-scrape.mjs'
import { decodeXmlEntities } from './lib/xml.mjs'
import { createProxyServer } from './server.mjs'

function baseConfig(overrides = {}) {
  return loadConfig({ YANDEX_BACKEND: 'mock', YANDEX_PROXY_PORT: '0', ...overrides })
}

// ── query extraction ─────────────────────────────────────────────────────────

test('extractQuery strips the DeepSeek harness query prefix', () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: deepseek harness' }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  }
  assert.equal(extractQuery(body), 'deepseek harness')
})

test('extractQuery accepts plain text content and string content', () => {
  assert.equal(extractQuery({ messages: [{ content: [{ type: 'text', text: ' hello world ' }] }] }), 'hello world')
  assert.equal(extractQuery({ messages: [{ content: 'just a string query' }] }), 'just a string query')
})

test('extractQuery rejects a body without messages or without any text', () => {
  assert.throws(() => extractQuery({}), MessagesRequestError)
  assert.throws(() => extractQuery({ messages: [{ content: [] }] }), MessagesRequestError)
})

// ── response building ────────────────────────────────────────────────────────

test('buildResponse always emits a web_search_tool_result block', () => {
  const response = buildResponse({ query: 'q', sources: [], model: 'deepseek-v4-flash' })

  const results = response.content.filter((block) => block.type === 'web_search_tool_result')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].content, [])
  assert.equal(response.model, 'deepseek-v4-flash')
})

test('buildResponse maps sources into result items and citation snippets', () => {
  const sources = [
    { url: 'https://a.example', title: 'A', snippet: 'snippet A', publishedAt: '2026-09-01' },
    { url: 'https://b.example', title: 'B' },
  ]
  const response = buildResponse({ query: 'q', sources })

  const results = response.content.find((block) => block.type === 'web_search_tool_result')
  assert.deepEqual(results.content, [
    { type: 'web_search_result', url: 'https://a.example', title: 'A', page_age: '2026-09-01' },
    { type: 'web_search_result', url: 'https://b.example', title: 'B' },
  ])

  const textBlocks = response.content.filter((block) => block.type === 'text')
  assert.equal(textBlocks.length, 1)
  assert.deepEqual(textBlocks[0].citations, [
    { type: 'char_location', url: 'https://a.example', cited_text: 'snippet A' },
  ])
})

// ── Yandex Cloud XML parsing ─────────────────────────────────────────────────

const YANDEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<yandexsearch version="1.0">
  <response>
    <found-docs priority="all">123</found-docs>
    <results>
      <group>
        <doc>
          <url>https://example.com/a?x=1&amp;y=2</url>
          <title><hlword>Title</hlword> &lt;A&gt;</title>
          <passages>
            <passage>First <hlword>passage</hlword> text.</passage>
            <passage>Second passage.</passage>
          </passages>
        </doc>
        <doc>
          <url>https://example.org/b</url>
          <title>Title B</title>
          <passages/>
        </doc>
      </group>
    </results>
  </response>
</yandexsearch>`

test('parseDocsXml extracts url/title/passages, decodes entities and strips hlword tags', () => {
  const sources = parseDocsXml(YANDEX_XML, 10)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://example.com/a?x=1&y=2')
  assert.equal(sources[0].title, 'Title <A>')
  assert.equal(sources[0].snippet, 'First passage text. Second passage.')
  assert.equal(sources[1].snippet, undefined)
})

test('decodeXmlEntities does not throw on invalid or surrogate code points', () => {
  assert.equal(decodeXmlEntities('&#x110000;'), '&#x110000;')
  assert.equal(decodeXmlEntities('&#0;'), '&#0;')
  assert.equal(decodeXmlEntities('&#x800;'), '\u0800') // valid ref decodes
  assert.match(decodeXmlEntities('ok &#xD800; done'), /&#xD800;/)
  assert.equal(decodeXmlEntities('a &amp; b &lt; c'), 'a & b < c')
})

test('parsePayload decodes base64 rawData into sources', () => {
  const payload = { rawData: Buffer.from(YANDEX_XML, 'utf8').toString('base64') }
  const sources = parsePayload(payload, 10)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://example.com/a?x=1&y=2')
})

test('parsePayload surfaces Yandex error envelopes', () => {
  assert.throws(() => parsePayload({ error: { message: 'permission denied' } }, 10), /permission denied/)
  assert.throws(() => parsePayload({ message: 'boom' }, 10), /boom/)
})

test('parsePayload rejects rawData that is not valid base64', () => {
  const isBase64Error = (error) => error instanceof YandexApiError && /not valid base64/.test(error.message)
  assert.throws(() => parsePayload({ rawData: 'definitely not base64!!' }, 10), isBase64Error)
  assert.throws(() => parsePayload({ rawData: '' }, 10), isBase64Error)
})

// ── Yandex SERP scraping parsing ─────────────────────────────────────────────

const SERP_HTML = `<html><body>
  <ul class="serp-list">
    <li class="serp-item">
      <h2 class="OrganicTitle"><a class="Link OrganicTitle-Link" href="https://yandex.ru/search/?rredir=1&amp;url=https%3A%2F%2Fsite.example%2Fpage">Result One</a></h2>
      <span class="OrganicTextContentSpan">Some snippet text.</span>
    </li>
    <li class="serp-item">
      <h2><a href="https://other.example/direct">Result Two</a></h2>
    </li>
  </ul>
</body></html>`

test('parseSerp extracts organic results and unwraps redirect URLs', () => {
  const sources = parseSerp(SERP_HTML, 10)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://site.example/page')
  assert.equal(sources[0].title, 'Result One')
  assert.equal(sources[0].snippet, 'Some snippet text.')
  assert.equal(sources[1].url, 'https://other.example/direct')
})

test('parseSerpItem decodes title entities in a single pass (&amp;lt; stays &lt;)', () => {
  const parsed = parseSerpItem('<h2><a href="https://ex.com/p">Escaped &amp;lt;tag&amp;gt; &amp;#60; x</a></h2>')
  assert.equal(parsed.title, 'Escaped &lt;tag&gt; &#60; x')
})

test('parseSerpItem decodes href entities in a single pass (&amp;lt; stays &lt;)', () => {
  const parsed = parseSerpItem('<h2><a href="https://ex.com/?q=&amp;lt;">T</a></h2>')
  assert.equal(parsed.url, 'https://ex.com/?q=&lt;')
})

test('resolveYandexUrl decodes the url= wrapper and passes plain hrefs through', () => {
  assert.equal(resolveYandexUrl('https://yandex.com/search/?url=https%3A%2F%2Ftarget.example%2Fx'), 'https://target.example/x')
  assert.equal(resolveYandexUrl('https://plain.example/path'), 'https://plain.example/path')
})

test('resolveYandexUrl refuses unsafe (SSRF) unwrapped targets', () => {
  // Non-public schemes and private/loopback/link-local addresses must not
  // surface as result URLs; the wrapper target resolves to undefined.
  assert.equal(resolveYandexUrl('https://yandex.ru/search/?url=file%3A%2F%2F%2Fetc%2Fpasswd'), undefined)
  assert.equal(resolveYandexUrl('https://yandex.ru/search/?url=gopher%3A%2F%2Fexample.com'), undefined)
  assert.equal(resolveYandexUrl('https://yandex.com/search/?url=http%3A%2F%2F127.0.0.1%2Fadmin'), undefined)
  assert.equal(resolveYandexUrl('https://yandex.com/search/?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F'), undefined)
  assert.equal(resolveYandexUrl('https://yandex.ru/search/?url=http%3A%2F%2F10.0.0.1%2Fx'), undefined)
  assert.equal(resolveYandexUrl('https://yandex.ru/search/?url=http%3A%2F%2Flocalhost%2Fx'), undefined)
  // A safe public target still unwraps.
  assert.equal(resolveYandexUrl('https://yandex.ru/search/?url=https%3A%2F%2Fpub.example%2Fx'), 'https://pub.example/x')
  // Non-wrapper plain hrefs (even odd ones) pass through unchanged.
  assert.equal(resolveYandexUrl('file:///etc/passwd'), 'file:///etc/passwd')
})

test('parseSerpItem drops results whose yandex.net wrapper points to an unsafe target', () => {
  const parsed = parseSerpItem('<h2><a href="https://yandex.net/search/?url=http%3A%2F%2F192.168.1.1%2Frouter">Evil</a></h2>')
  assert.equal(parsed, undefined)
  const safe = parseSerpItem('<h2><a href="https://yandex.net/search/?url=https%3A%2F%2Fok.example%2Fx">Fine</a></h2>')
  assert.equal(safe.url, 'https://ok.example/x')
})

test('parseSerpItem skips internal Yandex links (incl. yandex.net)', () => {
  assert.equal(parseSerpItem('<h2><a href="https://yandex.ru/maps">Maps</a></h2>'), undefined)
  assert.equal(parseSerpItem('<h2><a href="https://yandex.net/support/x">Support</a></h2>'), undefined)
})

// ── captcha detection ────────────────────────────────────────────────────────

test('isCaptcha ignores the bare word "captcha" in ordinary organic results', () => {
  const html = `<html><body><ul class="serp-list"><li class="serp-item">
    <h2><a href="https://howto.example/captcha-guide">How to solve a captcha</a></h2>
    <span class="OrganicTextContentSpan">Captcha problems? Here is every captcha type explained.</span>
  </li></ul></body></html>`
  assert.equal(isCaptcha(html), false)
})

test('isCaptcha flags real Yandex interstitial pages', () => {
  assert.equal(isCaptcha('<html><body><div class="SmartCaptcha-widget"></div></body></html>'), true)
  assert.equal(isCaptcha('<html><body><form action="https://captcha.yandex.ru/check"></form></body></html>'), true)
  assert.equal(isCaptcha('<html><body>Подтвердите, что запросы отправляли вы</body></html>'), true)
  assert.equal(isCaptcha('<div class="CheckboxCaptcha"></div>'), true)
})

// ── config resolution ────────────────────────────────────────────────────────

test('effectiveBackend resolves auto to api with credentials and scrape without', () => {
  assert.equal(effectiveBackend(loadConfig({ YANDEX_BACKEND: 'auto' })), 'scrape')
  assert.equal(effectiveBackend(loadConfig({
    YANDEX_BACKEND: 'auto',
    YANDEX_API_KEY: 'k',
    YANDEX_FOLDER_ID: 'f',
  })), 'api')
})

test('loadConfig rejects an unknown YANDEX_BACKEND', () => {
  assert.throws(() => loadConfig({ YANDEX_BACKEND: 'bogus' }), /invalid YANDEX_BACKEND/)
})

// ── E2E over HTTP with the mock backend ──────────────────────────────────────

async function withServer(fn, overrides = {}) {
  const config = baseConfig(overrides)
  const server = createProxyServer(config)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('E2E: POST the exact harness request shape returns a usable response', async () => {
  await withServer(async (base) => {
    const request = {
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Perform a web search for the query: deepseek harness' }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ignored', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(request),
    })
    assert.equal(response.status, 200)

    const payload = await response.json()
    const results = payload.content.filter((block) => block.type === 'web_search_tool_result')
    assert.equal(results.length, 1)
    assert.ok(results[0].content.length > 0)
    assert.equal(results[0].content[0].type, 'web_search_result')
    assert.ok(results[0].content[0].url.startsWith('http'))

    // Snippets travel in a text block's citations (provider contract).
    const textBlocks = payload.content.filter((block) => block.type === 'text')
    assert.equal(textBlocks.length, 1)
    assert.ok(Array.isArray(textBlocks[0].citations) && textBlocks[0].citations.length > 0)
    const citation = textBlocks[0].citations[0]
    assert.equal(citation.type, 'char_location')
    assert.ok(typeof citation.url === 'string' && typeof citation.cited_text === 'string')
  })
})

test('E2E: /v1/messages and /messages aliases work; unknown path is 404', async () => {
  await withServer(async (base) => {
    const body = { messages: [{ content: 'round-trip query' }] }
    for (const path of ['/v1/messages', '/messages']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.content[0].type, 'web_search_tool_result')
    }
    const missing = await fetch(`${base}/nope`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 404)
  })
})

test('E2E: healthz reports backend and credential state', async () => {
  await withServer(async (base) => {
    const health = await (await fetch(`${base}/healthz`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.backend, 'mock')
    assert.equal(health.yandexApiCredentials, false)
  })
})

test('E2E: malformed JSON body maps to 400 with an Anthropic-style error', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.ok(payload.error.message.includes('valid JSON'))
  })
})

test('E2E: backend timeout maps to 504, not 502', async () => {
  const hanging = createServer(() => { /* never respond: hold the request open past the proxy timeout */ })
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ content: 'timeout probe query' }] }),
      })
      assert.equal(response.status, 504)
      const payload = await response.json()
      assert.ok(payload.error.message.includes('timed out'))
    }, {
      YANDEX_BACKEND: 'api',
      YANDEX_API_KEY: 'test-key',
      YANDEX_FOLDER_ID: 'test-folder',
      YANDEX_SEARCH_API_URL: `http://127.0.0.1:${hanging.address().port}/search`,
      YANDEX_REQUEST_TIMEOUT_MS: '100',
    })
  } finally {
    await new Promise((resolve) => hanging.close(resolve))
  }
})

test('E2E: oversized request body maps to a 400 JSON error, not a connection reset', async () => {
  await withServer(async (base) => {
    const body = JSON.stringify({ messages: [{ content: 'x'.repeat(4_096) }] })
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.ok(payload.error.message.includes('too large'))
  }, { YANDEX_MAX_REQUEST_BYTES: '1024' })
})

test('E2E: a client disconnect cancels the backend search and leaves the server healthy', async () => {
  let backendGotAbort = false
  const hanging = createServer((req, res) => {
    // Hold the upstream open; record when the proxy's controller lets it go.
    req.on('aborted', () => { backendGotAbort = true })
    res.on('close', () => { backendGotAbort = true })
  })
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve))
  try {
    await withServer(async (base) => {
      const controller = new AbortController()
      const request = fetch(`${base}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ content: 'abort probe query' }] }),
        signal: controller.signal,
      })
      // Abort the client request while the backend is still "running".
      await new Promise((resolve) => setTimeout(resolve, 50))
      controller.abort()
      await request.catch(() => { /* expected client-side abort */ })

      // Give the proxy a tick to observe the disconnect, then prove it is alive.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const health = await (await fetch(`${base}/healthz`)).json()
      assert.equal(health.ok, true)
    }, {
      YANDEX_BACKEND: 'api',
      YANDEX_API_KEY: 'test-key',
      YANDEX_FOLDER_ID: 'test-folder',
      YANDEX_SEARCH_API_URL: `http://127.0.0.1:${hanging.address().port}/search`,
      YANDEX_REQUEST_TIMEOUT_MS: '5000',
    })
  } finally {
    await new Promise((resolve) => hanging.close(resolve))
  }
  // The upstream hang was released because the proxy controller aborted it.
  assert.equal(backendGotAbort, true)
})
