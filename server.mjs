/**
 * Local Anthropic Messages API proxy for the DeepSeek Harness `web_search`
 * tool, backed by Yandex search. This is **Variant A** — a standalone process
 * the harness's `web-search-deepseek` plugin is pointed at via its endpoint;
 * the native in-process provider plugin (Variant B, `plugin/`) does not go
 * through this HTTP contract.
 *
 * Point the harness's web-search-deepseek plugin at this server (base URL) and
 * it keeps using the exact same model-facing `web_search` tool while the
 * searches run through Yandex under the hood.
 *
 * Routes:
 *   POST /messages, /v1/messages, /anthropic/v1/messages — the Messages call
 *   GET  /healthz — status probe
 *   GET  /        — setup instructions
 */

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { loadConfig, effectiveBackend, hasApiCredentials } from './lib/config.mjs'
import * as yandexApi from './lib/yandex-api.mjs'
import * as yandexScrape from './lib/yandex-scrape.mjs'
import * as mock from './lib/mock.mjs'
import { extractQuery, buildResponse, MessagesRequestError } from './lib/messages.mjs'

const VERSION = '0.1.0'
const MESSAGES_PATHS = new Set(['/messages', '/v1/messages', '/anthropic/v1/messages'])

/** Pick the backend module for an effective backend name. */
function backendModule(name) {
  switch (name) {
    case 'api': return yandexApi
    case 'scrape': return yandexScrape
    case 'mock': return mock
    default: throw new Error(`unknown backend ${name}`)
  }
}

/** Run one backend search, returning a normalized source list. */
async function runBackend({ config, query, signal }) {
  const name = effectiveBackend(config)
  const backend = backendModule(name)
  return backend.search({ query, config, signal })
}

/**
 * Handle one POST /messages request body.
 * @param {object} body - parsed JSON body.
 * @param {object} ctx - { config, signal }
 * @returns {Promise<object>} the Messages response body.
 */
async function handleMessages(body, { config, signal }) {
  const query = extractQuery(body)
  const model = typeof body.model === 'string' ? body.model : undefined
  const sources = await runBackend({ config, query, signal })
  return buildResponse({ query, sources, model })
}

/** Read the request body with a byte cap. */
function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        // Reject once, then keep draining so the client can finish sending
        // and receive the 400 response instead of a connection reset.
        if (!tooLarge) {
          tooLarge = true
          reject(new MessagesRequestError('request body too large'))
        }
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => {
      if (!tooLarge) reject(error)
    })
  })
}

function json(response, statusCode, payload) {
  // The client may have disconnected while the backend was still running
  // (abort); writing to a destroyed/ended response would throw.
  if (response.writableEnded || response.destroyed) return
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function text(response, statusCode, body) {
  if (response.writableEnded || response.destroyed) return
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Map a backend/provider error into a faithful Anthropic-style error body. */
function adapterError(response, statusCode, message) {
  json(response, statusCode, { type: 'error', error: { type: 'api_error', message } })
}

export function createProxyServer(config) {
  const startedAt = Date.now()
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname === '/healthz') {
      const backend = effectiveBackend(config)
      json(response, 200, {
        ok: true,
        service: 'dsh-websearch-yandex-proxy',
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        backend,
        backendConfigured: backend === 'api' ? hasApiCredentials(config) : true,
        yandexApiCredentials: hasApiCredentials(config),
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/') {
      text(response, 200, banner(config))
      return
    }

    if (request.method !== 'POST') {
      return json(response, 405, { error: { type: 'invalid_request_error', message: 'method not allowed; use POST' } })
    }

    if (!MESSAGES_PATHS.has(url.pathname)) {
      return json(response, 404, { error: { type: 'invalid_request_error', message: `unknown path ${url.pathname}` } })
    }

    let body
    try {
      const raw = await readBody(request, config.maxRequestBytes)
      body = raw.length === 0 ? {} : JSON.parse(raw)
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'request body is not valid JSON'
        : error instanceof MessagesRequestError
          ? error.message
          : `failed to read request body: ${String(error)}`
      return adapterError(response, 400, message)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`backend timed out after ${config.requestTimeoutMs} ms`)), config.requestTimeoutMs)
    // A client disconnect (e.g. the harness's web_search call was cancelled)
    // aborts the in-flight backend search too, so upstream work stops and the
    // failure path maps to the same 504/abort semantics as a timeout. On
    // modern Node the reliable signal is the response socket closing before
    // the response was ended; `request`'s 'aborted' is kept as a fallback.
    const disconnect = () => controller.abort(new Error('client disconnected'))
    response.on('close', () => { if (!response.writableEnded) disconnect() })
    request.on('aborted', disconnect)
    try {
      const result = await handleMessages(body, { config, signal: controller.signal })
      json(response, 200, result)
    } catch (error) {
      if (error instanceof MessagesRequestError) {
        adapterError(response, 400, error.message)
      } else if (controller.signal.aborted) {
        // Checked before the backend error types: an abort is wrapped by the
        // backends into their own error classes, and a timeout must surface
        // as 504 rather than their default 502.
        const reason = controller.signal.reason
        const detail = reason instanceof Error ? reason.message : String(reason ?? '')
        adapterError(response, 504, `search aborted or timed out: ${detail}`)
      } else if (error instanceof yandexApi.YandexApiError || error instanceof yandexScrape.YandexScrapeError) {
        adapterError(response, error.status ?? 502, `${error.message}`)
      } else {
        adapterError(response, 502, `search backend failed: ${String(error)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  })
}

function banner(config) {
  const backend = effectiveBackend(config)
  const lines = [
    `dsh-websearch-yandex-proxy v${VERSION}`,
    '',
    'This is a local drop-in endpoint for the DeepSeek Harness `web_search` tool',
    '(Anthropic Messages API, server tool web_search_20250305), backing searches',
    'through Yandex.',
    '',
    `Listening:             http://${config.host}:${config.port}`,
    `Search backend:        ${backend}${backend === 'api' ? ' (official Yandex Cloud Search API)' : ''}`,
    `Yandex API configured: ${hasApiCredentials(config) ? 'yes' : 'no (set YANDEX_API_KEY + YANDEX_FOLDER_ID)'}`,
    '',
    'Wire into the harness:',
    '  1. Keep this server running;',
    '  2. Settings > Plugins > Plugin configuration > Web search > Endpoint:',
    `     http://${config.host}:${config.port}/anthropic/v1`,
    '     (or launch the harness with DEEPSEEK_SEARCH_BASE_URL=' + `http://${config.host}:${config.port}/anthropic/v1` + ')',
    '  3. The model-facing web_search tool is unchanged.',
    '',
    'Try it:               ' + `curl -s http://${config.host}:${config.port}/healthz`,
    'Send a search:       ' + `curl -s -X POST http://${config.host}:${config.port}/anthropic/v1/messages`,
    '                     -H ' + "'content-type: application/json'",
    `                     -d '{"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: deepseek harness"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}'`,
  ]
  return lines.join('\n') + '\n'
}

/** Start the server for this module's default config (also the CLI entrypoint). */
export function start() {
  const config = loadConfig()
  const server = createProxyServer(config)
  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(banner(config))
  })
  return server
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start()
}

export default createProxyServer
