var ipc = require("electron").ipcRenderer;

var log = document.getElementById("log");

/** Max (br+span) pairs kept in the log DOM to bound renderer memory. */
var MAX_LOG_LINES = 8000;

/** Do not persist more than this many characters to localStorage. */
var MAX_LOG_STORAGE_CHARS = 400000;

function appendLogChunk(text) {
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var br = document.createElement("br");
    var span = document.createElement("span");
    span.textContent = lines[i];
    log.appendChild(br);
    log.appendChild(span);
  }
  trimLogDom();
  window.scrollTo(0, document.body.scrollHeight);
}

function trimLogDom() {
  var maxNodes = MAX_LOG_LINES * 2;
  while (log.childNodes.length > maxNodes) {
    log.removeChild(log.firstChild);
    log.removeChild(log.firstChild);
  }
}

function cacheLog() {
  var el = document.getElementById("log");
  var logText = el.innerHTML;
  if (logText.length > MAX_LOG_STORAGE_CHARS) {
    logText = logText.slice(logText.length - MAX_LOG_STORAGE_CHARS);
  }
  localStorage.setItem("log", logText);
}

function loadLog() {
  var el = document.getElementById("log");
  var logText = localStorage.getItem("log");
  el.innerHTML = logText || "";
  trimLogDom();
}

function clearCache() {
  localStorage.removeItem("log");
}

function checkLogExpiry() {
  var expiry = new Date();
  expiry.setDate(expiry.getDate() - 1);
  var expiryTime = expiry.getTime();
  var logTimeRaw = localStorage.getItem("logTime");
  if (logTimeRaw == null) {
    cacheLogTime();
    clearCache();
    loadLog();
    return;
  }
  var logTime = Number(logTimeRaw);
  if (logTime < expiryTime) {
    clearCache();
  } else {
    loadLog();
  }
}

function cacheLogTime() {
  var logTime = new Date().getTime();
  localStorage.setItem("logTime", String(logTime));
}

window.onload = function () {
  checkLogExpiry();
};

ipc.on("savelogs", function (event, response) {
  cacheLog();
  cacheLogTime();
});

ipc.on("log", function (event, response) {
  console.log(response);
  appendLogChunk(response);
});
