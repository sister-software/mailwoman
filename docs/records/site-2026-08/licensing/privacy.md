---
sidebar_title: Privacy & legal
title: Privacy policy & legal posture
sidebar_position: 4
hide_footer: true
---

# Privacy policy & legal posture

Last updated: 2026-07-11. Contact for anything on this page: teffen@sister.software.

Mailwoman keeps personal data private through its architecture rather than through procedures. The software is designed so that personal data never reaches us. This page states that design, describes the few services we operate, and lists the legal frameworks the design addresses.

## The software collects no personal data

The Mailwoman libraries, CLI, and self-hosted API servers contain **no telemetry, analytics, or phone-home behavior, and they do not log queries by default**. Addresses you geocode are processed on your own machine or server. When you run the in-browser engine, the model and data files are downloaded once, and every query is processed inside your browser. The text you type is never transmitted.

Addresses can be personal data when they are linked to a person. Mailwoman's deployment model keeps that data where it already lives: on the deployer's infrastructure, under the deployer's existing legal basis. We never become a processor of it.

## The surfaces we operate

- **This website** (mailwoman.ai) is a static site. It sets no tracking cookies and runs no analytics.
- **The browser demo** downloads model and data artifacts from our content delivery infrastructure and then runs locally. Demo queries are processed in your browser and are not sent to us.
- **The public trial endpoint** (photon.mailwoman.ai) is provided for evaluation. Like any web server, it keeps short-lived operational access logs (IP address, request path, timestamp) for rate limiting and abuse prevention. These logs are not used for analytics, profiling, or any other purpose. They are not shared, and they are routinely discarded. The endpoint has no accounts and sets no cookies.

We hold no user accounts or query history. For a data-subject request (access, deletion, portability), we have no record on file to return or delete beyond the short-lived operational logs described above. Send requests and questions to the contact address.

## Legal frameworks

- **GDPR (EU) / UK GDPR:** the software supports compliance through data minimization. Personal data stays on the deployer's infrastructure and none of it reaches us. On the services we operate, the only processing is the operational logging described above (legitimate interest, short retention). We are not a processor of any deployer's data.
- **CCPA/CPRA (California) and similar regimes:** we collect no personal information and sell none, so there is no opt-out to exercise.
- **ePrivacy (cookies):** no service we operate sets tracking cookies.
- **EU AI Act:** Mailwoman's model is a small, non-generative token classifier used for address parsing, which makes it a limited-scope, transparent system. We publish model cards, training-data lineage, and evaluation methodology for every released model ([methodology](../concepts/methodology.mdx), [data provenance](./data-provenance.md)). This is consistent with the Act's transparency expectations for AI systems.
- **Data-source licensing:** every dataset we redistribute is used within its license. The [data licensing & provenance](./data-provenance.md) page documents the per-source terms, including the deliberate exclusion of share-alike sources from published artifacts until legal review is complete.
- **Accessibility:** the documentation site and demo aim for WCAG 2.1 AA. No formal certification has been performed yet, and an independent accessibility review is on our roadmap. WCAG 2.1 AA is a goal. This page makes no claim of compliance.

## What we will never add

We will never add advertising, sell data, or collect queries for model training. If any service we operate changes what it collects, we will update this page first, with a dated note.
