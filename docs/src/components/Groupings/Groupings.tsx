// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Country-grouping IDs from `@mailwoman/registry/groupings`, rendered as a wrapping row of tags.
 *
 *   The component reads no registry data, because `MDXComponents` loads it on every page.
 */

import { isPresent } from "@mailwoman/core/values/objects"
import type React from "react"

import styles from "./styles.module.css"

export interface GroupingsProps {
	/**
	 * Grouping IDs separated by spaces, such as `eu nato un`, in the order to print them.
	 */
	ids: string
}

/**
 * A list of grouping IDs, each one a tag.
 *
 * The list keeps a minimum width, so a table cell holding a dozen groupings wraps
 * them onto two lines rather than one per line.
 */
export const Groupings: React.FC<GroupingsProps> = ({ ids }) => (
	<span className={styles.list}>
		{ids
			.split(/\s+/)
			.filter(isPresent)
			.map((id) => (
				<code key={id} className={styles.id}>
					{id}
				</code>
			))}
	</span>
)
