/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Ejected from @docusaurus/theme-classic (v3.10) so we can mount <DocsSubHeader/>
 * — the sticky switcher for the docs' top-level categories — as a full-width band
 * above the sidebar+content row. The body mirrors upstream verbatim except for:
 *
 *   1. the extra `styles.docsViewport` column wrapper, so the sub-header stacks on
 *      top of the flex-row `docsWrapper` instead of becoming a column beside the
 *      sidebar; and
 *   2. the <DocsSubHeader/> mount + its hide-on-scroll wiring.
 *
 * Re-diff against upstream when bumping Docusaurus.
 */

import { useDocsSidebar } from "@docusaurus/plugin-content-docs/client"
import { useHideableNavbar } from "@docusaurus/theme-common/internal"
import BackToTopButton from "@theme/BackToTopButton"
import type { Props } from "@theme/DocRoot/Layout"
import DocRootLayoutMain from "@theme/DocRoot/Layout/Main"
import DocRootLayoutSidebar from "@theme/DocRoot/Layout/Sidebar"
import clsx from "clsx"
import { type ReactNode, useState } from "react"

import { DocsSubHeader, useIsDocsSection } from "../../../components/DocsSubHeader/index.tsx"

import styles from "./styles.module.css"

export default function DocRootLayout({ children }: Props): ReactNode {
	const sidebar = useDocsSidebar()
	const [hiddenSidebarContainer, setHiddenSidebarContainer] = useState(false)

	// The band shows on section pages (not the single-category licensing sidebar) and
	// hides on scroll-down. `useHideableNavbar` is the same scroll-direction hook the
	// real navbar uses; we pass `showSubHeader` so it no-ops when there's no band.
	const showSubHeader = useIsDocsSection()
	const { navbarRef, isNavbarVisible } = useHideableNavbar(showSubHeader)
	const subHeaderHidden = showSubHeader && !isNavbarVisible

	return (
		<div
			className={clsx(
				styles.docsViewport,
				showSubHeader && styles.withSubHeader,
				subHeaderHidden && styles.subHeaderHidden,
			)}
		>
			{showSubHeader && <DocsSubHeader navbarRef={navbarRef} hidden={subHeaderHidden} />}

			<div className={styles.docsWrapper}>
				<BackToTopButton />

				<div className={styles.docRoot}>
					{sidebar && (
						<DocRootLayoutSidebar
							sidebar={sidebar.items}
							hiddenSidebarContainer={hiddenSidebarContainer}
							setHiddenSidebarContainer={setHiddenSidebarContainer}
						/>
					)}

					<DocRootLayoutMain hiddenSidebarContainer={hiddenSidebarContainer}>{children}</DocRootLayoutMain>
				</div>
			</div>
		</div>
	)
}
