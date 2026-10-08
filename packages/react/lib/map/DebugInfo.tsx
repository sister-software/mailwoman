/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Display and log build, model and runtime details for bug reports.
 */

import { type ReactNode, useEffect, useMemo } from "react"

import { useBuildInfo } from "#common/useBuildInfo"

export interface DebugInfoProps {
	/**
	 * The runtime's backend and model size (e.g. `wasm (28 MB int8)`); empty before the model loads.
	 */
	activeBackend?: string
	/**
	 * The model version the runtime loaded.
	 *
	 * The training series.
	 * It differs from the npm version.
	 */
	selectedVersion?: string | null
	/**
	 * Whether the asset bundle finished loading.
	 */
	ready?: boolean
}

/**
 * One row of the record, as a label and a value.
 */
function Row({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="mw-debug-info__row">
			<span className="mw-debug-info__label">{label}</span>
			<code className="mw-debug-info__value">{value}</code>
		</div>
	)
}

export function DebugInfo({ activeBackend, selectedVersion, ready }: DebugInfoProps): ReactNode {
	const build = useBuildInfo()

	// Memoized on the primitives it reads, so the log below fires when a value changes
	// rather than on every render.
	// A record rebuilt each render would be a new object each time and log continuously.
	const record = useMemo(
		() => ({
			app: build?.app ?? "—",
			commit: build?.commit ?? build?.revision ?? "—",
			buildTime: build?.buildTime ?? "—",
			model: selectedVersion ?? "—",
			backend: activeBackend || (ready ? "unknown" : "loading…"),
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "—",
		}),
		[build?.app, build?.commit, build?.revision, build?.buildTime, selectedVersion, activeBackend, ready]
	)

	useEffect(() => {
		// eslint-disable-next-line no-console -- this is the feature: the record has to reach the console a reporter copies.
		console.info("[mailwoman] debug info", record)
	}, [record])

	return (
		<div className="mw-debug-info">
			<Row label="Build" value={record.app} />
			<Row label="Commit" value={record.commit.slice(0, 12)} />
			<Row label="Built" value={record.buildTime} />
			<Row label="Model" value={record.model} />
			<Row label="Backend" value={record.backend} />
		</div>
	)
}
