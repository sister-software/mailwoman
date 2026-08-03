/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Pricing tier cards + OEM band for the pricing page (GTM A3b).
 *
 *   Presentation only — no copy lives here.
 *
 *   UNMOUNTED as of the docs-reorg Task 5 skeleton cutover. Its only consumer was the old
 *   `licensing/pricing.mdx`, which is now parked unpublished under
 *   `docs/records/site-2026-08/licensing/pricing.mdx`; the live page is `docs/articles/pricing.mdx`
 *   and it renders the tiers as prose. Kept rather than deleted because the card styling is real
 *   work and the Product door lands later — mount it there, and take the tier figures from the live
 *   page, which is the ratified wording.
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
