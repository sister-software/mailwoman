// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the annotations of one check run, the record a check without a GitHub Actions
 * job log leaves of why it failed, such as a CodeQL alert.
 *
 * The check run's id comes from the link `gh pr checks` returns.
 * That link ends in `/runs/<id>` for a check that isn't an Actions job.
 *
 * The annotations come from `gh api repos/<repo>/check-runs/<id>/annotations`, every page.
 *
 * A failed call is returned with its error and a call that returned zero annotations
 * returns an empty list marked as read, so a reader can tell the two apart.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { isProcessError } from "@mailwoman/core/process"

import { PULL_REQUEST_REPO } from "#check-kit/pull-request/checks"
import { type RunGitHub, runGitHub } from "#dev-mcp/github"

/**
 * One annotation on a check run.
 */
export interface CheckAnnotation {
	path: string
	startLine: number | null
	endLine: number | null
	/**
	 * GitHub's level: `notice`, `warning` or `failure`.
	 */
	level: string
	title: string | null
	message: string
}

/**
 * The annotations of one check run, or why they couldn't be read.
 */
export type CheckAnnotationsReading =
	| { checkRunID: number; read: true; annotations: CheckAnnotation[] }
	| { checkRunID: number; read: false; error: string }

/**
 * Reads one check run's annotations, injected by a test.
 */
export type ReadCheckAnnotations = (checkRunID: number) => Promise<CheckAnnotationsReading>

interface RawAnnotation {
	path: string
	start_line?: number | null
	end_line?: number | null
	annotation_level: string
	title?: string | null
	message: string
}

/**
 * Read every annotation of the check run `checkRunID`.
 *
 * @param run The `gh` runner, injected by a test.
 */
export async function readCheckRunAnnotations(
	checkRunID: number,
	run: RunGitHub = runGitHub
): Promise<CheckAnnotationsReading> {
	let stdout: string

	try {
		stdout = await run([
			"api",
			`repos/${PULL_REQUEST_REPO}/check-runs/${checkRunID}/annotations?per_page=100`,
			"--paginate",
			"--slurp",
		])
	} catch (error) {
		const message = isProcessError(error)
			? error.stderr.trim() || error.message
			: error instanceof Error
				? error.message
				: String(error)

		return { checkRunID, read: false, error: `gh api failed: ${message}` }
	}

	let pages: RawAnnotation[][]

	try {
		pages = parseJSONStrict<RawAnnotation[][]>(stdout)
	} catch (error) {
		return {
			checkRunID,
			read: false,
			error: `gh api printed output that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
		return { checkRunID, read: false, error: "gh api printed JSON that is not a list of annotation pages" }
	}

	return {
		checkRunID,
		read: true,
		annotations: pages.flat().map((raw) => ({
			path: raw.path,
			startLine: raw.start_line ?? null,
			endLine: raw.end_line ?? null,
			level: raw.annotation_level,
			title: raw.title ?? null,
			message: raw.message,
		})),
	}
}

/**
 * One line per annotation: its level, its path and line, its title and its message.
 */
export function describeAnnotation(annotation: CheckAnnotation): string {
	const location = annotation.startLine == null ? annotation.path : `${annotation.path}:${annotation.startLine}`

	return `${annotation.level} ${location}: ${annotation.title ? `${annotation.title}: ` : ""}${annotation.message}`
}
