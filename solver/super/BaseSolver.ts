/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../../tokenization/Tokenizer.js"

export interface Solver {
	setup?(): void

	solve(tokenizer: Tokenizer): void
}
