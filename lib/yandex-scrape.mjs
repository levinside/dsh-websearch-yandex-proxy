/**
 * Best-effort Yandex SERP scraper backend (no API key required).
 *
 * This deliberately uses the public search page over a plain HTTPS GET. Yandex
 * may serve a SmartCaptcha to datacenter IPs or to automated fingerprints, so
 * this backend is a convenience fallback, not a hard guarantee. Prefer the
 * official Yandex Cloud Search API backend (YANDEX_API_KEY + YANDEX_FOLDER_ID).
 *
 * It parses `li.serp-item` blocks from the HTML: the first real <a href> as the
 * result URL (decoding Yandex's `url=...` redirect wrappers), the <h2> text as
 * title, and the OrganicTextContentSpan as snippet. Any captcha/interstitial
 * page is detected and reported explicitly.
 */

import { decodeXmlEntities } from './xml.mjs'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export class YandexScrapeError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message)
    this.name = 'YandexScrapeError'
    this.status = status
    this.cause = cause
  }
}

/**
 * Run one search against the public Yandex SERP.
 * @param {object} opts
 * @param {string} opts.query
 * @param {object} opts.config
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{url: string, title?: string, snippet?: string}>>}
 */
export async function search({ query, config, signal }) {
  const host = config.yandexScrapeHost
  const url = `https://${host}/search/?text=${encodeURIComponent(query)}`
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    })
  } catch (error) {
    throw new YandexScrapeError(`Yandex scrape fetch failed: ${String(error)}`, { cause: error })
  }
  const html = await response.text()
  if (isCaptcha(html)) {
    throw new YandexScrapeError(
      `Yandex served a captcha page for ${host} (HTTP ${response.status}). `
      + 'The scrape backend cannot search from this network. Configure the official API backend: '
      + 'set YANDEX_API_KEY and YANDEX_FOLDER_ID (see README).',
      { status: 503 },
    )
  }
  return parseSerp(html, config.maxResults)
}

/** Heuristics for a Yandex captcha / interstitial page. */
export function isCaptcha(html) {
  // Deliberately no bare 'captcha' marker: it false-positives on ordinary
  // results for queries *about* captchas (snippets mentioning the word).
  const markers = [
    'CheckboxCaptcha',
    'SmartCaptcha',
    'Если это не вы, просто закройте вкладку',
    'Подтвердите, что запросы отправляли вы',
    'showcaptcha',
    'captcha.yandex',
  ]
  const probe = html.slice(0, 400_000).toLowerCase()
  return markers.some((marker) => probe.includes(marker.toLowerCase()))
}

/** Extract serp items from the Yandex results HTML. */
export function parseSerp(html, maxResults) {
  const sources = []
  const itemRe = /<li\b[^>]*class="[^"]*serp-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let itemMatch
  while ((itemMatch = itemRe.exec(html)) !== null && sources.length < maxResults) {
    const block = itemMatch[1]
    const parsed = parseSerpItem(block)
    if (parsed !== undefined) sources.push(parsed)
  }
  return sources
}

/** Parse one serp-item block into a normalized source (undefined when unusable). */
export function parseSerpItem(block) {
  // Prefer <h2><a href=…>title</a></h2> (the organic title), then any link.
  const h2Link = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
  const linkSource = h2Link !== null ? h2Link[1] : block
  const hrefMatch = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(linkSource)
  if (hrefMatch === null) return undefined
  const rawHref = decodeHtml(hrefMatch[1])
  const url = resolveYandexUrl(rawHref)
  if (url === undefined || url === '' || url.startsWith('#')) return undefined
  if (isInternalYandex(url)) return undefined

  const title = stripTags(hrefMatch[2]).replace(/\s+/gu, ' ').trim()
  const snippetMatch = /class="[^"]*OrganicTextContentSpan[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
  const snippet = snippetMatch === null
    ? undefined
    : stripTags(snippetMatch[1]).replace(/\s+/gu, ' ').trim()

  const source = { url }
  if (title.length > 0) source.title = title
  if (snippet !== undefined && snippet.length > 0) source.snippet = snippet
  return source
}

/**
 * Decode Yandex redirect wrappers (`…?url=<encoded target>`) to the real URL.
 * The unwrapped target is a web_search result URL that ends up in the model's
 * context (and may later be fetched), so it is only accepted when it is a
 * public HTTP(S) URL: other schemes (`file:`, `gopher:`, …) and private /
 * loopback / link-local / metadata addresses are refused (SSRF hardening for
 * the fetched-URL path). An unsafe wrapper target resolves to `undefined` so
 * the caller drops the whole result item; plain non-wrapper hrefs pass
 * through unchanged.
 */
export function resolveYandexUrl(href) {
  let parsed
  try {
    parsed = new URL(href)
  } catch {
    return href
  }
  if (isYandexHost(parsed.hostname) && parsed.searchParams.has('url')) {
    const target = parsed.searchParams.get('url')
    if (target === null || target.length === 0) return href
    if (!isSafePublicHttpUrl(target)) return undefined
    return target
  }
  return href
}

/** True for Yandex-owned hosts (internationalized subdomains included). */
function isYandexHost(hostname) {
  return hostname === 'yandex.ru' || hostname.endsWith('.yandex.ru')
    || hostname === 'yandex.com' || hostname.endsWith('.yandex.com')
    || hostname === 'yandex.net' || hostname.endsWith('.yandex.net')
}

function isInternalYandex(url) {
  try {
    return isYandexHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** True for an absolute http(s) URL that must not point into private space. */
function isSafePublicHttpUrl(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return !isBannedHostname(parsed.hostname)
}

/** Loopback, link-local, metadata, and RFC-1918/unique-local addresses. */
function isBannedHostname(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true

  // IPv4 literals: block private, loopback, link-local, CGNAT, benchmark and 0.0.0.0.
  if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(h)) {
    const parts = h.split('.').map(Number)
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
    if (a === 192 && b === 168) return true           // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmark
  }

  // IPv6 literals: loopback, unspecified, link-local, unique-local.
  if (h === '::' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true

  return false
}

function stripTags(text) {
  // Strip raw markup first, then decode entities exactly once — a single-pass
  // decoder prevents double-decoding (e.g. `&amp;lt;` must stay `&lt;`).
  return decodeXmlEntities(text.replace(/<[^>]+>/gu, ' '))
}

function decodeHtml(text) {
  return decodeXmlEntities(text)
}
