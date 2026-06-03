"use strict";

var VALID_OPS = { rot90: true, flipX: true, flipY: true };

function defaultGeometry() {
	return { ops: [] };
}

/** Legacy {rotate, flipX, flipY} → ordered ops (matches py compose_ops decomposition). */
function legacyToOps(geom) {
	if (!geom) {
		return [];
	}
	if (geom.ops && Array.isArray(geom.ops)) {
		return geom.ops.slice();
	}
	var ops = [];
	var rot = ((Number(geom.rotate) || 0) % 360 + 360) % 360;
	if (rot === 90) {
		ops.push("rot90");
	} else if (rot === 180) {
		ops.push("rot90", "rot90");
	} else if (rot === 270) {
		ops.push("rot90", "rot90", "rot90");
	}
	if (geom.flipX) {
		ops.push("flipX");
	}
	if (geom.flipY) {
		ops.push("flipY");
	}
	return ops;
}

function normalizeGeometry(geom) {
	if (!geom) {
		return defaultGeometry();
	}
	if (geom.ops && Array.isArray(geom.ops)) {
		return { ops: geom.ops.slice() };
	}
	return { ops: legacyToOps(geom) };
}

function cloneGeometry(geom) {
	var g = normalizeGeometry(geom);
	return { ops: g.ops.slice() };
}

function identityAffine() {
	return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyAffine(left, right) {
	return {
		a: left.a * right.a + left.c * right.b,
		b: left.b * right.a + left.d * right.b,
		c: left.a * right.c + left.c * right.d,
		d: left.b * right.c + left.d * right.d,
		e: left.a * right.e + left.c * right.f + left.e,
		f: left.b * right.e + left.d * right.f + left.f,
	};
}

function affineForOp(op) {
	if (op === "rot90") {
		return { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
	}
	if (op === "flipX") {
		return { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	}
	if (op === "flipY") {
		return { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };
	}
	return identityAffine();
}

function applyOpsToAffine(ops) {
	var m = identityAffine();
	for (var i = 0; i < ops.length; i++) {
		m = multiplyAffine(m, affineForOp(ops[i]));
	}
	return m;
}

function applyOpsToDomMatrix(ops) {
	if (typeof DOMMatrix !== "undefined") {
		var m = new DOMMatrix();
		for (var i = 0; i < ops.length; i++) {
			var op = ops[i];
			if (op === "rot90") {
				m.rotateSelf(90);
			} else if (op === "flipX") {
				m.scaleSelf(-1, 1);
			} else if (op === "flipY") {
				m.scaleSelf(1, -1);
			}
		}
		return m;
	}
	return applyOpsToAffine(ops);
}

/** Preview transform: replay ops in click order (WYSIWYG with apply_geometry.py). */
function geometryCssTransform(geom) {
	var g = normalizeGeometry(geom);
	if (!g.ops.length) {
		return "";
	}
	var m = applyOpsToDomMatrix(g.ops);
	return (
		"matrix(" +
		m.a +
		", " +
		m.b +
		", " +
		m.c +
		", " +
		m.d +
		", " +
		m.e +
		", " +
		m.f +
		")"
	);
}

function geometryStatusText(geom) {
	var g = normalizeGeometry(geom);
	if (!g.ops.length) {
		return "identity";
	}
	return g.ops.join(" → ");
}

function isIdentityGeometry(geom) {
	return normalizeGeometry(geom).ops.length === 0;
}

function geometryHasPending(geom) {
	return !isIdentityGeometry(geom);
}

function countNonIdentityGeometry(geometryMap, sliceIds) {
	var n = 0;
	for (var i = 0; i < sliceIds.length; i++) {
		if (!isIdentityGeometry(geometryMap[sliceIds[i]])) {
			n += 1;
		}
	}
	return n;
}

function applyGeometryAction(geom, action) {
	if (!VALID_OPS[action]) {
		return normalizeGeometry(geom);
	}
	var g = normalizeGeometry(geom);
	var ops = g.ops.slice();
	ops.push(action);
	return { ops: ops };
}

function ensureGeometryMap(geometryMap, sliceIds) {
	var out = geometryMap || {};
	for (var i = 0; i < sliceIds.length; i++) {
		var sid = sliceIds[i];
		if (!out[sid]) {
			out[sid] = defaultGeometry();
		} else {
			out[sid] = normalizeGeometry(out[sid]);
		}
	}
	return out;
}

function resetGeometryMap(geometryMap, sliceIds) {
	var out = geometryMap || {};
	for (var i = 0; i < sliceIds.length; i++) {
		out[sliceIds[i]] = defaultGeometry();
	}
	return out;
}

function updateTileGeometryDom(grid, sliceId, geom) {
	if (!grid) {
		return;
	}
	var tile = grid.querySelector('[data-slice-id="' + sliceId + '"]');
	if (!tile) {
		return;
	}
	var viewport = tile.querySelector(".czi-orient-tile-viewport");
	if (viewport) {
		if (isIdentityGeometry(geom)) {
			viewport.style.transform = "";
		} else {
			viewport.style.transform = geometryCssTransform(geom);
			viewport.style.transformOrigin = "center center";
		}
	}
	var status = tile.querySelector("[data-geo-status]");
	if (status) {
		status.textContent = geometryStatusText(geom);
	}
}

function wireOrientationGridClicks(grid, getGeometryMap, onChange) {
	if (!grid || grid._mjOrientGeoWired) {
		return;
	}
	grid._mjOrientGeoWired = true;
	grid.addEventListener("click", function (ev) {
		var btn = ev.target.closest && ev.target.closest("button[data-geo]");
		if (!btn || !grid.contains(btn)) {
			return;
		}
		var sid = btn.getAttribute("data-slice");
		var action = btn.getAttribute("data-geo");
		var map = getGeometryMap();
		if (!map || !sid) {
			return;
		}
		map[sid] = applyGeometryAction(map[sid], action);
		updateTileGeometryDom(grid, sid, map[sid]);
		if (onChange) {
			onChange(sid, action);
		}
	});
}

function orientPreviewHintText(geometryAppliedAt, pendingCount) {
	if (pendingCount > 0) {
		return "CSS preview — not yet written to files.";
	}
	if (geometryAppliedAt) {
		return "Showing on-disk previews (geometry already applied).";
	}
	return "Showing on-disk previews.";
}

function orientPostApplySummaryText(geometryAppliedAt, filesTotal) {
	if (!geometryAppliedAt) {
		return "";
	}
	var when = geometryAppliedAt;
	try {
		when = new Date(geometryAppliedAt).toLocaleString();
	} catch (e) {
		/* keep ISO string */
	}
	var files =
		filesTotal != null && filesTotal !== "" ? String(filesTotal) : "?";
	return (
		"Last applied: " +
		when +
		" — " +
		files +
		" file(s). Tiles show saved orientation (no pending edits)."
	);
}

module.exports = {
	defaultGeometry: defaultGeometry,
	legacyToOps: legacyToOps,
	normalizeGeometry: normalizeGeometry,
	cloneGeometry: cloneGeometry,
	applyOpsToDomMatrix: applyOpsToDomMatrix,
	geometryCssTransform: geometryCssTransform,
	geometryStatusText: geometryStatusText,
	isIdentityGeometry: isIdentityGeometry,
	geometryHasPending: geometryHasPending,
	countNonIdentityGeometry: countNonIdentityGeometry,
	applyGeometryAction: applyGeometryAction,
	ensureGeometryMap: ensureGeometryMap,
	resetGeometryMap: resetGeometryMap,
	updateTileGeometryDom: updateTileGeometryDom,
	wireOrientationGridClicks: wireOrientationGridClicks,
	orientPreviewHintText: orientPreviewHintText,
	orientPostApplySummaryText: orientPostApplySummaryText,
};
