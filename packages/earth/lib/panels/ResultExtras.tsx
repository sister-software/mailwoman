/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What the app adds inside `@mailwoman/react/map`'s result panel: the FST provenance line, the XML view of the
 *   decoded tree, the span ribbon, the stage timing and the containment tree. The XML is decoded on first request
 *   through a dynamic import so the decoder's serializer stays out of the page's entry chunk.
 */

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { SpanHighlight } from "@mailwoman/react/pipeline/SpanHighlight"
import { TimingPanel } from "@mailwoman/react/pipeline/TimingPanel"
import { TreeView } from "@mailwoman/react/pipeline/TreeView"
import { useCallback, useState } from "react"

import demoStyles from "./panels.module.css"

export interface ResultExtrasProps {
	result: ParseResult
}

function FSTProvenance({ result }: ResultExtrasProps) {
	if (!result.fstActive) return null

	const provenance = result.fstProvenance

	return (
		<details style={{ marginBottom: "0.5rem", fontSize: "0.9rem" }}>
			<summary style={{ cursor: "pointer", userSelect: "none" }}>
				<strong>FST prior:</strong> <code>active</code>{" "}
				<span style={{ opacity: 0.7 }}>
					({provenance ? `${provenance.placeCount.toLocaleString()} places` : "94K US places"})
				</span>
			</summary>
			{provenance ? (
				<ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, listStyle: "disc", opacity: 0.7 }}>
					<li>Built: {new Date(provenance.builtAt).toLocaleDateString()}</li>
					<li>States: {provenance.stateCount.toLocaleString()}</li>
					<li>Importance matches: {provenance.importanceMatches.toLocaleString()}</li>
				</ul>
			) : null}
		</details>
	)
}

function XMLView({ tree }: { tree: unknown }) {
	const [xml, setXml] = useState<string | null>(null)
	const [shown, setShown] = useState(false)

	const onToggle = useCallback(async () => {
		if (xml === null) {
			const { decodeAsXML } = await import("@mailwoman/core/decoder")

			setXml(decodeAsXML(tree as Parameters<typeof decodeAsXML>[0]))
		}

		setShown((value) => !value)
	}, [xml, tree])

	return (
		<>
			<button type="button" className={demoStyles.exampleBtn} onClick={onToggle}>
				{shown ? "Hide XML" : "Show XML"}
			</button>
			{shown && xml !== null ? (
				<pre className={demoStyles.xml}>
					<code>{xml}</code>
				</pre>
			) : null}
		</>
	)
}

export function ResultExtras({ result }: ResultExtrasProps) {
	const hasTree = Boolean((result.tree as { roots?: unknown[] } | null)?.roots?.length)

	return (
		<>
			<FSTProvenance result={result} />
			{hasTree ? <XMLView tree={result.tree} /> : null}
			<SpanHighlight input={result.input} nodes={result.nodes} />
			{result.timing ? <TimingPanel timing={result.timing} /> : null}
			{hasTree ? (
				<details className={demoStyles.hierarchy}>
					<summary>Hierarchy</summary>
					<TreeView tree={result.tree} />
				</details>
			) : null}
		</>
	)
}
