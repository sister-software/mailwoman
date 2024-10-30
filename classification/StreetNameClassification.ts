/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StreetNameClassification extends Classification {
	public override readonly label = "street_name"
}

export default StreetNameClassification
