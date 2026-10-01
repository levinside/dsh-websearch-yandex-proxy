/**
 * Deterministic fake backend for local testing and CI. Returns a stable,
 * query-titled source list. Never touches the network.
 */

/** Return canned sources; the query shows up in titles so tests can assert round-tripping. */
export async function search({ query, config }) {
  return [
    { url: `https://example.com/result-1?q=${encodeURIComponent(query)}`, title: `${query} — first result`, snippet: `Mocked snippet for "${query}" (one).` },
    { url: 'https://example.org/result-2', title: `${query} — second result`, snippet: `Mocked snippet for "${query}" (two).` },
    { url: 'https://example.net/result-3', title: `${query} — third result` },
  ].slice(0, config.maxResults)
}
