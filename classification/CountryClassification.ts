/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification, ClassificationMetadata } from "./Classification.js"

export class CountryClassification extends Classification {
	public override readonly public = true
	public override readonly label = "country"

	constructor(_confidence?: number, meta?: ClassificationMetadata) {
		super(0.9, meta)
	}
}

export default CountryClassification
