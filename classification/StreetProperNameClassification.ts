/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StreetProperNameClassification extends Classification {
	public override readonly label = "street_proper_name"
}

export default StreetProperNameClassification
