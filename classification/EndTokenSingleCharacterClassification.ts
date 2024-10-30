/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class EndTokenSingleCharacterClassification extends Classification {
	public override readonly label = "end_token_single_character"
}

export default EndTokenSingleCharacterClassification
