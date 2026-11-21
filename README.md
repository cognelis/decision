# Paraself

English | [简体中文](README.zh-CN.md)

Paraself is a local-first desktop app for macOS (Apple Silicon) and Windows x64. It keeps a record of the decisions you make and gives that record back to you and to your AI agents.

When Claude Code, Codex or another coding agent asks you to choose and you answer, Paraself notices, asks you why, and saves the decision as Markdown in your Obsidian vault. You can also write down decisions, preferences and ideas yourself. Over time the record becomes something you can search, ask questions of, check against what actually happened, and turn into principles. Your agents can consult it before they suggest something.

The name comes from Ted Chiang's *paraself*, the version of you on another branch of time. Paraself began as a decision journal for working with coding agents; the aim is a fuller personal counterpart across work, study and everyday life.

The interface is in Chinese. Paraself was called Decision up to v1.2.0.

## Features

- **Capture.** Passive hooks in your coding agents pick up the questions an agent puts to you and your answers, whether it used a question tool (`AskUserQuestion`, `request_user_input`) or plain text. A clear decision opens a short "why" panel, an uncertain one waits in a queue, and the rest are dropped. The hooks never block the agent or change what it does.
- **Record.** Write down a decision, preference or idea at any time (⌘/Ctrl+N), including ones made away from the computer, such as in a meeting.
- **Review.** Note the outcome you expect when you decide, then record what happened and review it. Decisions worth reviewing are scheduled 14 days out and appear in the review inbox on the home page.
- **Knowledge.** Search your decisions, preferences, ideas and Obsidian notes; decisions and notes are also matched by meaning, using on-device embeddings. The Q&A assistant answers from these alone and cites its sources.
- **Principles.** Distill principles from reviewed decisions, by hand or with a model, follow how they work out once adopted, and turn them into skills and workflows you can publish to Codex or Claude Code.
- **For your agents.** An MCP server lets agents check your adopted principles before offering options, look up past decisions while they code or review, and record what you explicitly ask them to.
- **PR review.** Browse pull requests on GitHub, GitLab and Bitbucket Server/Data Center, run a read-only AI review that also checks your past decisions and review rules, and comment, approve or merge after you confirm. Decisions made in PR comments can be recorded too.
- **Todos.** Ask an agent to save what its investigation found as a todo list, one checkbox per finding, or keep empty lists such as 日常 (daily) or 学习 (learning) to add todos to as they come. Work through the items on the 待办 (Todos) page, in Obsidian, or by handing them back to an agent. An agent that finishes or drops an item has to say what it did and how it checked it, and every change is kept.
- **Historical decisions.** Keep a ledger of choices already made, on the 历史决定 (Historical decisions) tab of 知识: what was decided and when, with whatever else you care to add (alternatives, context, links, what it replaced). No rationale is asked for and nothing is scheduled; these records stay out of decision search and reviews unless you turn one into a decision.
- **Prompts.** Keep the prompts you use often, such as asking `paraself-review` to check a branch, on the 提示词 (Prompts) page, and copy one into Codex or Claude Code. Three examples are added the first time; edit or delete them freely.

## How capture works

1. The agent asks and you answer in its own interface, as usual.
2. A hook copies the question and answer into a private local queue and exits successfully right away, so the agent never waits on Paraself.
3. Paraself scores the exchange with local rules and, if enabled, a local model. A model alone never opens the panel: when rules and model disagree, the exchange goes to the pending queue.
4. Nothing reaches your vault until you handle it in the panel. Completed entries are written as Markdown, and the search index is updated from it.

## Install

Download the latest release from [GitHub Releases](https://github.com/cognelis/decision/releases):

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `Paraself-darwin-arm64-<version>.zip`: unzip and move `Paraself.app` to `/Applications` |
| Windows x64 | `Paraself-<version>-win-x64-Setup.exe` |

The builds carry no commercial signature: the Windows installer is unsigned, and the macOS app is ad-hoc signed and not notarized, so SmartScreen or Gatekeeper warns on first launch. Check the SHA-256 published with the release, then follow the [release notes](docs/release-notes.md) to open it. There are no automatic updates.

## Getting started

1. Launch Paraself. It uses the Obsidian vault you opened most recently, or creates `~/Documents/Paraself Vault`. You can change the vault on the 通用 (General) page.
2. On the 接入 (Connect) page, connect the agents you use. 全部修复 (Fix all) sets up every agent found on this machine. Restart those agents afterwards.
3. On the 模型 (Models) page, check which models do the recognizing, and install a local Qwen model if you want one.
4. To review pull requests, add your code platform on the 链接 (Links) page.

Until you record your first decision, the home page shows a setup checklist.

## Supported agents

| Agent | Status |
| --- | --- |
| Claude Code, Codex, Grok | Tested end to end |
| Antigravity, Qwen Code, Qoder CLI, Augment Auggie, Gemini CLI, Cursor CLI, GitHub Copilot CLI, CodeBuddy Code, Factory Droid | Built from their documentation and source, not yet tested end to end (marked 未实测 in the app) |

For each agent, Paraself installs passive hooks and registers the `paraself` MCP server. Everything else in the agent's config files is left as it was. A tool that is not on the list can be added with 接入其他工具 (Connect another tool) at the bottom of the Connect page: the assistant proposes how to hook into it, Paraself installs a temporary probe once you confirm, and the event fields are worked out from one real exchange.

If something looks wrong, the bridge can check and repair the setup from a terminal. On Windows, use `%LOCALAPPDATA%\Paraself\paraself-bridge.cmd` instead.

```bash
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" doctor
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" install --dry-run
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" install --apply
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `consult_decision_principles` | Before offering options: up to three adopted principles that bear on the question, with your related preferences and ideas listed separately. Read-only. |
| `search_decision_context` | While coding or reviewing: past decisions, adopted principles and summaries, filtered by project, repository, module and files, with superseded records marked. Read-only. |
| `record_decision_journal_entry` | Record a decision, preference or idea the user stated explicitly. |
| `record_decision_outcome` | Fill in what happened and the review for a recorded decision. |
| `record_decision_scope`, `record_decision_relation` | Record where a decision applies, and conflicts or supersession between decisions. |
| `record_decision_context_feedback`, `list_decision_context_feedback`, `record_decision_consultation_feedback` | Record and read whether retrieved context or a principle check helped. |
| `open_decision_source` | Open the source note in Obsidian. |
| `prepare_decision_handoff` | Build a read-only handoff from selected decisions. |
| `record_todo_list` | When the user asks: save research findings as a todo list, make an empty list (such as 日常 or 学习), or add items to an existing list. |
| `list_todo_lists` | Todo lists with items still open, with each item's status, details and latest note. Read-only. |
| `update_todo_item` | Mark an item in progress, done or dropped, or add a note. Done and dropped need a note: what was done and how it was checked, or why not. |
| `record_historical_decision` | When the user asks: keep a choice already made on the ledger of historical decisions. Only the matter and the decision are required; the same one again returns the record already kept. |
| `list_historical_decisions`, `get_historical_decision` | List historical decisions by words, project, status, tag, reversibility or date, and read one whole with the record it replaced, the ones that replaced it and its change history. Read-only, and apart from `search_decision_context`, which never returns them. |
| `update_historical_decision` | When the user asks: change a historical decision's fields or status, on the revision just read. Withdrawing replaces deleting; `promote` makes a formal decision from it, once. |
| `open_historical_decision` | When the user asks: open a historical decision's note in Obsidian, or one of the links or related notes it lists. |
| `search_obsidian_notes`, `get_obsidian_note` | Search your ordinary Obsidian notes (those the app indexes) and read one, a page at a time, with paths and line numbers. Read-only; notes carry no project scope. |
| `record_review_benchmark_cases` | When the user asks to curate a review benchmark: record historical PRs as candidate cases, either a defect (a problem a review should find, with its lines and fix commits) or clean (none). The app checks every commit and line in the local repository. |
| `list_review_benchmark_cases`, `get_review_benchmark_case` | List one repository's cases with counts, and read one with its labels and history. A case held out for evaluation comes without its labels. Read-only. |
| `update_review_benchmark_case` | Change a case's labels or references, add a note, withdraw it, or confirm it once the user says they checked it. |
| `run_review_benchmark` | When you ask, review a repository's confirmed cases again in the app, as it reviews now, and score them by set: run it before and after a change to the review prompt, model or rules. Spends model calls on every case. |
| `list_review_benchmark_runs`, `get_review_benchmark_run` | The runs, and one run with its totals and how it compares with the one before it, recall first and then harmful findings; a holdout run shows only its totals. Judging findings and adopting a change stay in the app. Read-only. |
| `list_prs` | Pull requests on a code platform connection (waiting for your review, yours, or merged), each with its latest review in Paraself (risk level, round and findings) and the platform's build status, people's approvals and open blockers. Read-only. |
| `list_pr_reviews`, `get_pr_review` | List the PR reviews Paraself keeps, and read one: its risk level, and each finding with what it stands on (a repository rule, or only your own decisions, which make it a suggestion), and for one posted, how the PR's author answered it. Read-only. |
| `run_pr_review` | When you ask for one, start a review in the app as the review page does: the PR read fresh, deep for a high-risk one, a later round only on what the new commits changed. Answers at once with the record to follow with `get_pr_review`; posts nothing to the PR. |
| `get_pr_review_settings`, `update_pr_review_settings` | Each link's automatic pre-review, read-only; and, when you ask, turned on (a model, reviews a day at most) or off. On, the app reviews the PRs waiting for you as they come in or move on, one at a time and never past a PR's third round, keeping the results to itself. Off by default: it spends model calls. |
| `update_pr_review_finding` | When you say so, mark a finding as not taken with your reason, or take that back; later reviews of the repository are told of it. Changes only the record in Paraself. |
| `record_pr_comments` | When you say so, post chosen findings of a review to their lines on the PR; a P1 is blocking by default (a task on Bitbucket), a finding resting only on your own basis cannot be, unless it is a P1 on a local review rule you marked `enforcement: blocking`, whose comment then quotes the rule; one already posted is never posted again. Approving and merging have no tool. |
| `list_pr_comments`, `update_pr_comment` | On one of your own PRs: the comments others left (people's and Paraself pre-reviews'), each with what you answered; and, once you say how and why, answer one with a standard reply (误报, 有意为之, 不处理), or 转后续, which first adds a todo to your 「PR 后续」 list. |
| `record_local_review_job` | When you ask for comments to be fixed, hand them to the local review: on lines of a local repository's changes, or on your own PR. A PR's fix goes onto its own branch as a new commit only once you confirm the push in the app, and only while the branch is still where the fix started. |
| `list_local_review_jobs`, `get_local_review_job` | The local review's tasks, and one task in detail: each comment's judgement and fix, the commits, high-risk files and verification. Read-only. |
| `update_local_review_job` | When you say so, cancel a running task, or retry a failed group or the evaluation. Pushing and approving high-risk changes stay in the app. |
| `get_review_quality` | A connection's review quality over the last 30 days against the 30 before: people's approvals and comments per merged PR, the median wait for a person's approval and reverts, read from the platform; what became of the findings posted, by what they stood on; and the rules authors keep calling wrong. Read-only. |
| `update_review_rule` | When you ask, turn one of your own local review rules off, or on again. |
| `list_review_escapes` | Problems review let through: merged PRs a later revert or fix showed, each with its write-up (the problem, which layer should have stopped it, why it did not, where the change goes). Read-only. |
| `list_rule_promotion_candidates` | Your own rules (decisions, local review rules) that review keeps needing, and escapes whose write-up says a rule should change, each with what says so, examples and a draft line for the repository's REVIEW.md. Proposing one hands it to the local review, which changes the file and opens a PR only after you confirm it in the app. Read-only. |
| `record_review_escape`, `update_review_escape` | When you say so, record one you name, write its four lines, dismiss it with your reason, or make it a defect candidate for the review benchmark from where the problem sat. |
| `get_pr_description_draft`, `update_pr` | Read a PR's description and draft the template's missing parts (verification, risk, rollback), keeping what the author wrote; once you confirm the text, write it back, only over the version read. Not approving or merging. |

No MCP tool can delete a decision, a todo list, a historical decision or a review benchmark case.

Connecting Codex or Claude Code also installs two skills, and keeps them current when Paraself is updated: [`paraself-memory`](skills/paraself-memory/SKILL.md) tells an agent when and how to use these tools, and [`paraself-review`](skills/paraself-review/SKILL.md) checks a code, PR or plan review against your decisions and notes. They go in `~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code. A skill folder you changed, or another tool's of the same name, is left alone and said in the connect result. A copy of the older `decision-context` skill that Paraself shipped is removed; one you changed is kept. Disconnecting leaves the skills in place.

## Models

Paraself tries the enabled model backends in the order set on the Models page. Out of the box:

1. Apple Foundation Models, on-device and built into macOS.
2. Qwen3.5, run locally: 4B (recommended, about 3 GB) or 2B (about 1.3 GB), installed from the Models page.
3. Rules, used whenever no model is available.

Capture classification runs on every agent turn, so by default it uses only the rules and the local Qwen 4B, never a remote service.

You can also add OpenAI (Responses API), Anthropic (Messages API), any OpenAI-compatible API (with a DeepSeek preset), or the Codex CLI and Claude Code CLI already signed in on your machine. These are off by default. Once you enable one, the trimmed content of the current task is sent to that provider. API keys are encrypted with the operating system's secure storage, or kept in a private local file if you turn on 本地密钥模式 (local key mode). Every model call is logged locally with its token count, and with its cost if you enter prices.

Semantic search uses the Qwen3-Embedding-0.6B model (about 640 MB). For now it is installed only with `npm run prepare:model` from a source checkout; without it, search uses keywords alone.

## Data and privacy

Markdown in your Obsidian vault is the source of truth. Paraself writes under `Decision Journal/` in the vault:

```text
Decision Journal/
  decisions/YYYY/MM/   decisions
  preferences/         preferences
  ideas/YYYY/MM/       ideas
  todos/YYYY/MM/       todo lists
  history/YYYY/        historical decisions
  principles/          candidate and adopted principles
  skills/ workflows/   skills and workflows built from principles
  decision-scopes/ decision-relations/ decision-feedback/ principle-relations/
  summarize/           earlier summaries, read but never written
```

Its own data lives in `~/Library/Application Support/Paraself/` on macOS and `%APPDATA%\Paraself\` on Windows:

| Database | Contents |
| --- | --- |
| `index.sqlite` | Search index of decisions; rebuildable from the Markdown |
| `semantic-vectors.sqlite` | Embeddings of decisions, principles and summaries; rebuildable |
| `obsidian-search/vaults/<id>/index.sqlite` | Index of your other vault notes; rebuildable |
| `local-decisions.sqlite` | Decisions you chose to keep on this machine only. This is their only copy and it cannot be rebuilt, so back it up. |

The same folder holds the private queues of captures waiting for you, the change history of your todo lists (`todo-history/`, kept on this machine only and never written to the vault), the organization suggestions and their review history (`organization/`, including what you declined and how far organizing has got, also on this machine only), the model call log (kept 7 days, at most 1,000 calls), and your saved prompts (`prompts.json`, on this machine only). The index of historical decisions and the history of changes to each are in `historical-decisions.sqlite`; the index can be rebuilt from their notes, the change history cannot. To back up, keep the vault, `local-decisions.sqlite`, `historical-decisions.sqlite`, `todo-history/`, `organization/` and `prompts.json`; the indexes can be rebuilt from Settings. Removing the app does not touch your notes.

- Everything stays on your machine unless you enable a remote API or CLI backend.
- A decision keeps an excerpt of its context, never the full transcript. Hooks read only a bounded tail of the local transcript.
- The app's local server listens on `127.0.0.1` only, on a random port with a token generated at each launch.

## Upgrading from Decision

On first launch Paraself renames the old `Decision` data folder to `Paraself`, keeps your vault and its `Decision Journal` folder, and still reads `DECISION_*` environment variables. Agents connected by Decision show as needing reconnection; 全部修复 replaces those connections. Remove the old Decision app afterwards.

## Build from source

You need Node.js `>=22.19.0 <26` (22 LTS recommended) and npm. On macOS you also need the Xcode Command Line Tools with the macOS 26 SDK. No API keys or certificates are required.

```bash
git clone https://github.com/cognelis/decision.git
cd decision
npm ci --ignore-scripts
npm run setup:electron
npm run check
npm run make
```

`npm run make` builds for the current platform, into `out/make/zip/darwin/arm64/` on macOS or `out/make/squirrel.windows/x64/` on Windows. Releasing is described in [docs/release.md](docs/release.md).

| Command | Purpose |
| --- | --- |
| `npm run check` | Type check and the full test suite |
| `npm run quality` | What CI runs: `check` plus the semantic recognition gate |
| `npm run build` | Package the app into `out/` without making installers |
| `npm run smoke` | Start the packaged app on a throwaway vault and run a real capture end to end |
| `npm run prepare:model` | Download the local Qwen generation and embedding models |
| `npm run replay:pr` | Replay real pull requests through the review pipeline ([docs](docs/pr-review-replay.md)) |
| `python3 scripts/install-local-macos.py --apply` | Install your build into `/Applications` on macOS, rolling back on failure |

Further documentation, in Chinese:

- [docs/semantic-recognition.md](docs/semantic-recognition.md): how recognition and the local models work, and how they were evaluated
- [docs/decisions/](docs/decisions/): implementation decisions and naming
- [docs/iteration-roadmap.md](docs/iteration-roadmap.md): what each iteration delivered and why

## License

[MIT](LICENSE), © Cognelis contributors.
