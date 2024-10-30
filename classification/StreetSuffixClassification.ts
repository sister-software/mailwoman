/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StreetSuffixClassification extends Classification {
	public override readonly label = "street_suffix"
}

export default StreetSuffixClassification
