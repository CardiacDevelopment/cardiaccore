# Habit Tracker — Notion Sync Activation

The habit tracker works offline immediately (localStorage). To turn on
**cross-device Notion sync**, do these three one-time steps. Until then the
`/api/habits/*` calls silently no-op and habits stay per-device.

## What was already created

Two Notion databases were created in *Bruce Blair's Workspace*:

| Database | Database ID | URL |
|----------|-------------|-----|
| **Cardiac Habits** | `70221c95715f4e2d9a4040845d7af20a` | https://app.notion.com/p/70221c95715f4e2d9a4040845d7af20a |
| **Cardiac Habit Logs** | `6510de468faf49c4b5e491e4c69cf53c` | https://app.notion.com/p/6510de468faf49c4b5e491e4c69cf53c |

Their schema already matches the API — no property setup needed.

## Step 1 — Share both databases with the app's integration

The app's server uses the internal integration behind `NOTION_TOKEN` (the same
one your Task Database uses). New databases are **not** shared with it
automatically.

For **each** database (Cardiac Habits, then Cardiac Habit Logs):

1. Open the database in Notion.
2. Click the **•••** menu (top-right) → **Connections** (a.k.a. "Add
   connections").
3. Select the same integration your Task Database is connected to
   (the Cardiac Core internal integration).

If you're unsure which integration that is: open your **Task Database**,
check its Connections list, and add the *same* one here.

## Step 2 — Add the two env vars in Vercel

Vercel → the `cardiaccore` project → **Settings → Environment Variables**. Add:

```
NOTION_HABITS_DB_ID      = 70221c95715f4e2d9a4040845d7af20a
NOTION_HABIT_LOGS_DB_ID  = 6510de468faf49c4b5e491e4c69cf53c
```

Apply to Production (and Preview/Development if you use them). `NOTION_TOKEN`
is already set and is reused.

## Step 3 — Redeploy

Pushing this branch to `main` triggers a Vercel deploy. Once live, the app will
sync habits + logs on load and after every change, exactly like your tasks.

## Verifying it works

1. Open the app, tap the ◎ habits icon, change any habit value.
2. Check the **Cardiac Habits** / **Cardiac Habit Logs** databases in Notion —
   new rows should appear.
3. Open the app on a second device — the same habit values should load.

## How the sync works (reference)

- **Habits** DB = one row per habit (definition). Matched to the local habit by
  Notion page ID.
- **Habit Logs** DB = one row per habit per period. `HabitId` = the habit's
  Notion page ID; `Period` = `YYYY-MM-DD` for daily habits or `W` + week-start
  date for weekly habits; `Day` is the real date used to fetch the last 150 days
  on sync.
- Endpoints: `api/habits/sync.js`, `push-habit.js`, `log-habit.js`,
  `archive-habit.js` — same design as `api/notion/*`.
