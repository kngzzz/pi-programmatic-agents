# pi-programmatic-agents

Programmatic sub-agent primitive for [Pi](https://github.com/badlogic/pi-mono). Invoke isolated sub-agents as functions with contracted outputs.

Inspired by [Anthropic's programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) — where Claude writes code that calls tools as functions inside a sandbox. This extension applies the same pattern to **sub-agents**: the parent agent composes objective, constraints, and output contract at call-time, and the sub-agent fulfills the contract in isolation. Only the projected result enters the parent's context window.

## Why this is a primitive

Anthropic built programmatic tool calling. The missing piece is programmatic sub-agents.

| Pattern | What orchestrates | Where intermediate results live | Context cost |
|---------|------------------|-------------------------------|--------------|
| Tool calling | Model reasons between calls | Context window | O(n) per tool |
| Programmatic tool calling | Model writes code | Code sandbox | O(1) final output |
| Sub-agent dispatch (current) | Model dispatches and waits | Context window | O(full response) |
| **Programmatic sub-agents** | Model composes function call | Sub-agent process | O(projected fields only) |

The sub-agent might consume 20K+ input tokens across 6 turns of tool use. The parent sees only the projected JSON fields it asked for.

## Install

```bash
pi install npm:pi-programmatic-agents
```

Or from source:

```bash
pi install git:github.com/kngzzz/pi-programmatic-agents
```

Then enable the extension:

```bash
pi config
```

## How it works

The extension adds a single tool: **`subagent_call`**

1. Parent agent composes the call — objective, output contract, tool allowlist, model
2. Extension spawns an isolated `pi` subprocess (`--no-session --no-extensions --no-skills`)
3. Sub-agent works independently using its allowed tools
4. Extension validates required JSON keys against the contract (`requiredKeys`) and treats `outputSchema` as prompt-level guidance
5. Extension projects only the requested fields back to the parent
6. Parent receives minimal, contracted output — everything else stays in the sub-agent's context

```
Parent agent                    Sub-agent (isolated pi process)
    │                                    │
    ├── subagent_call({                  │
    │     objective: "...",              │
    │     requiredKeys: [...],      ──►  ├── reads files
    │     project: [...],                ├── runs commands
    │     tools: ["read","bash"]         ├── reasons (6 turns)
    │   })                               ├── returns JSON
    │                               ◄──  │
    ├── receives projected fields only   │
    │   (sub-agent's 20K tokens          │
    │    never enter parent context)     │
    ▼                                    ▼
```

## Tool parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `objective` | ✅ | What the sub-agent should accomplish |
| `instructions` | | Additional guidance, pre/post-processing hints |
| `outputMode` | | `json` (default) or `text` |
| `outputSchema` | | JSON schema/contract guidance for the sub-agent prompt (not strict runtime schema validation yet) |
| `requiredKeys` | | Dot-path keys that must exist (e.g. `["summary", "items[0].url"]`) |
| `project` | | Dot-path projection — only these fields return to parent |
| `model` | | Model override for sub-agent (e.g. `anthropic/claude-haiku-4-5`) |
| `thinking` | | Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `tools` | | Tool allowlist (e.g. `["read", "grep", "find", "ls"]`) |
| `cwd` | | Working directory for sub-agent |
| `includeFiles` | | File paths to pass as `@file` inputs |
| `timeoutSeconds` | | Hard timeout (default 180, max 900) |
| `maxTurns` | | Max assistant turns (default 8, max 32) |
| `includeRawOutput` | | Include raw output preview in tool details |

## Examples

### Research as a function

```json
{
  "objective": "Research the latest Redis memory optimization techniques for write-heavy workloads",
  "instructions": "Return practical recommendations with tradeoffs and references",
  "outputMode": "json",
  "requiredKeys": ["summary", "recommendations", "citations"],
  "project": ["summary", "recommendations"],
  "tools": ["read", "bash"],
  "timeoutSeconds": 240,
  "maxTurns": 10
}
```

### Codebase exploration

```json
{
  "objective": "Find authentication entrypoints and token validation flow",
  "instructions": "Focus on call graph and risky trust boundaries",
  "outputMode": "json",
  "requiredKeys": ["entrypoints", "flow", "risks"],
  "project": ["entrypoints", "risks"],
  "tools": ["read", "grep", "find", "ls"],
  "includeFiles": ["./README.md"]
}
```

### Multi-agent orchestration

The parent agent can compose multiple sub-agent calls to decompose complex tasks:

```
Parent: "Design the parallel execution primitive"

  → subagent_call: "Inventory all built primitives in the codebase"          ✓ 5 turns, $0.06
  → subagent_call: "Trace primitive wiring in background task execution"     ✓ 6 turns, $0.09
  → subagent_call: "Trace primitive wiring in loop runtime"                  ✓ 5 turns, $0.07
  → subagent_call: "Extract test evidence proving primitive behaviors"       ✓ 5 turns, $0.06

Parent synthesizes all results into a design document.
Total: ~$0.28, each sub-agent's full context stayed isolated.
```

### Text mode

```json
{
  "objective": "Summarize the migration blockers in this repository",
  "outputMode": "text",
  "tools": ["read", "grep", "find", "ls"]
}
```

## Details

- **Isolation**: Sub-agent runs with `--no-session --no-extensions --no-skills --no-prompt-templates --no-themes`
- **Observability**: Full execution trace in `details.trace`, debug artifact at `details.artifactPath`
- **Safety**: Turn limits, timeouts, tool allowlists, concurrency cap, and projection hardening against prototype pollution.
- **Workspace confinement (default)**: `cwd` and `includeFiles` stay within parent workspace root. Set `PI_SUBAGENT_ALLOW_PATH_ESCAPE=1` to disable.
- **JSON mode behavior**: Strict final-output parsing by default. Optional recovery from earlier turns via `PI_SUBAGENT_LENIENT_JSON_RECOVERY=1`.
- **Environment handling**: Pass-through by default. Optional scrub mode: `PI_SUBAGENT_ENV_MODE=scrub` with allowlist via `PI_SUBAGENT_ENV_ALLOWLIST=KEY1,KEY2`.
- **Truncation**: Output truncated to Pi defaults (50KB / 2000 lines) to protect parent context.
- **Artifacts**: Debug artifact (`run.json`) written to `/tmp/pi-subagent-artifact-*` with automatic retention cleanup.

## Roadmap

- [ ] `subagent_batch` — parallel fan-out (spawn N sub-agents concurrently, return all results)
- [ ] `subagent_spawn` + `subagent_await` — true async primitives with handles

## License

Apache-2.0
