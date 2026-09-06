/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two Payment Links and the billing portal on `/license`. Renders the contact route alone until the operator fills
 *   the links in `src/license/shop.ts`, so the live page never shows a button that goes nowhere.
 */

import Link from "@docusaurus/Link"
import {
	BILLING_PORTAL_URL,
	PAYMENT_LINK_MONTHLY,
	PAYMENT_LINK_YEARLY,
	TERMS_PATH,
} from "@mailwoman/license-worker/sdk/constants"
import type React from "react"

import styles from "./styles.module.css"

export const BuyLicense: React.FC = () => {
	return (
		<div className={styles.buy}>
			<div className={styles.plans}>
				<a className={styles.plan} href={PAYMENT_LINK_MONTHLY}>
					<strong>Monthly</strong>
					<span>Renews every month; the key follows the paid period plus 14 days.</span>
				</a>
				<a className={styles.plan} href={PAYMENT_LINK_YEARLY}>
					<strong>Yearly</strong>
					<span>Renews every year; one key for the year plus 14 days.</span>
				</a>
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
