import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(process.cwd())
const extensionDir = join(root, "extension")
const outDir = join(root, "release")
const zipPath = join(outDir, "opencode-chrome-annotation-extension.zip")

const build = spawnSync("npm", ["run", "build:extension"], {
  cwd: root,
  stdio: "inherit",
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

mkdirSync(outDir, { recursive: true })
rmSync(zipPath, { force: true })

const zip = spawnSync("zip", ["-r", zipPath, ".", "-x", "*.DS_Store", "*/.DS_Store"], {
  cwd: extensionDir,
  stdio: "inherit",
})

if (zip.status !== 0) {
  process.exit(zip.status ?? 1)
}
