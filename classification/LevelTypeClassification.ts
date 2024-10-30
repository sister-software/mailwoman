/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class LevelTypeClassification extends Classification {
	public override readonly label = "level_type"
	public override readonly public = true
}
