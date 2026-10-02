# Orchestrator flows

Status: working design, not user documentation. It describes where declarative
flows are going, so the direction can be checked before each part lands. The
normative contract is [`store/spec/schema/flow.schema.json`](../store/spec/schema/flow.schema.json)
and the "Orchestrator flows" section of [`store/spec/README.md`](../store/spec/README.md).
Background: issue #379.

Sections marked **Planned** are not implemented yet. Their details can still
change; the scope and the rules in "Principles" should not.

## What a flow is

A flow is an Orchestrator task graph written down in a file. Director mode stays
the default: the Director builds a graph for a new or exploratory project. A flow
is for a recipe that already worked and should run the same way again, for
example CAD part -> render -> film, or issue -> plan -> code -> tests -> PR.

With a flow, the daemon compiles the file once, pins it, and runs the graph
itself. No Director is launched (`directorId: null`).

## Principles

- **A task is an agent in a pane, configured by its harness.** Model, skills,
  instructions, tools and environment belong to the harness package, not to the
  flow. To use a different model, pick a different harness or `engine:<name>`.
- **Deliverables pass as files.** A downstream task gets the pinned artifacts of
  its direct dependencies, read-only, in `inputs/<dep>/`. Its brief also lists
  each dependency's summary, attempt and artifact paths. There is no
  `$task.output` substitution and no structured output passing.
- **No expression language.** Substitution is `$inputs.<name>` in prompts only.
  Shell steps read values from environment variables. Conditions are single
  comparisons.
- **Check before launch.** Unknown keys, invalid fields, unknown harnesses or
  engines, missing dependencies, cycles and undeclared inputs fail the whole flow
  and nothing starts. Most errors carry `file:line:col`; a few (an unknown engine,
  a harness the daemon refuses) do not yet. **Planned:** reject a literal
  `inputs/<x>/` reference to a task that is not a direct dependency, and warn
  about a reference to a file the upstream task does not declare in `outputs`.
  Arbitrary shell code and prose are not analyzed.
- **Automatic actions are bounded.** Retries and graph size have limits. Shell
  steps default to a 10-minute timeout; agent tasks have no default timeout, so
  the flow author decides. Planned loops and graph expansion require explicit
  limits.
- **A run can be explained afterwards.** Provenance records the flow hash, inputs,
  engine, and per task the prompt hash and resolved engine. **Planned:** hashes
  of the scripts that `run` steps invoke.
- **Additive only.** New fields are optional; existing readers of `Run` and
  `TaskSpec` keep working.

## File format

YAML 1.2 (core schema) or JSON. Anchors, aliases, tags, duplicate keys and
multiple documents are rejected. Files up to 256 KiB.

The example below needs two Planned features: approval, and a shared git
worktree so that `implement`, `tests`, `review` and `open-pr` see the same
changes. Today every task runs in its own folder and only declared artifacts move
between tasks.

```yaml
spec: 1
name: issue-to-pr
description: Plan, implement, test and open a PR for a GitHub issue
worktree: true                          # Planned
inputs:
  issue: { required: true, description: Issue number }
tasks:
  - id: plan
    harness: engine:claude
    prompt: |
      Read GitHub issue #$inputs.issue (gh issue view). Write plan.md:
      root cause, files to touch, test strategy. Do not change code.
    outputs: { files: ["plan.md"] }

  - id: implement
    harness: engine:codex
    prompt: Implement inputs/plan/plan.md. Add or update tests.
    depends_on: [plan]
    timeout: 60m

  - id: tests
    run: npm test
    depends_on: [implement]
    retry: { max_attempts: 2 }

  - id: review
    harness: engine:claude
    prompt: Review the diff against inputs/plan/plan.md. Write review.md.
    depends_on: [plan, tests]
    outputs: { files: ["review.md"] }

  - id: approve-pr                      # Planned
    approval: "Open the PR?"
    depends_on: [review]

  - id: open-pr
    run: gh pr create --fill --body-file inputs/review/review.md
    depends_on: [review, approve-pr]
```

Flows are found by path, then in `<project>/.harness/flows/`, then in
`~/.harness/flows/`. **Planned:** in a `flows/` folder of an installed harness
package.

## Task kinds

| Kind | Key | Finishes when |
| --- | --- | --- |
| Agent task | `harness` + `prompt` | the worker calls `finish`/`fail`, or its turn ends and `outputs` are present |
| Shell step | `run` | the shell exits: 0 succeeds, anything else fails |
| Approval (**Planned**) | `approval` | a person approves, rejects or picks a decision |
| One-shot (**Planned**) | `oneshot` | a headless prompt returns; its text is saved as a file |
| Plan (**Planned**) | `plan` | its planner added a sub-graph and that sub-graph finished |
| Cancel (**Planned**) | `cancel` | immediately; it stops the run with a reason |

### Agent tasks

The worker gets a brief (`ORCHESTRATOR_TASK.md`) with its prompt, inputs,
declared outputs, verdict rule and timeout. `outputs: { files: [globs],
verdict?: ready }` lets the daemon finish the task itself when the worker's turn
ends and every glob matches a file (and, with `verdict: ready`,
`.harness/verdict.json` says `ready: true`). The verdict gate is opt-in; by
default the verdict stays a feed.

### Shell steps

`run` executes in a login shell in its own process group. The environment has
`HARNESS_INPUT_<NAME>` for every input plus `HARNESS_PROJECT_DIR`,
`HARNESS_FLOW_DIR`, `HARNESS_RUN_ID`, `HARNESS_TASK_ID` and `HARNESS_ATTEMPT`.
User values never become shell code. `stdout.log` and `stderr.log` are kept as
artifacts, also when the step fails or times out. Default timeout: 10 minutes.

### Approval (Planned)

An approval task waits for a person. It records the decision and an optional
comment as a file in its artifacts, so downstream tasks read them from
`inputs/<id>/`. `decisions` offers named choices, and `when` can branch on the
chosen one. Reject fails the task and is never retried automatically. A
decision names the attempt it answers, so a stale card cannot approve a newer
request, and recording the same decision twice has no further effect. The
waiting state and the decision are saved in the run so that a crash between
them leaves a consistent result, and the waiting state survives a daemon restart.
Answers come from the CLI (`harness orchestrator approve|reject`) and from a
card in the desktop app.

This is its own state, not an agent question card: question cards mirror a
dialog that is already shown in an agent's pane, and an approval task has no
pane.

### One-shot (Planned)

A one-shot task sends one prompt to a headless, tool-less engine and saves the
answer as a file with a name the flow sets. Text files from `inputs/` can be
included in the prompt explicitly, with a size limit; a file that is too large or
not valid text fails the task. It has its own timeout and stops on cancel. Only engines with a headless one-shot mode
are supported. Good for summaries, release notes and short transformations that
do not need an agent session.

### Plan (Planned)

A plan task runs a planner agent that adds tasks to the run, inside a frame the
flow fixes: a task limit, new ids only, allowed task kinds. The plan task
finishes only after the tasks it added finish, so a later step such as "review
all variants" waits for them. Everything else in the flow stays pinned. The
addition is tied to the plan task's attempt and is validated and saved as one
step, so it is either fully in the run or not at all. Provenance records what
was added.

## Dependencies and conditions

`depends_on` lists direct dependencies. By default a task starts when all of
them succeeded, and is blocked when one of them did not.

**Planned:**
- `trigger_rule` sets readiness: `all_success` (default), `all_done` (run after
  dependencies finish in any state, for reports and cleanup) and
  `none_failed_min_one_success` (join after branches where some were skipped).
- `when` is one comparison against a dependency: its state, a field of its
  verdict (`ready`, `errors`, `warnings`, taken from a snapshot of the attempt,
  not read live), or an approval decision. A false condition marks the task
  `skipped`.
- `skipped` counts as finished for the run result.

## Reliability

- `timeout` bounds one attempt (`30s`, `45m`, `2h`, up to 24h).
- `retry.max_attempts` is the number of attempts in all, the first included
  (1 to 6). Without it a failed task is not run again automatically. A task that
  could not be launched, or was interrupted by a daemon restart, is not retried
  automatically either.
- Manual `retry` does not depend on `max_attempts`. It keeps the existing
  checks: the run is active, the previous attempt has stopped, the task is known
  to have failed or stopped, and no downstream task already used its result.
- **Planned:** `retry.delay` with doubling backoff; `idle_timeout` for agent
  tasks that stop making progress, with no default; a bounded loop on an agent
  task, `loop: { until_run: <command>, max_iterations: N }`, where the daemon runs
  the check after each turn and sends the failing output back to the same agent.
  The task succeeds when the check passes and fails when the iterations run out.

## Run state and results

A flow run is `completed` when every task finished successfully. When nothing
can move and something failed, the run stays `active` with an error, so a task
can be retried by hand.

**Planned:** one outcome classifier (succeeded, failed, waiting for a person,
in progress) used by the CLI, `wait` and the desktop app.

## Paths

Each attempt has a task folder: `tasks/<id>/attempt-N/` under the run. It holds
the brief, `inputs/`, logs and the files that become artifacts. Artifacts are
snapshotted read-only with hashes when the task finishes.

**Planned:** the folder where a task executes is separate from its task folder.
Today they are the same. With a worktree they differ: the agent or shell step
works in the worktree, and inputs, brief, logs and artifacts stay in the task
folder.

### Worktree per run (Planned)

A coding flow can ask for a git worktree per run (`worktree: true`). Tasks run
there; the brief and the environment name the worktree and its base branch.
Agent tasks in such a run do not write at the same time. Worktrees of flow runs
are cleaned up only when they have no uncommitted work and no live agents.

## CLI

```
harness orchestrator [--port N --machine ID] run <flow> [--input k=v]... [--cwd DIR]
    [--engine E] [--parallelism N] [--bypass-permission] [--dry-run]
```

`--dry-run` validates and prints the compiled graph without a daemon.

**Planned:** `validate <flow>`, `flows` (list with inputs), `run --wait` and
`wait <project>` with exit codes (0 succeeded, 1 failed, 2 wait error,
3 timed out, the run continues, 4 waiting for a person), `rerun <project>`
(a new run of every task from the pinned flow and inputs, repeating the effective
engine, folder, parallelism, permission, source format and worktree settings;
plan expansions are generated again, and it warns when scripts or packages
differ from the recorded hashes; continuing the same run is `resume`),
`approve`/`reject`,
`--dry-run --stubs` (walk the graph with given outcomes and show what would run,
skip or block).

## Desktop (Planned)

- The new-project launcher offers Prompt or Flow. For a flow it lists the flows
  on the selected machine and asks for its inputs.
- A flow project shows its tasks without Director wording, including shell,
  one-shot, approval and skipped tasks.
- Approval cards in the project workspace, with an attention signal while a
  decision is pending.
- "Save as flow" exports the graph of a finished Director run as a flow file, so
  a recipe that worked can be pinned and edited instead of written from scratch.

## Not planned

- Replacing the Director.
- Passing structured output between tasks, or templating.
- Per-task model, tool, hook, MCP or session-context settings: this belongs to
  harness packages, and every task is its own agent session.
- Retry policies by error class: the daemon does not learn why a provider
  failed.
- Re-running finished tasks on `resume`: resume continues where the run stopped.
- An event log or live log streaming beyond the run's messages and the log files
  in task folders.
- Flow tags and flow versioning.
- Redacting secrets in step logs.
- A security sandbox, containers, multi-machine runs.

## Open questions

These change where flows go next, so they need agreement first:

- Composition: including one flow in another, child runs, fan-out over a list.
- Interactive loops (a person comments after each iteration), and loops that end
  on a field the agent reports instead of a check command.
- A `studio` package kind that only chains other harnesses, in addition to the
  planned `flows/` folder in harness packages.
- Conditions with `&&`/`||`, or on task output.
- Starting a task on the first successful dependency while others still run.
- Finer locks inside a worktree run instead of one writer at a time.
- Steps that wait for a time, an external event or a person's attention;
  scheduled and event-triggered runs.

## Details to settle while building

These do not change the direction, but each needs a decision before its part
lands:

- Whether a run succeeds when a failed task was handled by an `all_done` task.
- What `when` sees when a dependency wrote no verdict.
- What happens to skipped or running downstream tasks when an upstream task is
  retried.
- Loop: which wins between the check, `outputs` and an explicit `finish`; whether
  `timeout` covers one iteration or all; which events reset `idle_timeout`;
  whether a retry restarts the loop.
- Loop, plan and one-shot tasks after a retry or a daemon restart.
