import { copyFileSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(process.cwd())
const sourceDir = join(root, "extension-src")
const outputDir = join(root, "extension")
const iconSvg = join(root, "icon.svg")

for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    unlinkSync(join(outputDir, entry.name))
  }
}
rmSync(join(outputDir, "injected"), { recursive: true, force: true })
mkdirSync(join(outputDir, "injected"), { recursive: true })
mkdirSync(join(outputDir, "icons"), { recursive: true })

copyFileSync(join(sourceDir, "manifest.json"), join(outputDir, "manifest.json"))

for (const size of [16, 48, 128]) {
  const icon = spawnSync(
    "sips",
    ["-s", "format", "png", "-z", String(size), String(size), iconSvg, "--out", join(outputDir, "icons", `icon${size}.png`)],
    { cwd: root, stdio: "inherit" }
  )
  if (icon.status !== 0) {
    process.exit(icon.status ?? 1)
  }
}

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
