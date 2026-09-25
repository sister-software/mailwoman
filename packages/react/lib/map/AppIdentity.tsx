/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders the footer identity with the app name, an optional documentation link and the build
 *   commit. This component does not depend on the map.
 */

import type { ReactNode } from "react"

import { useBuildInfo } from "#common/useBuildInfo"

/**
 * The number of commit characters shown in the footer.
 */
const DISPLAYED_LENGTH = 6

/**
 * Props for {@link AppIdentity}.
 */
export interface AppIdentityProps {
	/**
	 * The app's display name, such as `Mailwoman Earth`.
	 */
	name: ReactNode
	/**
	 * The documentation link's target.
	 * The link is omitted when this is unset.
	 */
	docsURL?: string
	/**
	 * The documentation link's text. @default "Developer Documentation"
	 */
	docsLabel?: string
	/**
	 * The URL of the build record. @default "/build.json"
	 */
	buildInfoURL?: string
	/**
	 * Builds the commit link.
	 * Without it, the commit is shown as plain text.
	 */
	commitHref?: (commit: string) => string
}

/**
 * Renders the app name, documentation link and short build commit.
 * The commit is omitted when no build record loads.
 */
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
