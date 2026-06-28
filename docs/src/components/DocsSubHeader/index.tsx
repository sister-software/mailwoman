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
 * True when the active sidebar is one of the switcher's sections — i.e. a docs page that should show the band. The
 * single-category licensing sidebar is excluded, so its pages keep the stock layout (no band, no offsets).
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
 * One section tab. Its own hook (`useLayoutDocsSidebar`) resolves the destination from the _target_ sidebar's entry
 * link — so cross-section links work even though only the active sidebar's items are in context. One hook per instance
 * keeps the rules-of-hooks contract clean across the fixed `DOCS_SECTIONS` list.
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
	/** From `useHideableNavbar` — measures the band so its height sets the hide threshold. */
	navbarRef: Ref<HTMLElement>
	/** Slide the band up out of view (scrolled down); the parent reclaims its space in sync. */
	hidden: boolean
}

/**
 * Sticky, horizontally-scrollable switcher for the docs' top-level categories, rendered as a sub-header band between
 * the navbar and the sidebar/content row (mounted from the ejected `theme/DocRoot/Layout`).
 *
 * Each section is its own sidebar (see sidebars.ts), so this bar — not a collapsible sidebar category — is how a reader
 * moves between sections; the active sidebar's contents sit one level shallower as a result.
 */
export const DocsSubHeader: FC<DocsSubHeaderProps> = ({ navbarRef, hidden }) => {
	const activeName = useDocsSidebar()?.name
	const { pathname } = useLocation()
	const listRef = useRef<HTMLUListElement>(null)

	// Keep the active section in view when the bar overflows (mobile / narrow).
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

export default DocsSubHeader
