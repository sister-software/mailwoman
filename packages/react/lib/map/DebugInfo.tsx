/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<DebugInfo>` — what a bug report needs and a screenshot cannot carry: which build the page is, which model it
 *   loaded, and which backend actually executed it.
 *
 *   The backend is the one worth naming twice. `web/onnx-runner.ts` asks for `["webgpu", "wasm"]` and falls through
 *   to a WASM-only session inside a bare `catch`, so a page that works is NOT evidence that WebGPU ran — the two
 *   outcomes look identical from the outside. This row is the difference, which matters because the int8 graph's
 *   mobile-Safari invariant is about the WebGPU execution provider specifically.
 *
 *   It also logs the same record once per change, so a reporter can paste a console line instead of transcribing a
 *   panel, and so a remote session leaves the facts in the log it already collects.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import { type ReactNode, useEffect, useMemo } from "react"

import { useBuildInfo } from "#common/useBuildInfo"

export interface DebugInfoProps {
	/**
	 * The backend the runtime resolved to (e.g. `webgpu (28 MB int8)`); empty before it is known.
	 */
	activeBackend?: string
	/**
	 * Whether the CPU/WASM backend is currently forced, which explains a `wasm` backend that would otherwise be a WebGPU
	 * failure.
	 */
	forceWASM?: boolean
	/**
	 * The model version the runtime loaded — the TRAINING series, which is not the npm version.
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

export function DebugInfo({ activeBackend, forceWASM, selectedVersion, ready }: DebugInfoProps): ReactNode {
	const build = useBuildInfo()

	// Memoized on the primitives it reads, so the log below fires when a value changes rather than on every render —
	// a record rebuilt each render would be a new object each time and log continuously.
	const record = useMemo(
		() => ({
			app: build?.app ?? "—",
			commit: build?.commit ?? build?.revision ?? "—",
			buildTime: build?.buildTime ?? "—",
			model: selectedVersion ?? "—",
			backend: activeBackend || (ready ? "unknown" : "loading…"),
			forceWASM: Boolean(forceWASM),
			webgpuInBrowser: typeof navigator !== "undefined" && "gpu" in navigator,
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "—",
		}),
		[build?.app, build?.commit, build?.revision, build?.buildTime, selectedVersion, activeBackend, forceWASM, ready]
	)

	useEffect(() => {
		// eslint-disable-next-line no-console -- this IS the feature: the record has to reach the console a reporter copies.
		console.info("[mailwoman] debug info", record)
	}, [record])

	return (
		<div className="mw-debug-info">
			<Row label="Build" value={record.app} />
			<Row label="Commit" value={record.commit.slice(0, 12)} />
			<Row label="Built" value={record.buildTime} />
			<Row label="Model" value={record.model} />
			<Row label="Backend" value={record.backend} />
			{/* A browser with no WebGPU at all explains a `wasm` backend that is otherwise indistinguishable from a
			    WebGPU session that threw. */}
			<Row label="WebGPU available" value={record.webgpuInBrowser ? "yes" : "no"} />
			<Row label="Force WASM" value={record.forceWASM ? "on" : "off"} />
		</div>
	)
}
