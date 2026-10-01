/**
 * Anthropic Messages API subset used by the DeepSeek Harness
 * `web-search-deepseek` provider (its `web_search_20250305` server tool).
 *
 * Request (what the provider sends to `{baseURL}/messages`):
 *   messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web
 *               search for the query: <query>' }] }]
 *   tools:    [{ type: 'web_search_20250305', name: 'web_search', max_uses }]
 *
 * Response (what `mapAnthropicResponse` in the provider accepts):
 *   content: [
 *     { type: 'web_search_tool_result',
 *       content: [{ type: 'web_search_result', url, title?, page_age? }] },
 *     { type: 'text', text, citations: [{ type: 'char_location', url, cited_text }] }
 *   ]
 *
 * The provider throws unless at least one `web_search_tool_result` block is
 * present, so the server always emits one (empty `content` = "no results").
 */

import { randomBytes } from 'node:crypto'

/** Prefix the DeepSeek Harness provider puts around every query. */
const QUERY_PREFIX = 'Perform a web search for the query:'

/** Maximum characters taken from one text block as a query. */
const MAX_QUERY_LENGTH = 2_000

export class MessagesRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MessagesRequestError'
  }
}

/**
 * Extract the search query from a DeepSeek-Harness-shaped Messages body.
 * @param {object} body - parsed POST body.
 * @returns {string} the trimmed query.
 */
export function extractQuery(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new MessagesRequestError('missing messages[] in request body')
  }
  const texts = []
  for (const message of body.messages) {
    const content = message?.content
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      }
    }
  }
  const raw = texts.join(' ')
  let query = raw.trim()
  if (query.toLowerCase().startsWith(QUERY_PREFIX.toLowerCase())) {
    query = query.slice(QUERY_PREFIX.length).trim()
  }
  if (query.length === 0) throw new MessagesRequestError('no text content to search for in messages[]')
  return query.slice(0, MAX_QUERY_LENGTH)
}

/**
 * Build the Anthropic Messages response for a set of sources.
 * @param {object} opts
 * @param {string} opts.query - the search query.
 * @param {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>} opts.sources
 * @param {string} [opts.model] - echo the requested model id when provided.
 * @returns {object} the response body as the provider expects it.
 */
export function buildResponse({ query, sources, model }) {
  const resultItems = sources.map((source) => {
    const item = { type: 'web_search_result', url: source.url }
    if (source.title !== undefined && source.title.length > 0) item.title = source.title
    if (source.publishedAt !== undefined && source.publishedAt.length > 0) item.page_age = source.publishedAt
    return item
  })

  const citations = sources
    .filter((source) => source.snippet !== undefined && source.snippet.length > 0)
    .map((source) => ({ type: 'char_location', url: source.url, cited_text: source.snippet }))

  const summaryLines = sources.map((source) => {
    const label = source.title !== undefined && source.title.length > 0 ? source.title : source.url
    return `- ${label}: ${source.url}`
  })
  const summary = sources.length === 0
    ? `No results found for "${query}".`
    : `Search results for "${query}":\n${summaryLines.join('\n')}`

  return {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: model !== undefined && model.length > 0 ? model : 'yandex-search-proxy',
    content: [
      {
        type: 'web_search_tool_result',
        content: resultItems,
      },
      {
        type: 'text',
        text: summary,
        ...(citations.length > 0 ? { citations } : {}),
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}
