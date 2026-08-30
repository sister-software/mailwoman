@AGENTS.md

<!-- codemod-skill-discovery:begin -->

## Codemod Skill Discovery

This section is managed by `codemod` CLI.

- Core skill: `.claude/skills/codemod/SKILL.md`
- Package skills: `.claude/skills/<package-skill>/SKILL.md`
- Marker note: the core Codemod skill uses `codemod-compatibility: mcs-v1`; authored package skills for workflow `install-skill` use `codemod-compatibility: skill-package-v1`.
- Codemod AI CLI tools: `npx codemod ai docs`, `npx codemod ai dump-ast`, `npx codemod ai node-types`, `npx codemod ai tools`, `npx codemod ai resources`
- Codemod MCP: optional direct tool/resource integration for the same Codemod AI capabilities exposed by `npx codemod ai ...`.
- Codemod creation command: `/codemod`
- List installed Codemod skills: `npx codemod ai list --harness claude --format json`

<!-- codemod-skill-discovery:end -->
