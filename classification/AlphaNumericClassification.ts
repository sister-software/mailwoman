/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class AlphaNumericClassification extends Classification {
	public override readonly label = "alphanumeric"
}

export default AlphaNumericClassification
