"use strict";

/**
 * Load key renderer pages in a headless Electron window and fail on load alerts.
 * Run: ./node_modules/.bin/electron scripts/smoke-pages.js
 */
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");

const PAGES = [
	"loading.html",
	"menu.html",
	"project_start.html",
	"workspace_menu.html",
	"menu_category.html",
	"credits.html",
	"batch_select.html",
];

const repoRoot = path.join(__dirname, "..");

app.whenReady().then(async function () {
	var win = new BrowserWindow({
		show: false,
		webPreferences: { nodeIntegration: true, contextIsolation: false },
	});

	for (var i = 0; i < PAGES.length; i++) {
		var pageName = PAGES[i];
		await new Promise(function (resolve, reject) {
			function onFail(_event, errorCode, errorDescription) {
				win.webContents.removeListener("did-fail-load", onFail);
				reject(
					new Error(
						pageName +
							" did-fail-load " +
							errorCode +
							": " +
							errorDescription,
					),
				);
			}
			win.webContents.once("did-fail-load", onFail);
			win.webContents.once("did-finish-load", function () {
				win.webContents.removeListener("did-fail-load", onFail);
				setTimeout(resolve, 200);
			});
			win
				.loadFile(path.join(repoRoot, "pages", pageName))
				.catch(reject);
		});
		console.log("OK:", pageName);
	}
	win.destroy();
	app.quit();
});

app.on("window-all-closed", function () {
	app.quit();
});

process.on("unhandledRejection", function (err) {
	console.error(err);
	app.exit(1);
});
