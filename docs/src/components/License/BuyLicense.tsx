/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two Payment Links and the billing portal on `/license`.
 *
 *   Each card carries its own price, taken from the same `SHOP_PLANS` entry the provisioner sends to Stripe. It used
 *   to carry only the renewal sentence, so the one page on the site that can take money was also the one page that
 *   never said what it costs — a buyer had to hold the figure in their head from `/docs/pricing`.
 */

import Link from "@docusaurus/Link"
import {
	BILLING_PORTAL_URL,
	PAYMENT_LINK_MONTHLY,
	PAYMENT_LINK_YEARLY,
	PRICE_MONTHLY,
	PRICE_YEARLY,
	PRICE_YEARLY_PER_MONTH,
	TERMS_PATH,
} from "@mailwoman/license-worker/sdk/constants"
import type React from "react"

import styles from "./styles.module.css"

interface PlanProps {
	href: string
	name: string
	price: string
	/**
	 * The billing basis under the price — "per month, per legal entity". Short enough to read as a unit rather than a
	 * claim.
	 */
	basis: string
	/**
	 * The effective-rate line, when the plan has one worth making.
	 */
	note?: string
	renewal: string
}

const Plan: React.FC<PlanProps> = ({ href, name, price, basis, note, renewal }) => (
	<a className={styles.plan} href={href}>
		<strong className={styles.planName}>{name}</strong>

		<span className={styles.planPrice}>{price}</span>
		<span className={styles.planBasis}>{basis}</span>

		{note ? <span className={styles.planNote}>{note}</span> : null}

		<span className={styles.planRenewal}>{renewal}</span>

		<span aria-hidden="true" className={styles.planCTA}>
			Purchase {name.toLowerCase()} →
		</span>
	</a>
)

export const BuyLicense: React.FC = () => {
	return (
		<div className={styles.provide}>
			<div className={styles.plans}>
				<Plan
					href={PAYMENT_LINK_MONTHLY}
					name="Monthly"
					price={PRICE_MONTHLY}
					basis="per month, per legal entity"
					renewal="Renews every month; the key follows the paid period plus 14 days."
				/>

				<Plan
					href={PAYMENT_LINK_YEARLY}
					name="Yearly"
					price={PRICE_YEARLY}
					basis="per year, per legal entity"
					note={`Works out to ${PRICE_YEARLY_PER_MONTH} a month.`}
					renewal="Renews every year; one key for the year plus 14 days."
				/>
			</div>
			<p className={styles.fine}>
				Checkout asks for the licensee's legal name and your acceptance of the{" "}
				<Link to={TERMS_PATH}>commercial agreement</Link>. After payment you land on a page that shows your key and a
				refresh secret, and the same key arrives by email.
				{BILLING_PORTAL_URL ? (
					<>
						{" "}
						Change the card, the plan, or cancel at <a href={BILLING_PORTAL_URL}>the billing portal</a>.
					</>
				) : null}
			</p>
		</div>
	)
}
