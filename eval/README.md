# TaskAware AI Eval

Measures how well the natural-language → structured-task pipeline (`POST /api/ask-ai/`: prompt + Gemini 2.5 Flash + server post-processing) turns free text into tasks.

## What it measures
- **60 golden cases** in [cases.json](cases.json): Hebrew, English and mixed; single and multi-task; relative dates ("מחר בבוקר", "ביום ראשון"); anchor contexts (work/home/school/gym with before/during/after); implicit products ("נגמר נייר טואלט" → supermarket); no-place tasks; "here" requests grounded with nearby places.
- **Per-field accuracy**: place category, context, condition, due date (date + hour window), and task count.
- **Case accuracy**: every field and the task count are correct.
- **Latency**: p50 / p90 / max per request (the cold start is excluded).
- Device time is fixed (Wed 11 Nov 2026, 09:00 Israel time), so relative dates have one correct answer.

## Run
Needs Node 18+ only. No Python and no Gemini key needed, because it calls the deployed server.

```bash
cp eval/env.example eval/.env    # then fill in the eval account
node eval/run_eval.mjs --dry-run # self-test of the scorer, no network
node eval/run_eval.mjs --limit 5 # smoke test
node eval/run_eval.mjs           # full run, ~8 minutes (7s between calls for the Gemini free tier)
```

Options: `--tag multi`, `--delay 7000`, `--repeat 3` (consistency across runs).
Reports are written to `eval/results/run-<time>.md` and `.json`.
