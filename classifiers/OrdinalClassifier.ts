/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier } from "@mailwoman/core"

let ord = ""
ord += "((1)st?|(2)nd?|(3)rd?|([4-9])th?)" // singles
ord += "|" // or
ord += "(0*([0-9]*)(1[0-9])th?)" // teens
ord += "|" // or
ord += "(0*([0-9]*[02-9])((1)st?|(2)nd?|(3)rd?|([04-9])th?))" // the rest

const regex = new RegExp(`^${ord}$`, "i")

export class OrdinalClassifier extends WordClassifier {
	public explore(span: Span): void {
		if (!span.flags.has("numeral")) return

		if (regex.test(span.normalized)) {
			span.classifications.add("ordinal")
		}
	}
}
