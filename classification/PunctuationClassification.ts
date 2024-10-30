/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class PunctuationClassification extends Classification {
	public override readonly label = "punctuation"
}

export default PunctuationClassification
