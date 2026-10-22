/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Published list rates for forward geocoding, as the pricing calculator compares them. Each entry names the page it
 *   was read from and the date. `rates.test.ts` fails once the oldest reading is more than 120 days old, so a stale
 *   figure stops the test run instead of staying on the page.
 */

/**
 * One volume band: requests up to `upTo` in a month are billed at `perThousand`.
 */
export interface RateBand {
	upTo: number
	perThousand: number
}

export interface ProviderRate {
	provider: string
	product: string
	/**
	 * What the row's figure assumes, in a few words.
	 */
	note: string
	sourceURL: string
	/**
	 * The date the rate was read from `sourceURL`, as `YYYY-MM-DD`.
	 */
	retrievedOn: string
	/**
	 * Requests a month billed at nothing, taken off the first band.
	 */
	freePerMonth: number
	/**
	 * Ascending bands, or `null` for a provider that publishes no figure.
	 */
	bands: readonly RateBand[] | null
}

/**
 * The rows the calculator prices, in the order it shows them.
 * Each is a list rate, read from `sourceURL` on `retrievedOn`.
 */
export const ProviderRates: readonly ProviderRate[] = [
	{
		provider: "Google Maps Platform",
		product: "Geocoding API, Essentials",
		note: "10,000 free a month, then banded",
		sourceURL: "https://developers.google.com/maps/billing-and-pricing/pricing",
		retrievedOn: "2026-10-22",
		freePerMonth: 10_000,
		bands: [
			{ upTo: 100_000, perThousand: 5 },
			{ upTo: 500_000, perThousand: 4 },
			{ upTo: 1_000_000, perThousand: 3 },
			{ upTo: 5_000_000, perThousand: 1.5 },
			{ upTo: Infinity, perThousand: 0.38 },
		],
	},
	{
		provider: "Amazon Location Service",
		product: "Places Geocode, Core",
		note: "Results may not be stored",
		sourceURL: "https://aws.amazon.com/location/pricing/",
		retrievedOn: "2026-10-21",
		freePerMonth: 0,
		bands: [{ upTo: Infinity, perThousand: 0.5 }],
	},
	{
		provider: "Amazon Location Service",
		product: "Places Geocode, Stored",
		note: "The bucket that lets you keep the result",
		sourceURL: "https://aws.amazon.com/location/pricing/",
		retrievedOn: "2026-10-21",
		freePerMonth: 0,
		bands: [{ upTo: Infinity, perThousand: 4 }],
	},
	{
		provider: "Azure Maps",
		product: "Search",
		note: "5,000 free a month, then contact sales",
		sourceURL: "https://azure.microsoft.com/en-us/pricing/details/azure-maps/",
		retrievedOn: "2026-10-21",
		freePerMonth: 5000,
		bands: null,
	},
]

/**
 * The monthly cost of `requests` lookups at `rate`, in dollars.
 * `null` when the provider publishes no figure.
 */
export function monthlyCost(rate: ProviderRate, requests: number): number | null {
	if (!rate.bands) return null

	let total = 0
	let lower = 0

	for (const band of rate.bands) {
		const billedFrom = Math.max(lower, rate.freePerMonth)
		const billedTo = Math.min(requests, band.upTo)

		if (billedTo > billedFrom) {
			total += ((billedTo - billedFrom) / 1000) * band.perThousand
		}

		if (requests <= band.upTo) break

		lower = band.upTo
	}

	return total
}

/**
 * The oldest `retrievedOn` across every rate, which the page prints beside the table.
 */
export function oldestReading(rates: readonly ProviderRate[] = ProviderRates): string {
	return rates.map((rate) => rate.retrievedOn).toSorted()[0] ?? ""
}
