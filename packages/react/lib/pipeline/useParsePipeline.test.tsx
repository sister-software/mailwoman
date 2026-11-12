// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import type { ReactNode } from "react"
import { expect, test, vi } from "vitest"
import { userEvent } from "vitest/browser"

import type { PipelineRuntime } from "#pipeline/types"
import { useParsePipeline } from "#pipeline/useParsePipeline"

import { renderComponent } from "../../test/render.tsx"

/**
 * A runtime whose parses settle only when the test settles them, in the order they were asked.
 */
function controlledRuntime() {
	const asked: string[] = []
	const pending: Array<{ resolve: (result: ParseResult) => void; reject: (error: Error) => void }> = []

	const runtime: PipelineRuntime = {
		ready: true,
		parseStageLabels: ["parse"],
		runParse: (input) => {
			asked.push(input)

			return new Promise<ParseResult>((resolve, reject) => {
				pending.push({ resolve, reject })
			})
		},
	}

	const settle = (index: number, outcome: { answer: string } | { error: string }) => {
		const entry = pending[index]

		if (!entry) throw new Error(`no parse ${index} is pending`)

		if ("error" in outcome) {
			entry.reject(new Error(outcome.error))
		} else {
			// The answer travels in `input`, which the harness renders.
			entry.resolve({
				input: outcome.answer,
				tree: null,
				nodes: [],
				kindResult: null,
				timing: null,
				resolved: null,
				candidates: [],
				fstActive: false,
				fstProvenance: null,
			})
		}
	}

	return { runtime, asked, settle }
}

function Harness({ runtime }: { runtime: PipelineRuntime }): ReactNode {
	const pipeline = useParsePipeline({ runtime, defaultText: "" })
	const answer = pipeline.result?.input ?? ""

	return (
		<div>
			<span className="busy">{pipeline.busy ? "yes" : "no"}</span>
			<span className="answer">{answer}</span>
			<span className="error">{pipeline.parseError ?? ""}</span>
			<button type="button" className="submit-a" onClick={() => void pipeline.submit("a")}>
				a
			</button>
			<button type="button" className="submit-b" onClick={() => void pipeline.submit("b")}>
				b
			</button>
			<button type="button" className="reset" onClick={pipeline.reset}>
				reset
			</button>
		</div>
	)
}

const text = (container: HTMLElement, selector: string) => container.querySelector(selector)?.textContent ?? ""

const click = (container: HTMLElement, selector: string) =>
	userEvent.click(container.querySelector(selector) as HTMLButtonElement)

test("a query submitted during a parse runs once that parse settles, and its result is the one shown", async () => {
	const { runtime, asked, settle } = controlledRuntime()
	const { container } = renderComponent(<Harness runtime={runtime} />)

	await click(container, ".submit-a")
	await vi.waitFor(() => expect(asked).toEqual(["a"]))

	await click(container, ".submit-b")
	settle(0, { answer: "for a" })

	await vi.waitFor(() => expect(asked).toEqual(["a", "b"]))
	settle(1, { answer: "for b" })

	await vi.waitFor(() => expect(text(container, ".answer")).toBe("for b"))
	expect(text(container, ".busy")).toBe("no")
})

test("a failed parse shows its error without the previous result, and reset clears both", async () => {
	const { runtime, asked, settle } = controlledRuntime()
	const { container } = renderComponent(<Harness runtime={runtime} />)

	await click(container, ".submit-a")
	await vi.waitFor(() => expect(asked).toHaveLength(1))
	settle(0, { answer: "for a" })
	await vi.waitFor(() => expect(text(container, ".answer")).toBe("for a"))

	await click(container, ".submit-b")
	await vi.waitFor(() => expect(asked).toHaveLength(2))
	settle(1, { error: "parse boom" })

	await vi.waitFor(() => expect(text(container, ".error")).toBe("parse boom"))
	expect(text(container, ".answer")).toBe("")

	await click(container, ".reset")
	await vi.waitFor(() => expect(text(container, ".error")).toBe(""))
})
