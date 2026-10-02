/**
 * Cordis plugin entry for the native Yandex search provider (no HTTP proxy hop).
 *
 * Registers a `YandexSearchProvider` into `ctx.web` so the model-facing
 * `web_search` tool (owned by `tool-web`, unchanged) searches the Yandex Cloud
 * Search API directly from the harness process — no local HTTP proxy hop.
 *
 * The plugin is dependency-free on purpose: profile-installed plugins in this
 * setup resolve only their own module tree, so there are no `@deepseek-ai/*`
 * imports. Secrets are resolved the same way the harness's own providers do
 * it — through the `ctx.credentials` seam (the web Models page refs stored in
 * `~/.dsh/.credentials.yaml`), with a literal `config.apiKey` / `folderId` as
 * the only fallback. There is no environment-variable layer.
 */

import { YandexSearchProvider, YANDEX_PROVIDER_ID } from './provider.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-yandex'

/** The web seam this provider registers into. */
export const inject = ['web']

export { YANDEX_PROVIDER_ID } from './provider.mjs'

/**
 * Config keys (read from the plugin row's `config`, no schema required):
 *   apiKey / apiKeyRef      — literal key, or credential ref name in the web
 *                             Models credentials registry (default YANDEX_API_KEY)
 *   folderId / folderIdRef  — literal folder id, or credential ref name
 *                             (default YANDEX_FOLDER_ID)
 *   baseURL                 — search API URL (default: the public Yandex Cloud
 *                            searchAsync endpoint — deferred/async mode)
 *   searchType              — SERP segment (default SEARCH_TYPE_COM)
 *   l10n                    — localization (default LOCALIZATION_COM)
 *   maxResults              — upper bound on sources (default 10)
 *
 * Credential precedence: literal config value wins; otherwise the ref is
 * resolved through the harness `ctx.credentials` seam (Models page /
 * `.credentials.yaml` refs). No process environment is consulted.
 */

const DEFAULT_SEARCH_API_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync'
const DEFAULT_SEARCH_TYPE = 'SEARCH_TYPE_COM'
const DEFAULT_L10N = 'LOCALIZATION_COM'
const DEFAULT_MAX_RESULTS = 10

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

/** Resolve one fully-defaulted non-secret options snapshot from config. */
export function resolveOptions(config = {}) {
  return {
    yandexApiKey: nonEmpty(config.apiKey) ? config.apiKey : '',
    yandexApiKeyRef: nonEmpty(config.apiKeyRef) ? config.apiKeyRef : 'YANDEX_API_KEY',
    yandexFolderId: nonEmpty(config.folderId) ? config.folderId : '',
    yandexFolderIdRef: nonEmpty(config.folderIdRef) ? config.folderIdRef : 'YANDEX_FOLDER_ID',
    yandexSearchApiUrl: nonEmpty(config.baseURL) ? config.baseURL : DEFAULT_SEARCH_API_URL,
    yandexSearchType: nonEmpty(config.searchType) ? config.searchType : DEFAULT_SEARCH_TYPE,
    yandexL10n: nonEmpty(config.l10n) ? config.l10n : DEFAULT_L10N,
    maxResults: Number.isInteger(config.maxResults) && config.maxResults > 0
      ? config.maxResults
      : DEFAULT_MAX_RESULTS,
  }
}

/** Resolve one credential: a literal config value wins, else the seam. */
async function resolveCredential(ctx, { literal, refName }) {
  if (nonEmpty(literal)) return literal
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(refName)
      if (resolved && nonEmpty(resolved.value)) return resolved.value
    } catch {
      // an unresolvable ref yields no credential
    }
  }
  return undefined
}

/**
 * Resolve the secret key and folder id for the next search through the
 * harness credential seam. This is async: the seam handshake may round-trip,
 * and DSH resolves credentials per operation so a settings rewrite landing
 * mid-flight never mixes sections.
 */
export async function resolveCredentials(ctx, config = {}) {
  const apiKeyRef = nonEmpty(config.apiKeyRef) ? config.apiKeyRef : 'YANDEX_API_KEY'
  const folderIdRef = nonEmpty(config.folderIdRef) ? config.folderIdRef : 'YANDEX_FOLDER_ID'
  return {
    yandexApiKey: await resolveCredential(ctx, { literal: config.apiKey, refName: apiKeyRef }),
    yandexFolderId: await resolveCredential(ctx, { literal: config.folderId, refName: folderIdRef }),
  }
}

/**
 * Register the provider with `ctx.web`. Non-secret options are snapshotted
 * through a thunk; the secret key/folder id are resolved through the
 * credential seam at each search. Missing credentials never warn at apply
 * time (mirroring the harness's own providers): the service may register
 * after this plugin in startup order, and a search that cannot resolve its
 * refs fails with `WEB_PROVIDER_CREDENTIAL_MISSING` instead. On a
 * profile-config reload the row is re-applied with a fresh config object and
 * the seam auto-disposes the old provider, so new endpoint/keys take effect
 * without manual unregistration (no duplicate-id failures).
 */
export function apply(ctx, config = {}) {
  const provider = new YandexSearchProvider(
    () => resolveOptions(config),
    undefined,
    () => resolveCredentials(ctx, config),
  )
  ctx.web.registerSearchProvider(provider)
  ctx.logger?.debug?.('dsh-web-search-yandex: provider registered; secrets resolve at search time via the credentials seam')
}
