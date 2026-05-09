# Cardiac Core — Claude Code Context

## What This Is

A personal daily task management web app replicating the TeuxDeux experience with two-way Notion sync. Single `index.html` file, vanilla JS, no framework, no backend beyond Vercel serverless functions for Notion API proxying.

## Two Variants

| Variant | Status | Description |
|---------|--------|-------------|
| **Cardiac Core (private)** | ✅ Production | Single-tenant, `NOTION_TOKEN` env var on Vercel. Current active app. |
| **Cardiac Core Public** | 🔲 Planned | Multi-tenant, Supabase (Postgres + auth), no Notion dependency. $0/month target. |

**⚠️ For any change request: ALWAYS ask whether it applies to the personal version, the public version (Cardiac Core Public), or both before making edits.**

## Repo & Deployment

- **Repo:** `github.com/cardiaccore` (private)
- **Hosting:** Vercel
- **Stack:** Vanilla JS, single HTML file, CSS variables, no build step
- **Deploy workflow:** Push to main → Vercel auto-deploys

## File Map

```
├── index.html          # TeuxDeux-style refactor — THIS IS PRODUCTION
├── _lib/
│   └── notion.js       # Shared Notion API helpers (getConfig, notionFetch, pageToTask, taskToProperties, applyCors)
├── api/notion/
│   ├── status.js       # GET  — auth + DB connectivity check
│   ├── sync.js         # GET  — pull all non-archived pages (paginated, max 1000)
│   ├── push-task.js    # POST — create or update a Notion page
│   └── archive-task.js # POST — archive (soft-delete) a Notion page
```

## Task Data Model (localStorage `cardiacTasks`)

```js
{
  id: number,              // Date.now() at creation
  notionId?: string,       // Notion page ID, set after first push
  text: string,
  completed: boolean,
  dayOffset: number,       // 0=today, 1=tomorrow, -1=yesterday, 999=someday/unscheduled
  category: string,        // One of the category names below
  order: number,           // Sort position within a day
  createdAt: ISO string
}
```

## Categories & Colors

```js
const categoryColors = {
  'Brain Dump':          '#888780',
  'Personal':            '#378ADD',
  'Cardiac':             '#d4537e',
  'Benefits Board':      '#EF9F27',
  'Property Management': '#639922',
  'Estate':              '#BA7517',
  'Acquisitions':        '#7F77DD',
  'Growth':              '#1D9E75',
  'Research':            '#888780'
};
```

## Notion Integration

### Env Vars (Vercel)

- `NOTION_TOKEN` — Notion internal integration token (`secret_...`)
- `NOTION_DATABASE_ID` — `2463401f-1a99-80fa-ad27-000b91c4691a`

### Notion Property Schema

| Notion Property | Type | Local Field | Notes |
|----------------|------|-------------|-------|
| `Task` | title | `task.text` | |
| `Due Date` | date | `task.dayOffset` | Computed from today's date |
| `Status` | status | `task.completed` | Values: `Not started`, `Up Next`, `In progress`, `Done` |
| `Select` | multi-select | `task.category` | Despite the name, this is multi-select |
| `Project` | select | `task.project` | Read-only from app |

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/notion/status` | GET | Cheapest auth+DB check → `{connected, databaseTitle}` |
| `/api/notion/sync` | GET | Pull all non-archived pages, paginated (max 1000) → task array |
| `/api/notion/push-task` | POST | Create (no `notionId`) or update (PATCH with `notionId`) |
| `/api/notion/archive-task` | POST | Archive page by `notionId` (soft-delete, reversible in Notion UI) |

### Important API Notes

- Call `https://api.notion.com/v1/databases/{id}/query` directly with `Authorization: Bearer secret_...` and `Notion-Version: 2022-06-28` headers.
- The MCP endpoint at `https://mcp.notion.com/mcp` requires OAuth and will **always reject** internal `secret_` integration tokens. Don't use it.
- Database ID with dashes stripped for API calls: `2463401f1a9980faad27000b91c4691a`

## UI Architecture (index2.html)

### Views

1. **Day View (TODAY)** — scrollable task list for a single day
2. **Board View (SOMEDAY)** — tasks grouped by category, collapsible sections

### Layout

- **Header:** Large bold date (`SATURDAY, MAY 2`) + sync status dot beneath
- **Bottom nav:** Horizontal day strip (date pills, scrollable) + action row (TODAY / + / SOMEDAY)
- **Task cards:** Gray background (`--task-bg`), green left border, circular checkboxes, gap-separated
- **Drag handles:** Right side (right-handed thumb accessibility)

### Gesture System

**Day view:**
| Gesture | Action |
|---------|--------|
| Single tap | Toggle complete |
| Double tap | Edit modal |
| Long press (600ms) | Action menu (Reschedule / Edit / Delete) |
| Swipe right | Move to next day (blue "→ TOMORROW" reveal) |
| Swipe left | Unschedule (red "← UNSCHEDULE", moves to Someday) |
| Drag handle | Reorder within day |

**Board view (Someday):**
| Gesture | Action |
|---------|--------|
| Single tap | No-op (prevents fat-finger) |
| Double tap | Edit modal |
| Triple tap | Schedule to today |
| Long press (600ms) | Action menu (Reschedule / Edit / Delete) |

### Theming

- Dark mode default, light mode toggle persisted in `localStorage('cardiacLightMode')`
- All colors via CSS variables (`--bg-primary`, `--bg-secondary`, `--text-primary`, `--text-secondary`, `--accent-green`, `--border-color`, `--task-bg`)

## Key Behaviors

### Rollover
On app load, `rolloverOverdueTasks()` moves incomplete tasks with `dayOffset < 0` to `dayOffset: 0`. Runs **before** `checkNotionStatus()` resolves, so rolled-over tasks don't push to Notion on startup but sync on next explicit edit. **This is intentional — do not change.**

### Sync Merge
Remote tasks matched by `notionId`. Existing → updated in-place. New remote → appended with `dayOffset` from Notion (or 999 if null). Counter-based local IDs avoid `Date.now()` collisions.

### Delete Flow
1. `window.confirm` prompt
2. Archive in Notion first (if connected + has notionId)
3. If archive fails → abort delete, show error
4. If archive succeeds or no notionId → remove locally, re-render

### Auto-Sync
On successful Notion status check, a silent sync runs automatically via `syncFromNotion({ silent: true })`.

## Mandatory Coding Rules

1. **After every edit:** Extract script block → write to `/tmp/t.js` → run `node --check`. Do NOT present file until it passes.
2. **Smallest safe change possible.**
3. **Inspect existing patterns** before writing new code.
4. **No new dependencies** — vanilla JS only.
5. **Don't swallow errors.**
6. **Review diff** for accidental removals, orphaned fragments, and missing function declarations from partial `str_replace`.

## Debugging Patterns

- **Syntax checking:** `node --check` on extracted script content is gold standard. `new Function()` wrapper misses errors due to top-level `return` statements.
- **Error location:** Binary search through script lines with progressive `new Function()` parsing narrows error location.
- **Missing function detection:** Match `funcDecls` against HTML `on*` handler calls to catch missing function declarations.
- **`str_replace` risk:** Partial replacements can silently eat function keywords or leave orphaned fragments.

## Deferred Features (Not Yet Built)

- Font size buttons
- Default category dropdown
- Reorder-categories modal
- Drag-drop scheduling between days
- Swipe-left-to-delete on board
- Board layout toggle (vertical/horizontal)
- Per-card hint text
- "Load Example Tasks" debug button

## Cardiac Core Public (Planned)

- Multi-tenant, no Notion dependency
- Supabase (Postgres + auth, free tier), Vercel hosting
- Magic-link email auth via Supabase
- `tasks` table keyed by `user_id`
- localStorage becomes offline cache, not source of truth
- Goal: $0/month at launch
