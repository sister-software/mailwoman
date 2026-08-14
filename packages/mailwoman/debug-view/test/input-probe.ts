/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pty fixture behind `input.pty.test.ts`: the REAL {@link QueryInput}, wired the way
 *   `DebugSessionApp` wires it (a parent `useInput` owning escape, the field owning everything else), plus a plain
 *   `VALUE=[…]` echo the test asserts against.
 *
 *   JSX-free `createElement`, like the component it renders, because bare node strips types but does not transform
 *   JSX — and running the shipped source under a real terminal is the whole point of the probe. A fixture that
 *   re-implemented the key handling would prove only that the fixture works.
 */

import { Box, render, Text, useApp, useInput } from "ink"
import { createElement as h, useState, type ReactElement } from "react"

import { QueryInput, type InputState } from "../QueryInput.ts"

function Probe(): ReactElement {
	const { exit } = useApp()
	const [field, setField] = useState<InputState>({ value: "", cursor: 0 })
	const [submitted, setSubmitted] = useState("")

	useInput((_input, key) => {
		if (key.escape) {
			exit()
		}
	})

	return h(
		Box,
		{ flexDirection: "column" },
		h(
			Box,
			null,
			h(Text, null, "> "),
			h(QueryInput, {
				value: field.value,
				cursor: field.cursor,
				onChange: setField,
				onSubmit: setSubmitted,
				focus: true,
			})
		),
		h(Text, null, `VALUE=[${field.value}]`),
		h(Text, null, `CURSOR=[${field.cursor}]`),
		h(Text, null, `SUBMITTED=[${submitted}]`),
		h(Text, null, "READY")
	)
}

// Ink resolves `interactive` from `is-in-ci` and `stdout.isTTY`, so a CI environment variable makes it
// non-interactive even under a real pty — and a non-interactive Ink writes ONLY the final frame at unmount.
// The test reads the field's edit history out of the pty capture, so the frames have to be forced on.
render(h(Probe), { interactive: true })
