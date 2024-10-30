/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { AdjacentClassification } from "./AdjacentClassification.js"

test("constructor", (t) => {
	const c = new AdjacentClassification()
	t.false(c.public)
	t.equals(c.label, "adjacent")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
