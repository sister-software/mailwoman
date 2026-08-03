import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)
//
// One sidebar per top-level door. The docs sub-header (src/components/DocsSubHeader) is
// the door switcher, so a sidebar never wraps its contents in a collapsible section
// category — every doc sits at the top level of its own sidebar. The ids here are the
// authority the switcher reads (src/components/DocsSubHeader/sections.ts must list the
// same ids, in display order). Each doc belongs to exactly one sidebar, so Docusaurus
// picks the right one automatically.
//
// State as of the docs-reorg Task 5 skeleton cutover: the old seven-sidebar tree
// (startHere / use / understand / reference / contribute / legal) is gone with the
// content it indexed — everything it listed now lives unpublished under
// docs/records/site-2026-08/. Two doors ship here, and they are the whole published site:
//
// - `developers` — the get-started trio, what ships today, and where to get help.
// - `about` — the open-strategy pages, the compliance boundary, contact, and pricing.
//
// The Product / Solutions / Resources doors land with their own tasks. They are NOT
// declared here as empty sidebars: an empty sidebar renders a dead switcher tab (and
// `useLayoutDocsSidebar(...).link` resolves to nothing), so a door arrives together with
// the pages behind it or not at all.
//
// `pricing` is a root-level doc that sits in the `about` sidebar so it has a home in the
// nav tree (the orphan check in scripts/check-docs-structure.ts requires one), while the
// navbar links it directly at /docs/pricing.
const sidebars: SidebarsConfig = {
	developers: [
		{
			type: "category",
			label: "Get started",
			// Reading order, not alphabetical: what it is → install → the trial arc.
			// `useLayoutDocsSidebar("developers").link` resolves through this category to
			// its first doc, which is why the switcher tab still gets a destination with a
			// category in the lead position.
			items: [
				"developers/get-started/what-mailwoman-is",
				"developers/get-started/install-and-first-parse",
				"developers/get-started/ten-minute-trial",
			],
		},
		"developers/status",
		"developers/support",
	],
	about: ["about/mission", "about/security-and-compliance", "about/contact", "pricing"],
}

export default sidebars
