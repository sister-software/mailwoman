/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StreetPrefixClassification extends Classification {
	public override readonly label = "street_prefix"
}

export default StreetPrefixClassification
