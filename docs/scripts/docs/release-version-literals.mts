// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Finds Mailwoman release versions written as literals in fenced code blocks.
 *
 *   A fenced block in a published page is an instruction a reader copies,
 *   so it installs or runs the current release through `{{release.version}}`,
 *   which `docs/plugins/release-version/remark.ts` substitutes at build time.
 *
 *   The check skips prose and inline code.
 *   A sentence such as "checked with published `mailwoman@11.0.0` on 9 November
 *   2026" records which release a check ran against.
 */

/**
 * Package specifiers, the container image reference and the image build argument,
 * each followed by a version.
 */
const RELEASE_LITERAL =
	/(?:@mailwoman\/[a-z0-9-]+|(?<![\w/@.-])mailwoman)@\d+\.\d+\.\d+|sister-software\/mailwoman:\d+\.\d+\.\d+|MAILWOMAN_VERSION=\d+\.\d+\.\d+/g

const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * One literal release version inside a fenced code block.
 */
export interface ReleaseVersionLiteral {
	/**
	 * The 1-based line number.
	 */
	line: number
	/**
	 * The matched text, such as `mailwoman@11.0.0`.
	 */
	literal: string
}

/**
 * Returns every literal release version inside the fenced code blocks of a Markdown source.
 */
export function findReleaseVersionLiterals(source: string): ReleaseVersionLiteral[] {
	const found: ReleaseVersionLiteral[] = []
	let openFence: string | null = null

	/* oxlint-disable-next-line mailwoman/prefer-spliterator -- pre-install, built-ins-only CI over one Markdown page */
	for (const [index, text] of source.split("\n").entries()) {
		const fence = FENCE.exec(text)?.[1]

		if (fence) {
			if (!openFence) {
				openFence = fence

				continue
			}

			if (fence[0] === openFence[0] && fence.length >= openFence.length) {
				openFence = null

				continue
			}
		}

		if (!openFence) continue

		for (const match of text.matchAll(RELEASE_LITERAL)) {
			found.push({ line: index + 1, literal: match[0] })
		}
	}

	return found
}
