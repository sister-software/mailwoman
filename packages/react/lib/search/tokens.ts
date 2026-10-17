/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   How a docs search query divides into terms. The query code matches these terms against the index,
 *   and the modal emphasizes the same terms in a hit's title, so the two agree on what matched.
 */

/**
 * The parts of the text that the index tokenizer can index: its runs of letters and digits.
 *
 * The index drops term positions, so a quoted FTS5 string must hold one token.
 * The text is split where the `unicode61` tokenizer splits it, at any character
 * that is neither a letter nor a digit.
 */
export function queryTokens(text: string): string[] {
	return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== "")
}
