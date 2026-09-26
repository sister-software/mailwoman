import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { runShellSync } from "@mailwoman/core/process"
import { themes as prismThemes } from "prism-react-renderer"

import type { GlossaryPluginOptions } from "./plugins/glossary/plugin.ts"
// Upstream remark auto-linker wrapped with the proper-noun and homonym guards (see plugins/glossary/remark.ts).
import glossaryRemarkPlugin from "./plugins/glossary/remark.ts"

/**
 * Surfaces the glossary auto-linker must never link, whatever term claims them.
 *
 * `state` (an alias of `region`) fired on 38 pages and `tier` on 39 in ordinary senses.
 * Suppression is by surface, so `region` still links and a multi-word phrase
 * containing a suppressed word still links in full.
 */
const GLOSSARY_NO_AUTO_LINK = ["state", "tier"] as const

const gitHash = (() => {
	try {
		// oxlint-disable-next-line mailwoman/prefer-home -- the Docusaurus config loader is synchronous, and `@mailwoman/core/git` answers a promise
		return runShellSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
	} catch {
		return "unknown"
	}
})()

const buildDate = new Date()
const buildTime = buildDate.toISOString()

// Locale-stable display format, identical on server and client, so no React hydration mismatch.
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
				href: "https://public.mailwoman.ai",
			},
		},
		// The four faces that paint above the fold, preloaded; without them the font
		// chain measured ~1.57 s to first font byte on a warm cache.
		// Any other face still loads lazily.
		...(
			[
				"IoveskaNexus/WOFF2/IosevkaNexus-Regular.woff2",
				"IoveskaNexus/WOFF2/IosevkaNexus-Book.woff2",
				"IoveskaNexus/WOFF2/IosevkaNexus-Bold.woff2",
				"IosevkaNexusMono/WOFF2/IosevkaNexusMono-Regular.woff2",
			] as const
		).map((file) => ({
			tagName: "link",
			attributes: {
				rel: "preload",
				as: "font",
				type: "font/woff2",
				crossorigin: "anonymous",
				href: `https://public.mailwoman.ai/fonts/${file}`,
			},
		})),
		{
			tagName: "link",
			attributes: {
				rel: "preconnect",
				href: "https://tiles.mailwoman.ai",
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
		// rspack bundles the site; both bundlers report maplibre-gl's dynamic `import()` of an
		// expression as a "Critical dependency" warning, so that is not a bundler difference.
		// The persistent cache stays off until a build has been measured with it.
		faster: {
			rspackBundler: true,
			rspackPersistentCache: false,
		},
	},

	url: "https://mailwoman.ai",
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
		[
			// `/docs` is `routeBasePath`, not a page, so a reader who trims the path to `/docs` gets a 404.
			// This sends it to the first page of the get-started trio.
			"@docusaurus/plugin-client-redirects",
			{
				redirects: [
					{ from: "/docs", to: "/docs/developers/get-started/what-mailwoman-is" },
					// The navbar labels this door "Pricing", so `/pricing` is the URL a visitor guesses.
					{ from: "/pricing", to: "/docs/pricing" },
					// Same for the license page, which is the only route that can take money.
					{ from: ["/licensing", "/licenses"], to: "/license" },
				],
			},
		],
		"./plugins/runtime-assets/plugin.ts",
		[
			// Wraps docusaurus-plugin-glossary with the same validation, tooltips and remark.
			// Adds a custom page with tag filters and a category TOC.
			"./plugins/glossary/plugin.ts",
			{
				glossaryPath: "glossary/glossary.json",
				routePath: "/glossary",
				expandAcronymsOnFirstUse: true,
				autoLinkTerms: true,
				// Same list the remark linker gets, so backlinks and tooltips agree.
				noAutoLink: GLOSSARY_NO_AUTO_LINK,
			} satisfies GlossaryPluginOptions,
		],
	],

	themes: ["@docusaurus/theme-mermaid"],

	markdown: {
		mermaid: true,
	},

	clientModules: ["./src/client/trust-policies.ts"],

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
								noAutoLink: GLOSSARY_NO_AUTO_LINK,
							},
						],
					],
				},
				pages: {
					// Co-located `.ts` helpers are not pages and SSG-fail ("no default export")
					// if routed, so exclude them.
					// The other entries reproduce Docusaurus's defaults.
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
					// Internal utility pages stay reachable but out of the sitemap; patterns cover both slash forms.
					ignorePatterns: ["/demo", "/demo/", "/debug", "/debug/", "/trace", "/trace/"],
				},
				theme: {
					customCss: [
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
		// Default og:image / twitter:card for every page; regenerate via docs/scripts/social-card.html.
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
				// Magenta is the design system's primary mark on the navy navbar in both themes;
				// navy/blue alternatives ship under /img for lighter surfaces.
				src: "img/mailwoman-seal-magenta.svg",
			},
			// The doors, in reading order; `docSidebar` items point at sidebar ids declared in sidebars.ts.
			// Resources follows Docs (the evidence door) and Product leads Docs (the undecided visitor.
			items: [
				{
					type: "docSidebar",
					sidebarId: "product",
					position: "left",
					label: "Product",
				},
				{
					type: "docSidebar",
					sidebarId: "solutions",
					position: "left",
					label: "Solutions",
				},
				{
					type: "docSidebar",
					sidebarId: "developers",
					position: "left",
					label: "Developers",
				},
				{
					type: "docSidebar",
					sidebarId: "resources",
					position: "left",
					label: "Resources",
				},
				{
					type: "docSidebar",
					sidebarId: "about",
					position: "left",
					label: "About",
				},
				{
					// Direct doc link rather than a sidebar: pricing lives in the `about` sidebar
					// for nav-tree membership, but a reader looking for the price wants one click.
					to: "/docs/pricing",
					label: "Pricing",
					position: "left",
				},
				{
					// The call to action, styled as a button rather than a nav label.
					href: "https://earth.mailwoman.ai/",
					label: "Try the geocoder",
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
						{ label: "Earth", href: "https://earth.mailwoman.ai/" },
						{ label: "Field notes", to: "/research" },
						// /training is a published page with no other route into it.
						{ label: "Training", to: "/training" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "Pricing", to: "/docs/pricing" },
						{ label: "License", to: "/license" },
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
				{
					title: "Legal",
					items: [
						{
							label: "Inquiries",
							href: "mailto:hello@sister.software?subject=Hello%20Sister...",
						},
						{
							label: "Privacy Policy",
							to: "/privacy",
						},
						{
							label: "Terms of Service",
							to: "/terms-of-service",
						},
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
