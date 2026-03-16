# LTX Automation — AI News YouTube Channel Pipeline

## Project Overview
Automated pipeline: discover AI news -> script -> capture -> voiceover -> render -> upload -> comments.

## Architecture
- npm workspaces monorepo with 3 packages: `shared`, `pipeline`, `remotion`
- All TypeScript/Node.js, ESM modules (`"type": "module"`)
- SQLite via better-sqlite3 + Drizzle ORM
- Job state machine tracks pipeline progress

## Conventions
- Use `tsx` to run TypeScript files directly
- Pipeline modules accept CLI args and/or stdin JSON
- All DB writes go through Drizzle ORM
- Assets saved to `data/assets/job-{id}/`
- Use structured logging via `@ltx/shared` logger

## Key Commands
- `npm run build` — TypeScript compilation
- `npm run db:generate` — Generate Drizzle migrations
- `npm run db:migrate` — Apply migrations
- `npx remotion studio` — Preview video templates (from packages/remotion)
- `npx tsx packages/pipeline/src/<module>.ts` — Run pipeline modules

## Pipeline Modules (packages/pipeline/src/)
- `research.ts` — Write discovered ideas to DB (stdin JSON)
- `select.ts` — Create jobs from top ideas (--show-top N, --create-jobs id,id)
- `script.ts` — Write script package to DB (--write job-id --stdin)
- `visual-plan.ts` — Write shot list to DB (--write job-id --stdin)
- `capture.ts` — Playwright screenshots + recordings (--job id)
- `voiceover.ts` — Edge-TTS audio + SRT (--job id)
- `render.ts` — Remotion CLI rendering (--job id)
- `upload.ts` — YouTube API upload (--job id)
- `comments.ts` — Comment poll + classify + reply

## Job States
discovered -> ranked -> selected -> scripted -> visual_planned -> assets_captured -> voiced -> rendered -> uploaded_private -> scheduled -> published
Any state can transition to `failed` (with retryFromState preserved).
