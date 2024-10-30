/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class AdjacentClassification extends Classification {
	public override readonly label = "adjacent"
}

export default AdjacentClassification
