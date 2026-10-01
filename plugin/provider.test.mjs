/**
 * Tests for the native Yandex search provider (Variant B).
 * Run with `node --test test.mjs plugin/provider.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { YandexSearchProvider, YANDEX_PROVIDER_ID, WEB_PROVIDER_ERROR } from './provider.mjs'
import { resolveOptions, apply } from './index.mjs'
import { YandexApiError } from './lib/yandex-api.mjs'

function providerConfig(overrides = {}) {
  return {
    apiKey: 'test-key',
    folderId: 'test-folder',
    maxResults: 10,
    ...overrides,
  }
}

/** Build a thunk returning fully resolved options (as apply() wires it). */
function providerOptions(config) {
  return () => resolveOptions(config)
}

function cannedSources(query) {
  return [
    { url: 'https://a.example', title: `A for ${query}`, snippet: 'snippet a' },
    { url: 'https://b.example', title: 'B' },
  ]
}

/** Fake backend capturing the request and returning canned sources. */
function fakeBackend(impl) {
  const calls = []
  const runSearch = async (opts) => {
    calls.push(opts)
    return impl(opts)
  }
  return { runSearch, calls }
}

// ── options resolution ───────────────────────────────────────────────────────

test('resolveOptions falls back to defaults with no config', () => {
  const options = resolveOptions({})
  assert.equal(options.yandexApiKey, '')
  assert.equal(options.yandexFolderId, '')
  assert.equal(options.yandexSearchApiUrl, 'https://searchapi.api.cloud.yandex.net/v2/web/search')
  assert.equal(options.yandexSearchType, 'SEARCH_TYPE_RU')
  assert.equal(options.yandexL10n, 'LOCALIZATION_RU')
  assert.equal(options.maxResults, 10)
})

test('resolveOptions prefers literal config over environment', () => {
  process.env.YANDEX_API_KEY = 'env-key'
  process.env.YANDEX_FOLDER_ID = 'env-folder'
  try {
    const options = resolveOptions({ apiKey: 'lit-key', folderId: 'lit-folder', baseURL: 'http://x', maxResults: 3 })
    assert.equal(options.yandexApiKey, 'lit-key')
    assert.equal(options.yandexFolderId, 'lit-folder')
    assert.equal(options.yandexSearchApiUrl, 'http://x')
    assert.equal(options.maxResults, 3)
  } finally {
    delete process.env.YANDEX_API_KEY
    delete process.env.YANDEX_FOLDER_ID
  }
})

test('resolveOptions reads apiKeyEnv/folderIdEnv names from the environment', () => {
  process.env.MY_YANDEX_KEY = 'k'
  process.env.MY_YANDEX_FOLDER = 'f'
  try {
    const options = resolveOptions({ apiKeyEnv: 'MY_YANDEX_KEY', folderIdEnv: 'MY_YANDEX_FOLDER' })
    assert.equal(options.yandexApiKey, 'k')
    assert.equal(options.yandexFolderId, 'f')
  } finally {
    delete process.env.MY_YANDEX_KEY
    delete process.env.MY_YANDEX_FOLDER
  }
})

// ── availability ─────────────────────────────────────────────────────────────

test('provider id is stable', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).id, YANDEX_PROVIDER_ID)
})

test('available() requires key, folder id and a parseable URL', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).available(), true)
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig({ apiKey: '' }))).available(), false)
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig({ folderId: '' }))).available(), false)
})

test('resolveOptions normalizes invalid maxResults to the default', () => {
  assert.equal(resolveOptions(providerConfig({ maxResults: 0 })).maxResults, 10)
  assert.equal(resolveOptions(providerConfig({ maxResults: 3 })).maxResults, 3)
})

// ── search normalization ─────────────────────────────────────────────────────

test('search() normalizes sources into the seam result shape', async () => {
  const backend = fakeBackend(() => cannedSources('q'))
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch)

  const result = await provider.search({ query: 'q', maxResults: 8 })
  assert.deepEqual(result, { sources: cannedSources('q'), truncated: false })
  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].query, 'q')
})

test('search() applies the request maxResults bound at the backend layer', async () => {
  const backend = fakeBackend((opts) => {
    assert.equal(opts.config.maxResults, 3, 'request bound must win over the options default')
    return cannedSources('q')
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig({ maxResults: 10 })), backend.runSearch)
  await provider.search({ query: 'q', maxResults: 3 })
})

test('search() falls back to the options maxResults when the request has none', async () => {
  const backend = fakeBackend((opts) => {
    assert.equal(opts.config.maxResults, 10)
    return {}
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig({ maxResults: 10 })), backend.runSearch)
  await provider.search({ query: 'q' })
})

test('search() yields empty sources without error when the backend has none', async () => {
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), fakeBackend(() => []).runSearch)
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(result.sources, [])
})

// ── error mapping ────────────────────────────────────────────────────────────

test('search() maps YandexApiError to a WEB_PROVIDER_ERROR with context', async () => {
  const backend = fakeBackend(() => {
    throw new YandexApiError('HTTP 403: PermissionDenied', { status: 403 })
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch)

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error instanceof Error
      && error.code === WEB_PROVIDER_ERROR
      && /PermissionDenied/.test(error.message)
      && /Yandex web search failed/.test(error.message),
  )
})

test('search() surfaces aborted signals as WEB_ABORTED', async () => {
  const controller = new AbortController()
  const backend = fakeBackend(() => {
    controller.abort()
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch)

  await assert.rejects(
    provider.search({ query: 'q' }, controller.signal),
    (error) => error.code === 'WEB_ABORTED',
  )
})

// ── registration contract ────────────────────────────────────────────────────

test('apply() registers the provider into a ctx.web-shaped service', () => {
  const registered = []
  const ctx = { web: { registerSearchProvider: (provider) => { registered.push(provider) } } }
  apply(ctx, providerConfig())
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, YANDEX_PROVIDER_ID)
  assert.equal(registered[0].available(), true)
})

// ── vendored client sync ─────────────────────────────────────────────────────

test('plugin/lib stays byte-identical to the standalone lib/', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of ['yandex-api.mjs', 'xml.mjs']) {
    const source = readFileSync(join(root, 'lib', file), 'utf8')
    const vendored = readFileSync(join(root, 'plugin', 'lib', file), 'utf8')
    assert.equal(vendored, source, `${file} must match lib/${file} — re-copy after editing the client`)
  }
})
