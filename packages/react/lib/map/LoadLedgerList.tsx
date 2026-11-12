// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The load ledger as a disclosure: one row per artifact the release load requested,
 *   with its role, bytes, source and state.
 */

import {
	ARTIFACT_ROLE_LABELS,
	type ArtifactSource,
	type LedgerEntry,
	type LoadLedgerSnapshot,
} from "@mailwoman/core/load-ledger"
import type { ReactNode } from "react"

const SOURCE_LABELS: Readonly<Record<ArtifactSource, string>> = {
	"service-worker": "offline cache",
	"http-cache": "browser cache",
	network: "network",
	unknown: "source unknown",
}

/**
 * The bytes in a kibibyte, the step between the units this list shows.
 */
const BYTES_PER_KIB = 1024

function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KIB) return `${bytes} B`

	if (bytes < BYTES_PER_KIB * BYTES_PER_KIB) return `${(bytes / BYTES_PER_KIB).toFixed(0)} KB`

	return `${(bytes / BYTES_PER_KIB / BYTES_PER_KIB).toFixed(1)} MB`
}

function describeBytes(entry: LedgerEntry): string {
	if (entry.total) return `${formatBytes(entry.received)} of ${formatBytes(entry.total)}`

	return entry.received ? formatBytes(entry.received) : ""
}

function describeState(entry: LedgerEntry): string {
	switch (entry.state) {
		case "loading":
			return "loading"
		case "done":
			return entry.source ? SOURCE_LABELS[entry.source] : "done"
		case "missing":
			return "not published"
		case "failed":
			return entry.error ? `failed: ${entry.error}` : "failed"
	}
}

export interface LoadLedgerListProps {
	ledger: LoadLedgerSnapshot
	/**
	 * Opens the disclosure on first render, as after a failed load.
	 */
	open?: boolean
}

/**
 * A `<details>` listing every artifact in `ledger`, with a summary that counts them
 * and names any that failed.
 */
export function LoadLedgerList({ ledger, open = false }: LoadLedgerListProps): ReactNode {
	const done = ledger.entries.filter((entry) => entry.state === "done" || entry.state === "missing").length
	const failed = ledger.entries.filter((entry) => entry.state === "failed").length

	const summary = [
		`${done} of ${ledger.entries.length} files loaded`,
		failed ? `${failed} failed` : null,
		ledger.waitingForNetwork ? "waiting for network" : null,
	]
		.filter(Boolean)
		.join(" · ")

	return (
		<details className="mw-load-ledger" open={open}>
			<summary>{summary}</summary>
			<ul className="mw-load-ledger__list">
				{ledger.entries.map((entry) => (
					<li key={entry.url} className={`mw-load-ledger__row mw-load-ledger__row--${entry.state}`}>
						<span className="mw-load-ledger__role" title={entry.url}>
							{ARTIFACT_ROLE_LABELS[entry.role]}
						</span>
						<span className="mw-load-ledger__bytes">{describeBytes(entry)}</span>
						<span className="mw-load-ledger__state">{describeState(entry)}</span>
					</li>
				))}
			</ul>
		</details>
	)
}
