/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "./Classification.js"

export class ToponymClassification extends Classification {
	public override readonly label = "toponym"
}

export default ToponymClassification
