/**
 * A native `WebSearchProvider` for the DeepSeek Harness `ctx.web` seam, backed
 * by the official Yandex Cloud Search API.
 *
 * The harness process calls Yandex directly through `./lib/yandex-api.mjs` and
 * returns normalized `WebSearchSource[]`, the same shape the model-facing
 * `web_search` tool already renders, so the client part stays byte-identical.
 *
 * The provider is deliberately dependency-free (no `@deepseek-ai/*` imports):
 * profile-installed plugins in this setup resolve only their own module tree,
 * so the provider talks to the seam purely through the runtime `ctx.web`
 * contract (`registerSearchProvider`, `WebSearchRequest`, cancellation signal).
 */

import { search as searchYandex, YandexApiError } from './lib/yandex-api.mjs'

/** Stable id this provider registers under (pin the `web` row's searchProvider to it). */
export const YANDEX_PROVIDER_ID = 'yandex'

/** Error code consumers may match against (mirrors the seam's WEB_PROVIDER_ERROR). */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR'

/** Error code for a search that cannot resolve its API key / folder id. */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING'

/**
 * Default cap on searches running at once through Yandex's deferred queue.
 *
 * The harness fans one `web_search` call out to up to four queries in parallel,
 * each of which is a separate `searchAsync` submission. Yandex queues deferred
 * operations and starts answering 429 "too many pending requests" once several
 * are in flight, which both bills an extra retry and pushes the whole batch
 * deeper into the slow queue. Two parallel searches keep that pressure bounded
 * without turning a multi-query search into a strictly serial one.
 */
export const DEFAULT_MAX_CONCURRENT_SEARCHES = 2

/** FIFO concurrency limiter; `acquire(signal)` resolves with its `release`. */
function createLimiter(limit) {
  let active = 0
  const waiters = []
  const release = () => {
    const next = waiters.shift()
    if (next === undefined) {
      active -= 1
      return
    }
    next.signal?.removeEventListener('abort', next.onAbort)
    next.resolve(release)
  }
  return {
    acquire(signal) {
      if (signal?.aborted === true) return Promise.reject(abortError())
      if (active < limit) {
        active += 1
        return Promise.resolve(release)
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = waiters.indexOf(waiter)
            if (index !== -1) waiters.splice(index, 1)
            reject(abortError())
          },
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
        waiters.push(waiter)
      })
    },
  }
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/**
 * @typedef {object} ProviderOptions
 * @property {string} yandexApiKey         — literal key from config (may be empty)
 * @property {string} yandexApiKeyRef      — credential ref name in the Models registry
 * @property {string} yandexFolderId       — literal folder id (may be empty)
 * @property {string} yandexFolderIdRef    — credential ref name in the Models registry
 * @property {string} yandexSearchApiUrl
 * @property {string} yandexSearchType
 * @property {string} yandexL10n
 * @property {number} maxResults
 */

/**
 * One operation's resolved secrets, or empty strings when not resolvable.
 * @callback ResolveCredentials
 * @returns {Promise<{ yandexApiKey?: string, yandexFolderId?: string }>}
 */

/**
 * The search backend selected for one search. Defaults to the real Yandex
 * client; tests inject a fake to avoid the network.
 * @callback RunSearch
 * @param {{ query: string, config: object, signal?: AbortSignal }} opts
 * @returns {Promise<Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>>}
 */

/**
 * @param {() => ProviderOptions} resolveOptions - snapshot for the NEXT
 *   operation; a thunk so profile-config changes are honored between searches.
 * @param {RunSearch} [runSearch]
 * @param {ResolveCredentials} [resolveCredentials]
 */
export class YandexSearchProvider {
  constructor(resolveOptions, runSearch = searchYandex, resolveCredentials = async () => ({})) {
    this.resolveOptions = resolveOptions
    this.runSearch = runSearch
    this.resolveCredentials = resolveCredentials
    // Snapshot the cap once: a profile-config reload re-applies the plugin row
    // and builds a fresh provider, so the cap follows config without races.
    const configured = this.resolveOptions().maxConcurrentSearches
    this.limiter = createLimiter(
      Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENT_SEARCHES,
    )
  }

  id = YANDEX_PROVIDER_ID

  /** Cheap local usability check; must not make network calls. */
  available() {
    const options = this.resolveOptions()
    // A ref name is always present (it defaults), and whether it resolves is
    // decided at search time through the seam — so availability is about the
    // structurally runnable parts only, mirroring the harness's own providers.
    return URL.canParse(options.yandexSearchApiUrl)
      && Number.isInteger(options.maxResults) && options.maxResults > 0
  }

  /**
   * Run one search through the Yandex Cloud Search API and normalize it into
   * the seam's `WebSearchResult` shape. The result-count bound is applied at
   * the request layer (the seam re-enforces it on the way back regardless).
   * @param {import('@deepseek-ai/dsh-web').WebSearchRequest} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ sources: Array<object>, truncated: boolean }>}
   */
  async search(request, signal) {
    const options = this.resolveOptions()
    const resolved = await this.resolveCredentials()
    const yandexApiKey = resolved.yandexApiKey
    const yandexFolderId = resolved.yandexFolderId
    if (!yandexApiKey || !yandexFolderId) {
      const missing = []
      if (!yandexApiKey) missing.push(`"${options.yandexApiKeyRef}"`)
      if (!yandexFolderId) missing.push(`"${options.yandexFolderIdRef}"`)
      const credentialError = new Error(
        `Yandex web search has no credentials for ${missing.join(' and ')}; `
        + 'store them in the web Models credentials page (a ref with that name) '
        + 'or set a literal apiKey/folderId in the web-search-yandex config',
      )
      credentialError.code = WEB_PROVIDER_CREDENTIAL_MISSING
      throw credentialError
    }
    const maxResults = Math.min(
      request.maxResults ?? options.maxResults,
      options.maxResults,
    )
    let release
    try {
      // Queue behind other in-flight searches so Yandex never sees a burst of
      // pending deferred operations (429) and each accepted submit is billed.
      release = await this.limiter.acquire(signal)
      const sources = await this.runSearch({
        query: request.query,
        config: { ...options, yandexApiKey, yandexFolderId, maxResults },
        signal,
      })
      return { sources, truncated: false }
    } catch (error) {
      // Abort must win over backend error wrapping: `yandex-api` folds an
      // AbortError from fetch into a YandexApiError (with the original as
      // `cause`), so this check comes BEFORE the backend-error branch — the
      // same ordering the standalone server applies (504 vs provider 502).
      // It also covers an abort that lands while the search waits for its slot.
      if (signal?.aborted === true) {
        const aborted = new Error('Yandex web search aborted')
        aborted.code = 'WEB_ABORTED'
        throw aborted
      }
      if (error instanceof YandexApiError) {
        const wrapped = new Error(`Yandex web search failed: ${error.message}`)
        wrapped.code = WEB_PROVIDER_ERROR
        throw wrapped
      }
      throw error
    } finally {
      release?.()
    }
  }
}
