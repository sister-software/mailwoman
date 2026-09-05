/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { readEnv } from "#env"
import { planCatalog, planForPrice } from "#plans"

const worker = readEnv(env)

describe("the plan catalog", () => {
	it("maps exactly the two configured Price IDs to the two plan codes", () => {
		expect(
			planCatalog(worker)
				.map((plan) => plan.code)
				.toSorted()
		).toEqual(["commercial-monthly-v1", "commercial-yearly-v1"])

		expect(planForPrice(worker, worker.STRIPE_PRICE_MONTHLY)?.code).toBe("commercial-monthly-v1")
		expect(planForPrice(worker, worker.STRIPE_PRICE_YEARLY)?.code).toBe("commercial-yearly-v1")
	})

	it("answers nothing for a Price it was not configured with", () => {
		expect(planForPrice(worker, "price_somebody_elses")).toBeUndefined()
	})

	it("carries a 14-day grace on every plan, and no agreement version: that is the license's, recorded at purchase", () => {
		for (const plan of planCatalog(worker)) {
			expect(plan).not.toHaveProperty("agreement")
			expect(plan.graceDays).toBe(14)
			expect(plan.scope).toBe("all")
		}
	})
})
