/**
 * Tests for the native Yandex search provider plugin.
 * Run with `node --test provider.test.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  YandexSearchProvider,
  YANDEX_PROVIDER_ID,
  WEB_PROVIDER_ERROR,
  WEB_PROVIDER_CREDENTIAL_MISSING,
} from './provider.mjs'
import { resolveOptions, resolveCredentials, apply } from './index.mjs'
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

/** Resolver that always yields the test credentials (as the seam would). */
async function testCredentials() {
  return { yandexApiKey: 'test-key', yandexFolderId: 'test-folder' }
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
  assert.equal(options.yandexApiKeyEnv, 'YANDEX_API_KEY')
  assert.equal(options.yandexFolderId, '')
  assert.equal(options.yandexFolderIdEnv, 'YANDEX_FOLDER_ID')
  assert.equal(options.yandexSearchApiUrl, 'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync')
  assert.equal(options.yandexSearchType, 'SEARCH_TYPE_COM')
  assert.equal(options.yandexL10n, 'LOCALIZATION_COM')
  assert.equal(options.maxResults, 10)
})

test('resolveOptions carries literals and ref names, not secret values', () => {
  process.env.YANDEX_API_KEY = 'env-key'
  process.env.YANDEX_FOLDER_ID = 'env-folder'
  try {
    const options = resolveOptions({ apiKey: 'lit-key', folderId: 'lit-folder', baseURL: 'http://x', maxResults: 3 })
    assert.equal(options.yandexApiKey, 'lit-key')
    assert.equal(options.yandexFolderId, 'lit-folder')
    assert.equal(options.yandexApiKeyEnv, 'YANDEX_API_KEY')
    assert.equal(options.yandexFolderIdEnv, 'YANDEX_FOLDER_ID')
    assert.equal(options.yandexSearchApiUrl, 'http://x')
    assert.equal(options.maxResults, 3)
    // resolveOptions never consults the environment for secrets — that is
    // resolveCredentials' job.
    const bare = resolveOptions({})
    assert.equal(bare.yandexApiKey, '')
    assert.equal(bare.yandexFolderId, '')
  } finally {
    delete process.env.YANDEX_API_KEY
    delete process.env.YANDEX_FOLDER_ID
  }
})

test('resolveOptions reads apiKeyEnv/folderIdEnv names from the config', () => {
  process.env.MY_YANDEX_KEY = 'k'
  process.env.MY_YANDEX_FOLDER = 'f'
  try {
    const options = resolveOptions({ apiKeyEnv: 'MY_YANDEX_KEY', folderIdEnv: 'MY_YANDEX_FOLDER' })
    assert.equal(options.yandexApiKey, '')
    assert.equal(options.yandexApiKeyEnv, 'MY_YANDEX_KEY')
    assert.equal(options.yandexFolderId, '')
    assert.equal(options.yandexFolderIdEnv, 'MY_YANDEX_FOLDER')
  } finally {
    delete process.env.MY_YANDEX_KEY
    delete process.env.MY_YANDEX_FOLDER
  }
})

test('resolveOptions normalizes invalid maxResults to the default', () => {
  assert.equal(resolveOptions(providerConfig({ maxResults: 0 })).maxResults, 10)
  assert.equal(resolveOptions(providerConfig({ maxResults: 3 })).maxResults, 3)
  assert.equal(resolveOptions(providerConfig({ maxResults: '7' })).maxResults, 10)
})

// ── credential resolution ────────────────────────────────────────────────────

test('resolveCredentials prefers literal config over the seam and env', async () => {
  const ctx = {
    get: (name) => name === 'credentials'
      ? { resolve: async (ref) => ({ value: `seam-${ref}` }) }
      : undefined,
  }
  const resolved = await resolveCredentials(ctx, {
    apiKey: 'lit-key',
    folderId: 'lit-folder',
  })
  assert.equal(resolved.yandexApiKey, 'lit-key')
  assert.equal(resolved.yandexFolderId, 'lit-folder')
})

test('resolveCredentials uses the ctx.credentials seam when present', async () => {
  const ctx = {
    get: (name) => name === 'credentials'
      ? { resolve: async (ref) => ({ value: `seam-${ref}` }) }
      : undefined,
  }
  const resolved = await resolveCredentials(ctx, {})
  assert.equal(resolved.yandexApiKey, 'seam-YANDEX_API_KEY')
  assert.equal(resolved.yandexFolderId, 'seam-YANDEX_FOLDER_ID')
})

test('resolveCredentials falls back to the process env without the seam', async () => {
  process.env.MY_YANDEX_KEY = 'env-key'
  process.env.MY_YANDEX_FOLDER = 'env-folder'
  try {
    const resolved = await resolveCredentials({}, {
      apiKeyEnv: 'MY_YANDEX_KEY',
      folderIdEnv: 'MY_YANDEX_FOLDER',
    })
    assert.equal(resolved.yandexApiKey, 'env-key')
    assert.equal(resolved.yandexFolderId, 'env-folder')
  } finally {
    delete process.env.MY_YANDEX_KEY
    delete process.env.MY_YANDEX_FOLDER
  }
})

test('resolveCredentials returns undefined when nothing resolves', async () => {
  process.env.YANDEX_API_KEY = ''
  const resolved = await resolveCredentials({}, {})
  assert.equal(resolved.yandexApiKey, undefined)
  assert.equal(resolved.yandexFolderId, undefined)
})

// ── availability ─────────────────────────────────────────────────────────────

test('provider id is stable', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).id, YANDEX_PROVIDER_ID)
})

test('available() requires a parseable URL and a valid maxResults', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).available(), true)
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig({ baseURL: 'not a url' }))).available(), false)
  // Credential visibility is decided at search time (the seam may resolve a
  // ref even when nothing sits in the config or the environment right now).
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig({ apiKey: '', folderId: '' }))).available(), true)
})

// ── search normalization ─────────────────────────────────────────────────────

test('search() resolves credentials and normalizes sources into the seam shape', async () => {
  const backend = fakeBackend(() => cannedSources('q'))
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch, testCredentials)

  const result = await provider.search({ query: 'q', maxResults: 8 })
  assert.deepEqual(result, { sources: cannedSources('q'), truncated: false })
  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].query, 'q')
  assert.equal(backend.calls[0].config.yandexApiKey, 'test-key')
  assert.equal(backend.calls[0].config.yandexFolderId, 'test-folder')
})

test('search() applies the request maxResults bound at the backend layer', async () => {
  const backend = fakeBackend((opts) => {
    assert.equal(opts.config.maxResults, 3, 'request bound must win over the options default')
    return cannedSources('q')
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig({ maxResults: 10 })), backend.runSearch, testCredentials)
  await provider.search({ query: 'q', maxResults: 3 })
})

test('search() falls back to the options maxResults when the request has none', async () => {
  const backend = fakeBackend((opts) => {
    assert.equal(opts.config.maxResults, 10)
    return {}
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig({ maxResults: 10 })), backend.runSearch, testCredentials)
  await provider.search({ query: 'q' })
})

test('search() yields empty sources without error when the backend has none', async () => {
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), fakeBackend(() => []).runSearch, testCredentials)
  const result = await provider.search({ query: 'q' })
  assert.deepEqual(result.sources, [])
})

test('search() throws WEB_PROVIDER_CREDENTIAL_MISSING when credentials do not resolve', async () => {
  const backend = fakeBackend(() => { throw new Error('must not be called') })
  const provider = new YandexSearchProvider(
    providerOptions(providerConfig({ apiKey: '', folderId: '' })),
    backend.runSearch,
    async () => ({}),
  )

  await assert.rejects(
    provider.search({ query: 'q' }),
    (error) => error instanceof Error
      && error.code === WEB_PROVIDER_CREDENTIAL_MISSING
      && /YANDEX_API_KEY/.test(error.message)
      && /YANDEX_FOLDER_ID/.test(error.message)
      && /Models/.test(error.message),
  )
  assert.equal(backend.calls.length, 0)
})

// ── error mapping ────────────────────────────────────────────────────────────

test('search() maps YandexApiError to a WEB_PROVIDER_ERROR with context', async () => {
  const backend = fakeBackend(() => {
    throw new YandexApiError('HTTP 403: PermissionDenied', { status: 403 })
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch, testCredentials)

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
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch, testCredentials)

  await assert.rejects(
    provider.search({ query: 'q' }, controller.signal),
    (error) => error.code === 'WEB_ABORTED',
  )
})

test('search() maps WEB_ABORTED even when the abort reached us wrapped as a YandexApiError', async () => {
  // yandex-api folds an AbortError from fetch into a YandexApiError (with the
  // original as `cause`); the provider must still surface WEB_ABORTED, not
  // WEB_PROVIDER_ERROR, so the abort check precedes the backend-error branch.
  const controller = new AbortController()
  const backend = fakeBackend(() => {
    controller.abort()
    throw new YandexApiError('Yandex Search API request failed: The operation was aborted', {
      cause: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    })
  })
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), backend.runSearch, testCredentials)

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

test('apply() stays silent when credentials are visible (literal or env)', () => {
  const messages = []
  const originalWarn = console.warn
  console.warn = (message) => { messages.push(message) }
  try {
    const registered = []
    const ctx = { web: { registerSearchProvider: (provider) => { registered.push(provider) } } }
    apply(ctx, providerConfig())
    assert.equal(registered.length, 1)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(messages.length, 0)
})

test('apply() warns with an actionable hint when credentials are not visible', () => {
  const messages = []
  const originalWarn = console.warn
  console.warn = (message) => { messages.push(message) }
  try {
    process.env.YANDEX_API_KEY = ''
    delete process.env.YANDEX_API_KEY
    delete process.env.YANDEX_FOLDER_ID
    const registered = []
    const ctx = { web: { registerSearchProvider: (provider) => { registered.push(provider) } } }
    apply(ctx, {})
    assert.equal(registered.length, 1)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(messages.length, 1)
  assert.match(messages[0], /credentials/)
  assert.match(messages[0], /YANDEX_API_KEY/)
})
