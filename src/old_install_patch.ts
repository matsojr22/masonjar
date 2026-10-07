import fs from "fs";
import os from "os";
import path from "path";

const forceUpdate = require("./masonjar_force_update.js");

export const BOOTSTRAP_MARKER = "/* masonjar-force-update-bootstrap */";

export const BOOTSTRAP_PRELUDE =
	BOOTSTRAP_MARKER +
	"\n" +
	"try { process.env.MASONJAR_FORCE_UPDATE_AUTORUN = \"1\"; require(\"./masonjar_force_update.js\"); } catch (e) {}\n";

const MAX_DEPTH = 4;
const MAX_DIRS = 300;
const MAX_MS = 8000;

const SKIP_DIR_NAMES = new Set([
	"node_modules",
	"windows",
	"windowsapps",
	"$recycle.bin",
	".git",
]);

export function isBelowMandatoryUpdate(version: string): boolean {
	return !!forceUpdate.isBelowMandatoryUpdate(version);
}

export function readInstallIdentity(installRoot: string): {
	installRoot: string;
	version: string;
	name: string;
	productName: string;
} | null {
	const pkgPath = path.join(installRoot, "resources", "app", "package.json");
	const exePath = path.join(installRoot, "masonjar.exe");
	if (!fs.existsSync(exePath) || !fs.existsSync(pkgPath)) {
		return null;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
			name?: unknown;
			productName?: unknown;
			version?: unknown;
		};
		return {
			installRoot,
			version: String(raw.version || ""),
			name: String(raw.name || ""),
			productName: String(raw.productName || ""),
		};
	} catch (_err) {
		return null;
	}
}

function samePath(a: string, b: string): boolean {
	if (!a || !b) {
		return false;
	}
	const left = path.resolve(a);
	const right = path.resolve(b);
	if (process.platform === "win32") {
		return left.toLowerCase() === right.toLowerCase();
	}
	return left === right;
}

export function shouldArmInstall(
	identity: {
		version: string;
		name: string;
		productName: string;
		installRoot: string;
	},
	runningInstallRoot: string | null,
	mainJs?: string,
): boolean {
	if (samePath(identity.installRoot, runningInstallRoot || "")) {
		return false;
	}
	if (String(identity.name).toLowerCase() !== "masonjar") {
		return false;
	}
	if (String(identity.productName).toLowerCase() !== "mason jar") {
		return false;
	}
	if (!isBelowMandatoryUpdate(identity.version)) {
		return false;
	}
	if (mainJs && mainJs.includes(BOOTSTRAP_MARKER)) {
		return false;
	}
	return true;
}

function skippedDir(name: string): boolean {
	return SKIP_DIR_NAMES.has(name.toLowerCase());
}

function canDescend(dirPath: string): boolean {
	try {
		const st = fs.lstatSync(dirPath);
		if (st.isSymbolicLink()) {
			return false;
		}
		return st.isDirectory();
	} catch (_err) {
		return false;
	}
}

export function userScanRoots(home: string): string[] {
	return ["Desktop", "Downloads", "Documents"]
		.map((name) => path.join(home, name))
		.filter((dir) => {
			if (!dir || dir.startsWith("\\\\")) {
				return false;
			}
			return canDescend(dir);
		});
}

export function findMasonJarInstalls(
	roots: string[],
	now: () => number = Date.now,
): string[] {
	const found: string[] = [];
	const started = now();
	let visited = 0;
	const queue: Array<{ dir: string; depth: number }> = [];
	for (const root of roots) {
		if (canDescend(root)) {
			queue.push({ dir: root, depth: 0 });
		}
	}
	while (queue.length > 0) {
		if (visited >= MAX_DIRS || now() - started > MAX_MS) {
			break;
		}
		const item = queue.shift();
		if (!item) {
			break;
		}
		visited += 1;
		let names: string[] = [];
		try {
			names = fs.readdirSync(item.dir);
		} catch (_err) {
			continue;
		}
		if (names.includes("masonjar.exe")) {
			const identity = readInstallIdentity(item.dir);
			if (identity) {
				found.push(item.dir);
			}
		}
		if (item.depth >= MAX_DEPTH) {
			continue;
		}
		for (const name of names) {
			if (skippedDir(name)) {
				continue;
			}
			const child = path.join(item.dir, name);
			if (canDescend(child)) {
				queue.push({ dir: child, depth: item.depth + 1 });
			}
		}
	}
	return found;
}

export function armInstall(
	installRoot: string,
	bootstrapSource: string,
): boolean {
	const appDir = path.join(installRoot, "resources", "app");
	const mainPath = path.join(appDir, "main.js");
	const backupPath = path.join(appDir, "main.js.bak-force-update");
	const destBootstrap = path.join(appDir, "masonjar_force_update.js");
	if (!fs.existsSync(mainPath) || !fs.existsSync(bootstrapSource)) {
		return false;
	}
	let mainJs = "";
	try {
		mainJs = fs.readFileSync(mainPath, "utf8");
	} catch (_err) {
		return false;
	}
	if (mainJs.includes(BOOTSTRAP_MARKER)) {
		return false;
	}
	try {
		if (!fs.existsSync(backupPath)) {
			fs.copyFileSync(mainPath, backupPath);
		}
		fs.copyFileSync(bootstrapSource, destBootstrap);
		fs.writeFileSync(mainPath, BOOTSTRAP_PRELUDE + mainJs, "utf8");
		return true;
	} catch (_err) {
		return false;
	}
}

function appendTrace(tracePath: string | null, line: string): void {
	if (!tracePath) {
		return;
	}
	try {
		fs.mkdirSync(path.dirname(tracePath), { recursive: true });
		fs.appendFileSync(
			tracePath,
			new Date().toISOString() + " " + line + "\n",
			"utf8",
		);
	} catch (_err) {
		// Silent by design.
	}
}

export function tracePathForVersion(version: string): string | null {
	if (version !== "8.0.3") {
		return null;
	}
	return path.join(os.tmpdir(), "MasonJar", "old-install-patch.trace");
}

export function runOldInstallPatch(opts: {
	homeDir: string;
	runningInstallRoot: string | null;
	bootstrapSource: string;
	tracePath?: string | null;
}): void {
	const tracePath = opts.tracePath || null;
	try {
		appendTrace(tracePath, "start");
		const roots = userScanRoots(opts.homeDir);
		appendTrace(tracePath, "roots " + roots.length);
		const installs = findMasonJarInstalls(roots);
		appendTrace(tracePath, "found " + installs.length);
		for (const installRoot of installs) {
			const identity = readInstallIdentity(installRoot);
			if (!identity) {
				continue;
			}
			let mainJs = "";
			try {
				mainJs = fs.readFileSync(
					path.join(installRoot, "resources", "app", "main.js"),
					"utf8",
				);
			} catch (_err) {
				appendTrace(tracePath, "skip unreadable " + installRoot);
				continue;
			}
			if (!shouldArmInstall(identity, opts.runningInstallRoot, mainJs)) {
				appendTrace(
					tracePath,
					"skip " + identity.version + " " + identity.productName,
				);
				continue;
			}
			const armed = armInstall(installRoot, opts.bootstrapSource);
			appendTrace(tracePath, (armed ? "armed " : "arm-failed ") + installRoot);
		}
		appendTrace(tracePath, "done");
	} catch (_err) {
		appendTrace(tracePath, "stopped");
	}
}
