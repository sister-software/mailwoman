/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BackendControl } from "@mailwoman/react/map/BackendControl"
import { CompareToggle } from "@mailwoman/react/map/CompareToggle"
import { FAKE_SUGGESTIONS, makeFakeParseResult } from "@mailwoman/react/map/fake-runtime"
import { PlaceAutocomplete } from "@mailwoman/react/map/PlaceAutocomplete"
import { ResultPanel } from "@mailwoman/react/map/ResultPanel"
import type { VersionOption, Suggestion } from "@mailwoman/react/map/types"
import { usePlaceAutocomplete } from "@mailwoman/react/map/usePlaceAutocomplete"
import { VersionPicker } from "@mailwoman/react/map/VersionPicker"
import { useState } from "react"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import { actDelay } from "../../act.ts"
import { renderComponent } from "../../render.tsx"

const VERSIONS: VersionOption[] = [
	{ version: "v7.2.0", label: "v7.2.0 (latest)" },
	{ version: "v7.1.0", label: "v7.1.0" },
]

test("VersionPicker renders options and fires onSelect", async () => {
	const onSelect = vi.fn()
	const { container } = renderComponent(<VersionPicker versions={VERSIONS} selected="v7.2.0" onSelect={onSelect} />)

	const select = container.querySelector("#mw-demo-version") as HTMLSelectElement
	expect(select).not.toBeNull()
	expect(select.querySelectorAll("option")).toHaveLength(2)

	await userEvent.selectOptions(select, "v7.1.0")
	expect(onSelect).toHaveBeenCalledWith("v7.1.0")
})

test("VersionPicker renders nothing with fewer than two versions", () => {
	const { container } = renderComponent(
		<VersionPicker versions={[VERSIONS[0]!]} selected="v7.2.0" onSelect={() => {}} />
	)

	expect(container.querySelector("#mw-demo-version")).toBeNull()
})

test("CompareToggle reveals the compare select (primary excluded) when turned on", async () => {
	function Harness() {
		const [mode, setMode] = useState(false)
		const [version, setVersion] = useState<string | null>(null)

		return (
			<CompareToggle
				versions={[...VERSIONS, { version: "v6.4.0", label: "v6.4.0" }]}
				primaryVersion="v7.2.0"
				compareMode={mode}
				onCompareModeChange={setMode}
				compareVersion={version}
				onCompareVersionChange={setVersion}
			/>
		)
	}

	const { container } = renderComponent(<Harness />)

	expect(container.querySelector("#mw-demo-compare-version")).toBeNull()

	await userEvent.click(container.querySelector('input[type="checkbox"]') as HTMLInputElement)

	const select = container.querySelector("#mw-demo-compare-version") as HTMLSelectElement
	expect(select).not.toBeNull()
	const values = Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value)
	expect(values).not.toContain("v7.2.0")
	expect(values).toContain("v7.1.0")
	expect(values).toContain("v6.4.0")
})

test("BackendControl shows the backend and toggles forceWASM", async () => {
	const onForceWASMChange = vi.fn()

	const { container } = renderComponent(
		<BackendControl activeBackend="webgpu (28 MB int8)" forceWASM={false} onForceWASMChange={onForceWASMChange} />
	)

	expect(container.textContent).toContain("webgpu (28 MB int8)")
	await userEvent.click(container.querySelector('input[type="checkbox"]') as HTMLInputElement)
	expect(onForceWASMChange).toHaveBeenCalledWith(true)
})

test("ResultPanel renders components + resolved place, and switches candidate", async () => {
	function Harness() {
		const [index, setIndex] = useState(0)
		const result = makeFakeParseResult()

		return (
			<div className="mw-pipeline-explorer">
				<ResultPanel
					result={result}
					selectedCandidate={result.candidates[index] ?? null}
					selectedCandidateIndex={index}
					onSelectCandidate={setIndex}
				/>
			</div>
		)
	}

	const { container } = renderComponent(<Harness />)

	expect(container.textContent).toContain("Parsed components")
	expect(container.textContent).toContain("house_number")
	expect(container.querySelector(".mw-resolved")?.textContent).toContain("locality")

	// The second fake candidate is a region.
	await userEvent.click(container.querySelectorAll(".mw-candidates__btn")[1] as HTMLElement)
	await vi.waitFor(() => expect(container.querySelector(".mw-resolved")?.textContent).toContain("region"))
})

test("ResultPanel renders the injected failure slot when nothing resolved", () => {
	const result = { ...makeFakeParseResult(), resolved: null, candidates: [] }

	const { container } = renderComponent(
		<ResultPanel
			result={result}
			selectedCandidate={null}
			selectedCandidateIndex={0}
			onSelectCandidate={() => {}}
			failure={() => <p className="mw-test-failure">no resolve</p>}
		/>
	)

	expect(container.querySelector(".mw-test-failure")?.textContent).toBe("no resolve")
	expect(container.querySelector(".mw-resolved")).toBeNull()
})

function AutocompleteHarness({ autocomplete }: { autocomplete: (q: string) => Promise<Suggestion[]> }) {
	const [text, setText] = useState("")
	const ac = usePlaceAutocomplete({ text, setText, autocomplete, debounceMs: 10, minChars: 2 })

	return (
		<div>
			<input
				data-testid="ac-input"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={ac.onInputKeyDown}
				{...ac.inputProps}
			/>
			<PlaceAutocomplete
				suggestions={ac.suggestions}
				activeIndex={ac.activeIndex}
				onPick={ac.pick}
				onHover={ac.setActiveIndex}
				listboxID={ac.listboxID}
				optionID={ac.optionID}
			/>
		</div>
	)
}

test("usePlaceAutocomplete suggests on type and rewrites the input on pick", async () => {
	const autocomplete = async (q: string): Promise<Suggestion[]> =>
		FAKE_SUGGESTIONS.filter((s) => s.value.toLowerCase().startsWith(q.toLowerCase()))

	const { container } = renderComponent(<AutocompleteHarness autocomplete={autocomplete} />)

	const input = container.querySelector('[data-testid="ac-input"]') as HTMLInputElement
	await userEvent.type(input, "New")

	// Three fake suggestions start with "New".
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(3))
	expect(input.getAttribute("aria-expanded")).toBe("true")

	// The input has no comma, so picking a suggestion replaces the whole value.
	await userEvent.click(container.querySelectorAll('[role="option"]')[0] as HTMLElement)
	await vi.waitFor(() => expect(input.value).toBe("New York"))
	await vi.waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(0))
})

test("usePlaceAutocomplete stays closed for numeric input (postcode)", async () => {
	const autocomplete = vi.fn(async () => FAKE_SUGGESTIONS)
	const { container } = renderComponent(<AutocompleteHarness autocomplete={autocomplete} />)

	const input = container.querySelector('[data-testid="ac-input"]') as HTMLInputElement
	await userEvent.type(input, "90210")

	// The wait outlasts the debounce and runs inside `act()`, so the hook's state updates settle.
	// A query that starts with a digit never calls the fetcher.
	await actDelay(60)
	expect(autocomplete).not.toHaveBeenCalled()
	expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
})
