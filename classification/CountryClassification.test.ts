/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { CountryClassification as Classification } from "./CountryClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.true(c.public)
	t.equals(c.label, "country")
	t.equals(c.confidence, 0.9)
	t.deepEqual(c.meta, {})
	t.end()
})
