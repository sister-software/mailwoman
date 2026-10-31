/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { IGNORE_INDEX } from "@mailwoman/neural/labels"
import { expect, test } from "vitest"

import { failingLabelFloors, headLabels } from "./support.ts"

const BIO = ["O", "B-street", "I-street", "B-po_box", "I-po_box"]
const floor = (label: string, minRows: number, split = "val") => ({ label, split, min_rows: minRows })

test("a row holds the labels whose B- tag one of its pieces carries", () => {
	expect(headLabels([0, 1, 2, IGNORE_INDEX, 3], BIO)).toEqual(["street", "po_box"])
})

test("an I- tag without its B- tag does not hold the label", () => {
	expect(headLabels([0, 2, 4], BIO)).toEqual([])
})

test("a met floor reports no failure, a missed one reports the count reached", () => {
	expect(failingLabelFloors({ val: { street: 10 } }, [floor("street", 10)])).toEqual([])

	expect(failingLabelFloors({ val: { po_box: 3 } }, [floor("po_box", 40)])).toEqual([
		{ label: "po_box", split: "val", rows: 3, min_rows: 40, because: "3 rows hold po_box against a floor of 40" },
	])
})

test("a label the split holds no row for fails at zero", () => {
	expect(failingLabelFloors({ val: {} }, [floor("cedex", 1)])[0]).toMatchObject({ rows: 0 })
})

test("a split that was not counted is unmeasured rather than zero", () => {
	expect(failingLabelFloors({ val: {} }, [floor("street", 1, "test")])[0]).toMatchObject({
		rows: null,
		because: "split 'test' was not counted",
	})
})
