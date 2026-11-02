# Preflight passes files that cannot be read

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

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
- Consider checking the Windows file attributes directly for a precise message:
  `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000),
  `FILE_ATTRIBUTE_RECALL_ON_OPEN` (0x40000) and `FILE_ATTRIBUTE_OFFLINE`
  (0x1000) all mark a dehydrated file. A read attempt is sufficient and
  portable, so treat the attribute check as optional polish.
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
