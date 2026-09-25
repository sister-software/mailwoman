/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared footer identity: app name, optional documentation link, and build revision.
 *   Without build metadata, render the name without a dangling commit link.
 *   Safe to render without map dependencies.
 */

import type { ReactNode } from "react"

import { useBuildInfo } from "#common/useBuildInfo"

/**
 * Number of commit characters shown in the footer.
 */
const DISPLAYED_LENGTH = 6

export interface AppIdentityProps {
	/**
	 * The app's display name — `Mailwoman Earth`, `Mailwoman Moon`, `Mailwoman Mars`.
	 */
	name: ReactNode
	/**
	 * The documentation link's target.
	 *
	 * Omit to render the name and commit without one.
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
	 * Optional URL builder for the commit; without it, show the revision as text.
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
