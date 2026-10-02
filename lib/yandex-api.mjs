/**
 * Official Yandex Cloud Search API v2 backend (deferred / async mode).
 *
 * Wire contract (verified against a working SearXNG engine implementation):
 *   1. POST <searchAsync>            — start the search
 *      Authorization: Api-Key <AQVN...>  (the Yandex Cloud search API key)
 *      Content-Type: application/json
 *      body (camelCase): { query: { searchType, queryText, familyMode, page, fixTypoMode },
 *                        sortSpec, groupSpec, maxPassages, l10n, folderId, responseFormat: FORMAT_XML }
 *      response: { "id": "<operation-id>", "done": false } — NOT results, an op id.
 *   2. GET https://operation.api.cloud.yandex.net/operations/<operation-id>
 *      Authorization: Api-Key <AQVN...>  (same key)
 *      Poll until { "done": true, "response": { "rawData": "<base64-encoded XML>" } }.
 *      The XML holds <doc> entries with <url>, <title> and
 *      <passages><passage>…</passage></passages>; an empty hit list comes back
 *      as <error code="15"> ("комбинация слов нигде не встречается").
 *
 * Deferred mode is ~16× cheaper than the synchronous /v2/web/search endpoint
 * (Yandex bills per search submission, not per operation-status poll).
 *
 * Requires a Yandex Search API key and a folder id (the folder owning the
 * key; the key's service account needs the search-api.webSearch.user role).
 * Both arrive via `config.yandexApiKey` / `config.yandexFolderId`, resolved
 * by the provider through the harness credential seam.
 */

import { decodeXmlEntities } from './xml.mjs'

const USER_AGENT = 'dsh-web-search-yandex/0.1.0'

/** Deferred-mode endpoint that accepts a search and returns an operation id. */
export const YANDEX_SEARCH_ASYNC_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync'

/** Operation-status endpoint; the operation id is appended to it. */
export const YANDEX_OPERATIONS_URL = 'https://operation.api.cloud.yandex.net/operations/'

// Polling cadence: operations usually finish in a fraction of a second, so the
// first status check comes early and the interval is short. The whole poll has
// a hard time budget so a stuck operation surfaces as a timeout instead of an
// unbounded tail of requests. All three are overridable per search via
// `config.pollFirstDelayMs / pollIntervalMs / pollTimeoutMs` (used by tests).
const POLL_FIRST_DELAY_MS = 300
const POLL_INTERVAL_MS = 500
const POLL_TIMEOUT_MS = 20000

/**
 * Yandex caps `queryText` at 400 characters; a longer query makes the API
 * reject the whole request (InvalidArgument). The harness occasionally hands
 * the tool a long pasted blob, so clamp here — by Unicode code points, not
 * UTF-16 units, so a surrogate pair (emoji, non-BMP char) is never split.
 */
export const QUERY_TEXT_MAX_LENGTH = 400

/** Clamp a search query to QUERY_TEXT_MAX_LENGTH characters. */
export function normalizeQueryText(query) {
  if (typeof query !== 'string') query = String(query ?? '')
  if (Array.from(query).length <= QUERY_TEXT_MAX_LENGTH) return query
  return Array.from(query).slice(0, QUERY_TEXT_MAX_LENGTH).join('').trimEnd()
}

/** One normalized result, matching the harness `WebSearchSource` shape. */
export class YandexApiError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message)
    this.name = 'YandexApiError'
    this.status = status
    this.cause = cause
  }
}

/** True when this backend can run for the given config. */
function available(config) {
  return config.yandexApiKey.length > 0 && config.yandexFolderId.length > 0
}

/**
 * Run one search through the official Yandex Cloud Search API (deferred mode):
 * submit a searchAsync request, then poll the returned operation until it is
 * done and parse its base64-XML payload.
 * @param {object} opts
 * @param {string} opts.query - search text.
 * @param {object} opts.config - resolved proxy config.
 * @param {AbortSignal} [opts.signal] - cancellation signal.
 * @returns {Promise<Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>>}
 */
export async function search({ query, config, signal }) {
  if (!available(config)) {
    throw new YandexApiError(
      'Yandex Cloud Search API backend is not configured: no API key / folder id provided',
      { status: 503 },
    )
  }

  const rawQuery = typeof query === 'string' ? query : String(query ?? '')
  const queryText = normalizeQueryText(rawQuery)
  if (queryText !== rawQuery) {
    console.warn(
      `dsh-web-search-yandex: search query truncated to ${QUERY_TEXT_MAX_LENGTH} characters `
      + `(input ${Array.from(rawQuery).length})`,
    )
  }

  const body = {
    query: {
      searchType: config.yandexSearchType,
      queryText,
      familyMode: 'FAMILY_MODE_NONE',
      page: '0',
      fixTypoMode: 'FIX_TYPO_MODE_OFF',
    },
    sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE', sortOrder: 'SORT_ORDER_DESC' },
    groupSpec: { groupsOnPage: String(config.maxResults), groupMode: 'GROUP_MODE_FLAT', docsInGroup: '1' },
    maxPassages: '3',
    l10n: config.yandexL10n,
    folderId: config.yandexFolderId,
    responseFormat: 'FORMAT_XML',
  }

  const operationId = await submitSearch(config, body, signal)
  return pollOperation(operationId, config, signal, config.maxResults)
}

/** POST the search body to the searchAsync endpoint and return the operation id. */
async function submitSearch(config, body, signal) {
  const url = config.yandexSearchApiUrl || YANDEX_SEARCH_ASYNC_URL
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: apiHeaders(config),
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new YandexApiError(`Yandex Search API request failed: ${String(error)}`, { cause: error })
  }

  if (!response.ok) {
    throw new YandexApiError(
      await describeError(response),
      { status: response.status },
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new YandexApiError('Yandex Search API returned a non-JSON response body', { cause: error })
  }
  if (payload === null || typeof payload !== 'object') {
    throw new YandexApiError('Yandex Search API submit response has no operation id')
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new YandexApiError(
      `Yandex Search API submit response has no operation id: ${JSON.stringify(payload).slice(0, 200)}`,
    )
  }
  return payload.id
}

/**
 * Poll the operation until it is done and parse its payload. Respects the
 * abort signal between requests (an aborted wait rejects immediately instead
 * of hanging), retries transient 429/5xx statuses, and enforces a total time
 * budget — after which the search fails with a timeout error.
 */
async function pollOperation(operationId, config, signal, maxResults) {
  const url = `${YANDEX_OPERATIONS_URL}${encodeURIComponent(operationId)}`
  const firstDelay = Number.isFinite(config?.pollFirstDelayMs) ? config.pollFirstDelayMs : POLL_FIRST_DELAY_MS
  const interval = Number.isFinite(config?.pollIntervalMs) ? config.pollIntervalMs : POLL_INTERVAL_MS
  const timeout = Number.isFinite(config?.pollTimeoutMs) ? config.pollTimeoutMs : POLL_TIMEOUT_MS

  const startedAt = Date.now()
  await abortableDelay(firstDelay, signal)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedAt >= timeout) {
      throw new YandexApiError(
        `Yandex Search API operation ${operationId} did not finish within ${timeout}ms`,
      )
    }

    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        signal,
        redirect: 'error',
        headers: apiHeaders(config),
      })
    } catch (error) {
      throw new YandexApiError(`Yandex Search API operation poll failed: ${String(error)}`, { cause: error })
    }

    // Transient throttling/server errors: back off and retry instead of failing.
    if (response.status === 429 || response.status >= 500) {
      await abortableDelay(interval, signal)
      continue
    }

    if (!response.ok) {
      // All other 4xx are terminal — surface the status line.
      throw new YandexApiError(
        await describeError(response),
        { status: response.status },
      )
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new YandexApiError('Yandex Search API returned a non-JSON operation response', { cause: error })
    }
    if (payload === null || typeof payload !== 'object') {
      throw new YandexApiError('Unexpected Yandex Search API operation payload shape')
    }

    if (payload.done !== true) {
      // Not finished yet — wait out the interval and poll again.
      await abortableDelay(interval, signal)
      continue
    }

    if (payload.error !== undefined && payload.error !== null) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : String(payload.error.message ?? JSON.stringify(payload.error))
      throw new YandexApiError(`operation failed: ${message}`, { status: payload.error?.code })
    }
    if (typeof payload.response?.rawData !== 'string') {
      throw new YandexApiError(`Yandex Search API operation ${operationId} finished without rawData`)
    }
    return parsePayload(payload.response, maxResults)
  }
}

/**
 * Resolve after `ms` unless `signal` fires first, in which case reject with an
 * AbortError immediately (never hang through a wait the caller wants gone).
 * The abort listener is registered before the timer is scheduled, so an abort
 * cannot slip between the two without being observed.
 */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(abortError())
    }
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    let timer
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** Common headers for both searchAsync and operation-status requests. */
function apiHeaders(config) {
  return {
    'authorization': `Api-Key ${config.yandexApiKey}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/** Pull a human-readable message out of a non-2xx Yandex response. */
async function describeError(response) {
  let detail
  try {
    const payload = await response.json()
    detail = payload?.message ?? payload?.error?.message ?? (typeof payload === 'string' ? payload : undefined)
  } catch {
    // non-JSON error body; keep the status line only
  }
  return detail !== undefined && String(detail).length > 0
    ? `Yandex Search API error (HTTP ${response.status}): ${String(detail)}`
    : `Yandex Search API error (HTTP ${response.status})`
}

/** Normalize the API payload (base64-XML in rawData) into sources. */
export function parsePayload(payload, maxResults) {
  if (payload === null || typeof payload !== 'object') {
    throw new YandexApiError('Unexpected Yandex Search API payload shape')
  }
  if (typeof payload.rawData === 'string') {
    return parseRawDataXml(payload.rawData, maxResults)
  }
  if (typeof payload.error !== 'undefined' || typeof payload.message !== 'undefined') {
    throw new YandexApiError(`Yandex Search API error: ${JSON.stringify(payload.error ?? payload.message)}`)
  }
  // Some gateway variants return the docs directly under JSON keys.
  if (Array.isArray(payload.documents)) return payload.documents.slice(0, maxResults)
  throw new YandexApiError(`Yandex Search API payload has no rawData field: ${JSON.stringify(payload).slice(0, 200)}`)
}

/** Decode base64 XML and extract <doc> entries. */
function parseRawDataXml(rawData, maxResults) {
  // Buffer.from(x, 'base64') never throws (it silently skips invalid chars),
  // so validate the alphabet up front — otherwise a malformed payload would
  // decode to garbage and be reported as "no results".
  const cleaned = rawData.replace(/\s+/gu, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new YandexApiError('Yandex rawData is not valid base64')
  }
  const xml = Buffer.from(cleaned, 'base64').toString('utf8')
  const xmlError = yandexXmlError(xml)
  if (xmlError !== undefined) {
    // code 15 ("комбинация слов нигде не встречается") means a legitimately
    // empty hit list — surface it as no results rather than a failure.
    if (xmlError.code === '15') return []
    throw new YandexApiError(
      `Yandex Search API XML error (code ${xmlError.code ?? 'unknown'}): ${xmlError.message || 'no message'}`,
    )
  }
  return parseDocsXml(xml, maxResults)
}

/**
 * Locate a Yandex `<error …>…</error>` element in the result XML. Undefined
 * when the document contains no error. Yandex reports «no results» as
 * `<error code="15">` and backend failures under other codes.
 */
function yandexXmlError(xml) {
  const full = /<error\b([^>]*)>([\s\S]*?)<\/error>/i.exec(xml)
  const open = full ?? /<error\b([^>]*)\/>/i.exec(xml)
  if (!open) return undefined
  const codeMatch = /code\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(open[1])
  const code = codeMatch ? (codeMatch[1] ?? codeMatch[2] ?? codeMatch[3]) : undefined
  const message = full ? decodeXmlEntities(full[2].replace(/\s+/gu, ' ').trim()) : ''
  return { code, message }
}

/** Strip Yandex's <hlword> query-highlight tags (present in titles and passages). */
function stripHighlightTags(text) {
  if (text === undefined) return text
  return text.replace(/<\/?hlword[^>]*>/giu, '')
}

/** Extract url/title/passages from a Yandex <doc> XML document. */
export function parseDocsXml(xml, maxResults) {
  const sources = []
  const docRe = /<doc\b[^>]*>([\s\S]*?)<\/doc>/gi
  let match
  while ((match = docRe.exec(xml)) !== null && sources.length < maxResults) {
    const inner = match[1]
    const url = decodeXmlEntities(first(inner, /<url\b[^>]*>([\s\S]*?)<\/url>/i))
    if (url === undefined || url.length === 0) continue
    const title = stripHighlightTags(decodeXmlEntities(first(inner, /<title\b[^>]*>([\s\S]*?)<\/title>/i)))
    const passages = [...inner.matchAll(/<passage\b[^>]*>([\s\S]*?)<\/passage>/gi)]
      .map((m) => stripHighlightTags(decodeXmlEntities(m[1])).replace(/\s+/gu, ' ').trim())
      .filter((text) => text.length > 0)
    const source = { url }
    if (title !== undefined && title.length > 0) source.title = title
    if (passages.length > 0) source.snippet = passages.join(' ')
    sources.push(source)
  }
  return sources
}

function first(text, re) {
  const match = re.exec(text)
  return match === null ? undefined : match[1]
}
