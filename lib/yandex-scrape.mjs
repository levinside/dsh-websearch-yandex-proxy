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

export function available() {
  return true
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
function isCaptcha(html) {
  const markers = [
    'CheckboxCaptcha',
    'SmartCaptcha',
    'captcha',
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

/** Decode Yandex redirect wrappers (`…?url=<encoded target>`) to the real URL. */
export function resolveYandexUrl(href) {
  try {
    const parsed = new URL(href)
    if ((parsed.hostname.endsWith('yandex.ru') || parsed.hostname.endsWith('yandex.com')
      || parsed.hostname.endsWith('yandex.net')) && parsed.searchParams.has('url')) {
      const target = parsed.searchParams.get('url')
      if (target !== null && target.length > 0) return target
    }
    return href
  } catch {
    return href
  }
}

function isInternalYandex(url) {
  try {
    const hostname = new URL(url).hostname
    return hostname === 'yandex.ru' || hostname.endsWith('.yandex.ru')
      || hostname === 'yandex.com' || hostname.endsWith('.yandex.com')
  } catch {
    return false
  }
}

function stripTags(text) {
  return text
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_full, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_full, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
}
