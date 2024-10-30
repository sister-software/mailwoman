/**
 * @copyright OpenISP, Inc.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { PlaceClassification as Classification } from "./PlaceClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.false(c.public)
	t.equals(c.label, "place")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
