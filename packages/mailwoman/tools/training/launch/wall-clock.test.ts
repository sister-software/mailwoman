// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { checkWallClock, estimateWallClock, TRAIN_TIMEOUT_SECONDS } from "#tools/training/launch/wall-clock"

describe("the launch wall-clock check", () => {
	it("estimates a 90,000-step A100 run evaluated every 2,000 steps inside the timeout", () => {
		const estimate = checkWallClock(
			"A100",
			{ maxSteps: 90_000, evalEverySteps: 2000, batchSize: 128 },
			TRAIN_TIMEOUT_SECONDS
		)

		// 90,000 × 5.0 / 100 × 1.15 is 5,175 s of steps, truncated to whole seconds.
		// The validation passes add 46 × 15 = 690 s, and the allowance adds 1,800 s.
		expect(estimate).toMatchObject({ device: "A100-40GB", trainSeconds: 5175, evaluations: 46, totalSeconds: 7665 })
	})

	it("estimates v8.17.0's 23,752-step stage 2 at batch 512 on an A100 inside the timeout", () => {
		const estimate = checkWallClock(
			"A100",
			{ maxSteps: 23_752, evalEverySteps: 500, batchSize: 512 },
			TRAIN_TIMEOUT_SECONDS
		)

		// 23,752 × 20 / 100 × 1.15 is 5,462.96 s of steps, truncated to 5,462.
		// The validation passes add 48 × 15 = 720 s, and the allowance adds 1,800 s.
		expect(estimate).toMatchObject({
			device: "A100-40GB",
			secondsPer100Steps: 20,
			trainSeconds: 5462,
			evaluations: 48,
			totalSeconds: 7982,
		})
	})

	it("refuses a device or batch size with no observed rate", () => {
		expect(() => estimateWallClock("T4", { maxSteps: 100, evalEverySteps: 10, batchSize: 128 })).toThrow(/T4/)

		expect(() => estimateWallClock("A100", { maxSteps: 100, evalEverySteps: 10, batchSize: 256 })).toThrow(
			/batch_size=256/
		)
	})

	it("refuses a run whose estimate exceeds the timeout", () => {
		expect(() =>
			checkWallClock("cpu", { maxSteps: 200_000, evalEverySteps: 1000, batchSize: 8 }, TRAIN_TIMEOUT_SECONDS)
		).toThrow(/sandbox timeout is 32400s/)
	})
})
