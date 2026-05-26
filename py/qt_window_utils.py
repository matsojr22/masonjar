"""Helpers to raise/activate top-level Qt windows so Mason Jar tools come to front.

Used by ``adjust.py`` (PyQt) and ``map.py`` (Napari / Qt) after ``show()``.

Behavior:

- Call ``show()`` if the widget is not yet visible.
- ``raise_()`` and ``activateWindow()`` immediately and again on a couple of
  deferred ``QTimer.singleShot`` ticks so focus runs after the parent event
  loop paints.
- On Windows, also try ``user32.SetForegroundWindow(hwnd)`` (best-effort;
  Windows blocks steal-focus when the user is typing elsewhere). All ctypes
  calls are wrapped in ``try/except`` so a missing import or refused call
  never breaks the tool launch.

No ``WindowStaysOnTopHint`` (intrusive).
"""

from __future__ import annotations

import sys
from typing import Any


def _safe_attempt(callable_obj, *args, **kwargs):
    try:
        callable_obj(*args, **kwargs)
    except Exception:
        pass


def _windows_foreground(widget) -> None:
    """Best-effort SetForegroundWindow for the given widget on Windows."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        hwnd = int(widget.winId())
        if hwnd == 0:
            return
        try:
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception:
            pass
    except Exception:
        # ctypes may be unavailable, or winId() invalid before show()
        pass


def _bring_to_front_now(widget) -> None:
    if widget is None:
        return
    try:
        if hasattr(widget, "isVisible") and not widget.isVisible():
            widget.show()
    except Exception:
        pass
    _safe_attempt(widget.raise_)
    _safe_attempt(widget.activateWindow)
    _windows_foreground(widget)


def raise_and_activate(widget: Any) -> None:
    """Show, raise, and request keyboard focus for a top-level Qt widget.

    Schedules two deferred retries (0 ms and 200 ms) via ``QTimer.singleShot``
    so focus is reapplied after the host event loop has painted the window.
    """
    if widget is None:
        return

    _bring_to_front_now(widget)

    try:
        from qtpy.QtCore import QTimer
    except Exception:
        return

    def _retry() -> None:
        _bring_to_front_now(widget)

    try:
        QTimer.singleShot(0, _retry)
        QTimer.singleShot(200, _retry)
    except Exception:
        pass


def raise_and_activate_napari(viewer: Any) -> None:
    """Resolve Napari viewer's underlying Qt window and call raise_and_activate.

    Napari's main window is ``viewer.window._qt_window`` (see ``map.py``
    ``update_section_header``). Falls back to ``viewer.window`` if needed.
    """
    if viewer is None:
        return
    qt_window = None
    try:
        win = getattr(viewer, "window", None)
        if win is not None:
            qt_window = getattr(win, "_qt_window", None) or win
    except Exception:
        qt_window = None
    if qt_window is None:
        return
    raise_and_activate(qt_window)
