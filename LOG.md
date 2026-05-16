# Mailwoman Neural — work log

Append-only. One line per meaningful event. Format:
`YYYY-MM-DD HH:MM | phase-N | <what was done> | <next>`

2026-05-16 18:20 | phase-0 | session start, read epic #15 + sub-issues #3–#8 via unauthed GitHub API | bootstrap meta-files, begin yarn workspaces restructure
2026-05-16 18:24 | phase-0 | verified `yarn compile && yarn test` green (771/771); clean-clone preflight needs the explicit compile step (noted in DECISIONS.md) | task 1: workspaces
2026-05-16 18:46 | phase-0 | yarn workspaces: moved core/utils/solvers/filters into @mailwoman/core, classifiers into @mailwoman/classifiers; hoisted utils/parser.ts + DebugOutputBuilder.ts + commands/ back to root to break circular dep; sdk/repo.ts moved into @mailwoman/core/utils; node_modules/mailwoman self-symlink added for residual root-only paths; 109 import sites rewritten to @mailwoman/\* via scripts/rewrite-workspace-imports.mjs; project references in tsconfig wire build order; full suite green (771/771) | task 2: ComponentTag schema
