/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class LevelClassification extends Classification {
	public override readonly label = "level"
	public override readonly public = true
}

export default LevelClassification
