/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StartTokenClassification extends Classification {
	public override readonly label = "start_token"
}

export default StartTokenClassification
