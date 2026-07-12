---
sidebar_title: Privacy & legal
title: Privacy policy & legal posture
sidebar_position: 4
hide_footer: true
---

# Privacy policy & legal posture

Last updated: 2026-07-11. Contact for anything on this page: teffen@sister.software.

Mailwoman's privacy story is architectural rather than procedural: the software is designed so
that personal data never reaches us in the first place. This page states that plainly, covers
the few surfaces we do operate, and lists the legal frameworks the design addresses.

## The software collects nothing

The Mailwoman libraries, CLI, and self-hosted API servers contain **no telemetry, no analytics,
no phone-home behavior, and no query logging by default**. Addresses you geocode are processed
on your own machine or your own server. When you run the in-browser engine, the model and data
files are downloaded once and every query is processed inside your browser — the text you type
is never transmitted anywhere.

Addresses can constitute personal data when they are linked to a person. Mailwoman's deployment
model keeps that data wherever it already lives: on the deployer's infrastructure, under the
deployer's existing legal basis. We never become a processor of it.

## The surfaces we operate

- **This website** (mailwoman.sister.software) is a static site. It sets no tracking cookies
  and runs no analytics.
- **The browser demo** downloads model and data artifacts from our content delivery
  infrastructure, then runs locally. Demo queries are processed in your browser and are not
  sent to us.
- **The public trial endpoint** (photon.sister.software) is provided for evaluation. Like any
  web server, it keeps short-lived operational access logs (IP address, request path,
  timestamp) for rate limiting and abuse prevention. These logs are not used for analytics,
  profiling, or any other purpose, are not shared, and are routinely discarded. No accounts
  exist; no cookies are set.

Because we hold no user accounts and no query history, data-subject requests (access,
deletion, portability) have a short honest answer: there is nothing on file to return or
delete beyond the transient operational logs described above. Requests and questions are
welcome at the contact address.

## Legal frameworks

- **GDPR (EU) / UK GDPR:** the software enables compliance by data minimization — personal
  data stays on the deployer's infrastructure and none reaches us. For the surfaces we
  operate, the only processing is the operational logging described above (legitimate
  interest, short retention). We are not a processor of any deployer's data.
- **CCPA/CPRA (California) and similar regimes:** we collect no personal information and sell
  none; there is nothing to opt out of.
- **ePrivacy (cookies):** no tracking cookies on any surface we operate.
- **EU AI Act:** Mailwoman's model is a small, non-generative token classifier used for
  address parsing — a limited-scope, transparent system. We publish model cards, training-data
  lineage, and evaluation methodology for every released model
  ([methodology](../concepts/methodology.mdx), [data provenance](./data-provenance.md)),
  which aligns with the Act's transparency expectations for AI systems.
- **Data-source licensing:** every dataset we redistribute is used within its license, with
  per-source terms documented on the [data licensing & provenance](./data-provenance.md)
  page — including the deliberate exclusion of share-alike sources from published artifacts
  pending legal review.
- **Accessibility:** the documentation site and demo aim for WCAG 2.1 AA; no formal
  certification has been performed yet, and an independent accessibility review is part of
  our roadmap. We state this as an aspiration rather than a claimed compliance.

## What we will never add

No advertising, no sale of data, no query harvesting for model training. If any surface we
operate ever changes what it collects, this page changes first, with a dated note.
