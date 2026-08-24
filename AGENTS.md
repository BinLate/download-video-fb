<!-- gemini-and-chatgpt:begin -->
# Automatic Gemini + ChatGPT PR Review Gate
For every implementation, bug fix, refactor, or feature coding task, automatically apply `.agents/skills/gemini-and-chatgpt/SKILL.md`. Do not wait for the user to mention the skill.

For STANDARD/COMPLEX tasks, ensure project context is fresh using `scripts/project_context_scan.py`.

Mandatory order after implementation: verify locally -> ensure GitHub authentication and `origin` remote -> commit/push a dedicated branch -> create or update a GitHub Pull Request -> obtain the exact full 40-character PR HEAD SHA -> only then run `scripts/review_round.py` for independent review. Never open ChatGPT for the code-review phase before a GitHub PR exists. If GitHub authentication or the remote is missing, stop and tell the user to rerun `gemini-and-chatgpt\INSTALL-ANTIGRAVITY.bat`.

Review submissions use CDP direct-fill or deterministic clipboard paste. Review begins with a fresh ChatGPT conversation on round 1 and reuses the same conversation across rounds.

Strict Local-Worktree Rule: When ChatGPT returns findings, evaluate and fix them locally in the working repository. Never open browser tabs to GitHub Web pages to read source files that exist locally. Resolve all same-repository GitHub URLs to local workspace paths.

After fixing findings locally, verify again, push the new HEAD, and run `scripts/review_round.py` in the same conversation. Automatic merge remains OFF unless the user explicitly enables it.
<!-- gemini-and-chatgpt:end -->

