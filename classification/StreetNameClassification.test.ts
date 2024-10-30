/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { StreetNameClassification as Classification } from "./StreetNameClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.equals(c.label, "street_name")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
