/**
 * Official Yandex Cloud Search API v2 backend.
 *
 * Wire contract (verified against a working SearXNG engine implementation):
 *   POST https://searchapi.api.cloud.yandex.net/v2/web/search
 *   Authorization: Api-Key <AQVN...>        (the Yandex Cloud search API key)
 *   Content-Type: application/json
 *   body (camelCase): { query: { searchType, queryText, familyMode, page, fixTypoMode },
 *                     sortSpec, groupSpec, maxPassages, l10n, folderId, responseFormat: FORMAT_XML }
 *   response: { "rawData": "<base64-encoded XML>" } ; the XML holds <doc> entries
 *   with <url>, <title> and <passages><passage>…</passage></passages>.
 *
 * Requires YANDEX_API_KEY + YANDEX_FOLDER_ID (folder owning the key; the key's
 * service account needs the search-api.webSearch.user role).
 */

import { decodeXmlEntities } from './xml.mjs'

const USER_AGENT = 'dsh-web-search-yandex/0.1.0'

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
 * Run one search through the official Yandex Cloud Search API.
 * @param {object} opts
 * @param {string} opts.query - search text.
 * @param {object} opts.config - resolved proxy config.
 * @param {AbortSignal} [opts.signal] - cancellation signal.
 * @returns {Promise<Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>>}
 */
export async function search({ query, config, signal }) {
  if (!available(config)) {
    throw new YandexApiError(
      'Yandex Cloud Search API backend is not configured: set YANDEX_API_KEY and YANDEX_FOLDER_ID',
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

  let response
  try {
    response = await fetch(config.yandexSearchApiUrl, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'authorization': `Api-Key ${config.yandexApiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
      },
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
  return parsePayload(payload, config.maxResults)
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
  return parseDocsXml(xml, maxResults)
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
