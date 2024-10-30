/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class DependencyClassification extends Classification {
	public override readonly label = "dependency"
	public override readonly public = true
}

export default DependencyClassification
