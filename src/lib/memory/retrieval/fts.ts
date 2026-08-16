/**
 * Convert untrusted user text into a literal-only FTS5 expression.
 *
 * Passing chat text directly to `MATCH` lets punctuation such as commas,
 * periods, quotes, and colons be interpreted as FTS operators or column
 * names.  Apart from noisy warnings, that makes memory retrieval unreliable
 * for normal sentences.  Quoted tokens joined with OR preserve useful recall
 * while preventing the input from becoming FTS syntax.
 */
export function toSafeFts5Query(input: string): string {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniqueTokens = [...new Set(tokens.map((token) => token.toLocaleLowerCase()))].slice(0, 32);

  if (uniqueTokens.length === 0) {
    return '"__bp_no_fts_terms__"';
  }

  return uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}
