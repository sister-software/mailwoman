/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { AreaClassification as Classification } from "./AreaClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.false(c.public)
	t.equals(c.label, "area")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
