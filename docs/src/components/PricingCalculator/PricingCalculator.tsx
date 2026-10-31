/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pricing page's calculator: a monthly lookup count against each metered provider's published list rate, and the
 *   commercial license beside them. The slider moves every row except ours.
 */

import { PRICE_MONTHLY } from "@mailwoman/license-worker/client/constants"
import { useId, useState, type ReactNode } from "react"

import { monthlyCost, oldestReading, ProviderRates } from "./rates.ts"

import styles from "./styles.module.css"

const MIN_EXPONENT = 4
const MAX_EXPONENT = 8
const STEPS = 400

/**
 * Google's last volume band starts above 5 million lookups a month.
 * Past it, every metered row is at its lowest rate.
 */
const DEEPEST_DISCOUNT = 5_000_000

const toRequests = (step: number) => {
	const raw = 10 ** (MIN_EXPONENT + (step / STEPS) * (MAX_EXPONENT - MIN_EXPONENT))
	// The slider rounds to two digits so users can enter the values by hand.
	const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1)

	return Math.round(raw / magnitude) * magnitude
}

const toStep = (requests: number) =>
	Math.round(((Math.log10(Math.max(requests, 1)) - MIN_EXPONENT) / (MAX_EXPONENT - MIN_EXPONENT)) * STEPS)

const count = new Intl.NumberFormat("en-US")
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export const PricingCalculator = (): ReactNode => {
	const [requests, setRequests] = useState(1_000_000)
	const inputID = useId()
	const rangeID = useId()

	return (
		<div className={styles.calculator}>
			<div className={styles.controls}>
				<label htmlFor={inputID} className={styles.label}>
					Addresses geocoded a month
				</label>
				<input
					id={inputID}
					className={styles.number}
					type="number"
					min={0}
					step={1000}
					value={requests}
					onChange={(event) => setRequests(Math.max(0, Number(event.target.value) || 0))}
				/>
				<input
					id={rangeID}
					aria-label="Addresses geocoded a month, on a logarithmic scale"
					className={styles.range}
					type="range"
					min={0}
					max={STEPS}
					value={Math.min(STEPS, Math.max(0, toStep(requests)))}
					onChange={(event) => setRequests(toRequests(Number(event.target.value)))}
				/>
				<div className={styles.scale} aria-hidden="true">
					<span>10K</span>
					<span>100K</span>
					<span>1M</span>
					<span>10M</span>
					<span>100M</span>
				</div>
			</div>

			<table className={styles.table}>
				<thead>
					<tr>
						<th scope="col">Provider</th>
						<th scope="col" className={styles.amount}>
							A month at {count.format(requests)}
						</th>
					</tr>
				</thead>
				<tbody aria-live="polite">
					{ProviderRates.map((rate) => {
						const cost = monthlyCost(rate, requests)

						return (
							<tr key={rate.product}>
								<th scope="row">
									<span className={styles.provider}>{rate.provider}</span>
									<span className={styles.product}>
										{rate.product} · {rate.note} ·{" "}
										<a href={rate.sourceURL} rel="noopener">
											list rate, read {rate.retrievedOn}
										</a>
									</span>
								</th>
								<td className={styles.amount}>{cost === null ? "Quote on request" : dollars.format(cost)}</td>
							</tr>
						)
					})}
					<tr className={styles.ours}>
						<th scope="row">
							<span className={styles.provider}>Mailwoman</span>
							<span className={styles.product}>
								Commercial license · This row does not read the slider.
								{requests > DEEPEST_DISCOUNT
									? " At this volume the metered rows have earned their discount. Ours was already there."
									: null}
							</span>
						</th>
						<td className={styles.amount}>{PRICE_MONTHLY}</td>
					</tr>
				</tbody>
			</table>

			<p className={styles.fine}>
				Published list prices as of {oldestReading()}, before volume agreements, credits or negotiated discounts. Read
				each provider's page before you budget. The commercial license covers companies under 250 employees and $10M in
				annual revenue, at any volume.
			</p>
		</div>
	)
}
