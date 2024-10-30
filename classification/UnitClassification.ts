/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class UnitClassification extends Classification {
	public override readonly label = "unit"
	public override readonly public = true
}
