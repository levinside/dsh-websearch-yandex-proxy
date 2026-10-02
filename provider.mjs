/**
 * A native `WebSearchProvider` for the DeepSeek Harness `ctx.web` seam, backed
 * by the official Yandex Cloud Search API.
 *
 * The harness process calls Yandex directly through `./lib/yandex-api.mjs` —
 * the same canonical client the standalone `server.mjs` proxy uses — and
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

/**
 * @typedef {object} ProviderOptions
 * @property {string} yandexApiKey
 * @property {string} yandexFolderId
 * @property {string} yandexSearchApiUrl
 * @property {string} yandexSearchType
 * @property {string} yandexL10n
 * @property {number} maxResults
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
 */
export class YandexSearchProvider {
  constructor(resolveOptions, runSearch = searchYandex) {
    this.resolveOptions = resolveOptions
    this.runSearch = runSearch
  }

  id = YANDEX_PROVIDER_ID

  /** Cheap local usability check; must not make network calls. */
  available() {
    const options = this.resolveOptions()
    return options.yandexApiKey.length > 0
      && options.yandexFolderId.length > 0
      && URL.canParse(options.yandexSearchApiUrl)
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
    const maxResults = Math.min(
      request.maxResults ?? options.maxResults,
      options.maxResults,
    )
    try {
      const sources = await this.runSearch({
        query: request.query,
        config: { ...options, maxResults },
        signal,
      })
      return { sources, truncated: false }
    } catch (error) {
      // Abort must win over backend error wrapping: `yandex-api` folds an
      // AbortError from fetch into a YandexApiError (with the original as
      // `cause`), so this check comes BEFORE the backend-error branch — the
      // same ordering the standalone server applies (504 vs provider 502).
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
    }
  }
}
