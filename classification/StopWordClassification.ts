/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StopWordClassification extends Classification {
	public override readonly label = "stop_word"
}

export default StopWordClassification
