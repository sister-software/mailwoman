/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs a rehearsal purchase and renewal against a deployed worker in Stripe test mode.
 *
 *   The rehearsal creates a customer on a Stripe test clock and a Checkout Session with the same
 *   `checkoutCollection` settings as the Payment Link. A person pays in a browser with the test card.
 *   The rehearsal then advances the clock past the period end, and Stripe delivers the renewal's
 *   `invoice.paid` event to the worker. The claim route should then return the renewed token.
 *
 *   Payment Links cannot use a test clock, so the rehearsal creates its own Checkout Session.
 */

import type Stripe from "stripe"

import { type ClaimResponse, parseClaimResponse } from "#claim-interface"
import { calendarDateUTC, plusDays } from "#dates"
import { GRACE_DAYS } from "#plans"
import { checkoutCollection, type ShopPlan, shopURLs } from "#shop/catalog"
import { idOf } from "#stripe/shapes"

/**
 * The Stripe objects created by {@link startRehearsal}.
 */
export interface RehearsalStart {
	clock: string
	customer: string
	session: string
	/**
	 * The Checkout URL where the person pays.
	 */
	url: string
}

/**
 * Options for {@link startRehearsal}.
 */
export interface StartRehearsalInput {
	siteOrigin: string
	plan: ShopPlan["code"]
	licensee: string
	email: string
	/**
	 * Returns the current time in milliseconds, which becomes the clock's frozen time.
	 * Defaults to `Date.now`.
	 */
	now?: () => number
}

/**
 * Creates the test clock, customer and Checkout Session, and returns the payment URL.
 *
 * The function looks up the provisioned Price by lookup key.
 * It throws when no such Price exists in the current mode.
 */
export async function startRehearsal(stripe: Stripe, input: StartRehearsalInput): Promise<RehearsalStart> {
	const listed = await stripe.prices.list({ lookup_keys: [input.plan], active: true, limit: 1 })
	const price = listed.data[0]

	if (!price) throw new Error(`no active Price carries the lookup key ${input.plan}; run shop provision first`)

	const frozenTime = Math.floor((input.now ?? Date.now)() / 1000)
	const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozenTime, name: "mailwoman rehearsal" })
	const customer = await stripe.customers.create({ test_clock: clock.id, email: input.email, name: input.licensee })
	const urls = shopURLs(input.siteOrigin)

	const session = await stripe.checkout.sessions.create({
		mode: "subscription",
		customer: customer.id,
		line_items: [{ price: price.id, quantity: 1 }],
		success_url: urls.successURL,
		cancel_url: urls.licenseURL,
		...checkoutCollection(input.plan),
	})

	if (!session.url) throw new Error(`Checkout Session ${session.id} carries no URL to pay at`)

	return { clock: clock.id, customer: customer.id, session: session.id, url: session.url }
}

/**
 * The issue and expiry dates of one license token.
 */
export interface TokenDates {
	issued: string
	expires: string
}

/**
 * The result of {@link advanceRehearsal}.
 */
export interface RehearsalRenewal {
	subscription: string
	clock: string
	first: TokenDates
	renewed: TokenDates
	/**
	 * The subscription's period end after the advance, as a UTC calendar date.
	 */
	periodEnd: string
	/**
	 * The expected `expires` of the renewed token, which is `periodEnd` plus the grace period.
	 */
	expected: string
	agrees: boolean
}

/**
 * Options for {@link advanceRehearsal}.
 */
export interface AdvanceRehearsalInput {
	session: string
	workerOrigin: string
	/**
	 * Number of days to advance the clock.
	 *
	 * It must pass one billing period plus Stripe's renewal window.
	 */
	days: number
	fetch?: typeof fetch
	/**
	 * Waits between polls.
	 * Tests pass a function that returns immediately.
	 */
	sleep?: (ms: number) => Promise<void>
	pollMs?: number
	/**
	 * Maximum polls per wait before the rehearsal gives up.
	 */
	attempts?: number
	log?: (line: string) => void
}

const DEFAULT_POLL_MS = 5000
const DEFAULT_ATTEMPTS = 60

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

async function readClaim(fetchFn: typeof fetch, workerOrigin: string, session: string): Promise<ClaimResponse> {
	const response = await fetchFn(`${workerOrigin}/v1/checkout-sessions/${session}/license`, {
		headers: { accept: "application/json" },
	})

	if (!response.ok) throw new Error(`the claim route answered ${response.status} for ${session}`)

	const claim = parseClaimResponse(await response.json())

	if (!claim) throw new Error(`the claim route answered a body that is no claim for ${session}`)

	return claim
}

/**
 * Waits for the first token, advances the test clock and waits for the renewed token.
 *
 * The worker issues tokens only after Stripe delivers a webhook, so a timeout
 * usually points to the webhook destination.
 */
export async function advanceRehearsal(stripe: Stripe, input: AdvanceRehearsalInput): Promise<RehearsalRenewal> {
	const fetchFn = input.fetch ?? fetch
	const sleep = input.sleep ?? defaultSleep
	const pollMs = input.pollMs ?? DEFAULT_POLL_MS
	const attempts = input.attempts ?? DEFAULT_ATTEMPTS
	const log = input.log ?? (() => {})

	const waitFor = async <T>(what: string, read: () => Promise<T | undefined>): Promise<T> => {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const value = await read()

			if (value !== undefined) return value

			await sleep(pollMs)
		}

		throw new Error(`gave up waiting for ${what} after ${attempts} polls`)
	}

	const issuedClaim = async (after?: TokenDates): Promise<TokenDates | undefined> => {
		const claim = await readClaim(fetchFn, input.workerOrigin, input.session)

		if (claim.status === "revoked") throw new Error(`the license behind ${input.session} is revoked`)

		if (claim.status !== "issued") return undefined

		return after && claim.expires === after.expires ? undefined : { issued: claim.issued, expires: claim.expires }
	}

	const session = await stripe.checkout.sessions.retrieve(input.session)
	const subscriptionID = idOf(session.subscription)
	const customerID = idOf(session.customer)

	if (!subscriptionID || !customerID) throw new Error(`${input.session} is not a paid subscription session`)

	const customer = await stripe.customers.retrieve(customerID)
	const clockID = customer.deleted ? undefined : idOf(customer.test_clock)

	if (!clockID) throw new Error(`customer ${customerID} is not on a test clock; start the rehearsal with shop rehearse`)

	const first = await waitFor("the first token", () => issuedClaim())

	log(`first token: issued ${first.issued}, expires ${first.expires}`)

	const clock = await stripe.testHelpers.testClocks.retrieve(clockID)
	const target = clock.frozen_time + input.days * 86_400

	await stripe.testHelpers.testClocks.advance(clockID, { frozen_time: target })
	log(`advancing ${clockID} to ${calendarDateUTC(target)}`)

	await waitFor("the clock", async () => {
		const state = await stripe.testHelpers.testClocks.retrieve(clockID)

		if (state.status === "internal_failure") throw new Error(`test clock ${clockID} failed to advance`)

		return state.status === "ready" ? state : undefined
	})

	const renewed = await waitFor("the renewal token", () => issuedClaim(first))

	log(`renewed token: issued ${renewed.issued}, expires ${renewed.expires}`)

	const subscription = await stripe.subscriptions.retrieve(subscriptionID)
	const item = subscription.items.data[0]

	if (!item) throw new Error(`subscription ${subscriptionID} carries no item`)

	const periodEnd = calendarDateUTC(item.current_period_end)
	const expected = plusDays(periodEnd, GRACE_DAYS)

	return {
		subscription: subscriptionID,
		clock: clockID,
		first,
		renewed,
		periodEnd,
		expected,
		agrees: renewed.expires === expected,
	}
}
