# TOOLS.md — Local Notes

Skills define *how* tools work. This file is for *your* specifics.

## Environment

- **Platform:** Windows 11
- **Workspace:** D:\localclaw\workspace
- **Model:** Qwen3:4b via Ollama (localhost:11434)
- **Gateway:** http://127.0.0.1:18789

## Available Tools

- list_files — List workspace files
- read_file — Read file with line numbers
- create_file — Create new file (fails if exists)
- replace_lines — Replace lines N-M
- insert_after — Insert after line N
- delete_lines — Delete lines N-M
- find_replace — Find/replace exact text
- delete_file — Delete file
- web_search — Google Custom Search

## Notes

- Line-based tools work best for edits (replace_lines, insert_after)
- find_replace is fragile with whitespace — prefer line-based tools
- For large files, read_file first to get line numbers
- create_file blocks overwrites — use editing tools for existing files

## Critical Tool Rules

**NEVER use `run_command` to open a browser.** Use `browser_open(url)` instead. `run_command("chrome ...")` opens a separate window with no session — browser_snapshot will fail.

**Web Research Decision Table:**

| Situation | Use |
|-----------|-----|
| Reading Reddit, GitHub, news, docs | `web_search` + `web_fetch` |
| Filling a form, logging in, clicking a UI | `browser_open` + `browser_click` |
| Reddit specifically | `web_search` with `site:reddit.com "term"` then `web_fetch` |
| Opening ChatGPT/Claude in browser | `browser_open("https://chatgpt.com")` |

**Desktop focus:** use short process name — `"msedge"`, `"chrome"`, `"code"` — never the full window title.

---

## Web Research Strategy — READ THIS BEFORE USING THE BROWSER

Choose the right tool for the job. Browser automation is fragile and slow. Only use it when you actually need to interact with a page.

### Decision Table

| What you need to do | Use this |
|---|---|
| Read Reddit posts, GitHub, news articles, blogs | `web_search` + `web_fetch` — never the browser |
| Read X/Twitter content | Browser only — open search URL directly (e.g. `https://x.com/search?q=TERM&f=live`), snapshot, scroll — never click into tweets or follow links |
| Interact with a web app (forms, buttons, login) | Browser automation |
| Scrape infinite scroll content | Browser + scroll loop — cap at a reasonable limit |

### Rules for web_search + web_fetch (preferred for research)

- Use `web_search` first to get URLs, then `web_fetch` each relevant URL to read full content
- For Reddit specifically: use `site:reddit.com/r/SUBREDDIT "keyword"` search queries — do not open a browser
- `web_fetch` works on Reddit, GitHub, and most static sites without triggering bot detection
- Extract what you need from the fetched content and move on — do not browse around

### Rules for browser automation (only when required)

- Open the most specific URL possible — never start at a homepage and navigate from there
- For X/Twitter: go straight to `https://x.com/search?q=TERM&f=live` — do not log in, do not click tweets, do not follow external links
- Never click external links inside posts or feeds — they will navigate you away and you will lose your place
- If you need to go back, use `browser_open` with the original URL — do not use Alt+Left or browser history
- Take snapshots sparingly — one per page state, not repeatedly on the same unchanged page
- If a snapshot loop guard triggers, STOP and rethink — do not retry the same call
- On task resume: always re-open the target URL fresh via `browser_open` — never assume prior browser state is still valid

### For read-only research tasks

If the task is purely reading and summarizing (no login, no form submission, no interaction), use `web_search` + `web_fetch`. This applies to: Reddit, GitHub, news sites, documentation, blog posts. The browser is not needed and will cause problems.

---

*Add whatever helps you do your job. This is your cheat sheet.*
