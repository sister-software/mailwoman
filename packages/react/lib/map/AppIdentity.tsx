/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<AppIdentity>` — the left half of the footer strip: the app's name, a link to the documentation, and the commit
 *   the build was made from.
 *
 *   One home for all three sites. Earth, Moon and Mars mount the same `<MapFooter>` and differ only in a display name
 *   and their credits, so a commit link written into any one of them would be a copy the other two either lack or
 *   grow separately.
 *
 *   The commit is what a bug report cannot otherwise carry. These deploy from `main` on every push that reaches them,
 *   so "the site" is whichever revision was head at build time and a visitor describing a behaviour has no way to say
 *   which one they saw. `build.json` is that record, and its absence — a dev server, an offline first paint — renders
 *   the name alone rather than a dangling link.
 *
 *   node-safe: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { useBuildInfo } from "#common/useBuildInfo"

/**
 * How much of the revision the link shows. Long enough to be unambiguous in this repository,
 * short enough to sit in a one-line strip beside the name and the credits.
 */
const DISPLAYED_LENGTH = 6

export interface AppIdentityProps {
	/**
	 * The app's display name — `Mailwoman Earth`, `Mailwoman Moon`, `Mailwoman Mars`.
	 */
	name: ReactNode
	/**
	 * The documentation link's target. Omit to render the name and commit without one.
	 */
	docsURL?: string
	/**
	 * What the documentation link reads. @default "Developer Documentation"
	 */
	docsLabel?: string
	/**
	 * Where to read the deployment record. @default "/build.json"
	 */
	buildInfoURL?: string
	/**
	 * Build the href for a commit. injected rather than written here: the repository's URL belongs
	 * to the deployment, and `@mailwoman/react` publishes to npm while `@mailwoman/site-kit` —
	 * which owns `commitURL` beside the record that carries the sha — is private,
	 * so this package cannot import it. `commitURL` takes the sha for this reason: every
	 * caller passes it directly, so no app writes an adapter and the URL keeps a single home.
	 * Without this prop the revision renders as text rather than a link.
	 */
	commitHref?: (commit: string) => string
}

export function AppIdentity({
	name,
	docsURL,
	docsLabel = "Developer Documentation",
	buildInfoURL,
	commitHref,
}: AppIdentityProps): ReactNode {
	const build = useBuildInfo(buildInfoURL)
	const commit = build?.commit

	return (
		<>
			<strong>{name}</strong>
			{docsURL ? (
				<>
					{" "}
					<a href={docsURL}>{docsLabel}</a>
				</>
			) : null}
			{commit ? (
				<>
					{" ("}
					{commitHref ? (
						<a href={commitHref(commit)} title={`Built from ${commit}`}>
							<code>{commit.slice(0, DISPLAYED_LENGTH)}</code>
						</a>
					) : (
						<code title={`Built from ${commit}`}>{commit.slice(0, DISPLAYED_LENGTH)}</code>
					)}
					{")"}
				</>
			) : null}
		</>
	)
}
