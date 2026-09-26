# Routines is live

**Hosted feature release · September 2026**

Your prompts, on a schedule, on a budget.

A routine is a saved prompt with a name, a model and optional Web search. It runs
every day, on weekdays or once a week, at a time in any time zone. Each routine
has a per-run maximum and a monthly budget in credits, plus an on/off switch. An
account can keep up to 10.

- Runs go through the same hold and settle as chat, and each gets a signed
  receipt.
- A run that could cost more than its per-run maximum, or than what's left of
  its monthly budget, is refused before anything is reserved. Nothing is
  charged.
- One run at a time per routine. After downtime only the latest missed slot
  runs, and a slot can never be charged twice.
- "Private models only" routes like Private Mode: zero-data-retention models
  only, never the backup gateway.
- Answers land in the inbox at /workspace/routines, with the newest 50 runs
  kept per routine.

[![Routines launch film](../assets/releases/routines.png)](../assets/releases/routines.mp4)

[Download the 22-second launch film](../assets/releases/routines.mp4)

## Notes

- Routines run on the server, where Veil can't mask anything: the prompt is
  sent as written.
- There's no "Run now" button yet.
- A routine can't save a seed phrase; Seed Guard refuses it.
- With Web search on, each run also pays the web-search fee, so set the
  per-run maximum to cover it.

## Video validation

A 22-second launch film recorded on the Routines build on a local demo account.
It shows "Portuguese word of the day" (Claude Haiku 4.5, every day at 07:30,
1 credit per run, 10 a month). Its run was refused at that cap and marked
0 credits: "The per-run maximum couldn't cover this run with this model and
prompt. Nothing was charged." With the cap raised to 3 credits, the next run
was delivered to the inbox for 0.6953 credits with a signed receipt. To film
them, the runs were made due by moving the routine's next run time into the
past in the demo database. 1920×1080, 30 fps, H.264, no audio, metadata
removed.

Docs and original artwork: CC BY-NC 4.0. Code: PolyForm Noncommercial 1.0.0.
See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
