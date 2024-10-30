/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class HouseNumberClassification extends Classification {
	public override readonly label = "housenumber"
	public override readonly public = true
}

export default HouseNumberClassification
