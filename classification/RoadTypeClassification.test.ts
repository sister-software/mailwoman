/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { RoadTypeClassification as Classification } from "./RoadTypeClassification.js"

test("constructor", (t) => {
	const c = new Classification()
	t.equals(c.label, "road_type")
	t.equals(c.confidence, 1.0)
	t.deepEqual(c.meta, {})
	t.end()
})
