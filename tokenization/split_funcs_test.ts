/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import * as funcs from "./split_funcs.js"

test("exports: fieldsFuncBoundary", (t) => {
	t.deepEquals("function", typeof funcs.fieldsFuncBoundary)
	t.deepEquals(1, funcs.fieldsFuncBoundary.length)
	t.end()
})
test("exports: fieldsFuncWhiteSpace", (t) => {
	t.deepEquals("function", typeof funcs.fieldsFuncWhiteSpace)
	t.deepEquals(1, funcs.fieldsFuncWhiteSpace.length)
	t.end()
})
test("fieldsFuncBoundary", (t) => {
	t.true(funcs.fieldsFuncBoundary(","))
	t.true(funcs.fieldsFuncBoundary("\n"))
	t.true(funcs.fieldsFuncBoundary("\t"))
	t.true(funcs.fieldsFuncBoundary('"'))
	t.false(funcs.fieldsFuncBoundary("A"))
	t.false(funcs.fieldsFuncBoundary("1"))
	t.end()
})

test("fieldsFuncWhiteSpace", (t) => {
	t.true(funcs.fieldsFuncWhiteSpace(" "))
	t.true(funcs.fieldsFuncWhiteSpace("\xa0")) // non-breaking space
	t.true(funcs.fieldsFuncWhiteSpace("\t"))
	t.true(funcs.fieldsFuncWhiteSpace("\n"))
	t.false(funcs.fieldsFuncWhiteSpace("A"))
	t.false(funcs.fieldsFuncWhiteSpace("1"))
	t.end()
})
