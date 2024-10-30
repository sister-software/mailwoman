/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"

export class PersonalTitleClassification extends Classification {
	public override readonly label = "personal_title"
}

export default PersonalTitleClassification
