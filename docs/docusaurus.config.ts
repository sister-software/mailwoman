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
	trailingSlash: false,

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
					ignorePatterns: ["/debug", "/debug/", "/trace", "/trace/"],
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
			// The doors, in reading order. `docSidebar` items point at sidebar ids declared in
			// sidebars.ts — the Solutions / Resources doors land with their own tasks and are
			// deliberately absent rather than stubbed, because a navbar entry pointing at an
			// empty sidebar is a dead link with a label on it.
			//
			// Product leads Docs: a visitor who has not decided yet outnumbers the one who has,
			// and every Product page ends in a handoff into the `developers` door.
			items: [
				{
					type: "docSidebar",
					sidebarId: "product",
					position: "left",
					label: "Product",
				},
				{
					type: "docSidebar",
					sidebarId: "developers",
					position: "left",
					label: "Docs",
				},
				{
					type: "docSidebar",
					sidebarId: "about",
					position: "left",
					label: "About",
				},
				{
					// Direct doc link rather than a sidebar: pricing lives in the `about` sidebar for
					// nav-tree membership, but a reader looking for the price wants one click.
					to: "/docs/pricing",
					label: "Pricing",
					position: "left",
				},
				{
					to: "/research",
					label: "Field notes",
					position: "left",
				},
				{
					// The call to action, styled as a button rather than a nav label.
					to: "/demo",
					label: "Try the demo",
					position: "right",
					className: "navbar__cta",
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
						// /training is a published page with no other route into it since the navbar
						// was cut back to the doors. This is the smallest fix for that, not a
						// considered placement — revisit when the Resources door lands.
						{ label: "Training", to: "/training" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "Pricing", to: "/docs/pricing" },
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
