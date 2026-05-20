"use strict";

function defaultGeometry() {
	return { rotate: 0, flipX: false, flipY: false };
}

function geometryCssTransform(geom) {
	var rot = Number(geom && geom.rotate) || 0;
	var sx = geom && geom.flipX ? -1 : 1;
	var sy = geom && geom.flipY ? -1 : 1;
	return "rotate(" + rot + "deg) scaleX(" + sx + ") scaleY(" + sy + ")";
}

function isIdentityGeometry(geom) {
	if (!geom) {
		return true;
	}
	return (Number(geom.rotate) || 0) % 360 === 0 && !geom.flipX && !geom.flipY;
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
	var g = geom || defaultGeometry();
	if (action === "rot90") {
		g.rotate = ((Number(g.rotate) || 0) + 90) % 360;
	} else if (action === "flipX") {
		g.flipX = !g.flipX;
	} else if (action === "flipY") {
		g.flipY = !g.flipY;
	}
	return g;
}

function ensureGeometryMap(geometryMap, sliceIds) {
	var out = geometryMap || {};
	for (var i = 0; i < sliceIds.length; i++) {
		if (!out[sliceIds[i]]) {
			out[sliceIds[i]] = defaultGeometry();
		}
	}
	return out;
}

module.exports = {
	defaultGeometry: defaultGeometry,
	geometryCssTransform: geometryCssTransform,
	isIdentityGeometry: isIdentityGeometry,
	countNonIdentityGeometry: countNonIdentityGeometry,
	applyGeometryAction: applyGeometryAction,
	ensureGeometryMap: ensureGeometryMap,
};
