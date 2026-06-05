"use strict";

/**
 * Static-fit canvas editor for tissue keep masks (255 = keep, 0 = remove).
 */
function createTissueCleanupCanvas(opts) {
	opts = opts || {};
	var canvas = opts.canvas;
	var viewport = opts.viewport;
	var ctx = canvas ? canvas.getContext("2d") : null;
	var onTraceChange = opts.onTraceChange;

	var ORPHAN_MIN_AREA = 32;
	var ORPHAN_AREA_FRAC = 0.0002;

	var state = {
		image: null,
		imageUrl: "",
		mask: null,
		maskVisible: false,
		sliceUntouched: true,
		scale: 1,
		panX: 0,
		panY: 0,
		mode: "idle",
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
		return {
			x: Math.max(0, Math.min(canvas.width - 1, x)),
			y: Math.max(0, Math.min(canvas.height - 1, y)),
		};
	}

	function notifyTraceChange() {
		if (typeof onTraceChange === "function") {
			onTraceChange(state.tracePoints.length);
		}
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
		if (
			!state.maskVisible ||
			(state.sliceUntouched && maskIsAllKeep())
		) {
			if (state.mode === "trace" && state.tracePoints.length > 0) {
				ctx.strokeStyle = "#00e5ff";
				ctx.fillStyle = "#00e5ff";
				ctx.lineWidth = 12;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				if (state.tracePoints.length === 1) {
					var tp0 = state.tracePoints[0];
					ctx.beginPath();
					ctx.arc(tp0.x, tp0.y, 6, 0, Math.PI * 2);
					ctx.fill();
				} else {
					ctx.beginPath();
					ctx.moveTo(state.tracePoints[0].x, state.tracePoints[0].y);
					for (var tp = 1; tp < state.tracePoints.length; tp++) {
						ctx.lineTo(state.tracePoints[tp].x, state.tracePoints[tp].y);
					}
					ctx.stroke();
				}
			}
			return;
		}
		var overlay = document.createElement("canvas");
		overlay.width = canvas.width;
		overlay.height = canvas.height;
		var octx = overlay.getContext("2d");
		octx.drawImage(state.mask, 0, 0);
		var imgData = octx.getImageData(0, 0, overlay.width, overlay.height);
		var data = imgData.data;
		for (var i = 0; i < data.length; i += 4) {
			if (data[i] >= 128) {
				data[i] = 40;
				data[i + 1] = 200;
				data[i + 2] = 80;
				data[i + 3] = 115;
			} else {
				data[i] = 255;
				data[i + 1] = 40;
				data[i + 2] = 40;
				data[i + 3] = 140;
			}
		}
		octx.putImageData(imgData, 0, 0);
		ctx.drawImage(overlay, 0, 0);
		if (state.mode === "trace" && state.tracePoints.length > 0) {
			ctx.strokeStyle = "#00e5ff";
			ctx.fillStyle = "#00e5ff";
			ctx.lineWidth = 12;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			if (state.tracePoints.length === 1) {
				var p0 = state.tracePoints[0];
				ctx.beginPath();
				ctx.arc(p0.x, p0.y, 6, 0, Math.PI * 2);
				ctx.fill();
			} else {
				ctx.beginPath();
				ctx.moveTo(state.tracePoints[0].x, state.tracePoints[0].y);
				for (var p = 1; p < state.tracePoints.length; p++) {
					ctx.lineTo(state.tracePoints[p].x, state.tracePoints[p].y);
				}
				ctx.stroke();
			}
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

	function pruneOrphanKeepIslands() {
		if (!state.mask) {
			return 0;
		}
		var w = state.mask.width;
		var h = state.mask.height;
		var mctx = state.mask.getContext("2d");
		var data = mctx.getImageData(0, 0, w, h).data;
		var orphanMax = Math.max(
			ORPHAN_MIN_AREA,
			Math.floor(w * h * ORPHAN_AREA_FRAC),
		);
		var labels = new Int32Array(w * h);
		var nextLabel = 1;
		var areas = [];
		var stack = [];

		function idx(x, y) {
			return y * w + x;
		}

		for (var y = 0; y < h; y++) {
			for (var x = 0; x < w; x++) {
				var i = idx(x, y);
				if (data[i * 4] < 128 || labels[i] !== 0) {
					continue;
				}
				var label = nextLabel++;
				var area = 0;
				stack.push(i);
				labels[i] = label;
				while (stack.length) {
					var cur = stack.pop();
					area += 1;
					var cx = cur % w;
					var cy = (cur / w) | 0;
					var neighbors = [
						[cx - 1, cy],
						[cx + 1, cy],
						[cx, cy - 1],
						[cx, cy + 1],
					];
					for (var n = 0; n < neighbors.length; n++) {
						var nx = neighbors[n][0];
						var ny = neighbors[n][1];
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
							continue;
						}
						var ni = idx(nx, ny);
						if (labels[ni] !== 0 || data[ni * 4] < 128) {
							continue;
						}
						labels[ni] = label;
						stack.push(ni);
					}
				}
				areas[label] = area;
			}
		}

		var largest = 0;
		var largestLabel = 0;
		for (var li = 1; li < nextLabel; li++) {
			if ((areas[li] || 0) > largest) {
				largest = areas[li];
				largestLabel = li;
			}
		}

		var cleared = 0;
		for (var pi = 0; pi < labels.length; pi++) {
			var lab = labels[pi];
			if (!lab || lab === largestLabel) {
				continue;
			}
			if ((areas[lab] || 0) >= orphanMax) {
				continue;
			}
			data[pi * 4] = 0;
			data[pi * 4 + 1] = 0;
			data[pi * 4 + 2] = 0;
			data[pi * 4 + 3] = 255;
			cleared += 1;
		}
		if (cleared) {
			mctx.putImageData(new ImageData(data, w, h), 0, 0);
			draw();
		}
		return cleared;
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
		state.maskVisible = false;
		state.sliceUntouched = true;
		draw();
	}

	function setMaskVisible(visible) {
		state.maskVisible = !!visible;
		draw();
	}

	function setSliceUntouched(untouched) {
		state.sliceUntouched = !!untouched;
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
		}
		if (mode !== "trace") {
			state.tracePoints = [];
			notifyTraceChange();
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
	var erasedDuringStroke = false;

	function wirePointerEvents() {
		if (!viewport) {
			return;
		}

		viewport.addEventListener("mousedown", function (ev) {
			if (state.mode !== "erase" && state.mode !== "trace") {
				return;
			}
			ev.preventDefault();
			var pt = imageCoords(ev.clientX, ev.clientY);
			if (state.mode === "erase") {
				pushUndo();
				erasedDuringStroke = true;
				painting = true;
				state.maskVisible = true;
				state.sliceUntouched = false;
				paintErase(pt.x, pt.y);
				return;
			}
			state.tracePoints.push(pt);
			draw();
			notifyTraceChange();
		});

		window.addEventListener("mousemove", function (ev) {
			if (!painting || state.mode !== "erase") {
				return;
			}
			var pt = imageCoords(ev.clientX, ev.clientY);
			paintErase(pt.x, pt.y);
		});

		window.addEventListener("mouseup", function () {
			if (painting && state.mode === "erase" && erasedDuringStroke) {
				pushUndo();
				var cleared = pruneOrphanKeepIslands();
				if (cleared > 0 && typeof opts.onOrphansPruned === "function") {
					opts.onOrphansPruned(cleared);
				}
			}
			painting = false;
			erasedDuringStroke = false;
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
		setMaskVisible: setMaskVisible,
		setSliceUntouched: setSliceUntouched,
		maskIsAllKeep: maskIsAllKeep,
		setMode: setMode,
		undo: undo,
		pushUndo: pushUndo,
		getTracePoints: function () {
			return state.tracePoints.slice();
		},
		getTracePointsForJson: function () {
			var pts = state.tracePoints;
			var out = [];
			for (var i = 0; i < pts.length; i++) {
				out.push([Math.round(pts[i].x), Math.round(pts[i].y)]);
			}
			return out;
		},
		clearTrace: function () {
			state.tracePoints = [];
			notifyTraceChange();
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
