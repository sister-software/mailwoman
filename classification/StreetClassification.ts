/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class StreetClassification extends Classification {
	public override readonly label = "street"
	public override readonly public = true
}

export default StreetClassification
