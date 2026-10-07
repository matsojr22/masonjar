import fs from "fs";
import path from "path";

const GUARD_SOURCE = "masonjar_runtime_guard.py";

export function sitePackagesDir(benv: string): string | null {
  if (!benv) {
    return null;
  }
  if (process.platform === "win32") {
    const win = path.join(benv, "Lib", "site-packages");
    return fs.existsSync(win) ? win : null;
  }
  const lib = path.join(benv, "lib");
  if (!fs.existsSync(lib)) {
    return null;
  }
  try {
    const names = fs.readdirSync(lib);
    for (const name of names) {
      if (!name.startsWith("python")) {
        continue;
      }
      const site = path.join(lib, name, "site-packages");
      if (fs.existsSync(site)) {
        return site;
      }
    }
  } catch (_err) {
    return null;
  }
  return null;
}

function sitecustomizeSource(electronPrefixes: string[]): string {
  const listed = electronPrefixes
    .filter((item) => !!item)
    .map((item) => JSON.stringify(item))
    .join(", ");
  return (
    "# Rewritten by Mason Jar on launch.\n" +
    "import masonjar_runtime_guard as _mj_guard\n" +
    "_mj_guard.enforce_or_exit(electron_prefixes=[" +
    listed +
    "])\n"
  );
}

/** Copy the guard into benv site-packages and rewrite sitecustomize.py. */
export function installRuntimeGuard(opts: {
  benv: string;
  guardSourcePath: string;
  electronPrefixes: string[];
}): boolean {
  const site = sitePackagesDir(opts.benv);
  if (!site || !fs.existsSync(opts.guardSourcePath)) {
    return false;
  }
  try {
    fs.copyFileSync(opts.guardSourcePath, path.join(site, GUARD_SOURCE));
    fs.writeFileSync(
      path.join(site, "sitecustomize.py"),
      sitecustomizeSource(opts.electronPrefixes),
      "utf8",
    );
    return true;
  } catch (_err) {
    return false;
  }
}
