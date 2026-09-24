import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

// Node-only navigation configuration.
// Keep these five sidebars synchronized with the switcher sections
// in `src/components/DocsSubHeader/sections.ts`.
// Every published document belongs to one sidebar.
// The root-level pricing page is grouped under `about` and linked directly from the navbar.
const sidebars: SidebarsConfig = {
	// Keep the overview first; the switcher uses it as the product landing page.
	product: [
		"product/overview",
		"product/capabilities",
		"product/deployment-options",
		"product/drop-in-replacements",
		"product/data-products",
	],
	// Lead with the questions that typically arise first in an evaluation.
	solutions: [
		"solutions/eliminate-the-per-request-bill",
		"solutions/own-what-you-look-up",
		"solutions/keep-addresses-inside",
		"solutions/fleet-reverse-geocoding",
		"solutions/resolve-a-messy-file",
	],
	developers: [
		{
			type: "category",
			label: "Get started",
			// The switcher resolves this category to its first document.
			items: [
				"developers/get-started/what-mailwoman-is",
				"developers/get-started/install-and-first-parse",
				"developers/get-started/ten-minute-trial",
			],
		},
		{
			type: "category",
			label: "Tutorials",
			// Tutorials progress from parsing and geocoding to deployment, then data builds.
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
			// Group related tasks from input cleanup through validation, scale, and operations.
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
			// Put API references first.
			// The CLI page is generated from command specifications.
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
			// Background material is grouped by subject rather than by task.
			items: [
				{
					type: "category",
					label: "Localization",
					items: ["developers/knowledge-base/localization/cross-locale-queries"],
				},
				{
					type: "category",
					label: "Postal systems",
					// Explain address structure and delivery before covering edge cases and misconceptions.
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
					// Introduce geocoding, its architectures and data, then discuss quality and alternatives.
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
					// Follow the parse pipeline from tokenization through decoding, calibration, and training.
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
	// Benchmarks lead; comparisons and research notes follow.
	// The benchmark inputs and scripts are published under `static/benchmarks/`.
	resources: [
		{
			type: "category",
			label: "Benchmarks",
			// Show the overview and measurements before the guide to interpreting them.
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
			// Compare hosted, self-hosted, and open-source alternatives in that order.
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
