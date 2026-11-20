// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reduces a check's captured output to the text its tools printed.
 *
 * A GitHub Actions log prefixes each line with the job, the step and a timestamp.
 * `run-p --print-label` prefixes each line with one bracketed label per nesting level.
 *
 * A terminal color adds escape sequences.
 * Each parser reads the line with all three removed, and keeps the innermost label.
 */

import { stripANSI } from "@mailwoman/core/strings/terminal"

/**
 * One line of a check's output with its prefixes removed.
 */
export interface CheckOutputLine {
	/**
	 * The innermost `run-p` label, such as `lint:prose:code`, or `null` for an unlabeled line.
	 */
	label: string | null
	text: string
}

/**
 * The tab-separated job and step names and the RFC 3339 timestamp a downloaded Actions log puts first.
 */
const ACTIONS_PREFIX = /^[^\t]*\t[^\t]*\t﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u

/**
 * A `run-p --print-label` prefix: the script name padded inside brackets, then one space.
 */
const RUN_P_LABEL = /^\[([A-Za-z0-9:_-]+)\s*\] ?/u

/**
 * A color sequence written as the two characters
 * `^[` in place of the escape byte, as `gh run view --log` prints it.
 */
const CARET_ESCAPE = /\^\[\[[0-9;]*m/gu

/**
 * Split captured output into lines, removing the Actions prefix, escape sequences and every `run-p` label.
 */
// repo-health-ignore export-name-affix -- the debug view's `outputLines` renders a parse trace.
export function checkOutputLines(output: string): CheckOutputLine[] {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- the runner has already buffered the output in memory
	return output.split(/\r\n|\r|\n/u).map((raw) => {
		let text = stripANSI(raw).replaceAll(CARET_ESCAPE, "").replace(ACTIONS_PREFIX, "")
		let label: string | null = null

		for (let match = RUN_P_LABEL.exec(text); match; match = RUN_P_LABEL.exec(text)) {
			label = match[1]!
			text = text.slice(match[0].length)
		}

		return { label, text }
	})
}
