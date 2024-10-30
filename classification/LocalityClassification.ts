/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class LocalityClassification extends Classification {
	public override readonly label = "locality"
	public override readonly public = true
}

export default LocalityClassification
