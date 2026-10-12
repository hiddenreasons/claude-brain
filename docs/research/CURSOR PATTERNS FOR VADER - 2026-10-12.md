# Cursor patterns for VADER

Read 2026-10-12. Every Cursor sentence below comes from a page fetched that day. Pages are cursor.com docs, changelog, or help. Forum posts were not used.

This is a recommendation for the headless Claude harness on the Mac (`~/.vader-mac-runs`). Max 3 Claude jobs. Each job is supposed to use its own git worktree. A later step commits with hooks on. A fresh Claude Opus session reviews. Anthony approves merges.

The five problems from 2026-10-11/12:

1. Every start and resume pastes all of `STATUS.md` (~131 KB). Prompts land at 128–139 KB.
2. F1 and F1-audit shared one worktree, so one job's commit could contain the other's work.
3. Lint and test failures show up in the pre-commit hook, sometimes after a long test run.
4. No rollback point between job iterations.
5. Lessons stopped being recorded after Oct 9. A lesson-drafting script is being added.

`docs/REJECTED IDEAS.md` is not in this checkout. Nothing below is ruled out by a file I could read. If that doc already kills an idea, drop the idea.

## Top 5

Ranked by how directly they cut problems 1–5 inside the current stack (Claude Code CLI, hooks, git worktrees, bash/python), at reasonable effort and risk.

| Rank | Copy this | Problem | Effort | Risk |
|---|---|---|---|---|
| 1 | One git worktree per job. Refuse to start if that checkout is already assigned. | 2 | S | Low. A job waits or gets its own tree. |
| 2 | Stop pasting `STATUS.md`. Put a short brief in the prompt and let the job read files when it needs them. | 1 | S | A job can miss a decision that lived only in the pasted file. Keep a one-screen digest of open decisions for that job. |
| 3 | Run ruff on the files this iteration touched, and put a short failure into the next turn, before the commit hook. | 3 | M | Running the full suite on every edit makes jobs slower. Keep the full suite at commit time. |
| 4 | Record a git snapshot at the start of each iteration, and restore that snapshot when an iteration should be thrown away. | 4 | S | Extra commits or refs to prune after the job. |
| 5 | Draft a lesson at the end of the job. Keep it out of later prompts until Anthony or MAC marks it approved. Then include only the short approved lines that match. | 5 | S | An approved lesson that is wrong will ride along until someone declines it. |

## Project rules

1. What it does. Project rules are `.mdc` files in `.cursor/rules`. When a rule applies, its text is included at the start of the model context. Four attach modes come from `alwaysApply`, `description`, and `globs`: always included (globs and description ignored); auto-attached when a matching file is in context; pulled in when the agent decides the description is relevant; included only when you `@`-mention the rule. A plain `.md` file in `.cursor/rules` is ignored. `AGENTS.md` is the plain-markdown alternative, including nested files, with the nearer file winning. Cursor's guidance is to keep a rule under 500 lines, split large rules, and reference a file instead of copying it. A path mention such as `@migration-template.sql` tells the agent where to look. The file is not inlined. The agent reads it with tools when it needs it. The same behavior is documented for the editor, the CLI, and Cloud Agents. Anything that must always be in context has to be pasted into the rule body. Team Rules are a dashboard feature on Team and Enterprise plans. ([Rules](https://cursor.com/docs/rules), read 2026-10-12)

2. Problem 1. This is the direct answer to pasting 131 KB on every start and resume.

3. How to reproduce it here. Change the step that fills `iter-N.prompt` (this repo's tests call those fill-ins launch tokens). Ship a short header: job id, worktree path, the task, and the open decisions that name this job. Tell the session to read `STATUS.md`, `LESSONS.md`, and the brief with its own tools, and to read only the sections it needs. Keep always-on text under a few hundred lines. Put repo conventions in the repo (`CLAUDE.md` or a short rules file) so they are not recopied from `STATUS.md`. Match lessons the way Cursor matches globs: a Python job gets the Python lessons, not the whole file.

4. Effort S. Risk: a decision that used to ride along in the paste can be missed. Mitigation is the one-screen digest, not a return to the full file. Touches the prompt-assembly step. The scripts under `~/.vader-mac-runs` were not in this checkout.

5. `docs/REJECTED IDEAS.md` could not be read.

## One checkout per job (worktrees)

1. What it does. Worktrees give each agent task its own git checkout: its own files, dependencies, and changes, with the main checkout left alone. Cursor's docs say to use them when several agents work on the same repo and you want to avoid conflicts. In the Agents Window, starting or moving an agent into a worktree creates that checkout. In the IDE, `/worktree` runs the rest of that chat in a separate checkout. `/best-of-n` gives each model its own worktree. The CLI flag `--worktree` does the same and places checkouts under `~/.cursor/worktrees/`. Cleanup in Cursor 3.5+ keeps the newest worktrees up to a machine-wide cap (default 25) and can delete worktrees created with `git worktree add` when they sit under the worktree root Cursor manages. ([Worktrees](https://cursor.com/docs/configuration/worktrees), [Using Agent in CLI](https://cursor.com/docs/cli/using), read 2026-10-12)

2. Problem 2.

3. How to reproduce it here. The harness already stages jobs in git worktrees. Make the assignment a lock: one job id, one worktree path, recorded in the job folder before Claude starts. If F1-audit asks for F1's path, create a second worktree from the same base commit or refuse to launch. Do not put these trees under `~/.cursor/worktrees/`, so Cursor's own cleanup cannot reap them.

4. Effort S. Risk is low: a second tree costs disk, a refused launch is visible. Touches the launch step that creates the worktree. Those scripts were not in this checkout.

5. `docs/REJECTED IDEAS.md` could not be read.

## Cloud agents

1. What it does. Cloud agents run in isolated VMs with a cloned repo, dependencies, secrets, and network access. You can run many in parallel. They do not need the local machine to stay online. Each one clones the repo and works on a separate branch, then pushes for handoff. Cursor names these Cloud Agents; the docs say they were formerly called Background Agents. The 1.2 changelog, which has no calendar date on the page, lists Background Agent behavior from that release: PR templates are followed, changes on the agent branch are auto-pulled, and conflicts such as rebases show up as follow-ups. The current Cloud Agents page documents the separate branch and the separate VM. It does not restate the auto-pull or the conflict follow-up. ([Cloud Agents](https://cursor.com/docs/cloud-agent), [Changelog 1.2](https://cursor.com/changelog/1-2), read 2026-10-12)

2. Problem 2, as a paid hosted version of "one agent, one checkout, one branch." Problem 3 only in the weak sense that an agent with a real environment can run tests. The current page does not say cloud agents inject editor diagnostics.

3. How to reproduce the useful part here. Keep the Mac harness. Give each job its own worktree and its own branch. Do not add Cursor Cloud Agents. They are billed at API pricing and need a paid plan.

4. Effort L if anyone were to adopt the product. Not recommended. Nothing in the harness needs to change for this section.

5. `docs/REJECTED IDEAS.md` could not be read.

## Lint and diagnostic feedback

1. What it does. Agent can run shell commands and sees their output. Hooks can also add text after a tool. `postToolUse` runs after a successful tool call and may return `additional_context`, which the docs describe as extra context injected into the conversation after the tool result. `afterFileEdit` runs after an agent edit and is documented as a place for formatters. The `afterFileEdit` section shows an input (path and edits) and does not document an output field that sends formatter or linter text back to the model. `afterTabFileEdit` explicitly says no output fields are supported. Agent Review can run after every commit, or from `/agent-review`, or from the Source Control tab. That is a review of a commit or of local changes, not a diagnostic on each edit. ([Hooks](https://cursor.com/docs/hooks), [Agent overview](https://cursor.com/docs/agent/overview), [Agent Review](https://cursor.com/docs/agent/agent-review), read 2026-10-12)

2. Problem 3.

3. How to reproduce it here. In the brief, require the session to run `ruff check` on the files it just edited and to fix what ruff prints before it moves on. The shell output is the feedback. Between iterations, have bash do the same check and, on failure, put the short ruff output at the top of the next `iter-N.prompt`. Leave the full pytest run on the pre-commit hook. Optionally run the tests that import the touched modules at the iteration boundary, and cap the log that goes back into the prompt (a few dozen lines, not the whole run).

4. Effort M. Risk: a full pytest on every edit burns the job. Scope the in-loop check to ruff plus the tests that match the diff. Touches the brief text and the iteration boundary in the harness. Hook config in this repo stays as it is.

5. `docs/REJECTED IDEAS.md` could not be read.

## Checkpoints and restore

1. What it does. During an Agent session, Cursor saves snapshots of the codebase before significant changes, capturing the state of all modified files. You can preview a checkpoint and restore. Restore reverts files only. It does not remove messages from the conversation. Checkpoints are stored locally and are separate from Git. The docs say to use them for undoing agent changes, and to use Git for permanent version control. ([Agent overview](https://cursor.com/docs/agent/overview), read 2026-10-12)

2. Problem 4.

3. How to reproduce it here. At the start of each iteration, create a git ref the job can name, for example `refs/jobs/<job>/iter-<N>`, pointing at the worktree HEAD before Claude runs. To drop a bad iteration, `git reset --hard` that ref in that worktree only, then start the next iteration. Keep the ref until Anthony merges or kills the job. Do not try to copy Cursor's local checkpoint store. The docs already say Git is the permanent record, and a headless session has no checkpoint button.

4. Effort S. Risk: a reset throws away uncommitted work in that worktree, which is the point, so the ref has to be taken before the iteration writes files. Touches the iteration loop. One ref per iteration, job-scoped, so F1 cannot reset F1-audit.

5. `docs/REJECTED IDEAS.md` could not be read.

## Memories

1. What it does. Two different features use the name.

Cursor 1.0 (changelog dated Jun 4, 2025) shipped Memories as a beta: Cursor remembers facts from conversations and can reference them later. They are stored per project, per individual, and managed from Settings. You enable them from Settings → Rules. Changelog 1.2 says Memories is GA, and that user approvals for background-generated memories were added. That page does not show a calendar date, and it does not describe the approval screen. No current docs page in the index I read (`https://cursor.com/llms.txt`, read 2026-10-12) documents an IDE Memories setting.

Automations, documented on the current Cloud Agents automations page, have a different memory. The agent reads and writes named notes across runs of the same automation. The default name is `MEMORIES.md`. The file lives outside the agent's working filesystem. Memories are on by default, can be turned off, and can be edited in the tool configuration UI. The agent can delete outdated memory files during a run. The docs say to be careful when the automation handles untrusted input, because a bad memory can affect later runs. There is no approval step before a write lands. ([Changelog 1.0](https://cursor.com/changelog/1-0), [Changelog 1.2](https://cursor.com/changelog/1-2), [Automations](https://cursor.com/docs/cloud-agent/automations), read 2026-10-12)

2. Problem 5. The useful part is "draft, then a person accepts, then later runs see only the accepted text." That matches the 1.2 line about user approvals. The automations version writes first and lets a person delete later. That is the wrong order for VADER lessons.

3. How to reproduce it here. This repo already drafts lessons into `PROPOSED-LESSONS.md` and waits until Anthony or MAC sets `Status:` to `approved` or `declined`. An approved lesson is data. MAC is supposed to copy approved lessons into `~/.vader-mac-runs/LESSONS.md`. The Brain never writes that file (`brain/learning.py`). Wire the new lesson-drafting script to that gate. At the end of a job, append a draft. Do not put the draft in the next prompt. When a later job's prompt is built, include only approved lessons whose text matches the job (same area, same failure), and keep each one short. Cap the block. Bugbot's rule cap is a useful size check: 30,000 characters per rule and 100,000 combined, with a verbose mode that shows what was truncated. VADER's cap should be much smaller. A few hundred lines of approved lessons is enough.

4. Effort S, because the approval page already exists. Risk: a wrong approval sticks until someone declines it. Touches the lesson-drafting script that is being added, and the same prompt-assembly step as rank 2. I did not read `LESSONS.md`.

5. `docs/REJECTED IDEAS.md` could not be read.

## Agent hooks

1. What it does. Hooks are commands in `.cursor/hooks.json`. They fire around tool use, file edits, and session lifecycle. Output the model can see includes `agent_message` when a `preToolUse` call is denied, `additional_context` on `postToolUse` and `postToolUseFailure`, and `additional_context` on `sessionStart` (that hook is fire-and-forget; the loop does not wait on it). The `stop` hook can submit a `followup_message` to keep the loop going. The default cap is 5 auto follow-ups per script, and `loop_limit` can raise, lower, or remove it. Cloud agents run the repo's command hooks once the environment is writable. They do not load `~/.cursor/hooks.json`. ([Hooks](https://cursor.com/docs/hooks), [Cloud Agents](https://cursor.com/docs/cloud-agent), read 2026-10-12)

2. Problems 1 and 3. `sessionStart`'s `additional_context` is the same idea as a short injected digest. `postToolUse`'s `additional_context` is the lint-feedback path. The `stop` follow-up is a way to iterate, which VADER already does with `iter-N`.

3. How to reproduce it here. Prefer a bash step the harness owns over a model-driven loop. The harness already starts and stops iterations. Use that boundary to inject the short status digest and the ruff output. A `stop`-style auto follow-up inside the model session can run past the point where a person would have looked. Leave the iteration count in the harness.

4. Effort M if the checks are added at the iteration boundary (see rank 3). Effort L if a new in-process hook system is built. Do the boundary script. Touches the harness iteration loop, not Cursor's `hooks.json`.

5. `docs/REJECTED IDEAS.md` could not be read.

## Bugbot

1. What it does. Bugbot reviews pull requests and comments on findings. It also reads `.cursor/BUGBOT.md` and nested copies, plus team rules, learned rules, and manual rules. Each rule is truncated at 30,000 characters. The combined block is capped at 100,000 characters, and some rules are dropped past that cap. `bugbot run verbose=true` posts a table of what was included, truncated, or omitted. Commenting `@cursor remember [fact]` on a PR saves a learned rule for later reviews. Autofix spawns a Cloud Agent to patch findings, on a new branch or the existing one, with a max of 3 attempts per PR when it commits to the existing branch. Autofix uses Cloud Agent credits. Settings in `.cursor/config/bugbot.yaml` are read from the PR's base branch, so the PR cannot change how it is reviewed. ([Bugbot](https://cursor.com/docs/bugbot), read 2026-10-12)

2. Problem 5, only as a size-and-approval lesson: learned rules are explicit (`@cursor remember`), and oversized rules are truncated on purpose. The review itself overlaps the fresh Opus review VADER already runs. It does not fix problems 1–4 inside a job.

3. How to reproduce the useful part here. Keep the fresh Opus review and Anthony's merge. When a review finds a repeatable mistake, draft a lesson (rank 5) instead of teaching a hosted reviewer. Log the character count of every prompt. If the lessons block or the digest exceeds the cap you set, truncate and write the count into `runs.log` the way Bugbot's verbose mode shows omitted rules.

4. Effort S for the cap and the log line. Adopting Bugbot is a paid GitHub app and is not part of this recommendation. Touches prompt assembly and `runs.log`.

5. `docs/REJECTED IDEAS.md` could not be read.

## cursor-agent CLI

1. What it does. The Cursor CLI (`agent`) runs the same rules system as the editor, and it also applies root `AGENTS.md` and `CLAUDE.md`. `--worktree` runs the agent in a new git worktree. `--resume` continues a thread. `-p` / `--print` is the non-interactive mode for scripts. The headless page says file changes in print mode require `--force` (or `--yolo`); without `--force`, changes are only proposed. The using page says Cursor has full write access in non-interactive mode. Those two pages do not use the same words. `/summarize` (alias `/compress`) frees context. Plan mode is `--mode=plan`. ([Using Agent in CLI](https://cursor.com/docs/cli/using), [Using Headless CLI](https://cursor.com/docs/cli/headless), read 2026-10-12)

2. Problems 1 and 2, as patterns: resume a thread instead of repasting the world, and use a worktree flag so the checkout is not the one you are sitting in. The product is a second agent runtime.

3. How to reproduce it here. Stay on `claude -p`. On resume, pass the previous session id and the short digest, not a fresh paste of `STATUS.md`. The worktree lock is rank 1.

4. Effort L to switch runtimes, and it adds a paid CLI (`CURSOR_API_KEY` in the headless install docs). Not recommended. No harness change for the CLI itself.

5. `docs/REJECTED IDEAS.md` could not be read.

## Codebase search

1. What it does. The current search doc (also served at the old codebase-indexing URL) describes Instant Grep: a local index for exact, regex, and word-boundary search. It runs on the machine. The page says Cursor does not upload file paths or code to build that index, and does not store embeddings of the codebase for search. Opening a match can still send file content to the model. The Explore subagent does broad search in its own context and returns findings, so the parent conversation does not fill up with raw files. Changelog 1.2 says embeddings for semantic search were improved and that PRs are indexed. That is a changelog entry, not the current search page. The TypeScript SDK lists a built-in tool named `semSearch` and says the tool-call shape is internal-facing. It does not say what `semSearch` returns or whether it uses embeddings. ([Search](https://cursor.com/docs/agent/tools/search), [codebase-indexing URL](https://cursor.com/docs/context/codebase-indexing), [Changelog 1.2](https://cursor.com/changelog/1-2), [TypeScript SDK](https://cursor.com/docs/sdk/typescript), read 2026-10-12)

2. Problem 1, indirectly. The part worth copying is "search, then return a short finding." An embedding index does not shrink `STATUS.md`.

3. How to reproduce it here. Tell the job to search with `rg` and to quote the matching lines in its notes, and to leave the rest of the file unread. The Brain and the harness already live on a single Mac. A local `rg` is enough. Do not build a vector index.

4. Effort S as a line in the brief. Building an index is L and does not pay for problems 1–5. Touches the brief only.

5. `docs/REJECTED IDEAS.md` could not be read.

## Plan mode and to-dos

1. What it does. Plan Mode has the agent research, ask questions, and write a plan you can edit before it builds. Plans save to the home directory by default, or into the workspace if you choose. When a build goes wrong, the docs say to revert, tighten the plan, and run it again. Changelog 1.2 says agents keep a structured to-do list, update it as they go, and can show it in Slack. The current agent overview documents `/goal` for a long-lived objective and says it is still rolling out. It does not mention to-dos. ([Plan Mode](https://cursor.com/docs/agent/plan-mode), [Changelog 1.2](https://cursor.com/changelog/1-2), [Agent overview](https://cursor.com/docs/agent/overview), read 2026-10-12)

2. None of 1–5 on their own. "Revert and run the plan again" is the same move as rank 4, with the brief as the plan. VADER jobs already start from a written brief.

3. How to reproduce the useful part here. The brief is the plan. Rank 4 is the revert. A to-do list inside the model does not need a new harness feature. The iteration log already shows where the job is.

4. Effort S to add a sentence to the brief ("if this iteration is wrong, stop; the harness will reset to the iteration ref"). A Plan Mode port is L and needs a person in the loop, which these jobs do not have.

5. `docs/REJECTED IDEAS.md` could not be read.

## Subagents and skills

1. What it does. A subagent has its own context window, starts clean, and returns a final message. The parent does not see the intermediate tool output. Built-in ones include Explore (search; a faster model; parallel searches) and Bash (shell series, so the parent is not filled with logs). Skills are `SKILL.md` packages. At start, the agent sees the skill list and loads a skill when the description matches, or when you invoke it with `/`. `paths` limits a skill to matching files. The body can point at `references/` and `scripts/` that load only when needed. The docs call this progressive loading. Cursor also loads skills from `.claude/skills/` and `~/.claude/skills/`. ([Subagents](https://cursor.com/docs/subagents), [Agent Skills](https://cursor.com/docs/skills), read 2026-10-12)

2. Problem 1. Explore and Bash are the pattern for "do not paste the haystack." Skills are the pattern for "do not paste every playbook into every job."

3. How to reproduce it here. For a wide search or a noisy command, the brief can tell the job to write the raw output under the job folder and put five lines of findings in the reply. The harness then keeps that raw file out of the next prompt. Split standing instructions the same way: a short always-on header, and longer notes the job reads by path when the task matches. Claude Code can already read those files. No new skill runner is required.

4. Effort S for the brief and the prompt filter. Risk: a summary can drop a line you needed. Keep the raw file on disk. Touches the brief and prompt assembly.

5. `docs/REJECTED IDEAS.md` could not be read.

## Agent Review

1. What it does. Agent Review is a local review of your changes. It can run after every commit, from `/agent-review`, or from Source Control against the main branch. Depth is Quick or Deep. It reads `BUGBOT.md`. ([Agent Review](https://cursor.com/docs/agent/agent-review), read 2026-10-12)

2. None. VADER already runs a fresh Opus review before Anthony merges. A review after the commit does not move lint earlier (problem 3) and does not snapshot an iteration (problem 4).

3. How to reproduce it here. Leave the existing review step. Do not add a second reviewer.

4. Effort L to add another review pass, and it spends another Opus session. Not recommended.

5. `docs/REJECTED IDEAS.md` could not be read.

## Projects

1. What it does. A Project is a coordinator that plans and delegates to other agents. The coordinator does not write code. Projects run on Cloud Agents, on paid plans, and keep a shared context that grows as agents add research and preferences. They are not available on the free Hobby plan or with Privacy Mode (Legacy). ([Projects](https://cursor.com/docs/agent/projects), read 2026-10-12)

2. None of 1–5. A growing shared context is how problem 1 comes back.

3. How to reproduce it here. Do not. The harness is already the coordinator: it launches jobs, caps them at 3, and asks Anthony before merge.

4. Effort L. Paid cloud product. No harness change.

5. `docs/REJECTED IDEAS.md` could not be read.

## Not worth copying

- Cloud Agent VMs, Projects, and Automations. Paid, and a growing shared memory is the `STATUS.md` problem again.
- Bugbot and Autofix as products. Paid review-and-patch on GitHub. The Opus review plus Anthony's merge already covers that step.
- The Cursor CLI as a second runtime. Another agent, another API key. Copy the worktree and the short resume, and keep `claude -p`.
- Automations memories that save on write, with deletion afterward. Lessons stay drafts until Anthony or MAC sets `Status: approved`.
- `/best-of-n`. One task becomes several models and several trees. The cap is 3 jobs.
- Instant Grep's custom index, and any embedding index. `rg` on the Mac is enough. The current search page says embeddings are not stored for search.
- `/goal` and `stop`-hook follow-ups that let the model schedule its own next turn. The harness already decides when the next iteration starts.
- Agent Review as an extra pass. It runs at commit time, which is the moment problem 3 is already late.
- Team Rules and skill sync from the Cursor dashboard. One owner, files on the Mac, no team plan required.
- IDE checkpoint UI. Headless jobs have no button. Use a git ref.

## Could not verify

Local files that are not on this machine and have no copy in the repo (`hiddenreasons/claude-brain` at `9a6911d`):

- `~/.vader-mac-runs/_shared/brief-header.md`
- `~/.vader-mac-runs/_shared/run-template.sh`
- `~/.vader-mac-runs/harness/after-job.sh`
- `~/.vader-mac-runs/LESSONS.md`
- `docs/AGENT WORKFLOW.md`
- `docs/REJECTED IDEAS.md`
- `CLAUDE.md`
- `.pre-commit-config.yaml`

Repo files that were read and that describe the harness from the outside: `README.md`, `docs/GROKBOT-COMMS-LOG.md`, `brain/mac_runs.py`, `brain/learning.py`, `tests/conftest.py`, `tests/test_guardrails.py` (the comment that `iter-N.prompt` is filled with launch tokens).

Cursor claims I will not state as fact:

- Whether the IDE Memories setting from changelogs 1.0 and 1.2 still exists, and what the approval screen looks like. No current docs page describes it. Forum threads were not used.
- Whether the editor silently pushes language-server diagnostics into the agent after each edit. The pages above document shell output, `postToolUse` `additional_context`, and `afterFileEdit` as a formatter hook. They do not document an LSP diagnostic channel.
- What the SDK tool `semSearch` does, and whether changelog 1.2's embedding index is still in the product. The current search page says embeddings are not stored for search.
- Whether two Cloud Agents are blocked from pushing the same branch. The current page says each works on a separate branch. The 1.2 changelog says conflicts are surfaced as follow-ups. Neither page describes a lock.
- Which non-interactive CLI sentence is the contract for unattended writes. The headless page requires `--force` to apply edits. The using page says non-interactive mode has full write access.
- Whether a checkpoint restore includes files written by shell commands or by subagents. The overview says "all modified files" and does not define that phrase.
- A calendar date for changelog 1.2. The fetched page does not show one. Changelog 1.0 is dated Jun 4, 2025.
