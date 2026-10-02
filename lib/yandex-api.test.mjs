/**
 * Unit tests for the Yandex wire-contract helpers in lib/yandex-api.mjs.
 * Run with `node --test lib/yandex-api.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QUERY_TEXT_MAX_LENGTH,
  normalizeQueryText,
  search,
  YandexApiError,
  YANDEX_SEARCH_ASYNC_URL,
  YANDEX_OPERATIONS_URL,
} from './yandex-api.mjs'

test('normalizeQueryText keeps short and exactly-max queries as-is', () => {
  assert.equal(normalizeQueryText('short query'), 'short query')
  const exact = 'x'.repeat(QUERY_TEXT_MAX_LENGTH)
  assert.equal(normalizeQueryText(exact), exact)
})

test('normalizeQueryText clamps queries longer than 400 characters', () => {
  const long = 'y'.repeat(QUERY_TEXT_MAX_LENGTH + 50)
  const cut = normalizeQueryText(long)
  assert.equal(Array.from(cut).length, QUERY_TEXT_MAX_LENGTH)
  assert.equal(cut, 'y'.repeat(QUERY_TEXT_MAX_LENGTH))
})

test('normalizeQueryText trims trailing whitespace left by the cut', () => {
  const long = 'z'.repeat(QUERY_TEXT_MAX_LENGTH) + ' tail'
  assert.equal(normalizeQueryText(long), 'z'.repeat(QUERY_TEXT_MAX_LENGTH))
})

test('normalizeQueryText never splits a surrogate pair (emoji at the boundary)', () => {
  // 399 ASCII chars + an emoji (one code point, two UTF-16 units)
  const query = 'a'.repeat(QUERY_TEXT_MAX_LENGTH - 1) + '😀'
  const cut = normalizeQueryText(query)
  assert.equal(Array.from(cut).length, QUERY_TEXT_MAX_LENGTH)
  assert.equal(cut.charCodeAt(cut.length - 1) <= 0xffff, true)
  assert.doesNotThrow(() => {
    // slicing by UTF-16 units would end with a lone high surrogate; joining a
    // lone surrogate is not a throw, so assert we kept the full emoji instead
    assert.equal(cut.endsWith('😀'), true)
  })
})

test('normalizeQueryText coerces non-string input defensively', () => {
  assert.equal(normalizeQueryText(undefined), '')
  assert.equal(normalizeQueryText(null), '')
  assert.equal(normalizeQueryText(123), '123')
})

// ── helpers for the deferred (searchAsync → operation poll) flow ─────────────

/**
 * Minimal Yandex config so search() reaches the fetch layer. Poll timing is
 * overridden to millisecond values so tests never wait on the production
 * 300/500ms cadence or the 20s timeout budget.
 */
function searchConfig(overrides = {}) {
  return {
    yandexApiKey: 'k',
    yandexFolderId: 'f',
    yandexSearchApiUrl: 'https://search.example/v2/web/searchAsync',
    yandexSearchType: 'SEARCH_TYPE_COM',
    yandexL10n: 'LOCALIZATION_COM',
    maxResults: 10,
    pollFirstDelayMs: 1,
    pollIntervalMs: 1,
    pollTimeoutMs: 2000,
    ...overrides,
  }
}

/** Response-like object for the fetch stubs. */
function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** A single<doc> XML payload the parser is expected to turn into one source. */
const DOC_XML = '<yandexsearch>'
  + '<doc><url>https://a.example</url><title>A title</title>'
  + '<passages><passage>snippet text</passage></passages></doc>'
  + '</yandexsearch>'

const ONE_SOURCE = [{ url: 'https://a.example', title: 'A title', snippet: 'snippet text' }]

/** Fetch stub for the happy deferred flow: first POST is submit, then GET polls. */
function deferredStub({ poll = () => jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } }) } = {}) {
  return async (url, init) => {
    if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
    return poll(url, init)
  }
}

// ── deferred flow: submit + poll parsing ─────────────────────────────────────

test('search() submits to searchAsync then polls the operation and parses rawData', async () => {
  const config = searchConfig()
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-123', done: false })
      return jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } })
    }

    const sources = await search({ query: 'q', config })
    assert.deepEqual(sources, ONE_SOURCE)

    assert.equal(calls.length, 2)
    const [submit, poll] = calls

    // Phase 1: POST the same body shape as the sync endpoint, to searchAsync.
    assert.equal(submit.url, config.yandexSearchApiUrl)
    assert.equal(submit.init.method, 'POST')
    assert.equal(submit.init.headers.authorization, 'Api-Key k')
    const body = JSON.parse(submit.init.body)
    assert.equal(body.query.queryText, 'q')
    assert.equal(body.query.searchType, 'SEARCH_TYPE_COM')
    assert.equal(body.groupSpec.groupsOnPage, String(config.maxResults))
    assert.equal(body.responseFormat, 'FORMAT_XML')

    // Phase 2: GET the operation status with the same Api-Key.
    assert.equal(poll.url, `${YANDEX_OPERATIONS_URL}op-123`)
    assert.equal(poll.init.method, 'GET')
    assert.equal(poll.init.headers.authorization, 'Api-Key k')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() falls back to the canonical searchAsync endpoint when config has no URL', async () => {
  const originalFetch = globalThis.fetch
  const urls = []
  try {
    globalThis.fetch = async (url, init) => {
      urls.push(url)
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
      return jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } })
    }
    const config = searchConfig()
    delete config.yandexSearchApiUrl
    await search({ query: 'q', config })
    assert.equal(urls[0], YANDEX_SEARCH_ASYNC_URL)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── polling behavior ─────────────────────────────────────────────────────────

test('search() retries the operation poll on transient 429/5xx statuses', async () => {
  const statuses = [429, 503, 200]
  let pollCount = 0
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
      pollCount += 1
      if (pollCount <= 2) return jsonResponse(statuses[pollCount - 1], { message: `status ${statuses[pollCount - 1]}` })
      return jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } })
    }

    const sources = await search({ query: 'q', config: searchConfig() })
    assert.equal(pollCount, 3, 'two transient statuses must be retried before success')
    assert.deepEqual(sources, ONE_SOURCE)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() surfaces a terminal 4xx operation poll error with its status', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
      return jsonResponse(403, { message: 'PermissionDenied' })
    }
    await assert.rejects(
      search({ query: 'q', config: searchConfig() }),
      (error) => error instanceof YandexApiError
        && error.status === 403
        && /PermissionDenied/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() fails with a timeout when the operation never finishes', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
      return jsonResponse(200, { done: false })
    }
    await assert.rejects(
      search({ query: 'q', config: searchConfig({ pollTimeoutMs: 50 }) }),
      (error) => error instanceof YandexApiError && /did not finish within 50ms/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() aborts promptly during polling instead of hanging', async () => {
  const controller = new AbortController()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return jsonResponse(200, { id: 'op-1', done: false })
      return jsonResponse(200, { done: false })
    }
    // A long poll interval keeps the flow sitting in an abortable wait; the
    // abort must reject straight away rather than waiting it out.
    const config = searchConfig({ pollIntervalMs: 60000, pollTimeoutMs: 120000 })
    const promise = search({ query: 'q', config, signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 25)
    await assert.rejects(promise, (error) => error.name === 'AbortError')
    clearTimeout(timer)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── operation and payload error handling ─────────────────────────────────────

test('search() fails with a clear error when the submit response has no operation id', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => jsonResponse(200, { done: false })
    await assert.rejects(
      search({ query: 'q', config: searchConfig() }),
      (error) => error instanceof YandexApiError && /no operation id/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() surfaces a failed operation with its error message', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = deferredStub({
      poll: () => jsonResponse(200, { done: true, error: { code: 3, message: 'invalid argument' } }),
    })
    await assert.rejects(
      search({ query: 'q', config: searchConfig() }),
      (error) => error instanceof YandexApiError
        && error.status === 3
        && /operation failed: invalid argument/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() returns an empty list when the XML carries <error code="15">', async () => {
  const noResultsXml = '<yandexsearch><error code="15">комбинация слов нигде не встречается</error></yandexsearch>'
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = deferredStub({
      poll: () => jsonResponse(200, { done: true, response: { rawData: base64(noResultsXml) } }),
    })
    const sources = await search({ query: 'q', config: searchConfig() })
    assert.deepEqual(sources, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('search() surfaces Yandex XML errors other than code 15', async () => {
  const errorXml = '<yandexsearch><error code="503">backend unavailable</error></yandexsearch>'
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = deferredStub({
      poll: () => jsonResponse(200, { done: true, response: { rawData: base64(errorXml) } }),
    })
    await assert.rejects(
      search({ query: 'q', config: searchConfig() }),
      (error) => error instanceof YandexApiError
        && /code 503/.test(error.message)
        && /backend unavailable/.test(error.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── truncation logging (happens on submit, before any polling) ───────────────

test('search() warns and sends a 400-char queryText when the query is too long', async () => {
  const warnings = []
  let sentBody = null
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') {
        sentBody = JSON.parse(init.body)
        return jsonResponse(200, { id: 'op-1', done: false })
      }
      return jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } })
    }
    console.warn = (message) => { warnings.push(message) }

    const sources = await search({ query: 'a'.repeat(500), config: searchConfig() })
    assert.deepEqual(sources, ONE_SOURCE)
    assert.equal(sentBody.query.queryText.length, QUERY_TEXT_MAX_LENGTH)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /truncated to 400 characters/)
    assert.match(warnings[0], /input 500/)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test('search() stays silent and sends the query verbatim when it is short', async () => {
  const warnings = []
  let sentBody = null
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  try {
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') {
        sentBody = JSON.parse(init.body)
        return jsonResponse(200, { id: 'op-1', done: false })
      }
      return jsonResponse(200, { done: true, response: { rawData: base64(DOC_XML) } })
    }
    console.warn = (message) => { warnings.push(message) }

    await search({ query: 'q', config: searchConfig() })
    assert.equal(sentBody.query.queryText, 'q')
    assert.equal(warnings.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})
