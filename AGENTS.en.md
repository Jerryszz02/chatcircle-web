# Agent handoff

[中文](AGENTS.md) | English

This file covers how a new agent takes over, collaboration boundaries, and delivery requirements. Refer to existing documents for the product overview, implementation details, business rules, commands, and maintenance work; do not maintain a second copy here. Continue to follow user instructions and applicable global rules.

## Establish the context for this task

1. Check the current branch, remote default branch, worktrees, uncommitted and untracked files, relevant ignored data, and running services. Do not assume a previous agent's workspace or preview is the current baseline. Verify apparent duplicate files before deleting or committing them.
2. Start with the [development and maintenance index](docs/README.md) and read the specialist documents needed for the task. Read the [developer guide](docs/developer-guide.en.md) before your first code change, and [maintenance work](docs/maintenance.md) when addressing existing gaps. Items in the index or maintenance list do not automatically expand the scope authorized for this task.
3. Before editing code, locate the actual entry point, affected callers, and existing tests. Consult [business rules](docs/business-rules.md) for business constraints and [API contracts](docs/api-contracts.md) for interfaces. Do not infer the current state from old chats, obsolete designs, or fixed file or test counts.

## Collaboration and environment boundaries

- This repository belongs to Chat Circles. The Empact website is a separate project. Sharing an ECS host and gateway does not authorize changes to the other repository or website.
- Start new tasks in an independent `agent/` worktree based on the latest remote default branch. Continue existing tasks or PR fixes on their existing branch. Commit only changes for this task; preserve other people's files, data, and services.
- When starting a preview, record its working directory, port, backend, and served version. Identify the process before resolving a port conflict; do not stop an unknown service. Before showing a preview to the user, confirm that it serves this task's workspace. Prefer Chrome for browser work.
- Use synthetic data and test configuration for local and isolated verification. Follow the relevant manual when real accounts or data are needed; do not collect credentials from browsers, logs, or other projects. In particular, do not use business data exported through MCP as test fixtures or PR attachments. See the [MCP manual](mcp/README.md) for login and permission boundaries.
- For production, the shared gateway, recovery, or alerting, check dependencies and authorization using the [deployment manual](deploy/README.md) and [backup and recovery manual](deploy/backup-recovery.md). A documentation task does not itself authorize these operations.

## Documentation and translation

- The root [README](README.en.md) introduces the project to general readers. Button-by-button procedures belong in the [organization administrator guide](docs/org-admin-guide.en.md) and [super administrator guide](docs/super-admin-guide.en.md). Do not copy those procedures into this file.
- `AGENTS.md` is the entry point for agent working rules; `AGENTS.en.md` is its English counterpart. Other English versions use the `.en.md` suffix. An English document must not add business rules or imply that the website has an English interface.
- When changing any of these five documents, update its counterpart and navigation links in the same PR. Preserve code, paths, environment variables, enums, and API identifiers. When translating button labels in administrator guides, retain the original Chinese label so readers can find it in the current interface. Link untranslated specialist documents to their existing versions.
- Do not put tokens, passwords, real personal information, recovery archives, or temporary runtime reports in handoff documents. Do not turn a successful CI run, deployment SHA, or email sending record into a permanent guarantee. Add unresolved work to the existing maintenance list rather than creating a duplicate list.

## Delivery

- Select existing tests and acceptance checks appropriate to the change. For documentation only, check translation completeness, links, paths, and command fidelity. For behavior changes, update relevant existing tests. Read the actual commands from specialist manuals and current scripts.
- Review the final diff, commit and push changes for this task, and create a PR ready for review. Address review feedback within the user's authorization; do not trigger additional review cycles on your own.
- Leave the PR open when a merge has not been authorized. Merging into `main` triggers deployment after successful CI; read the [release checklist](docs/release-checklist.md) before taking that step. After an authorized merge, follow global delivery rules to verify the remote, canonical checkout, safe cleanup, and actual release result.
- The final handoff should state the changes, checks actually run, PR and commit, retained workspaces, and outstanding items. Report committed code, successful CI, deployment, and business or email acceptance separately; one is not proof of the others.

Linked specialist documents may be in Chinese.
