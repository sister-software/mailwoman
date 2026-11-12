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
			items: [
				"guides/batch-geocode",
				"guides/reverse-geocode",
				"guides/operate-data",
				"guides/deploy",
				"guides/use-a-compatible-http-client",
				"guides/use-mcp",
				"guides/report-a-problem",
				"guides/validate-records",
				"guides/install-coding-skill",
				"guides/annotate-results",
				"guides/match-records",
				"guides/normalize-input",
				"guides/handle-po-boxes",
				"guides/handle-intersections",
				"guides/handle-bare-postcodes",
				"guides/handle-landmark-queries",
				"guides/review-parse-results",
				"guides/parse-in-browser",
				"guides/add-autocomplete",
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
