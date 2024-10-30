/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { VenueClassification as Classification } from "./VenueClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.true(c.public)
	t.equals(c.label, "venue")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
