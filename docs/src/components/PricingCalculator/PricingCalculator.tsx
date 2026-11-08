// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The pricing page's calculator: a monthly lookup count against each metered provider's published list rate, and the
 *   commercial license beside them. The slider moves every row except ours.
 */

import { PRICE_MONTHLY } from "@mailwoman/license-worker/client/constants"
import clsx from "clsx"
import { useId, useState, type ReactNode } from "react"

import { monthlyCost, oldestReading, ProviderRates } from "./rates.ts"

import styles from "./styles.module.css"

const MIN_EXPONENT = 4
const MAX_EXPONENT = 8
const STEPS = 100

/**
 * The logarithmic scale marks each power of ten between its endpoints.
 */
const RANGE_MARKERS = Array.from(
	{ length: MAX_EXPONENT - MIN_EXPONENT + 1 },
	(_, index) => (index / (MAX_EXPONENT - MIN_EXPONENT)) * STEPS
)

const toRequests = (step: number) => {
	const raw = 10 ** (MIN_EXPONENT + (step / STEPS) * (MAX_EXPONENT - MIN_EXPONENT))
	// The slider rounds to two digits so users can enter the values by hand.
	const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1)

	return Math.round(raw / magnitude) * magnitude
}

const toStep = (requests: number) =>
	Math.round(((Math.log10(Math.max(requests, 1)) - MIN_EXPONENT) / (MAX_EXPONENT - MIN_EXPONENT)) * STEPS)

const count = new Intl.NumberFormat("en-US")
const compactCount = new Intl.NumberFormat("en-US", { notation: "compact" })
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export const PricingCalculator = (): ReactNode => {
	const [requests, setRequests] = useState(1_000_000)
	// The handle retains its raw position because distinct positions can round to the same request count.
	const [rangeStep, setRangeStep] = useState(() => toStep(requests))
	const [pulseCount, setPulseCount] = useState(0)
	const inputID = useId()
	const rangeID = useId()
	const sourcesID = useId()

	const updateVolume = (nextRequests: number, nextStep: number) => {
		if (nextRequests > requests && RANGE_MARKERS.some((marker) => rangeStep < marker && nextStep >= marker)) {
			setPulseCount((current) => current + 1)
		}

		setRequests(nextRequests)
		setRangeStep(nextStep)
	}

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
					step={100}
					value={requests}
					onChange={(event) => {
						const nextRequests = Math.max(0, Number(event.target.value) || 0)

						updateVolume(nextRequests, Math.min(STEPS, Math.max(0, toStep(nextRequests))))
					}}
				/>
				<input
					id={rangeID}
					aria-label="Addresses geocoded a month, on a logarithmic scale"
					aria-valuetext={`${count.format(requests)} addresses per month`}
					className={styles.range}
					type="range"
					list={`${rangeID}-markers`}
					min={0}
					max={STEPS}
					step={1}
					value={rangeStep}
					onChange={(event) => {
						const nextStep = Number(event.target.value)

						updateVolume(toRequests(nextStep), nextStep)
					}}
				/>
				<datalist id={`${rangeID}-markers`}>
					{RANGE_MARKERS.map((marker) => (
						<option key={marker} value={marker} />
					))}
				</datalist>
				<div className={styles.scale} aria-hidden="true">
					{RANGE_MARKERS.map((marker) => (
						<span key={marker} style={{ left: `${(marker / STEPS) * 100}%` }}>
							{compactCount.format(toRequests(marker))}
						</span>
					))}
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
					<tr className={styles.ours}>
						<th scope="row">
							<span className={styles.provider}>Mailwoman</span>
							<span className={styles.product}>One flat monthly price. Unlimited address lookups.</span>
						</th>
						<td className={styles.amount}>
							<span key={pulseCount} className={clsx(styles.price, pulseCount > 0 && styles.pricePulse)}>
								{PRICE_MONTHLY}
							</span>
						</td>
					</tr>
					{ProviderRates.map((rate, index) => {
						const cost = monthlyCost(rate, requests)

						return (
							<tr key={rate.product}>
								<th scope="row">
									<span className={styles.provider}>{rate.provider}</span>
									<span className={styles.product}>
										{rate.product} · {rate.note}
										<sup>
											<a
												href={`#${sourcesID}-${index}`}
												className={styles.sourceMarker}
												aria-label={`Pricing source for ${rate.provider}, ${rate.product}`}
												title={`List rate, read ${rate.retrievedOn}`}
											>
												†
											</a>
										</sup>
									</span>
								</th>
								<td className={styles.amount}>
									{typeof cost === "number" ? (
										<span key={pulseCount} className={clsx(styles.price, pulseCount > 0 && styles.pricePulse)}>
											{dollars.format(cost)}
										</span>
									) : (
										"Quote on request"
									)}
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>

			<ul className={styles.sources} aria-label="Pricing sources">
				{ProviderRates.map((rate, index) => (
					<li key={rate.product} id={`${sourcesID}-${index}`}>
						<span aria-hidden="true">† </span>
						<a href={rate.sourceURL} rel="noopener">
							{rate.provider} · {rate.product}
						</a>
						{` — list rate, read ${rate.retrievedOn}.`}
					</li>
				))}
			</ul>

			<p className={styles.fine}>
				Published list prices as of {oldestReading()}, before volume agreements, credits or negotiated discounts. Read
				each provider's page before you budget. The commercial license covers companies under 250 employees and $10M in
				annual revenue, at any volume.
			</p>
		</div>
	)
}
