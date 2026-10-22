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

/** Fake ctx.web with an optional credentials seam. */
function harnessCtx({ withSeam = true } = {}) {
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        ctx.registered = (ctx.registered ?? []).concat(provider)
      },
    },
  }
  if (withSeam) {
    ctx.get = (name) => name === 'credentials'
      ? { resolve: async (ref) => ({ value: `seam-${ref}` }) }
      : undefined
  }
  return ctx
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

/** Let queued promise work (slot hand-offs) settle between assertions. */
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** Backend that holds every search open until released, tracking live count. */
function gatedBackend() {
  const state = { active: 0, peak: 0, gates: [] }
  const runSearch = async () => {
    state.active += 1
    state.peak = Math.max(state.peak, state.active)
    await new Promise((resolve) => state.gates.push(resolve))
    state.active -= 1
    return []
  }
  return { state, runSearch }
}

/** Release gated searches wave by wave until `settled` flips. */
async function drainGates(state, isSettled) {
  for (let guard = 0; !isSettled() && guard < 200; guard += 1) {
    while (state.gates.length > 0) state.gates.shift()()
    await tick()
  }
}

// ── options resolution ───────────────────────────────────────────────────────

test('resolveOptions falls back to defaults with no config', () => {
  const options = resolveOptions({})
  assert.equal(options.yandexApiKey, '')
  assert.equal(options.yandexApiKeyRef, 'YANDEX_API_KEY')
  assert.equal(options.yandexFolderId, '')
  assert.equal(options.yandexFolderIdRef, 'YANDEX_FOLDER_ID')
  assert.equal(options.yandexSearchApiUrl, 'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync')
  assert.equal(options.yandexSearchType, 'SEARCH_TYPE_COM')
  assert.equal(options.yandexL10n, 'LOCALIZATION_EN')
  assert.equal(options.maxResults, 10)
  // No override: undefined, so lib/yandex-api.mjs defaults (300/500/120000ms) apply.
  assert.equal(options.pollTimeoutMs, undefined)
  assert.equal(options.pollIntervalMs, undefined)
  assert.equal(options.pollFirstDelayMs, undefined)
  // No override: the provider falls back to its own default cap of two.
  assert.equal(options.maxConcurrentSearches, undefined)
})

test('resolveOptions carries literals and ref names, not secret values', () => {
  const options = resolveOptions({
    apiKey: 'lit-key',
    folderId: 'lit-folder',
    apiKeyRef: 'MY_KEY_REF',
    folderIdRef: 'MY_FOLDER_REF',
    baseURL: 'http://x',
    maxResults: 3,
  })
  assert.equal(options.yandexApiKey, 'lit-key')
  assert.equal(options.yandexFolderId, 'lit-folder')
  assert.equal(options.yandexApiKeyRef, 'MY_KEY_REF')
  assert.equal(options.yandexFolderIdRef, 'MY_FOLDER_REF')
  assert.equal(options.yandexSearchApiUrl, 'http://x')
  assert.equal(options.maxResults, 3)
})

test('resolveOptions defaults ref names when only literals are given', () => {
  const options = resolveOptions(providerConfig({ apiKey: 'k', folderId: 'f' }))
  assert.equal(options.yandexApiKey, 'k')
  assert.equal(options.yandexApiKeyRef, 'YANDEX_API_KEY')
  assert.equal(options.yandexFolderId, 'f')
  assert.equal(options.yandexFolderIdRef, 'YANDEX_FOLDER_ID')
})

test('resolveOptions normalizes invalid maxResults to the default', () => {
  assert.equal(resolveOptions(providerConfig({ maxResults: 0 })).maxResults, 10)
  assert.equal(resolveOptions(providerConfig({ maxResults: 3 })).maxResults, 3)
  assert.equal(resolveOptions(providerConfig({ maxResults: '7' })).maxResults, 10)
})

test('resolveOptions passes deferred-poll timing overrides through', () => {
  const options = resolveOptions(providerConfig({
    pollTimeoutMs: 150000,
    pollIntervalMs: 750,
    pollFirstDelayMs: 100,
  }))
  assert.equal(options.pollTimeoutMs, 150000)
  assert.equal(options.pollIntervalMs, 750)
  assert.equal(options.pollFirstDelayMs, 100)
})

test('resolveOptions drops invalid poll timing values so lib defaults apply', () => {
  const options = resolveOptions(providerConfig({
    pollTimeoutMs: 0,
    pollIntervalMs: -5,
    pollFirstDelayMs: '800',
  }))
  assert.equal(options.pollTimeoutMs, undefined)
  assert.equal(options.pollIntervalMs, undefined)
  assert.equal(options.pollFirstDelayMs, undefined)
})

test('resolveOptions passes maxConcurrentSearches and drops invalid values', () => {
  assert.equal(resolveOptions(providerConfig({ maxConcurrentSearches: 3 })).maxConcurrentSearches, 3)
  assert.equal(resolveOptions(providerConfig({ maxConcurrentSearches: 0 })).maxConcurrentSearches, undefined)
  assert.equal(resolveOptions(providerConfig({ maxConcurrentSearches: 1.5 })).maxConcurrentSearches, undefined)
  assert.equal(resolveOptions(providerConfig({ maxConcurrentSearches: '2' })).maxConcurrentSearches, undefined)
})

// ── credential resolution ────────────────────────────────────────────────────

test('resolveCredentials prefers literal config over the seam', async () => {
  const ctx = harnessCtx({ withSeam: true })
  const resolved = await resolveCredentials(ctx, { apiKey: 'lit-key', folderId: 'lit-folder' })
  assert.equal(resolved.yandexApiKey, 'lit-key')
  assert.equal(resolved.yandexFolderId, 'lit-folder')
})

test('resolveCredentials uses the ctx.credentials seam when present', async () => {
  const ctx = harnessCtx({ withSeam: true })
  const resolved = await resolveCredentials(ctx, {})
  assert.equal(resolved.yandexApiKey, 'seam-YANDEX_API_KEY')
  assert.equal(resolved.yandexFolderId, 'seam-YANDEX_FOLDER_ID')
})

test('resolveCredentials resolves custom ref names through the seam', async () => {
  const ctx = harnessCtx({ withSeam: true })
  const resolved = await resolveCredentials(ctx, {
    apiKeyRef: 'MY_KEY_REF',
    folderIdRef: 'MY_FOLDER_REF',
  })
  assert.equal(resolved.yandexApiKey, 'seam-MY_KEY_REF')
  assert.equal(resolved.yandexFolderId, 'seam-MY_FOLDER_REF')
})

test('resolveCredentials never consults the process environment', async () => {
  process.env.YANDEX_API_KEY = 'env-key'
  process.env.YANDEX_FOLDER_ID = 'env-folder'
  try {
    // No seam (ctx without a credentials service): nothing may resolve.
    const resolved = await resolveCredentials({}, {})
    assert.equal(resolved.yandexApiKey, undefined)
    assert.equal(resolved.yandexFolderId, undefined)
  } finally {
    delete process.env.YANDEX_API_KEY
    delete process.env.YANDEX_FOLDER_ID
  }
})

// ── availability ─────────────────────────────────────────────────────────────

test('provider id is stable', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).id, YANDEX_PROVIDER_ID)
})

test('available() requires a parseable URL and a valid maxResults', () => {
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig())).available(), true)
  assert.equal(new YandexSearchProvider(providerOptions(providerConfig({ baseURL: 'not a url' }))).available(), false)
  // Credentials are resolved at search time through the seam; availability is
  // about the structurally runnable parts only.
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

test('search() forwards the deferred-poll timing options to the backend', async () => {
  const backend = fakeBackend(() => [])
  const provider = new YandexSearchProvider(
    providerOptions(providerConfig({ pollTimeoutMs: 150000, pollIntervalMs: 750 })),
    backend.runSearch,
    testCredentials,
  )
  await provider.search({ query: 'q' })
  assert.equal(backend.calls[0].config.pollTimeoutMs, 150000)
  assert.equal(backend.calls[0].config.pollIntervalMs, 750)
})

// ── concurrency cap ──────────────────────────────────────────────────────────
// One web_search call fans out to up to four queries; Yandex answers 429 once
// several deferred operations are pending, so the provider queues them.

test('search() caps concurrent Yandex searches at two by default', async () => {
  const { state, runSearch } = gatedBackend()
  const provider = new YandexSearchProvider(providerOptions(providerConfig()), runSearch, testCredentials)

  let settled = false
  const all = Promise.all(
    [0, 1, 2, 3].map((index) => provider.search({ query: `q${index}` })),
  ).then(() => { settled = true })

  await tick()
  assert.equal(state.active, 2, 'only two backends may run at once by default')

  await drainGates(state, () => settled)
  await all
  assert.equal(state.peak, 2, 'the cap holds for the whole batch')
})

test('search() honors maxConcurrentSearches from the plugin row', async () => {
  const { state, runSearch } = gatedBackend()
  const provider = new YandexSearchProvider(
    providerOptions(providerConfig({ maxConcurrentSearches: 1 })),
    runSearch,
    testCredentials,
  )

  let settled = false
  const all = Promise.all(
    [0, 1, 2].map((index) => provider.search({ query: `q${index}` })),
  ).then(() => { settled = true })

  await tick()
  assert.equal(state.active, 1, 'a configured cap of one serializes searches')

  await drainGates(state, () => settled)
  await all
  assert.equal(state.peak, 1)
})

test('search() rejects an aborted queued search without leaking its slot', async () => {
  const { state, runSearch } = gatedBackend()
  const provider = new YandexSearchProvider(
    providerOptions(providerConfig({ maxConcurrentSearches: 1 })),
    runSearch,
    testCredentials,
  )

  const first = provider.search({ query: 'first' })
  await tick()
  assert.equal(state.active, 1)

  const controller = new AbortController()
  const queued = provider.search({ query: 'queued' }, controller.signal)
  const third = provider.search({ query: 'third' })
  await tick()
  assert.equal(state.active, 1, 'queued searches must not reach the backend')

  controller.abort()
  await assert.rejects(queued, (error) => error.code === 'WEB_ABORTED')
  assert.equal(state.active, 1, 'the aborted waiter must not start a search')

  state.gates.shift()()
  await tick()
  assert.equal(state.active, 1, 'the freed slot goes to the next waiter')

  state.gates.shift()()
  await Promise.all([first, third])
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
  const ctx = harnessCtx()
  apply(ctx, providerConfig())
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].id, YANDEX_PROVIDER_ID)
  assert.equal(ctx.registered[0].available(), true)
})

test('apply() stays silent when the harness has a credentials seam', () => {
  const messages = []
  const originalWarn = console.warn
  console.warn = (message) => { messages.push(message) }
  try {
    const ctx = harnessCtx({ withSeam: true })
    apply(ctx, {})
    assert.equal(ctx.registered.length, 1)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(messages.length, 0)
})

test('apply() never warns at apply time (search-time errors carry the signal)', () => {
  const messages = []
  const originalWarn = console.warn
  console.warn = (message) => { messages.push(message) }
  try {
    // Neither a literal nor a seam is visible — apply() stays silent anyway,
    // because the credentials service may register later in startup order.
    const ctx = harnessCtx({ withSeam: false })
    apply(ctx, {})
    assert.equal(ctx.registered.length, 1)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(messages.length, 0)
})
