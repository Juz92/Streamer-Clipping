# Daily Peanut Clips — Paperclip AI Expansion Plan

**Prepared for:** CEO Agent
**Date:** 2026-04-01
**Company:** Daily Peanut Clips & Highlights
**Mission:** Turn every livestream into a library of viral Shorts, automatically.

---

## Current State

We have a working clip extraction pipeline at `C:\peanut` that:
- Downloads Burnt Peanut livestreams (6-7 hour streams, 10-15GB each)
- Analyzes 3 signals (transcript, chat, audio) to find viral moments
- Manually scans transcripts for humor (the most important step)
- Extracts 10-15 clips per stream, ranked by virality score
- Renders 9:16 Shorts with dual-panel layout, karaoke captions, and neon glow hook text
- Generates upload metadata (titles, descriptions, tags) for YouTube/TikTok/Reels
- 3-stage QA process on every render

**What's manual today:** Everything is triggered by a human in a Claude Code conversation. There's no orchestration, no automated scheduling, no upload pipeline, and no analytics feedback loop.

---

## Proposed Org Structure (12 Agents)

```
CEO
├── CTO
│   ├── Pipeline Engineer
│   └── Remotion Engineer
│
├── Clip Producer
│   ├── Stream Scout
│   └── QA Reviewer
│
├── Content Manager
│   ├── SEO & Metadata Specialist
│   ├── Compilation Producer
│   └── Community Manager
│
├── Analytics Analyst
│   └── A/B Testing Agent
│
└── Multi-Channel Expansion Agent
```

---

## Agent Definitions

### Existing Agents

#### CEO
- **Role:** Strategic oversight, weekly review, approve priorities
- **Reports to:** Board/Human
- **Key decisions:** Which streamers to clip, budget allocation, growth priorities

#### CTO
- **Role:** Technical architecture, pipeline development, code quality
- **Reports to:** CEO
- **Key decisions:** Technology choices, module design, performance optimization

---

### New Agents — Operations

#### Clip Producer
- **Role:** The workhorse. Runs the full clip pipeline for each stream: download, analyze, scan transcript, extract clips, render 9:16 Shorts.
- **Reports to:** CTO
- **Adapter:** claude_local
- **Workspace:** `C:\peanut`
- **Instructions file:** `C:\peanut\CLAUDE.md`
- **First tasks:**
  - Process all unprocessed Burnt Peanut streams
  - Render clips using approved visual style (neon glow hook + karaoke captions)
  - Generate clip-scores.xlsx for each job

#### Stream Scout
- **Role:** Monitors The Burnt Peanut for new streams. Checks daily. Creates issues for unprocessed streams. Flags streams with high-value collaborators (Summit, Nickmercs = more discoverable clips).
- **Reports to:** Clip Producer
- **Adapter:** claude_local
- **Cadence:** Every 12 hours (via Paperclip scheduling)
- **First tasks:**
  - Run `npx tsx packages/clips/src/discover.ts --list` daily
  - Compare against existing job directories
  - Create issue for any new unprocessed stream

#### QA Reviewer
- **Role:** Runs the 3-stage QA process on every rendered batch. Extracts frames, checks avatar centering, layout correctness, caption positioning, hook banner coverage, audio normalization. Rejects clips with specific fix notes.
- **Reports to:** Clip Producer
- **Adapter:** claude_local
- **Key rule:** NEVER self-approve. Must extract and visually inspect a frame from EVERY rendered short.
- **QA checklist per clip:**
  - [ ] Avatar visible and recognizable?
  - [ ] Avatar centered (not cut off or edge-biased)?
  - [ ] Correct layout mode (2-panel for gameplay, centered crop for desk)?
  - [ ] Hook text visible with white banner fully covering text?
  - [ ] Karaoke captions working (white → yellow word tracking)?
  - [ ] Captions positioned correctly (join line for gameplay, bottom for desk)?
  - [ ] Audio normalized?

---

### New Agents — Content & Distribution

#### Content Manager
- **Role:** Generates upload-metadata.md for every job. Writes titles, descriptions, tags, hashtags per platform. Plans posting schedule and cross-platform cadence.
- **Reports to:** CEO
- **Adapter:** claude_local
- **Key rule:** Every title must be under 70 chars. Every description links both channels. Tags under 500 chars per video.
- **Channel links (always include):**
  - Streams: https://www.youtube.com/@TheBurntPeanut
  - Clips: https://www.youtube.com/@DailyPeanutClipsHighlights

#### SEO & Metadata Specialist
- **Role:** Keyword research per clip. Analyzes search volume, competitor tags, trending topics. Optimizes titles for CTR and descriptions for ranking.
- **Reports to:** Content Manager
- **Adapter:** claude_local
- **First tasks:**
  - Research "burnt peanut" keyword ecosystem on YouTube
  - Build tag template library by clip type (roast, gameplay, crude humor, meltdown)
  - Analyze top gaming clip channels for tag patterns

#### Compilation Producer
- **Role:** After 50+ Shorts are posted, creates weekly "Best of" compilations (5-8 min) for mid-roll ad revenue. Selects top-performing Shorts by view count, stitches with transitions, adds intro/outro.
- **Reports to:** Content Manager
- **Adapter:** claude_local
- **Revenue case:** Shorts RPM ~$0.005/1K views. Long-form RPM $3-8/1K. A compilation with 50K views earns more than a Short with 500K views.
- **Activation:** Month 3+ (after 50+ Shorts posted)

#### Community Manager
- **Role:** Monitors comments on posted Shorts. Drafts engagement-driving replies. Pins best comments. Identifies audience preferences ("more Jinxy content" → feed to Clip Producer). Reports toxic/spam.
- **Reports to:** Content Manager
- **Adapter:** claude_local
- **Why:** YouTube algorithm weights comment velocity in first 48 hours. Active comment engagement directly impacts distribution.

---

### New Agents — Development

#### Pipeline Engineer
- **Role:** Builds missing pipeline modules, fixes bugs, improves automation. Takes development issues from QA Reviewer and Analytics Analyst feedback.
- **Reports to:** CTO
- **Adapter:** claude_local
- **Workspace:** `C:\peanut` (git worktree branches)
- **Priority backlog:**
  1. Build `orchestrate.ts` — single-command full pipeline runner (referenced in CLAUDE.md but not yet coded)
  2. Build `upload.ts` — YouTube Shorts upload via OAuth2 (googleapis dependency already in package.json)
  3. Fix layout auto-detection in `lib/layout.ts` to work per-clip instead of batch-guessing
  4. Build automated avatar position detection (currently manual QC frame extraction)
  5. Improve VTT word-level timestamp parsing (current parser misses some inline tags)

#### Remotion Engineer
- **Role:** Upgrades video rendering from raw ffmpeg to proper Remotion React components. Animated hook text, smooth caption transitions, configurable layout via props.
- **Reports to:** CTO
- **Adapter:** claude_local
- **Workspace:** `C:\peanut\packages\remotion`
- **Why:** ffmpeg drawtext is limited. Remotion gives animated text reveals, spring physics, smooth fades, and React component composition. More flexibility for evolving the visual style.
- **First tasks:**
  1. Rebuild hook text as animated Remotion component (spring pop-in, fade out at 2s)
  2. Implement proper karaoke word tracking in React (currently ASS subtitles)
  3. Build configurable dual-panel layout component with adjustable split ratio

---

### New Agents — Growth & Analytics

#### Analytics Analyst
- **Role:** Tracks performance of every posted Short. Monitors stay rate, avg view %, like rate, comment rate, views velocity. Compares clip types (roasts vs gameplay vs crude humor). Generates weekly reports. Feeds insights back to scoring formula.
- **Reports to:** CEO
- **Adapter:** claude_local
- **Cadence:** 48 hours after each upload batch + weekly summary
- **Key outputs:**
  - Per-clip performance scorecard
  - Clip type comparison (which categories perform best)
  - Posting time analysis
  - Weekly trend report to CEO

#### A/B Testing Agent
- **Role:** Runs structured experiments on creative variables. Different hook styles, thumbnail approaches, posting times, title formats. Tracks variants, measures results, feeds learnings back.
- **Reports to:** Analytics Analyst
- **Adapter:** claude_local
- **First experiments:**
  - Hook text: question format vs statement format
  - Posting time: morning vs evening vs late night
  - Thumbnail: punchline frame vs reaction frame
  - Caption style: current karaoke vs no captions vs larger text

#### Multi-Channel Expansion Agent
- **Role:** Research and onboard new streamers. Identify creators whose content works as clips. Analyze OBS layouts, create channel-config.json, test pipeline on their streams, spin up new clip channels.
- **Reports to:** CEO
- **Adapter:** claude_local
- **Activation:** Month 3+ (after first channel is stable and profitable)
- **Target:** 5 clip channels within 6 months

---

## Skill Assignments

All skills are located at `C:\Users\Justi\.claude\skills\<skill-name>\SKILL.md`

### Core Project Skills (Custom)

| Skill | Path | Description |
|-------|------|-------------|
| `streamer-clipping` | `C:\Users\Justi\.claude\skills\streamer-clipping\SKILL.md` | Full clip extraction pipeline — the primary operational skill (43KB) |
| `video-review` | `C:\Users\Justi\.claude\skills\video-review\SKILL.md` | Pre-upload video quality review |
| `ranked-shorts` | `C:\Users\Justi\.claude\skills\ranked-shorts\SKILL.md` | Viral video ranking pipeline |
| `football-shorts` | `C:\Users\Justi\.claude\skills\football-shorts\SKILL.md` | Before The Glory pipeline (legacy, reference only) |
| `seo-analytics-analyst` | `C:\Users\Justi\.claude\skills\seo-analytics-analyst\SKILL.md` | SEO and analytics via browser automation |
| `social-content-creator` | `C:\Users\Justi\.claude\skills\social-content-creator\SKILL.md` | Social media content planning |

### General Skills (Available to assign)

| Skill | Path | Best for Agent |
|-------|------|----------------|
| `javascript-typescript` | `.claude\skills\javascript-typescript\SKILL.md` | Pipeline Engineer, Remotion Engineer, CTO |
| `backend-development` | `.claude\skills\backend-development\SKILL.md` | Pipeline Engineer, CTO |
| `frontend-design` | `.claude\skills\frontend-design\SKILL.md` | Remotion Engineer |
| `video-downloader` | `.claude\skills\video-downloader\SKILL.md` | Clip Producer, Stream Scout |
| `copywriting` | `.claude\skills\copywriting\SKILL.md` | Content Manager |
| `copy-editing` | `.claude\skills\copy-editing\SKILL.md` | Content Manager |
| `content-strategy` | `.claude\skills\content-strategy\SKILL.md` | Content Manager, CEO |
| `social-content` | `.claude\skills\social-content\SKILL.md` | Community Manager |
| `seo-optimizer` | `.claude\skills\seo-optimizer\SKILL.md` | SEO Specialist |
| `seo-audit` | `.claude\skills\seo-audit\SKILL.md` | SEO Specialist |
| `seo-content` | `.claude\skills\seo-content\SKILL.md` | SEO Specialist |
| `ai-seo` | `.claude\skills\ai-seo\SKILL.md` | SEO Specialist |
| `programmatic-seo` | `.claude\skills\programmatic-seo\SKILL.md` | SEO Specialist |
| `analytics-tracking` | `.claude\skills\analytics-tracking\SKILL.md` | Analytics Analyst |
| `ab-test-setup` | `.claude\skills\ab-test-setup\SKILL.md` | A/B Testing Agent |
| `xlsx` | `.claude\skills\xlsx\SKILL.md` | Analytics Analyst, Clip Producer |
| `qa-regression` | `.claude\skills\qa-regression\SKILL.md` | QA Reviewer |
| `code-review` | `.claude\skills\code-review\SKILL.md` | CTO, Pipeline Engineer |
| `test-driven-development` | `.claude\skills\test-driven-development\SKILL.md` | Pipeline Engineer |
| `systematic-debugging` | `.claude\skills\systematic-debugging\SKILL.md` | Pipeline Engineer |
| `lead-research-assistant` | `.claude\skills\lead-research-assistant\SKILL.md` | Multi-Channel Expansion |
| `content-research-writer` | `.claude\skills\content-research-writer\SKILL.md` | Multi-Channel Expansion |
| `humanizer-main` | `.claude\skills\humanizer-main\SKILL.md` | Community Manager |
| `launch-strategy` | `.claude\skills\launch-strategy\SKILL.md` | CEO, Multi-Channel Expansion |
| `marketing-ideas` | `.claude\skills\marketing-ideas\SKILL.md` | CEO, Content Manager |
| `brainstorming` | `.claude\skills\brainstorming\SKILL.md` | CEO, CTO |
| `writing-plans` | `.claude\skills\writing-plans\SKILL.md` | CTO, CEO |
| `executing-plans` | `.claude\skills\executing-plans\SKILL.md` | All dev agents |
| `subagent-driven-development` | `.claude\skills\subagent-driven-development\SKILL.md` | CTO |
| `dispatching-parallel-agents` | `.claude\skills\dispatching-parallel-agents\SKILL.md` | CTO, Clip Producer |
| `verification-before-completion` | `.claude\skills\verification-before-completion\SKILL.md` | QA Reviewer |

### Per-Agent Skill Matrix

| Agent | Skills |
|-------|--------|
| **CEO** | streamer-clipping, content-strategy, analytics-tracking, launch-strategy, marketing-ideas, brainstorming, writing-plans |
| **CTO** | streamer-clipping, javascript-typescript, backend-development, code-review, writing-plans, subagent-driven-development, dispatching-parallel-agents |
| **Clip Producer** | streamer-clipping, video-downloader, javascript-typescript, xlsx, dispatching-parallel-agents |
| **Stream Scout** | streamer-clipping, video-downloader |
| **QA Reviewer** | streamer-clipping, video-review, qa-regression, verification-before-completion |
| **Content Manager** | copywriting, copy-editing, content-strategy, social-content, seo-optimizer |
| **SEO Specialist** | seo-audit, seo-content, ai-seo, programmatic-seo, analytics-tracking |
| **Compilation Producer** | streamer-clipping, video-downloader, copywriting |
| **Community Manager** | social-content, social-content-creator, copywriting, humanizer-main |
| **Pipeline Engineer** | javascript-typescript, backend-development, test-driven-development, systematic-debugging, streamer-clipping, executing-plans |
| **Remotion Engineer** | javascript-typescript, frontend-design, streamer-clipping, executing-plans |
| **Analytics Analyst** | seo-analytics-analyst, analytics-tracking, xlsx, content-strategy, ab-test-setup |
| **A/B Testing Agent** | ab-test-setup, analytics-tracking, content-strategy, xlsx |
| **Multi-Channel Expansion** | content-research-writer, lead-research-assistant, streamer-clipping, launch-strategy |

---

## Key Project Files & Locations

| File | Location | Purpose |
|------|----------|---------|
| **CLAUDE.md** | `C:\peanut\CLAUDE.md` | Main project instructions for all agents |
| **Streamer clipping skill** | `C:\Users\Justi\.claude\skills\streamer-clipping\SKILL.md` | Full 43KB operational guide |
| **Pipeline source** | `C:\peanut\packages\clips\src\` | All TypeScript pipeline modules |
| **Remotion compositions** | `C:\peanut\packages\remotion\src\compositions\` | Video rendering templates |
| **Shared utilities** | `C:\peanut\packages\shared\src\` | Logger, file helpers, timing |
| **Job data** | `C:\peanut\data\clips\job-NNN-YYYY-MM-DD\` | Per-stream working directories |
| **Channel config** | `C:\peanut\data\clips\channel-config.json` | Avatar/gameplay regions |
| **Memory files** | `C:\Users\Justi\.claude\projects\C--peanut\memory\` | Persistent learnings |

### Critical Memory Files (learned behaviors)

| Memory | Location | What it captures |
|--------|----------|-----------------|
| Approved visual style | `memory\approved_visual_style.md` | Neon glow hook + karaoke caption spec (DO NOT change) |
| QA process | `memory\feedback_qa_process.md` | 3-stage mandatory QA (extract + inspect every frame) |
| Avatar QC | `memory\feedback_avatar_qc.md` | Avatar varies per stream — must QC before batch render |
| Peanut catchphrases | `memory\peanut_catchphrases.md` | "lock in" before highlights, "hooray" after cool plays |
| Channel info | `memory\user_channels.md` | Both channel URLs and descriptions |

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
**Agents to hire:** Clip Producer, Stream Scout, QA Reviewer
**Goal:** Automate the daily clip production loop

- Stream Scout checks for new streams daily
- Clip Producer processes each stream end-to-end
- QA Reviewer validates every render before handoff
- Human handles upload and metadata manually

### Phase 2: Content & Distribution (Week 3-4)
**Agents to hire:** Content Manager, SEO Specialist
**Goal:** Automate metadata and optimize for discovery

- Content Manager generates upload-metadata.md per job
- SEO Specialist optimizes tags and titles
- Posting schedule automated with cadence rules

### Phase 3: Development (Week 3-6)
**Agents to hire:** Pipeline Engineer, Remotion Engineer
**Goal:** Build missing infrastructure and improve quality

- Pipeline Engineer builds orchestrate.ts and upload.ts
- Remotion Engineer upgrades rendering from ffmpeg to React
- Both work in git worktree branches, CTO reviews PRs

### Phase 4: Analytics & Optimization (Week 5-8)
**Agents to hire:** Analytics Analyst, A/B Testing Agent
**Goal:** Close the feedback loop — learn what works

- Analytics Analyst tracks every posted Short
- A/B Testing Agent runs experiments on hooks/thumbnails/timing
- Insights feed back into clip scoring formula

### Phase 5: Growth (Month 3+)
**Agents to hire:** Compilation Producer, Community Manager, Multi-Channel Expansion
**Goal:** Scale revenue and expand to multiple streamers

- Compilation Producer creates weekly "Best of" compilations (high RPM)
- Community Manager drives comment engagement
- Multi-Channel Expansion onboards new streamers (5 channels by month 6)

---

## Budget Estimate (Monthly)

| Agent | Estimated Cost | Notes |
|-------|---------------|-------|
| CEO | $50 | Weekly review + strategic decisions |
| CTO | $100 | Architecture review, PR approval |
| Clip Producer | $400 | Heavy: 7hr streams, ffmpeg, multiple renders |
| Stream Scout | $20 | Lightweight polling |
| QA Reviewer | $80 | Frame extraction + visual inspection |
| Content Manager | $100 | Metadata for 10-15 clips per stream |
| SEO Specialist | $60 | Keyword research per batch |
| Compilation Producer | $80 | Monthly (starts Month 3) |
| Community Manager | $40 | Comment monitoring |
| Pipeline Engineer | $200 | Active development sprints |
| Remotion Engineer | $150 | Active development sprints |
| Analytics Analyst | $60 | Weekly reports + tracking |
| A/B Testing Agent | $40 | Experiment management |
| Multi-Channel Expansion | $100 | Research + onboarding (starts Month 3) |
| **TOTAL** | **~$1,480/month** | |

---

## Success Metrics

| Metric | Month 1 Target | Month 3 Target | Month 6 Target |
|--------|---------------|----------------|----------------|
| Shorts produced/week | 10-15 | 20-30 | 50+ (multi-channel) |
| Avg views per Short | 500 | 5,000 | 25,000 |
| Subscribers | 100 | 1,000 | 10,000 |
| Monthly revenue | $0 | $50 (Shorts RPM) | $500+ (compilations) |
| Streams processed | 1/week | 2-3/week | 5+/week (multi-channel) |
| Human time required | 5 hrs/week | 2 hrs/week | 30 min/week |
