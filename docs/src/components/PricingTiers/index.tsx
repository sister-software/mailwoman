/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Pricing tier cards + OEM band for the licensing pricing page (GTM A3b).
 *
 *   Presentation only — every sentence of copy lives in
 *   `docs/articles/licensing/pricing.mdx`, which remains the ratified source.
 */

import type { ReactNode } from "react"

import styles from "./styles.module.css"

export interface TierProps {
	/**
	 * Tier name, rendered as an uppercase eyebrow.
	 */
	name: string
	/**
	 * Headline price, set in the site mono between double rules.
	 */
	price: string
	/**
	 * Optional sub-line under the price (billing basis, effective rate).
	 */
	priceNote?: string
	ctaLabel: string
	ctaHref: string
	children: ReactNode
}

export function PricingGrid({ children }: { children: ReactNode }): ReactNode {
	return <div className={styles.grid}>{children}</div>
}

export function Tier({ name, price, priceNote, ctaLabel, ctaHref, children }: TierProps): ReactNode {
	return (
		<section className={styles.tier}>
			<header>
				<p className={styles.tierName}>{name}</p>

				<div className={styles.frank}>
					<p className={styles.price}>{price}</p>

					{priceNote ? <p className={styles.priceNote}>{priceNote}</p> : null}
				</div>
			</header>

			<div className={styles.tierBody}>{children}</div>

			<a className="button button--outline button--primary button--block" href={ctaHref}>
				{ctaLabel}
			</a>
		</section>
	)
}

export interface OEMBandProps {
	ctaLabel: string
	ctaHref: string
	children: ReactNode
}

export function OEMBand({ ctaLabel, ctaHref, children }: OEMBandProps): ReactNode {
	return (
		<aside className={styles.oemBand}>
			<div className={styles.oemBody}>{children}</div>

			<a className="button button--outline button--primary" href={ctaHref}>
				{ctaLabel}
			</a>
		</aside>
	)
}
