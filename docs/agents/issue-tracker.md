# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files under `.scratch/` while GitHub issue writes are unavailable.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`
- Reuse an existing canonical spec when one exists; do not copy it into `.scratch/`
- One ticket per file: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Number tickets in dependency order, blockers first
- Record triage state with a `Status:` line
- Record dependencies with a `Blocked by:` line
- Append discussion under `## Comments`

## Skill operations

- "Publish to the tracker" means create or update the relevant Markdown file under `.scratch/`
- "Fetch a ticket" means read the referenced local file
- `to-tickets` writes one file per ticket, never one combined backlog
- `implement` works the first `ready-for-agent` ticket whose blockers are complete

GitHub remains the repository remote, but local Markdown is the active issue tracker until this file is deliberately changed.
