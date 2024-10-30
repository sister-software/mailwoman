/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class UnitTypeClassification extends Classification {
	public override readonly label = "unit_type"
	public override readonly public = true
}
