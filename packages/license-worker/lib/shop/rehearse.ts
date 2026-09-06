/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A rehearsal purchase against a deployed worker, in Stripe's test mode: a customer on a test clock, a Checkout
 *   Session shaped as the Payment Link is (the same `checkoutCollection`), paid by a person in a browser with the test
 *   card; then the clock advances past the period end, Stripe raises and pays the renewal invoice, delivers its
 *   `invoice.paid` to the worker, and the claim route hands back the second token. A Payment Link cannot carry a test
 *   clock, which is why the session is built here. Nothing is replayed or signed: the worker is exercised as a customer
 *   would exercise it, delivery included.
 */

import type Stripe from "stripe"

import { type ClaimResponse, parseClaimResponse } from "#claim-contract"
import { calendarDateUTC, plusDays } from "#dates"
import { GRACE_DAYS } from "#plans"
import { checkoutCollection, type ShopPlan, shopURLs } from "#shop/catalog"
import { idOf } from "#stripe/shapes"

export interface RehearsalStart {
	clock: string
	customer: string
	session: string
	/**
	 * Where the person pays.
	 */
	url: string
}

export interface StartRehearsalInput {
	siteOrigin: string
	plan: ShopPlan["code"]
	licensee: string
	email: string
	/**
	 * The clock's frozen time, in unix seconds; `Date.now` unless a test injects one.
	 */
	now?: () => number
}

/**
 * The first half: the objects, and the URL to pay. The Price is the provisioned one, found by lookup key as
 * `provisionShop` finds it; a missing Price means the shop was never provisioned in this mode.
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

export interface TokenDates {
	issued: string
	expires: string
}

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
	 * `periodEnd` plus the grace: what the renewed token's `expires` must read.
	 */
	expected: string
	agrees: boolean
}

export interface AdvanceRehearsalInput {
	session: string
	workerOrigin: string
	/**
	 * How far past the clock's frozen time to advance; past one monthly period, with room for Stripe's renewal window.
	 */
	days: number
	fetch?: typeof fetch
	/**
	 * Waits between polls; a test passes one that does not wait.
	 */
	sleep?: (ms: number) => Promise<void>
	pollMs?: number
	/**
	 * Polls per wait before the rehearsal gives up on the worker or the clock.
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
 * The second half: wait for the first token, advance the clock, wait for the second. The wait on the worker is a wait
 * on Stripe's delivery, so a timeout here names the webhook destination before anything else.
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
