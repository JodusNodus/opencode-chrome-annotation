import { copyFileSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(process.cwd())
const sourceDir = join(root, "extension-src")
const outputDir = join(root, "extension")

for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    unlinkSync(join(outputDir, entry.name))
  }
}
rmSync(join(outputDir, "injected"), { recursive: true, force: true })
mkdirSync(join(outputDir, "injected"), { recursive: true })

copyFileSync(join(sourceDir, "manifest.json"), join(outputDir, "manifest.json"))

const build = spawnSync(
  "bun",
  [
    "build",
    join(sourceDir, "background.ts"),
    join(sourceDir, "injected", "dom.ts"),
    "--target=browser",
    "--format=esm",
    "--outdir",
    outputDir,
    "--entry-naming",
    "[dir]/[name].js",
  ],
  { cwd: root, stdio: "inherit" }
)

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}
