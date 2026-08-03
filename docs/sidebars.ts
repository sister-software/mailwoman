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
		{
			type: "category",
			label: "Tutorials",
			// Reading order again, and it is a dependency order: the parse walk needs only the
			// install, the CSV loop needs candidate.db, the server needs both, and the precision
			// page needs a second download on top. Each page's prerequisites name the one before it.
			//
			// The next two are the wave-2 destinations rather than further rungs on that ladder:
			// the drop-in swap re-uses the same candidate.db as the server page but answers a
			// different question (an existing client, not a new one), and the browser page needs no
			// data root at all. Both sit after the ladder so a reader following it in order reaches
			// them having already met every artifact they name.
			//
			// The last two are the build pages, and they come last because they invert the
			// direction of every page above: those consume published artifacts, these produce
			// them. Each is hours of wall clock and tens of gigabytes, so a reader arrives at
			// them having already established they need something the downloads do not give.
			// US before planet — the planet page's per-country loop assumes the US ladder
			// (rooftop, then interpolation, then the gazetteer under both) is already familiar.
			items: [
				"developers/tutorials/understand-a-parse",
				"developers/tutorials/geocode-a-csv",
				"developers/tutorials/run-the-api-server",
				"developers/tutorials/improve-geocode-precision",
				"developers/tutorials/swap-in-for-nominatim",
				"developers/tutorials/parse-in-the-browser",
				"developers/tutorials/build-the-us-dataset",
				"developers/tutorials/full-planet-build",
			],
		},
		{
			type: "category",
			label: "How-to guides",
			// Not a ladder. Each page is one task a reader arrives already wanting, so the order is by
			// how early in a build the question lands rather than by dependency: get the data clean
			// (messy input, edge kinds), check it (validate, confidence), move volume (batch, records),
			// then the surfaces that sit beside the parse rather than inside it (autocomplete, reverse,
			// annotations), then the operational questions that only arrive once something works
			// (data currency, the two deploy shapes, the agent surfaces, filing a bug).
			// Every page names its own prerequisites and links the tutorial that establishes them, so
			// arriving at any one of them cold works.
			items: [
				"developers/how-to/handle-messy-input",
				"developers/how-to/handle-po-boxes-and-edge-kinds",
				"developers/how-to/validate-addresses",
				"developers/how-to/tune-confidence-thresholds",
				"developers/how-to/batch-geocode-at-volume",
				"developers/how-to/match-messy-records",
				"developers/how-to/add-autocomplete",
				"developers/how-to/reverse-geocode",
				"developers/how-to/use-annotations",
				"developers/how-to/keep-data-fresh",
				"developers/how-to/deploy-docker",
				"developers/how-to/deploy-serverless",
				"developers/how-to/use-the-mcp-server",
				"developers/how-to/install-the-claude-code-skill",
				"developers/how-to/report-a-parsing-bug",
			],
		},
		"developers/status",
		"developers/support",
	],
	about: ["about/mission", "about/security-and-compliance", "about/contact", "pricing"],
}

export default sidebars
