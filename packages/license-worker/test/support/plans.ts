/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Price id a plan carries under the test environment, read from the catalog the worker reads.
 */

import type { LicenseWorkerEnv } from "@mailwoman/license-worker/env"
import { planCatalog } from "@mailwoman/license-worker/plans"

export function priceOf(env: LicenseWorkerEnv, code: "commercial-monthly-v1" | "commercial-yearly-v1"): string {
	const plan = planCatalog(env).find((candidate) => candidate.code === code)

	if (!plan) throw new Error(`no plan ${code}`)

	return plan.stripePriceID
}
