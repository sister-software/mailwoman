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
// docs/records/site-2026-08/. Five doors ship here, and they are the whole published site:
//
// - `product` — what the engine does, where it runs, what it replaces, what data it pulls.
// - `solutions` — the same engine addressed by the pain a buyer arrives with, not by feature.
// - `developers` — the get-started trio, what ships today, and where to get help.
// - `about` — the open-strategy pages, the compliance boundary, contact, and pricing.
// - `resources` — the evidence door: published benchmarks with their runnable scripts, and the
//   capability-shape comparisons against the alternatives.
//
// `pricing` is a root-level doc that sits in the `about` sidebar so it has a home in the
// nav tree (the orphan check in scripts/check-docs-structure.ts requires one), while the
// navbar links it directly at /docs/pricing.
const sidebars: SidebarsConfig = {
	// Evaluation order, and every page here routes rather than instructs: a reader arrives
	// deciding whether Mailwoman fits, not building against it. Overview defines the thing;
	// capabilities answers what it does; deployment options answers where it runs; drop-in
	// replacements answers what it can stand in for; data products answers what you carry.
	// Each page hands off into the `developers` door, so this sidebar is the shallow end
	// rather than a parallel set of instructions.
	//
	// Flat, no lead category: `useLayoutDocsSidebar("product").link` resolves to the first
	// entry, so the switcher tab lands on the overview.
	product: [
		"product/overview",
		"product/capabilities",
		"product/deployment-options",
		"product/drop-in-replacements",
		"product/data-products",
	],
	// Indexed by the pain a reader arrives with rather than by the feature that answers it,
	// so a manager scanning the switcher recognizes their own problem before they have
	// learned any of this project's vocabulary. Every page runs the same four beats —
	// problem, what changes, what you still carry, the same two closing links — because the
	// repetition is what makes the door scannable at the fifth page.
	//
	// Order is by how early the question lands in an evaluation: cost is the question that
	// starts one, storage rights and residency are the two that stop one, and the last two
	// are workload-shaped rather than commercial — they are read by someone who has already
	// decided the commercial part and is now checking a specific job.
	//
	// Flat, no lead category, for the same reason as `product`: the switcher tab resolves
	// through `useLayoutDocsSidebar("solutions").link` to the first entry.
	solutions: [
		"solutions/cut-the-per-request-bill",
		"solutions/own-what-you-look-up",
		"solutions/keep-addresses-inside",
		"solutions/fleet-reverse-geocoding",
		"solutions/resolve-a-messy-file",
	],
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
		{
			type: "category",
			label: "Reference",
			// Look-up order, not reading order: a reader arrives here knowing the fact they want,
			// so the surfaces come first (library, CLI, HTTP), then the vocabularies those surfaces
			// speak (component tags), then the things you decide before you install (packages,
			// runtime flags, locales, footprints). `cli` is generated by
			// docs/scripts/generate-cli-reference.ts on every build — edit the command schemas, not
			// the page.
			items: [
				"developers/reference/library-api",
				"developers/reference/cli",
				"developers/reference/http-apis",
				"developers/reference/component-tags",
				"developers/reference/packages",
				"developers/reference/runtime-flags",
				"developers/reference/locales-and-tiers",
				"developers/reference/footprints",
			],
		},
		{
			type: "category",
			label: "Knowledge base",
			// Background rather than instruction: nothing here changes a reader's filesystem, and every
			// page hands off to the tutorial, how-to or reference that does. Shelves are separate
			// categories so a reader can tell domain knowledge (postal systems) apart from the machinery.
			items: [
				{
					type: "category",
					label: "Postal systems",
					// Reading order. The first four build one idea: an address is an instruction to a
					// postal service (what an address is), the routing code inside it is a path through a
					// sorting network (postcodes), the network is why the format is ordered as it is (how
					// mail gets delivered), and every country ordered it differently (around the world).
					// The next two are the hard cases that follow from the idea, and falsehoods sits last
					// because it distills all six into one line each — useful as a checklist once the
					// reasoning is familiar, and reachable cold for a reader who arrives at it directly.
					items: [
						"developers/knowledge-base/postal/what-is-an-address",
						"developers/knowledge-base/postal/postcodes-and-zip-codes",
						"developers/knowledge-base/postal/how-mail-gets-delivered",
						"developers/knowledge-base/postal/addressing-around-the-world",
						"developers/knowledge-base/postal/two-addresses-one-building",
						"developers/knowledge-base/postal/po-boxes-and-alternatives",
						"developers/knowledge-base/postal/falsehoods-about-addresses",
					],
				},
				{
					type: "category",
					label: "Geocoding",
					// Reading order, and it builds the same way the postal shelf does. The first page
					// defines the job (forward and reverse, place against coordinate, precision tiers);
					// the second is the shelf's argument — the two ways the job is built, and what each
					// costs to run; the third is the place database both designs sit on. Those three are
					// the machinery. The last three are the judgment calls that follow from it: how to
					// decide whether a coordinate is good enough, how to choose among the shapes on the
					// market, and why the parsing half resists rules in the first place.
					// `why-addresses-are-hard` sits last for the same reason `falsehoods` does next door —
					// it is the distillation, and it reads better once the machinery is familiar.
					items: [
						"developers/knowledge-base/geocoding/what-geocoding-is",
						"developers/knowledge-base/geocoding/the-two-architectures",
						"developers/knowledge-base/geocoding/gazetteers",
						"developers/knowledge-base/geocoding/how-close-is-close-enough",
						"developers/knowledge-base/geocoding/the-landscape",
						"developers/knowledge-base/geocoding/why-addresses-are-hard",
					],
				},
				{
					type: "category",
					label: "Address intelligence",
					// Reading order, and it follows one parse from end to end. The first page is the
					// whole chain on one messy input; the next three take a stage each in the order the
					// parse runs them (pieces and labels, the gazetteer prior on the scores, the decode
					// that picks a reading). Calibration comes fifth because it is about the number the
					// first four produce, and training sixth because it explains where all of it was
					// learned. `what-the-model-cannot-do` sits last for the same reason `falsehoods` and
					// `why-addresses-are-hard` do on the shelves above — it is the distillation, and its
					// limits read as limits rather than as a list once the machinery is familiar.
					items: [
						"developers/knowledge-base/address-intelligence/how-a-model-reads-an-address",
						"developers/knowledge-base/address-intelligence/tokens-and-labels",
						"developers/knowledge-base/address-intelligence/the-gazetteer-prior",
						"developers/knowledge-base/address-intelligence/decoding-and-viterbi",
						"developers/knowledge-base/address-intelligence/calibration-and-confidence",
						"developers/knowledge-base/address-intelligence/training-and-the-corpus",
						"developers/knowledge-base/address-intelligence/what-the-model-cannot-do",
					],
				},
			],
		},
		"developers/status",
		"developers/support",
	],
	about: ["about/mission", "about/security-and-compliance", "about/contact", "pricing"],
	// The evidence door. Benchmarks lead because they are the door's claim — the pages carry
	// numbers, and every number's script, inputs and result file are published beside it under
	// `static/benchmarks/`. Compare follows because a reader who has read a measurement is better
	// equipped to read a capability comparison than the other way round.
	//
	// `benchmarks/index` sits first inside its own category so
	// `useLayoutDocsSidebar("resources").link` resolves to it and the switcher tab lands on the
	// evidence door's front page rather than mid-panel.
	//
	// Field notes moved here from the navbar in this task: it is long-form research writing, which
	// is what this door is for, and the navbar was gaining a sixth item. It stays a `link` item
	// because `/research` is a plugin route rather than a doc, and it sits last so it never
	// resolves as the door's entry link. The footer keeps its own link, unchanged.
	resources: [
		{
			type: "category",
			label: "Benchmarks",
			// Reading order: the door's front page, then the two panels in the order they were run,
			// then the reading guide. The guide sits last on purpose — it is written against the two
			// panels above it and illustrates every trap with one of their numbers, so it lands
			// better once the measurements are familiar. It is reachable cold from either panel.
			items: [
				"resources/benchmarks/index",
				"resources/benchmarks/france-ban",
				"resources/benchmarks/belgium-panel",
				"resources/benchmarks/reading-our-numbers",
			],
		},
		{
			type: "category",
			label: "Compare",
			// Ordered by how a reader arrives: hosted API first (the default alternative anyone has
			// already found), then the self-hosted engine, then the open-source stack you meet when
			// you decide to build rather than buy. Each page ends in a "when to choose them" section
			// and none of them carries an accuracy claim about another system.
			items: [
				"resources/compare/index",
				"resources/compare/google-maps",
				"resources/compare/self-hosted-nominatim",
				"resources/compare/pelias-and-libpostal",
			],
		},
		{ type: "link", label: "Field notes", href: "/research" },
	],
}

export default sidebars
