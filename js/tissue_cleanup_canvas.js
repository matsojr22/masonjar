"use strict";

/**
 * Pan/zoom canvas editor for tissue keep masks (255 = keep, 0 = remove).
 */
function createTissueCleanupCanvas(opts) {
	opts = opts || {};
	var canvas = opts.canvas;
	var viewport = opts.viewport;
	var ctx = canvas ? canvas.getContext("2d") : null;

	var state = {
		image: null,
		imageUrl: "",
		mask: null,
		scale: 1,
		panX: 0,
		panY: 0,
		mode: "pan",
		eraserSize: 16,
		tracePoints: [],
		undoStack: [],
	};

	function imageCoords(clientX, clientY) {
		if (!viewport || !canvas) {
			return { x: 0, y: 0 };
		}
		var rect = viewport.getBoundingClientRect();
		var x = (clientX - rect.left - state.panX) / state.scale;
		var y = (clientY - rect.top - state.panY) / state.scale;
		return { x: x, y: y };
	}

	function resizeCanvasToImage() {
		if (!canvas || !state.image) {
			return;
		}
		canvas.width = state.image.naturalWidth;
		canvas.height = state.image.naturalHeight;
		if (!state.mask || state.mask.width !== canvas.width || state.mask.height !== canvas.height) {
			state.mask = newMask(canvas.width, canvas.height, 255);
		}
		fitToViewport();
		draw();
	}

	function newMask(w, h, fill) {
		var c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		var mctx = c.getContext("2d");
		mctx.fillStyle = "rgb(" + fill + "," + fill + "," + fill + ")";
		mctx.fillRect(0, 0, w, h);
		return c;
	}

	function fitToViewport() {
		if (!viewport || !canvas || !canvas.width) {
			return;
		}
		var vw = viewport.clientWidth || 512;
		var vh = viewport.clientHeight || 512;
		state.scale = Math.min(vw / canvas.width, vh / canvas.height, 1);
		state.panX = (vw - canvas.width * state.scale) / 2;
		state.panY = (vh - canvas.height * state.scale) / 2;
		applyTransform();
	}

	function applyTransform() {
		if (!canvas) {
			return;
		}
		canvas.style.transform =
			"translate(" + state.panX + "px," + state.panY + "px) scale(" + state.scale + ")";
	}

	function draw() {
		if (!ctx || !state.image || !state.mask) {
			return;
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(state.image, 0, 0);
		var overlay = document.createElement("canvas");
		overlay.width = canvas.width;
		overlay.height = canvas.height;
		var octx = overlay.getContext("2d");
		octx.drawImage(state.mask, 0, 0);
		var imgData = octx.getImageData(0, 0, overlay.width, overlay.height);
		var data = imgData.data;
		for (var i = 0; i < data.length; i += 4) {
			if (data[i] < 128) {
				data[i] = 255;
				data[i + 1] = 40;
				data[i + 2] = 40;
				data[i + 3] = 140;
			} else {
				data[i + 3] = 0;
			}
		}
		octx.putImageData(imgData, 0, 0);
		ctx.drawImage(overlay, 0, 0);
		if (state.mode === "trace" && state.tracePoints.length > 1) {
			ctx.strokeStyle = "#00e5ff";
			ctx.lineWidth = 12;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.beginPath();
			ctx.moveTo(state.tracePoints[0].x, state.tracePoints[0].y);
			for (var p = 1; p < state.tracePoints.length; p++) {
				ctx.lineTo(state.tracePoints[p].x, state.tracePoints[p].y);
			}
			ctx.stroke();
		}
	}

	function pushUndo() {
		if (!state.mask) {
			return;
		}
		var snap = document.createElement("canvas");
		snap.width = state.mask.width;
		snap.height = state.mask.height;
		snap.getContext("2d").drawImage(state.mask, 0, 0);
		state.undoStack.push(snap);
		if (state.undoStack.length > 8) {
			state.undoStack.shift();
		}
	}

	function undo() {
		if (!state.undoStack.length || !state.mask) {
			return false;
		}
		var snap = state.undoStack.pop();
		state.mask.getContext("2d").clearRect(0, 0, state.mask.width, state.mask.height);
		state.mask.getContext("2d").drawImage(snap, 0, 0);
		draw();
		return true;
	}

	function loadImageUrl(url) {
		return new Promise(function (resolve, reject) {
			var img = new Image();
			img.onload = function () {
				state.image = img;
				state.imageUrl = url;
				resizeCanvasToImage();
				resolve();
			};
			img.onerror = reject;
			img.src = url;
		});
	}

	function loadMaskFromImage(imgOrCanvas) {
		if (!state.mask || !imgOrCanvas) {
			return;
		}
		pushUndo();
		var mctx = state.mask.getContext("2d");
		mctx.clearRect(0, 0, state.mask.width, state.mask.height);
		mctx.drawImage(imgOrCanvas, 0, 0, state.mask.width, state.mask.height);
		draw();
	}

	function loadMaskFromBase64(b64) {
		return new Promise(function (resolve, reject) {
			var img = new Image();
			img.onload = function () {
				loadMaskFromImage(img);
				resolve();
			};
			img.onerror = reject;
			img.src = "data:image/png;base64," + b64;
		});
	}

	function resetMaskAllKeep() {
		if (!state.mask) {
			return;
		}
		pushUndo();
		var mctx = state.mask.getContext("2d");
		mctx.fillStyle = "#ffffff";
		mctx.fillRect(0, 0, state.mask.width, state.mask.height);
		draw();
	}

	function maskIsAllKeep() {
		if (!state.mask) {
			return true;
		}
		var mctx = state.mask.getContext("2d");
		var data = mctx.getImageData(0, 0, state.mask.width, state.mask.height).data;
		for (var i = 0; i < data.length; i += 4) {
			if (data[i] < 128) {
				return false;
			}
		}
		return true;
	}

	function exportMaskPngPath(fs, pathMod, outPath) {
		if (!state.mask || !fs) {
			return;
		}
		var tmp = document.createElement("canvas");
		tmp.width = state.mask.width;
		tmp.height = state.mask.height;
		var tctx = tmp.getContext("2d");
		tctx.drawImage(state.mask, 0, 0);
		var buf = Buffer.from(
			tmp.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
			"base64",
		);
		fs.mkdirSync(pathMod.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, buf);
	}

	function loadMaskFromFile(fs, pathMod, maskPath) {
		if (!state.mask) {
			return Promise.resolve();
		}
		if (!fs || !fs.existsSync(maskPath)) {
			resetMaskAllKeep();
			return Promise.resolve();
		}
		return new Promise(function (resolve, reject) {
			var img = new Image();
			img.onload = function () {
				state.mask.getContext("2d").clearRect(0, 0, state.mask.width, state.mask.height);
				state.mask.getContext("2d").drawImage(img, 0, 0, state.mask.width, state.mask.height);
				draw();
				resolve();
			};
			img.onerror = reject;
			img.src = "file://" + maskPath.split(pathMod.sep).join("/") + "?m=" + Date.now();
		});
	}

	function setMode(mode) {
		state.mode = mode;
		if (viewport) {
			viewport.classList.toggle("erase-mode", mode === "erase");
			viewport.classList.toggle("trace-mode", mode === "trace");
			viewport.classList.toggle("panning", false);
		}
		if (mode !== "trace") {
			state.tracePoints = [];
		}
		draw();
	}

	function paintErase(x, y) {
		if (!state.mask) {
			return;
		}
		var mctx = state.mask.getContext("2d");
		mctx.fillStyle = "#000000";
		mctx.beginPath();
		mctx.arc(x, y, state.eraserSize / 2, 0, Math.PI * 2);
		mctx.fill();
		draw();
	}

	var painting = false;
	var panning = false;
	var lastPanX = 0;
	var lastPanY = 0;
	var erasedDuringStroke = false;

	function wirePointerEvents() {
		if (!viewport) {
			return;
		}
		viewport.addEventListener(
			"wheel",
			function (ev) {
				ev.preventDefault();
				var delta = ev.deltaY > 0 ? 0.9 : 1.1;
				state.scale = Math.min(8, Math.max(0.05, state.scale * delta));
				applyTransform();
			},
			{ passive: false },
		);

		viewport.addEventListener("mousedown", function (ev) {
			var pt = imageCoords(ev.clientX, ev.clientY);
			if (state.mode === "erase") {
				pushUndo();
				erasedDuringStroke = true;
				painting = true;
				paintErase(pt.x, pt.y);
				return;
			}
			if (state.mode === "trace") {
				state.tracePoints.push(pt);
				draw();
				return;
			}
			panning = true;
			lastPanX = ev.clientX;
			lastPanY = ev.clientY;
			viewport.classList.add("panning");
		});

		window.addEventListener("mousemove", function (ev) {
			if (painting && state.mode === "erase") {
				var pt = imageCoords(ev.clientX, ev.clientY);
				paintErase(pt.x, pt.y);
				return;
			}
			if (!panning) {
				return;
			}
			state.panX += ev.clientX - lastPanX;
			state.panY += ev.clientY - lastPanY;
			lastPanX = ev.clientX;
			lastPanY = ev.clientY;
			applyTransform();
		});

		window.addEventListener("mouseup", function () {
			painting = false;
			panning = false;
			if (viewport) {
				viewport.classList.remove("panning");
			}
		});
	}

	wirePointerEvents();

	return {
		state: state,
		draw: draw,
		fitToViewport: fitToViewport,
		loadImageUrl: loadImageUrl,
		loadMaskFromBase64: loadMaskFromBase64,
		loadMaskFromFile: loadMaskFromFile,
		exportMaskPngPath: exportMaskPngPath,
		resetMaskAllKeep: resetMaskAllKeep,
		maskIsAllKeep: maskIsAllKeep,
		setMode: setMode,
		undo: undo,
		pushUndo: pushUndo,
		getTracePoints: function () {
			return state.tracePoints.slice();
		},
		clearTrace: function () {
			state.tracePoints = [];
			draw();
		},
		setEraserSize: function (n) {
			state.eraserSize = n;
		},
	};
}

module.exports = {
	createTissueCleanupCanvas: createTissueCleanupCanvas,
};
