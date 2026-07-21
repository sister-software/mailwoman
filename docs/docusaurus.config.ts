import { execSync } from "node:child_process"

import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { themes as prismThemes } from "prism-react-renderer"

import type { GlossaryPluginOptions } from "./plugins/glossary/plugin.ts"
// Upstream remark auto-linker wrapped with the proper-noun guard (see plugins/glossary/remark.ts).
import glossaryRemarkPlugin from "./plugins/glossary/remark.ts"

const gitHash = (() => {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	} catch {
		return "unknown"
	}
})()

const buildDate = new Date()
const buildTime = buildDate.toISOString()
// Locale-stable display format: "2026-05-28 02:42 UTC". Same string on server and client,
// so no React hydration mismatch.
const buildTimeDisplay = (() => {
	const pad = (n: number) => String(n).padStart(2, "0")
	const Y = buildDate.getUTCFullYear()
	const M = pad(buildDate.getUTCMonth() + 1)
	const D = pad(buildDate.getUTCDate())
	const h = pad(buildDate.getUTCHours())
	const m = pad(buildDate.getUTCMinutes())

	return `${Y}-${M}-${D} ${h}:${m} UTC`
})()

const config: Config = {
	customFields: {
		buildCommit: gitHash,
		buildTime,
		buildTimeDisplay,
	},
	title: "Mailwoman",
	tagline: "TypeScript-first address parser + geocoder. No API key — runs in Node and the browser.",
	favicon: "img/favicon-32.png",
	headTags: [
		{
			tagName: "meta",
			attributes: {
				name: "theme-color",
				content: "#00093b",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://public.sister.software",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://tiles.sister.software",
			},
		},
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://elevation-tiles-prod.s3.amazonaws.com",
			},
		},
	],

	future: {
		v4: true,
		// @docusaurus/faster is installed but its rspack bundler chokes on `node:` prefixed imports
		// from isomorphic deps (sentencepiece-js, onnxruntime-web). Explicitly disable so standard
		// webpack stays in charge. The other speedups (swc loader / minimizer, lightningcss, mdx
		// cache) are stable on this build and worth keeping.
		faster: {
			rspackBundler: false,
			rspackPersistentCache: false,
		},
	},

	url: "https://mailwoman.sister.software",
	baseUrl: "/",
	// GitHub Pages 301-redirects every slashless URL to its `…/` form. Without this flag,
	// Docusaurus emits slashless canonicals/sitemap/links, and the Algolia Crawler drops
	// every page whose canonical ≠ served URL — the whole docs tree vanished from search.
	trailingSlash: true,

	organizationName: "sister-software",
	projectName: "mailwoman",

	onBrokenLinks: "throw",
	onBrokenAnchors: "throw",

	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},

	plugins: [
		"./plugins/demo-assets/plugin.ts",
		[
			// Wraps docusaurus-plugin-glossary: same validation/tooltips/remark, custom page with
			// tag filters + category TOC. See plugins/glossary/plugin.ts.
			"./plugins/glossary/plugin.ts",
			{
				glossaryPath: "glossary/glossary.json",
				routePath: "/glossary",
				expandAcronymsOnFirstUse: true,
				autoLinkTerms: true,
			} satisfies GlossaryPluginOptions,
		],
	],

	themes: ["@docusaurus/theme-mermaid"],

	markdown: {
		mermaid: true,
	},

	presets: [
		[
			"classic",
			{
				docs: {
					path: "articles",
					routeBasePath: "docs",
					sidebarPath: "./sidebars.ts",
					// Single shared tag registry (also used by the blog and the glossary plugin).
					// Docusaurus resolves this relative to the content dir, hence the "../".
					tags: "../tags.yml",
					onInlineTags: "throw",
					editUrl: "https://github.com/sister-software/mailwoman/tree/main/docs/",
					// Internal-only content — kept in the repo for the record but NOT rendered on the public
					// site (globs are relative to `path: "articles"`). `reviews/` is AI-consult transcripts +
					// the public-readiness review; the `*postmortem*` / session-report files are candid
					// night-shift narratives with spend + autonomous-operation notes — neither is for a public
					// audience. The technical eval reports stay published (concept pages cite them as
					// evidence). Where a kept page linked to one of these, the link was reduced to plain text
					// (onBrokenLinks is "throw"). To re-publish a doc, remove its pattern here.
					// The `**` matches the topic subdirs (evals/{night-shifts,retrospectives}/…) the reports
					// were foldered into — a postmortem stays unpublished wherever it lands in the tree.
					exclude: ["reviews/**", "evals/**/*postmortem*", "evals/**/*night-shift-session-report*"],
					remarkPlugins: [
						[
							glossaryRemarkPlugin,
							{
								glossaryPath: "glossary/glossary.json",
								routePath: "/glossary",
								siteDir: __dirname,
							},
						],
					],
				},
				pages: {
					// Files in src/pages/ are auto-routed. Co-located `.ts` helpers (e.g.
					// demo/map-helpers.ts) are NOT pages and SSG-fail ("no default export") if routed —
					// a latent break the install-blocked CI never surfaced. Pages here are all
					// .tsx/.md/.mdx, so exclude `.ts`. The other entries reproduce Docusaurus's defaults
					// (a custom `exclude` replaces them).
					exclude: [
						"**/_*.{js,jsx,ts,tsx,md,mdx}",
						"**/_*/**",
						"**/*.test.{js,jsx,ts,tsx}",
						"**/__tests__/**",
						"**/*.ts",
					],
				},
				blog: {
					path: "research",
					routeBasePath: "research",
					tags: "../tags.yml",
					onInlineTags: "throw",
					blogTitle: "Field notes",
					blogDescription: "Iteration notes, ship retrospectives, design log entries.",
					blogSidebarTitle: "All posts",
					blogSidebarCount: "ALL",
					showReadingTime: true,
					postsPerPage: 10,

					feedOptions: {
						type: ["rss", "atom"],
						title: "Mailwoman Research Log",
						copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
					},
				},
				sitemap: {
					// Internal utility pages — keep them reachable but out of the sitemap
					// (and thus out of crawler discovery). Patterns cover both slash forms.
					ignorePatterns: ["/debug", "/debug/", "/trace", "/trace/", "/demo-next", "/demo-next/"],
				},
				theme: {
					customCss: [
						// ---
						"./src/css/fonts/IosevkaNexus.css",
						"./src/css/fonts/IosevkaNexusMono.css",
						"./src/css/theme-light.css",
						"./src/css/theme-dark.css",
						"./src/css/markdown.css",
						"./src/css/sidebar.css",
						"./src/css/docs-subheader.css",
						"./src/css/toc-mobile.css",
						"./src/css/mermaid.css",
						"./src/css/custom.css",
					],
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		// Default og:image / twitter:card for every page; the same card is uploaded
		// as the GitHub repo social preview. Regenerate via docs/scripts/social-card.html.
		image: "img/social-card.png",
		colorMode: {
			respectPrefersColorScheme: true,
		},
		mermaid: {
			theme: { light: "base", dark: "base" },
			options: {
				fontFamily: '"Iosevka Nexus Mono Web", "Iosevka", monospace',
				flowchart: { htmlLabels: false, curve: "basis", padding: 18 },
				themeVariables: { primaryColor: "#ffffff", lineColor: "#21201c" },
			},
		},
		algolia: {
			appId: "1AEXFQAAAJ",
			indexName: "Mailwoman Site",
			apiKey: "637194a77c844e7df987b51d59505272",
		},
		navbar: {
			title: "Mailwoman",
			logo: {
				alt: "Mailwoman 〒 hanko seal",
				// Magenta seal on the navy navbar in both themes — the design system
				// brief calls magenta the primary mark; navy/blue alts ship under
				// /img for use on lighter surfaces.
				src: "img/mailwoman-seal-magenta.svg",
			},
			items: [
				{
					to: "/demo",
					label: "Demo",
					position: "left",
				},
				{
					to: "/training",
					label: "Training",
					position: "left",
				},
				{
					// Lands on the "Start here" section; the docs sub-header switches sections from there.
					type: "docSidebar",
					sidebarId: "startHere",
					position: "left",
					label: "Docs",
				},
				{
					to: "/research",
					label: "Field notes",
					position: "left",
				},
				{
					to: "/glossary",
					label: "Glossary",
					position: "left",
				},
				{
					to: "/docs/licensing/",
					label: "Licensing",
					position: "left",
				},
				{
					href: "https://github.com/sister-software/mailwoman",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Try it",
					items: [
						{ label: "Demo", to: "/demo" },
						{ label: "Field notes", to: "/research" },
					],
				},
				{
					title: "Docs",
					items: [
						{ label: "Roadmap", to: "/docs/plan/SCOPE" },
						{ label: "Eval reports", to: "/docs/evals/" },
						{ label: "Retrospectives", to: "/docs/retrospectives" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
			],
			copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
}

export default config
