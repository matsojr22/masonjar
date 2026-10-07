"""Refuse ~/.masonjar/benv Python unless the parent process is Mason Jar."""

from __future__ import annotations

import os
import sys


def access_allowed(ancestor_paths, electron_prefixes=None, runtime_key=None) -> bool:
    """Allow masonjar.exe, or electron.exe only under an embedded checkout prefix.

    runtime_key is ignored. Copying a key does not admit another executable.
    """
    del runtime_key
    prefixes = []
    for prefix in electron_prefixes or []:
        if not prefix:
            continue
        prefixes.append(os.path.normcase(os.path.normpath(prefix)))
    for raw in ancestor_paths or []:
        if not raw:
            continue
        base = os.path.basename(str(raw)).lower()
        if base in ("masonjar.exe", "masonjar"):
            return True
        if base in ("electron.exe", "electron"):
            full = os.path.normcase(os.path.normpath(str(raw)))
            for prefix in prefixes:
                if full == prefix or full.startswith(prefix + os.sep):
                    return True
    return False


def _windows_ancestor_paths() -> list[str]:
    import ctypes
    from ctypes import wintypes

    TH32CS_SNAPPROCESS = 0x00000002
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == ctypes.c_void_p(-1).value or snapshot == -1:
        return []
    parents: dict[int, int] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
        while ok:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            ok = kernel32.Process32NextW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(snapshot))

    def image(pid: int) -> str:
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(32768)
            size = wintypes.DWORD(32768)
            if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return ""
            return buf.value
        finally:
            kernel32.CloseHandle(handle)

    paths: list[str] = []
    pid = os.getpid()
    seen: set[int] = set()
    for _ in range(12):
        parent = parents.get(pid)
        if not parent or parent in seen or parent == pid:
            break
        seen.add(parent)
        full = image(parent)
        if full:
            paths.append(full)
        pid = parent
    return paths


def ancestor_exe_paths() -> list[str]:
    if sys.platform == "win32":
        return _windows_ancestor_paths()
    paths: list[str] = []
    pid = os.getpid()
    seen: set[int] = set()
    for _ in range(12):
        proc = "/proc/{0}".format(pid)
        stat_path = os.path.join(proc, "stat")
        if not os.path.exists(stat_path):
            break
        try:
            with open(stat_path, "r", encoding="utf-8", errors="replace") as handle:
                stat = handle.read()
            end = stat.rfind(")")
            parent = int(stat[end + 1 :].split()[1])
        except (OSError, ValueError, IndexError):
            break
        if parent in seen or parent == pid:
            break
        seen.add(parent)
        exe = os.path.join("/proc", str(parent), "exe")
        try:
            paths.append(os.path.realpath(exe))
        except OSError:
            pass
        pid = parent
    return paths


def enforce_or_exit(electron_prefixes=None) -> None:
    try:
        paths = ancestor_exe_paths()
    except Exception:
        return
    if not paths:
        return
    if access_allowed(paths, electron_prefixes):
        return
    sys.stderr.write(
        "This Python environment belongs to Mason Jar. "
        "PFA Jar has to use its own home directory and its own venv.\n"
    )
    raise SystemExit(1)
