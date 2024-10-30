/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class SurnameClassification extends Classification {
	public override readonly label = "surname"
}

export default SurnameClassification
