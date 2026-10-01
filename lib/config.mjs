/**
 * Configuration for the Yandex-backed web_search proxy.
 * Every value comes from an environment variable; there is no config file.
 */

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '127.0.0.1'

function intEnv(env, name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid ${name}: expected an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`)
  }
  return value
}

function strEnv(env, name, fallback) {
  const raw = env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

const BACKENDS = new Set(['auto', 'api', 'scrape', 'mock'])

export function loadConfig(env = process.env) {
  const backend = strEnv(env, 'YANDEX_BACKEND', 'auto').toLowerCase()
  if (!BACKENDS.has(backend)) {
    throw new Error(
      `invalid YANDEX_BACKEND=${JSON.stringify(backend)}: expected one of ${[...BACKENDS].join(', ')}`,
    )
  }

  return {
    host: strEnv(env, 'YANDEX_PROXY_HOST', DEFAULT_HOST),
    // 0 is accepted so tests can bind an ephemeral port; the CLI default is 8787.
    port: intEnv(env, 'YANDEX_PROXY_PORT', DEFAULT_PORT, { min: 0 }),

    /** auto = api when a key+folder are present, otherwise scrape. */
    backend,
    yandexApiKey: strEnv(env, 'YANDEX_API_KEY', ''),
    yandexFolderId: strEnv(env, 'YANDEX_FOLDER_ID', ''),
    yandexSearchApiUrl: strEnv(
      env,
      'YANDEX_SEARCH_API_URL',
      'https://searchapi.api.cloud.yandex.net/v2/web/search',
    ),
    yandexSearchType: strEnv(env, 'YANDEX_SEARCH_TYPE', 'SEARCH_TYPE_RU'),
    yandexL10n: strEnv(env, 'YANDEX_L10N', 'LOCALIZATION_RU'),

    /** Host used by the scraper backend (best-effort; no API key needed). */
    yandexScrapeHost: strEnv(env, 'YANDEX_SCRAPE_HOST', 'yandex.com'),
    requestTimeoutMs: intEnv(env, 'YANDEX_REQUEST_TIMEOUT_MS', 15_000, { min: 100, max: 120_000 }),

    /** Upper bound on sources returned to the harness; tool-web caps at 8 anyway. */
    maxResults: intEnv(env, 'YANDEX_MAX_RESULTS', 10, { min: 1, max: 50 }),

    /** Request body size limit for POST /messages (bytes). */
    maxRequestBytes: intEnv(env, 'YANDEX_MAX_REQUEST_BYTES', 1_000_000, { min: 1_024, max: 16_000_000 }),
  }
}

export function hasApiCredentials(config) {
  return config.yandexApiKey.length > 0 && config.yandexFolderId.length > 0
}

/** Resolve the effective backend name for a config (after `auto`). */
export function effectiveBackend(config) {
  if (config.backend === 'auto') return hasApiCredentials(config) ? 'api' : 'scrape'
  return config.backend
}
