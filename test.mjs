/**
 * Unit + E2E tests for the Yandex web_search proxy.
 * Run with `node --test test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from './lib/config.mjs'
import { extractQuery, buildResponse, MessagesRequestError } from './lib/messages.mjs'
import { parsePayload, parseDocsXml } from './lib/yandex-api.mjs'
import { parseSerp, parseSerpItem, resolveYandexUrl } from './lib/yandex-scrape.mjs'
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

test('parseSerpItem skips internal Yandex links', () => {
  const parsed = parseSerpItem(`<h2><a href="https://yandex.ru/maps">Maps</a></h2>`)
  assert.equal(parsed, undefined)
})

test('resolveYandexUrl decodes the url= wrapper and passes plain hrefs through', () => {
  assert.equal(resolveYandexUrl('https://yandex.com/search/?url=https%3A%2F%2Ftarget.example%2Fx'), 'https://target.example/x')
  assert.equal(resolveYandexUrl('https://plain.example/path'), 'https://plain.example/path')
})

// ── E2E over HTTP with the mock backend ──────────────────────────────────────

async function withServer(fn) {
  const config = baseConfig()
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
