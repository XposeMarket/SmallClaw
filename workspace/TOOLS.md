# TOOLS.md — Available Tools & Usage Guide

## Environment

- **Platform:** Windows 11
- **Workspace:** D:\SmallClaw\workspace
- **Model:** Ollama (local)
- **Gateway:** http://127.0.0.1:18789

---

## File & Shell Tools

| Tool | What it does |
|------|-------------|
| `shell` | Execute shell/cmd commands |
| `read` | Read file contents with line numbers |
| `write` | Write (create/overwrite) a file |
| `edit` | Edit specific lines in a file |
| `list` | List directory contents |
| `delete` | Delete a file or directory |
| `rename` | Rename/move a file |
| `copy` | Copy a file |
| `mkdir` | Create a directory |
| `stat` | Get file metadata (size, dates) |
| `append` | Append content to a file |
| `apply_patch` | Apply a unified diff patch |

## Web Tools

| Tool | What it does |
|------|-------------|
| `web_search` | Search the web (Google/Brave/Tavily) |
| `web_fetch` | Fetch and parse a URL (no browser needed) |

## Memory Tools

| Tool | What it does |
|------|-------------|
| `memory_write` | Write/upsert a fact to long-term memory store |
| `memory_search` | Keyword search USER.md + SOUL.md snippets |
| `memory_read` | Read full contents of USER.md, SOUL.md, or IDENTITY.md |
| `persona_read` | Read a persona file with line numbers (before editing) |
| `persona_update` | Surgically update SOUL.md, USER.md, IDENTITY.md, MEMORY.md |

## Intraday Memory

| Tool | What it does |
|------|-------------|
| `write_note` | Write temporary note to today's intraday notes file (auto-cleaned EOD) |

## Task Tools

| Tool | What it does |
|------|-------------|
| `task_control` | List, create, update, complete tasks |

## Time

| Tool | What it does |
|------|-------------|
| `time_now` | Get current date/time |

## Browser Tools

| Tool | What it does |
|------|-------------|
| `browser_open` | Open a URL in the automation browser |
| `browser_snapshot` | Screenshot + interactive element refs |
| `browser_click` | Click an element by ref number |
| `browser_fill` | Fill a form field |
| `browser_press_key` | Press a keyboard key |
| `browser_wait` | Wait N milliseconds |
| `browser_scroll` | Scroll page up or down |
| `browser_close` | Close browser session |

## Desktop Tools

| Tool | What it does |
|------|-------------|
| `desktop_screenshot` | Screenshot the desktop |
| `desktop_find_window` | Find a window by process name |
| `desktop_focus_window` | Focus a window by process name |
| `desktop_click` | Click at x,y coordinates |
| `desktop_drag` | Drag from one point to another |
| `desktop_type` | Type text |
| `desktop_press_key` | Press a key |
| `desktop_wait` | Wait N ms |
| `desktop_get_clipboard` | Read clipboard |
| `desktop_set_clipboard` | Write to clipboard |

## Skills Tools

| Tool | What it does |
|------|-------------|
| `skill_list` | List installed skills |
| `skill_search` | Search skills by keyword |
| `skill_install` | Install a skill from ClawHub |
| `skill_remove` | Remove a skill |
| `skill_exec` | Execute a skill |

## Self-Maintenance Tools

| Tool | What it does |
|------|-------------|
| `read_source` | Read SmallClaw source code files |
| `list_source` | List SmallClaw source files |
| `propose_repair` | Propose a self-repair patch |
| `self_update` | Run self-update process |
| `spawn_agent` | Spawn a sub-agent |

---

## Decision Table — Which Tool to Use

| What you need | Use this |
|---|---|
| Read a website, GitHub, Reddit, docs | `web_search` + `web_fetch` |
| Log into a site or interact with a web form | `browser_open` + `browser_click/fill` |
| Reddit research | `web_search` with `site:reddit.com "term"` → `web_fetch` |
| Read or create local files | `read` / `write` / `edit` / `append` |
| Run a command or script | `shell` |
| Interact with a desktop app | `desktop_screenshot` + `desktop_click/type` |
| Remember something permanently | `memory_write` (upsert + stable key) |
| Update persona/user model | `persona_update` |
| Search what you already know | `memory_search` |
| Read a full persona file | `memory_read` or `persona_read` |
| Temporary note during a task | `write_note` |
| What time is it | `time_now` |

---

## Critical Rules

**NEVER use `shell` to open a browser.** Use `browser_open(url)` instead.

**Desktop focus:** Use short process name — `"msedge"`, `"chrome"`, `"code"` — never the full window title. Fail twice → stop and report, do not loop.

**Line-based edits:** Use `edit` (replace_lines) for existing files — more reliable than find/replace for whitespace-sensitive content.

**Reddit:** Always `web_search` with `site:reddit.com "keyword"` then `web_fetch` individual post URLs. Never use the browser for Reddit.

---

## When TOOLS.md is Injected

TOOLS.md is **not** always injected (saves context tokens). It is referenced when:
- You make 3+ consecutive tool failures
- You explicitly ask "what tools do I have"
- System detects tool uncertainty in reasoning

Otherwise, you should know your tools without being reminded.

---

*Last updated: 2026-03-04*
