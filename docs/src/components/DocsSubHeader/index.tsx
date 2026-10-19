/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import Link from "@docusaurus/Link"
import { useDocsSidebar, useLayoutDocsSidebar } from "@docusaurus/plugin-content-docs/client"
import { useLocation } from "@docusaurus/router"
import clsx from "clsx"
import { type FC, type Ref, useEffect, useRef } from "react"

import { DOCS_SECTIONS, type DocsSectionDef } from "./sections.ts"

import styles from "./styles.module.css"

export { DOCS_SECTIONS } from "./sections.ts"

/**
 * Returns true when the current page is in a switcher section.
 */
export function useIsDocsSection(): boolean {
	const sidebar = useDocsSidebar()

	return DOCS_SECTIONS.some((section) => section.id === sidebar?.name)
}

interface SectionLinkProps {
	section: DocsSectionDef
	active: boolean
}

/**
 * A tab linking to a section's first page.
 */
const SectionLink: FC<SectionLinkProps> = ({ section, active }) => {
	const href = useLayoutDocsSidebar(section.id).link?.path

	if (!href) return null

	return (
		<li className={styles.item}>
			<Link
				to={href}
				className={clsx(styles.link, active && styles.linkActive)}
				data-active={active}
				aria-current={active ? "page" : undefined}
			>
				{section.label}
			</Link>
		</li>
	)
}

export interface DocsSubHeaderProps {
	/**
	 * Ref used to measure the band's height.
	 */
	navbarRef: Ref<HTMLElement>
	/**
	 * Whether to hide the band while scrolling.
	 */
	hidden: boolean
}

/**
 * Sticky, scrollable tabs for switching between top-level docs sections.
 */
export const DocsSubHeader: FC<DocsSubHeaderProps> = ({ navbarRef, hidden }) => {
	const activeName = useDocsSidebar()?.name
	const { pathname } = useLocation()
	const listRef = useRef<HTMLUListElement>(null)

	// Keep the active tab visible when the bar overflows.
	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>("[data-active='true']")
			?.scrollIntoView({ block: "nearest", inline: "center" })
	}, [pathname])

	return (
		<nav
			ref={navbarRef}
			className={clsx(styles.subHeader, hidden && styles.hidden)}
			aria-label="Documentation sections"
		>
			<ul ref={listRef} className={styles.list}>
				{DOCS_SECTIONS.map((section) => (
					<SectionLink key={section.id} section={section} active={section.id === activeName} />
				))}
			</ul>
		</nav>
	)
}
