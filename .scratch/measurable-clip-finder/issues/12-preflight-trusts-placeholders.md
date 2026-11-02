# Preflight passes files that cannot be read

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

`checkFile` now proves readability instead of inferring it. After the existing
size check it opens the file and reads one byte; on failure it reports the size
it was told, the underlying error, and that a cloud placeholder must be
downloaded before the stage can run. Severity still follows `required`, so an
unreadable optional artifact warns rather than blocking.

`checkFile` is exported so it can be tested directly.

Verified both directions:

- `packages/clips/test/preflight-readability.test.ts` — 5 tests. A path that
  exists and cannot be read as a file never returns PASS; an unreadable optional
  path warns; the readable, empty and missing branches still behave.
- On real data, `preflight --stream DRR2zh3YscM --stage analysis` now reports
  **PASS on all four paths and 0 warnings**, including the 10.7 GB `stream.mp4`.
  That is the case worth checking: the file still carries the OneDrive
  placeholder attribute while being fully readable, so the probe confirms the
  new check does not false-positive on a hydrated placeholder — which is the
  mistake the attribute-based approach would have made.

`job-006` is analysis-ready for the first time: video, subtitles, chat and audio
levels all present and readable.

Found on 2026-11-02 while resolving
[01 — Recover the chat replay route](01-recover-chat-replay.md).

## Question

Nothing to decide. `preflight.ts` reports a file as present and correctly sized
when nothing on the machine can actually read a byte of it.

Observed, verbatim, against `job-006`:

```
[PASS] manifest.videoPath: ...\job-006-2026-07-16\source\stream.mp4 (10977.7 MB)
```

That file is a OneDrive cloud-only placeholder. Every attempt to read it fails
with `OSError errno 22`. `checkFile` uses `existsSync` and `statSync().size`,
which are metadata operations — both succeed on a dehydrated placeholder, and
the reported size is the cloud file's size, not what is local.

So preflight will green-light an analysis run whose video cannot be opened, and
the failure surfaces much later inside ffmpeg or whisper as something that looks
unrelated. This is the same silent-degrade class that ticket 01 existed to kill,
in the module meant to prevent it.

Done when:

- `checkFile` proves readability, not just existence — open the file and read a
  byte. Cheap, and it is the only check that distinguishes a real file from a
  placeholder.
- The failure message says *why*, naming the placeholder case specifically. A
  bare "cannot read" will send the next reader hunting for a permissions bug.
- **Do not** test the Windows file attributes instead of reading. Measured on
  2026-11-02 after OneDrive hydrated `job-006`'s source: the file reports
  `cloud-only: True` from `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` while reads
  succeed and ffprobe returns a correct 42458.22 s duration. OneDrive keeps the
  placeholder flag set on a file it is now serving, so an attribute check would
  **falsely block a perfectly readable file**. The attributes are useful only
  for wording an error message after a read has already failed — never as the
  test itself.
- A test covers it. Simulating a placeholder is awkward, so a zero-byte file or
  a directory passed where a file is expected is an acceptable stand-in for the
  "exists but unreadable" branch.

## Context worth carrying

The underlying condition is environmental and is the user's to fix: the project
lives inside OneDrive, `OneDrive.exe` is not running, and every media file in
`data/clips/` carries the offline attribute. Text artifacts (`.vtt`, `.json`,
`audio_levels.txt`, transcripts) are all local; every `.mp4` and `.ass` is
cloud-only. See
[01's resolution](01-recover-chat-replay.md#resolution) for the full scan.

This ticket is not about fixing OneDrive. It is about preflight telling the
truth when it happens again — which it will, because a pipeline that writes
11.5 GB videos into a synced folder will keep getting them dehydrated.

## Comments
