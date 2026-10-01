/**
 * Minimal XML entity decoding (no DOM dependency). Decodes the five named
 * XML/HTML entities plus numeric character references. Used on short extracted
 * substrings, so a light hand-rolled decoder is safe and predictable.
 */

const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

/** Decode XML/HTML entities in place. Numeric refs keep their code point. */
export function decodeXmlEntities(text) {
  if (text === undefined) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (full, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isNaN(code) ? full : String.fromCodePoint(code)
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isNaN(code) ? full : String.fromCodePoint(code)
    }
    const named = NAMED.get(entity)
    return named === undefined ? full : named
  })
}
