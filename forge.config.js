require("dotenv").config();
module.exports = {
	packagerConfig: {
		osxSign: {},
		asar: false,
		icon: "assets/icons/icon",
		// Paths passed to ignore are repo-relative with a leading "/" (see electron-packager copy-filter).
		// Anchor with ^/ so "/python/src/..." does not match a bare "src" substring.
		ignore: [
			"^/src($|/)",
			"^/tsconfig\\.json$",
			"^/yarn\\.lock$",
			"^/\\.env$",
			"^/README\\.md$",
			"^/LICENSE$",
			// Top-level python/ package only — not node_modules/python-shell
			"^/python($|/)",
			"^/scripts($|/)",
			"^/patches($|/)",
			"^/docs/(?!USER_GUIDE\\.md$)",
			"^/development($|/)",
			"^/AGENTS\\.md$",
			"^/legacy_atlas\\.nrrd$",
			"^/vendor($|/)",
			"^/\\.cursor($|/)",
			"^/\\.gitmodules$",
			"^/forge\\.config\\.js$",
			"^/\\.eslintrc\\.js$",
			"^/\\.eslintignore$",
			"^/\\.gitignore$",
			"^/\\.gitattributes$",
			"^/debug-.*\\.log$",
		],
	},
	makers: [
		{
			name: "@electron-forge/maker-zip",
			platforms: ["win32"],
		},
		{
			name: "@electron-forge/maker-dmg",
			config: {
				format: "ULFO",
			},
		},
		{
			name: "@electron-forge/maker-deb",
		},
	],
};
