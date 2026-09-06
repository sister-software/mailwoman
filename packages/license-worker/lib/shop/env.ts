/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The Stripe secret keys `mwops shop` reads on the operator's machine. These are process environment, not worker
 *   bindings: the deployed worker reads `STRIPE_SECRET_KEY` from Wrangler (`#env`).
 */

import { $private as corePrivate, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Stripe secret keys for shop reconciliation, one per mode so a live write is a deliberate act. Never log their values.
 */
const PrivateShopEnvSchema = z.object({
	/**
	 * The test-mode secret key (`sk_test_…`): `mwops shop … --mode test` provisions the sandbox twins of the shop's
	 * Stripe objects with it and refuses any other prefix.
	 */
	MAILWOMAN_STRIPE_SECRET_KEY: z.string().optional().meta({
		title: "Stripe test-mode secret key",
		description: "Test-mode Stripe secret key used by `mwops shop … --mode test`.",
	}),
	/**
	 * The live-mode secret key (`sk_live_…`), held apart from the test one so a live write is a deliberate act: `mwops
	 * shop … --mode live` reads this and refuses any other prefix.
	 */
	MAILWOMAN_STRIPE_LIVE_SECRET_KEY: z.string().optional().meta({
		title: "Stripe live-mode secret key",
		description: "Live-mode Stripe secret key used by `mwops shop … --mode live`.",
	}),
})

/**
 * Live shop credentials over core's. Never log their values.
 */
export const $private = liveEnv(PrivateShopEnvSchema, corePrivate)
