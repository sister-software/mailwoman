/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shop's operations for `mwops shop <operation>`: the same contract as the release registry (an id, a declared
 *   effect, zod input and output, `run`), so the operator CLI is a view over this list the way it is over the other
 *   two. `status` reads; `provision` writes to Stripe and, with `--apply`, to the two files that must carry what Stripe
 *   answered: the environment's Price ids in `wrangler.toml`, and for live mode the Payment Links in the site's shop
 *   module. The mode picks the key: `test` reads `MAILWOMAN_STRIPE_SECRET_KEY` and refuses anything but an `sk_test_`
 *   key; `live` reads `MAILWOMAN_STRIPE_LIVE_SECRET_KEY` and refuses anything but `sk_live_`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { defineOperation, OperationEffect, type ReleaseOperation } from "@mailwoman/release-kit"
import Stripe from "stripe"
import { z } from "zod"

import { AGREEMENT_VERSION, SHOP_PLANS } from "#shop/catalog"
import { $private } from "#shop/env"
import { type ProvisionReport, provisionShop } from "#shop/provision"
import { advanceRehearsal, startRehearsal } from "#shop/rehearse"
import { readEnvironmentVar, withEnvironmentVars } from "#shop/wrangler-vars"
import { STRIPE_API_VERSION } from "#stripe/client"

const ShopMode = z.enum(["test", "live"])

type ShopMode = z.infer<typeof ShopMode>

/**
 * The Wrangler environment each Stripe mode's ids belong to.
 */
const ENVIRONMENT_FOR_MODE: Record<ShopMode, "sandbox" | "production"> = { test: "sandbox", live: "production" }

const DEFAULT_SITE_ORIGIN = "https://mailwoman.ai"

function stripeFor(mode: ShopMode): Stripe {
	const key = mode === "live" ? $private.MAILWOMAN_STRIPE_LIVE_SECRET_KEY : $private.MAILWOMAN_STRIPE_SECRET_KEY
	const expectedPrefix = mode === "live" ? "sk_live_" : "sk_test_"
	const variable = mode === "live" ? "MAILWOMAN_STRIPE_LIVE_SECRET_KEY" : "MAILWOMAN_STRIPE_SECRET_KEY"

	if (!key) throw new Error(`${variable} is not set`)

	if (!key.startsWith(expectedPrefix)) {
		throw new Error(`${variable} is not a ${expectedPrefix} key; the ${mode} mode refuses any other`)
	}

	return new Stripe(key, { apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient() })
}

const ProvisionedObjectSchema = z.object({
	id: z.string().optional(),
	action: z.enum(["exists", "updated", "created", "missing", "blocked"]),
})

const ReportSchema = z.object({
	terms: z.object({ url: z.string(), consent: z.boolean() }),
	product: ProvisionedObjectSchema,
	prices: z.record(z.string(), ProvisionedObjectSchema),
	paymentLinks: z.record(
		z.string(),
		ProvisionedObjectSchema.extend({ url: z.string().optional(), consent: z.boolean(), promotionCodes: z.boolean() })
	),
	portal: ProvisionedObjectSchema,
	webhook: ProvisionedObjectSchema.extend({ url: z.string(), secret: z.string().optional() }).optional(),
})

const ProvisionInputSchema = z.object({
	mode: ShopMode,
	apply: z.boolean().optional(),
	"site-origin": z.string().optional(),
	"worker-origin": z.string().optional(),
})

interface WrittenFiles {
	wranglerToml?: string
	shopModule?: string
}

/**
 * Carry the ids Stripe answered into the files that must hold them: the environment's Price ids, and for live mode the
 * Payment Links the site renders. The webhook secret is never written; it goes to `wrangler secret put`.
 */
async function recordInRepository(
	mode: ShopMode,
	report: ProvisionReport,
	log: (line: string) => void
): Promise<WrittenFiles> {
	const written: WrittenFiles = {}
	const environment = ENVIRONMENT_FOR_MODE[mode]
	const monthly = report.prices["commercial-monthly-v1"].id
	const yearly = report.prices["commercial-yearly-v1"].id

	if (monthly && yearly) {
		const tomlPath = resolvePackagePath("@mailwoman/license-worker", "wrangler.toml")
		const toml = await readLocalTextFile(tomlPath)
		const next = withEnvironmentVars(toml, environment, { STRIPE_PRICE_MONTHLY: monthly, STRIPE_PRICE_YEARLY: yearly })

		if (next !== toml) {
			await writeLocalTextFile(next, tomlPath)
			written.wranglerToml = String(tomlPath)
		}

		const agreement = readEnvironmentVar(toml, environment, "AGREEMENT_VERSION")

		if (agreement !== AGREEMENT_VERSION) {
			log(
				`wrangler.toml [env.${environment}.vars] AGREEMENT_VERSION reads ${agreement}; the catalog sells ${AGREEMENT_VERSION}`
			)
		}
	}

	const links = SHOP_PLANS.map((plan) => report.paymentLinks[plan.code].url)

	if (mode === "live" && links.every((url): url is string => url !== undefined)) {
		const shopPath = resolvePackagePath("@mailwoman/license-worker", "lib", "sdk", "constants.ts")
		const source = await readLocalTextFile(shopPath)
		const [monthlyURL, yearlyURL] = links as [string, string]

		const next = source
			.replace(
				/^export const PAYMENT_LINK_MONTHLY = .*$/mu,
				`export const PAYMENT_LINK_MONTHLY = ${JSON.stringify(monthlyURL)}`
			)
			.replace(
				/^export const PAYMENT_LINK_YEARLY = .*$/mu,
				`export const PAYMENT_LINK_YEARLY = ${JSON.stringify(yearlyURL)}`
			)

		if (next !== source) {
			await writeLocalTextFile(next, shopPath)
			written.shopModule = String(shopPath)
		}
	}

	return written
}

const provisionOperation = defineOperation({
	id: "shop.provision",
	description:
		"Reconcile the Stripe account against the shop catalog: the Product, the two Prices, the two Payment Links, the portal configuration and, given --worker-origin, the webhook destination. Reports what exists and what is missing; --apply creates the missing objects and writes the Price ids into wrangler.toml (and, live, the Payment Links into lib/sdk/constants.ts).",
	effect: OperationEffect.ExternalWrite,
	inputSchema: ProvisionInputSchema,
	outputSchema: ReportSchema.extend({
		written: z.object({ wranglerToml: z.string().optional(), shopModule: z.string().optional() }),
	}),
	async run(input, context) {
		const apply = input.apply === true && !context.dryRun

		const report = await provisionShop(stripeFor(input.mode), {
			siteOrigin: input["site-origin"] ?? DEFAULT_SITE_ORIGIN,
			...(input["worker-origin"] ? { workerOrigin: input["worker-origin"] } : {}),
			apply,
			log: context.log,
		})

		if (!report.terms.consent) {
			context.log(
				`a Payment Link was not created: Stripe refused consent collection. Set ${report.terms.url} as the terms of service under the account's public details in the dashboard, then re-run.`
			)
		}

		if (report.webhook?.secret) {
			context.log(
				"the webhook signing secret is in this report once; store it with: wrangler secret put STRIPE_WEBHOOK_SECRET"
			)
		}

		const written = apply ? await recordInRepository(input.mode, report, context.log) : {}

		return { ...report, written }
	},
})

const statusOperation = defineOperation({
	id: "shop.status",
	description: "Read what the Stripe account holds against the shop catalog, writing nothing.",
	effect: OperationEffect.Read,
	inputSchema: z.object({
		mode: ShopMode,
		"site-origin": z.string().optional(),
		"worker-origin": z.string().optional(),
	}),
	outputSchema: ReportSchema,
	async run(input, context) {
		return await provisionShop(stripeFor(input.mode), {
			siteOrigin: input["site-origin"] ?? DEFAULT_SITE_ORIGIN,
			...(input["worker-origin"] ? { workerOrigin: input["worker-origin"] } : {}),
			apply: false,
			log: context.log,
		})
	},
})

const PLAN_CODES = SHOP_PLANS.map((plan) => plan.code) as [ShopPlanCode, ...ShopPlanCode[]]

type ShopPlanCode = (typeof SHOP_PLANS)[number]["code"]

const TokenDatesSchema = z.object({ issued: z.string(), expires: z.string() })

/**
 * Past one monthly period, with room for the renewal window Stripe opens before the period end.
 */
const DEFAULT_ADVANCE_DAYS = 32

const rehearseOperation = defineOperation({
	id: "shop.rehearse",
	description:
		"Start a rehearsal purchase in Stripe's test mode: a customer on a test clock and a Checkout Session shaped as the Payment Link is. Prints the URL to pay with the test card; then run shop.rehearse-renewal with the session id.",
	effect: OperationEffect.ExternalWrite,
	inputSchema: z.object({
		plan: z.enum(PLAN_CODES).optional(),
		licensee: z.string().optional(),
		email: z.string().optional(),
		"site-origin": z.string().optional(),
	}),
	outputSchema: z.object({ clock: z.string(), customer: z.string(), session: z.string(), url: z.string() }),
	async run(input, context) {
		if (context.dryRun) throw new Error("a rehearsal creates test-mode objects; there is no dry run of it")

		return await startRehearsal(stripeFor("test"), {
			siteOrigin: input["site-origin"] ?? DEFAULT_SITE_ORIGIN,
			plan: input.plan ?? "commercial-monthly-v1",
			licensee: input.licensee ?? "Rehearsal Licensee Ltd",
			email: input.email ?? "rehearsal@example.com",
		})
	},
})

const rehearseRenewalOperation = defineOperation({
	id: "shop.rehearse-renewal",
	description:
		"Second half of a rehearsal: wait for the worker to issue the first token, advance the test clock past the period end, and wait for the renewal's token. Reports both tokens' dates and whether the renewed expiry is the new period end plus the grace.",
	effect: OperationEffect.ExternalWrite,
	inputSchema: z.object({
		session: z.string(),
		"worker-origin": z.string(),
		days: z.number().int().positive().optional(),
	}),
	outputSchema: z.object({
		subscription: z.string(),
		clock: z.string(),
		first: TokenDatesSchema,
		renewed: TokenDatesSchema,
		periodEnd: z.string(),
		expected: z.string(),
		agrees: z.boolean(),
	}),
	async run(input, context) {
		if (context.dryRun) throw new Error("advancing a test clock is the rehearsal; there is no dry run of it")

		return await advanceRehearsal(stripeFor("test"), {
			session: input.session,
			workerOrigin: input["worker-origin"],
			days: input.days ?? DEFAULT_ADVANCE_DAYS,
			log: context.log,
		})
	},
})

/**
 * The registry `mwops shop` is a view over, in the order the usage lists them.
 */
export const shopOperations: ReadonlyArray<ReleaseOperation<unknown, unknown>> = [
	statusOperation,
	provisionOperation,
	rehearseOperation,
	rehearseRenewalOperation,
] as ReadonlyArray<ReleaseOperation<unknown, unknown>>
