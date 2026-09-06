/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The body of `/license/issued`: poll the worker's claim route for the Checkout Session Stripe returned the buyer
 *   with, then show the key, the one-time refresh secret, the `.env` fragment and the two commands to run. The state is
 *   the pure reducer in `src/license/claim.ts`; this component owns only the timer, the abort, and the copy. Nothing the
 *   worker answers is stored anywhere but the DOM.
 */

import {
	CLAIM_INTERVAL_MS,
	fetchClaim,
	initialClaimState,
	nextClaimState,
	type ClaimState,
	type IssuedClaim,
} from "@mailwoman/license-worker/sdk/claim"
import { BILLING_PORTAL_URL, SUPPORT_EMAIL } from "@mailwoman/license-worker/sdk/constants"
import { useClipboard } from "@mailwoman/react"
import type React from "react"
import { useEffect, useReducer } from "react"

import styles from "./styles.module.css"

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
	const { copied, copy } = useClipboard()

	return (
		<button type="button" className={styles.copyButton} onClick={() => void copy(text)} title={label}>
			{copied ? "✓ Copied" : label}
		</button>
	)
}

const supportLink = (subject: string) => (
	<a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`}>{SUPPORT_EMAIL}</a>
)

const Issued: React.FC<{ claim: IssuedClaim }> = ({ claim }) => {
	const adopt = claim.refresh_secret
		? `mailwoman license adopt "${claim.token}" --secret "${claim.refresh_secret}"`
		: `mailwoman license adopt "${claim.token}"`

	const envFragment = `MAILWOMAN_LICENSE_KEY="${claim.token}"`

	return (
		<>
			<dl className={styles.facts}>
				<dt>Licensee</dt>
				<dd>{claim.licensee}</dd>
				<dt>Scope</dt>
				<dd>all packages</dd>
				<dt>Issued</dt>
				<dd>{claim.issued}</dd>
				<dt>Valid until</dt>
				<dd>{claim.expires} (UTC, inclusive)</dd>
				<dt>License id</dt>
				<dd>
					<code>{claim.lid}</code>
				</dd>
			</dl>

			<h2>Your key</h2>
			<pre className={styles.token}>{claim.token}</pre>
			<div className={styles.copyRow}>
				<CopyButton text={claim.token} label="Copy key" />
				<CopyButton text={envFragment} label="Copy as .env line" />
			</div>

			{claim.refresh_secret ? (
				<div className={styles.secret}>
					<h2>Your refresh secret</h2>
					<p>
						<strong>Shown once.</strong> Keep it with the key; it is what fetches your renewals.
					</p>
					<pre className={styles.token}>{claim.refresh_secret}</pre>
					<div className={styles.copyRow}>
						<CopyButton text={claim.refresh_secret} label="Copy secret" />
					</div>
				</div>
			) : (
				<p>
					The refresh secret was shown when this page first loaded, and is in your first email. It is not shown again.
				</p>
			)}

			<h2>Install it</h2>
			<p>On each machine that runs mailwoman, adopt the key once and check it:</p>
			<pre className={styles.token}>
				{adopt}
				{"\n"}
				mailwoman license verify --online
			</pre>
			<div className={styles.copyRow}>
				<CopyButton text={`${adopt}\nmailwoman license verify --online`} label="Copy commands" />
			</div>
			<p>
				Or set <code>{envFragment.split("=")[0]}</code> in the environment. After a renewal,{" "}
				<code>mailwoman license refresh</code> fetches the current key.
			</p>

			<p>
				The same key is in your email.
				{BILLING_PORTAL_URL ? (
					<>
						{" "}
						Change the card, the plan, or cancel at <a href={BILLING_PORTAL_URL}>the billing portal</a>.
					</>
				) : null}
			</p>
		</>
	)
}

const Phase: React.FC<{ state: ClaimState; sessionID: string }> = ({ state, sessionID }) => {
	switch (state.phase) {
		case "polling":
			return <p>Confirming your payment with Stripe… This takes a few seconds; the page updates on its own.</p>
		case "issued":
			return <Issued claim={state.claim} />
		case "waiting_too_long":
			return (
				<p>
					Your payment is recorded but the key is not ready yet. It arrives by email on its own. If it has not arrived
					within an hour, write to {supportLink(`License not issued for ${sessionID}`)} with your session id{" "}
					<code>{sessionID}</code>.
				</p>
			)
		case "revoked":
			return <p>This license has been revoked. Write to {supportLink(`Revoked license ${sessionID}`)}.</p>
		case "not_found":
			return (
				<p>
					Stripe does not know this session. Use the link Stripe sent you, or write to{" "}
					{supportLink(`Unknown session ${sessionID}`)}.
				</p>
			)
		default:
			return (
				<p>The license service did not answer. The key arrives by email on its own; reload this page to try again.</p>
			)
	}
}

export const IssuedLicense: React.FC<{ sessionID: string | null }> = ({ sessionID }) => {
	const [state, dispatch] = useReducer(nextClaimState, undefined, initialClaimState)

	useEffect(() => {
		if (!sessionID || state.phase !== "polling") return undefined

		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined

		const poll = async () => {
			const event = await fetchClaim(sessionID, controller.signal)

			if (controller.signal.aborted) return

			dispatch(event)
			timer = setTimeout(() => void poll(), CLAIM_INTERVAL_MS)
		}

		void poll()

		return () => {
			controller.abort()

			if (timer !== undefined) {
				clearTimeout(timer)
			}
		}
		// The effect runs once per session id; the reducer stopping the loop is `state.phase` leaving `polling`.
	}, [sessionID, state.phase])

	if (!sessionID) {
		return (
			<p>
				This page is where Stripe sends you after payment. To buy a license, start at{" "}
				<a href="/license">the license page</a>.
			</p>
		)
	}

	return <Phase state={state} sessionID={sessionID} />
}
