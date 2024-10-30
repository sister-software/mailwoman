/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class DirectionalClassification extends Classification {
	public override readonly label = "directional"
}

export default DirectionalClassification
