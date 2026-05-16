# Mailwoman Neural — work log

Append-only. One line per meaningful event. Format:
`YYYY-MM-DD HH:MM | phase-N | <what was done> | <next>`

2026-05-16 18:20 | phase-0 | session start, read epic #15 + sub-issues #3–#8 via unauthed GitHub API | bootstrap meta-files, begin yarn workspaces restructure
2026-05-16 18:24 | phase-0 | verified `yarn compile && yarn test` green (771/771); clean-clone preflight needs the explicit compile step (noted in DECISIONS.md) | task 1: workspaces
2026-05-16 18:46 | phase-0 | yarn workspaces: moved core/utils/solvers/filters into @mailwoman/core, classifiers into @mailwoman/classifiers; hoisted utils/parser.ts + DebugOutputBuilder.ts + commands/ back to root to break circular dep; sdk/repo.ts moved into @mailwoman/core/utils; node_modules/mailwoman self-symlink added for residual root-only paths; 109 import sites rewritten to @mailwoman/\* via scripts/rewrite-workspace-imports.mjs; project references in tsconfig wire build order; full suite green (771/771) | task 2: ComponentTag schema
2026-05-16 18:50 | phase-0 | added COMPONENT_TAGS + ComponentTag + BIO_LABELS + BioLabel in @mailwoman/core/types (packages/core/core/types/component.ts), 9 schema tests pass, total 780/780 | task 3: ClassificationProposal + Classifier interface + legacy adapter
2026-05-16 18:55 | phase-0 | core types: ClassificationProposal, ProposalClassifier, ClassifierContext, Section alias; mapping.ts (legacy Classification → ComponentTag); wrapLegacyClassifier in @mailwoman/classifiers; equivalence test on HouseNumberClassifier passes; total 784/784. DEFERRED in this commit: building the registry that wraps every rule classifier, plumbing proposals into the solver path (logged in DECISIONS as task-3 follow-up). | task 4: PolicyRegistry
2026-05-16 18:59 | phase-0 | @mailwoman/core/policy: PolicyMode union, ClassifierPolicy / PolicyRegistry interfaces, defaults (rule_only for every COMPONENT_TAG), InMemoryPolicyRegistry with .set/.remove/.lookup/.apply; 14 mode + threshold + locale-specificity tests pass; total 798/798. Solver wiring still on the legacy mutation path (same task-3 follow-up deferral). | task 5: LocaleProfile + en-US/fr-FR
