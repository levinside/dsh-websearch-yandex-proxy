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
      return isValidCodePoint(code) ? String.fromCodePoint(code) : full
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return isValidCodePoint(code) ? String.fromCodePoint(code) : full
    }
    const named = NAMED.get(entity)
    return named === undefined ? full : named
  })
}

/**
 * True for a code point `String.fromCodePoint` accepts and a hostile document
 * must not smuggle into output: positive, inside the Unicode range, and not a
 * UTF-16 surrogate. Invalid or malformed refs (`&#x110000;`, `&#0;`,
 * surrogates) stay as the literal entity instead of throwing a `RangeError`
 * out of the parser (NUL is refused too — it is not valid XML text content).
 */
function isValidCodePoint(code) {
  return Number.isInteger(code) && code > 0 && code <= 0x10FFFF
    && !(code >= 0xD800 && code <= 0xDFFF)
}
