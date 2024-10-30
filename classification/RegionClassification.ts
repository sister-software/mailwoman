/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class RegionClassification extends Classification {
	public override readonly label = "region"
	public override readonly public = true
}

export default RegionClassification
