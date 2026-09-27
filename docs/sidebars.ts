import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

/**
 * Docs sidebars.
 * Every published document belongs to exactly one sidebar.
 *
 * Keep the top-level keys in sync with the switcher sections in `src/components/DocsSubHeader/sections.ts`.
 * The switcher links to each sidebar's first document, so that entry is the section's landing page.
 */
const sidebars: SidebarsConfig = {
	product: [
		"product/overview",
		"product/capabilities",
		"product/deployment-options",
		"product/drop-in-replacements",
		"product/data-products",
	],
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
			items: [
				"developers/get-started/what-mailwoman-is",
				"developers/get-started/install-and-first-parse",
				"developers/get-started/ten-minute-trial",
			],
		},
		{
			type: "category",
			label: "Tutorials",
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
			// The CLI page is generated from the command specs.
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
			items: [
				{
					type: "category",
					label: "Localization",
					items: ["developers/knowledge-base/localization/cross-locale-queries"],
				},
				{
					type: "category",
					label: "Postal systems",
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
	// The root-level pricing page lives here and is also linked from the navbar.
	about: ["about/mission", "about/security-and-compliance", "about/contact", "pricing"],
	resources: [
		{
			type: "category",
			label: "Benchmarks",
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
