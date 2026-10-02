/**
 * Cordis plugin entry for the native Yandex search provider (no HTTP proxy hop).
 *
 * Registers a `YandexSearchProvider` into `ctx.web` so the model-facing
 * `web_search` tool (owned by `tool-web`, unchanged) searches the Yandex Cloud
 * Search API directly from the harness process — no local HTTP proxy hop.
 *
 * The plugin is dependency-free on purpose: profile-installed plugins in this
 * setup resolve only their own module tree, so there are no `@deepseek-ai/*`
 * imports. Options come from the row's `config` with environment fallbacks.
 */

import { YandexSearchProvider, YANDEX_PROVIDER_ID } from './provider.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-yandex'

/** The web seam this provider registers into. */
export const inject = ['web']

export { YANDEX_PROVIDER_ID } from './provider.mjs'

/**
 * Config keys (read from the plugin row's `config`, no schema required):
 *   apiKey / apiKeyEnv      — literal key or env var name (default YANDEX_API_KEY)
 *   folderId / folderIdEnv  — literal folder id or env var (default YANDEX_FOLDER_ID)
 *   baseURL                 — search API URL (default the public Yandex Cloud endpoint)
 *   searchType              — SERP segment (default SEARCH_TYPE_RU)
 *   l10n                    — localization (default LOCALIZATION_RU)
 *   maxResults              — upper bound on sources (default 10)
 */

const DEFAULT_SEARCH_API_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search'
const DEFAULT_SEARCH_TYPE = 'SEARCH_TYPE_RU'
const DEFAULT_L10N = 'LOCALIZATION_RU'
const DEFAULT_MAX_RESULTS = 10

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

/** Resolve one fully-defaulted options snapshot from config + environment. */
export function resolveOptions(config = {}) {
  const apiKeyEnv = nonEmpty(config.apiKeyEnv) ? config.apiKeyEnv : 'YANDEX_API_KEY'
  const folderIdEnv = nonEmpty(config.folderIdEnv) ? config.folderIdEnv : 'YANDEX_FOLDER_ID'
  return {
    yandexApiKey: nonEmpty(config.apiKey) ? config.apiKey : (process.env[apiKeyEnv] ?? ''),
    yandexFolderId: nonEmpty(config.folderId) ? config.folderId : (process.env[folderIdEnv] ?? ''),
    yandexSearchApiUrl: nonEmpty(config.baseURL) ? config.baseURL : DEFAULT_SEARCH_API_URL,
    yandexSearchType: nonEmpty(config.searchType) ? config.searchType : DEFAULT_SEARCH_TYPE,
    yandexL10n: nonEmpty(config.l10n) ? config.l10n : DEFAULT_L10N,
    maxResults: Number.isInteger(config.maxResults) && config.maxResults > 0
      ? config.maxResults
      : DEFAULT_MAX_RESULTS,
  }
}

/**
 * Register the provider with `ctx.web`. The thunk defers option resolution to
 * each operation, so every search uses one consistent snapshot. On a
 * profile-config reload the row is re-applied with a fresh config object and
 * the seam auto-disposes the old provider, so new endpoint/keys take effect
 * without manual unregistration (no duplicate-id failures).
 */
export function apply(ctx, config = {}) {
  const provider = new YandexSearchProvider(() => resolveOptions(config))
  ctx.web.registerSearchProvider(provider)
  // A missing key/folder id makes the provider silently unavailable: emit one
  // actionable line at apply time so a typo in an env var name or a missing
  // credential does not end up as a puzzling "no usable web provider" later.
  if (!provider.available()) {
    const apiKeyEnv = nonEmpty(config.apiKeyEnv) ? config.apiKeyEnv : 'YANDEX_API_KEY'
    const folderIdEnv = nonEmpty(config.folderIdEnv) ? config.folderIdEnv : 'YANDEX_FOLDER_ID'
    console.warn(
      'dsh-web-search-yandex: provider registered but unavailable — '
      + `set config apiKey/folderId or export ${apiKeyEnv} / ${folderIdEnv}`,
    )
  }
}
