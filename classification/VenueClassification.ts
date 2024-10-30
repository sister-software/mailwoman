/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class VenueClassification extends Classification {
	public override readonly label = "venue"
	public override readonly public = true
}

export default VenueClassification
