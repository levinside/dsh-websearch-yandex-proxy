/**
 * Unit tests for the Yandex wire-contract helpers in lib/yandex-api.mjs.
 * Run with `node --test lib/yandex-api.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QUERY_TEXT_MAX_LENGTH, normalizeQueryText, search } from './yandex-api.mjs'

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

// ── truncation logging ───────────────────────────────────────────────────────

/** Minimal Yandex config so search() reaches the fetch call. */
function searchConfig() {
  return {
    yandexApiKey: 'k',
    yandexFolderId: 'f',
    yandexSearchApiUrl: 'https://search.example/v2/web/search',
    yandexSearchType: 'SEARCH_TYPE_COM',
    yandexL10n: 'LOCALIZATION_COM',
    maxResults: 10,
  }
}

test('search() warns and sends a 400-char queryText when the query is too long', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings = []
  let sentBody = null
  try {
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, json: async () => ({ documents: [] }) }
    }
    console.warn = (message) => { warnings.push(message) }

    const sources = await search({ query: 'a'.repeat(500), config: searchConfig() })
    assert.deepEqual(sources, [])
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
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings = []
  let sentBody = null
  try {
    globalThis.fetch = async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, json: async () => ({ documents: [] }) }
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
