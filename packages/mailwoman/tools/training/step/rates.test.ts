/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { measureTrainLog } from "./rates.ts"

describe("measureTrainLog", () => {
	it("measures an uninterrupted run", () => {
		const csv = ["step,elapsed,loss", "100,10,2.0", "200,20,1.5", "200,21,eval"].join("\n")

		expect(measureTrainLog(csv)).toEqual({ finalStep: 200, wallSeconds: 21, secondsPer100Steps: 10.5, restarts: 0 })
	})

	it("sums each segment once when the process restarts", () => {
		const csv = ["step,elapsed", "100,10", "200,20", "150,0", "300,15"].join("\n")

		expect(measureTrainLog(csv)).toMatchObject({ finalStep: 300, wallSeconds: 35, restarts: 1 })
	})

	it("measures a resumed clock from the restart row", () => {
		const csv = ["step,elapsed", "100,10", "200,20", "150,25", "300,40"].join("\n")

		expect(measureTrainLog(csv)).toMatchObject({ wallSeconds: 35, restarts: 1 })
	})

	it("refuses a log without numeric rows", () => {
		expect(() => measureTrainLog("step,elapsed\n")).toThrow(/no rows/)
	})
})
