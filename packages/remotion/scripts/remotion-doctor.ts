import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REMOTION_ROOT = join(ROOT, "packages", "remotion");
const problems: string[] = [];
const warnings: string[] = [];

function readJson(path: string) { return JSON.parse(readFileSync(path, "utf-8")); }
function commandOk(cmd: string, args: string[] = ["-version"]) {
  try { execFileSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] }); return true; } catch { return false; }
}
function collectPackageJsons() {
  const paths = [join(ROOT, "package.json"), join(REMOTION_ROOT, "package.json")];
  return paths.filter(existsSync);
}
const rootPkg = readJson(join(ROOT, "package.json"));
const remPkg = readJson(join(REMOTION_ROOT, "package.json"));
const allDeps = { ...(remPkg.dependencies ?? {}), ...(remPkg.devDependencies ?? {}) };
for (const dep of ["remotion", "@remotion/cli", "@remotion/bundler", "@remotion/renderer"]) {
  if (!allDeps[dep]) problems.push(`packages/remotion missing ${dep}`);
}
const remotionVersions = new Map<string, Set<string>>();
for (const pkgPath of collectPackageJsons()) {
  const pkg = readJson(pkgPath);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, version] of Object.entries<string>(pkg[section] ?? {})) {
      if (name === "remotion" || name.startsWith("@remotion/")) {
        if (!remotionVersions.has(name)) remotionVersions.set(name, new Set());
        remotionVersions.get(name)!.add(version);
        if (version.startsWith("^") || version.startsWith("~")) warnings.push(`${pkg.name ?? pkgPath}: ${name} uses range ${version}; exact pins are safer for render reproducibility`);
      }
    }
  }
}
for (const [name, versions] of remotionVersions) {
  if (versions.size > 1) warnings.push(`${name} has multiple declared versions: ${[...versions].join(", ")}`);
}
for (const [cmd, label] of [["ffmpeg", "ffmpeg"], ["ffprobe", "ffprobe"]] as const) {
  if (!commandOk(cmd)) problems.push(`${label} is not reachable on PATH`);
}
for (const rel of ["packages/remotion/src/index.ts", "packages/remotion/src/Root.tsx"]) {
  if (!existsSync(join(ROOT, rel))) problems.push(`missing ${rel}`);
}
try {
  execFileSync(process.execPath, [join(ROOT, "node_modules", "@remotion", "cli", "remotion-cli.js"), "--version"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
} catch {
  warnings.push("local Remotion CLI could not execute; run npm install if node_modules is missing or broken");
}
const report = { ok: problems.length === 0, root: ROOT, problems, warnings };
console.log(JSON.stringify(report, null, 2));
if (problems.length) process.exit(1);
