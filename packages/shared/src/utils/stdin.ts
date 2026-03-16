const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10 MB

export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new Error(
        `Stdin payload exceeds ${MAX_STDIN_BYTES / 1024 / 1024} MB limit`
      );
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString("utf-8").trim();
}
