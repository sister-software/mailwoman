// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

const sidebars: SidebarsConfig = {
	product: [
		{ type: "link", label: "Product overview", href: "/product" },
		{ type: "link", label: "Choose an operation", href: "/product/capabilities" },
		{ type: "link", label: "Choose a deployment", href: "/product/deployment" },
		{ type: "link", label: "Data and licensing", href: "/product/data-and-licensing" },
		{ type: "link", label: "Limits and release status", href: "/product/limits-and-status" },
	],
	solutions: [{ type: "link", label: "Choose a workflow", href: "/solutions" }],
	developers: [
		{ type: "category", label: "Get started", items: ["start"] },
		{
			type: "category",
			label: "Tutorials",
			items: ["tutorials/inspect-a-parse", "tutorials/geocode-a-file", "tutorials/run-a-server"],
		},
		{
			type: "category",
			label: "How-to guides",
			link: { type: "doc", id: "guides/index" },
			items: [
				{
					type: "category",
					label: "Choose and roll out",
					items: [
						"guides/plan-an-integration",
						"guides/evaluate-your-addresses",
						"guides/roll-out-an-integration",
						"guides/report-a-problem",
					],
				},
				{
					type: "category",
					label: "Prepare and review input",
					items: [
						"guides/normalize-input",
						"guides/prefer-one-country",
						"guides/handle-po-boxes",
						"guides/handle-intersections",
						"guides/handle-bare-postcodes",
						"guides/handle-landmark-queries",
						"guides/review-parse-results",
						"guides/validate-records",
					],
				},
				{
					type: "category",
					label: "Find places and manage data",
					items: [
						"guides/batch-geocode",
						"guides/reverse-geocode",
						"guides/review-geocode-evidence",
						"guides/operate-data",
					],
				},
				{
					type: "category",
					label: "Connect and deploy",
					items: [
						"guides/parse-in-browser",
						"guides/add-autocomplete",
						"guides/use-a-compatible-http-client",
						"guides/use-mcp",
						"guides/install-coding-skill",
						"guides/deploy",
					],
				},
				{
					type: "category",
					label: "Match and enrich",
					items: ["guides/match-records", "guides/annotate-results"],
				},
			],
		},
		{
			type: "category",
			label: "Reference",
			items: [
				"reference/cli",
				"reference/http",
				"reference/library",
				"reference/schema",
				"reference/packages-and-runtime",
				"reference/data-and-locales",
				"reference/coverage",
				"reference/support",
			],
		},
		{
			type: "category",
			label: "Explanation",
			items: [
				"explanation/address-systems",
				"explanation/parsing",
				"explanation/geocoding",
				"explanation/confidence-and-limits",
				"explanation/data-and-model-quality",
				"explanation/trust-and-evidence",
			],
		},
	],
	about: [{ type: "link", label: "About Mailwoman", href: "/about" }],
	resources: [
		{ type: "link", label: "Benchmark evidence", href: "/evidence/benchmarks" },
		{ type: "link", label: "Compare geocoders", href: "/evidence/comparisons" },
		{ type: "link", label: "Field notes", href: "/research" },
	],
}

export default sidebars
