#!/usr/bin/env python3
"""
oneTeam — YOLO inference over HTTP
==================================

WHY THIS EXISTS
---------------
`scripts/yolo_inference.py` was reachable only by spawning a fresh Python
process per photo. That process pays for the interpreter, the torch and OpenCV
imports and the model load every single time: 47s cold, 3.3s warm, measured on
the machine this was written on. It ran under `spawnSync`, so the caller's event
loop was frozen for all of it — in the bot that is a Telegram handler that has
not answered for a minute.

This server imports that worker once and serves it. The import happens before
the socket starts listening, so "the port is open" and "the model is loaded" are
the same statement, and a request never sees the cold start.

It adds no inference logic of its own. `run_inference` is imported as-is and its
JSON contract is passed through untouched, so the Node client cannot tell the
difference between this and the spawned worker — which is the point: one
contract, two transports.

    GET  /health          -> {"ok": true, ...}
    POST /detect {"image": "<path or URL>"} -> the worker's own JSON

Stdlib server, on purpose. FastAPI would add a framework, an ASGI runtime and a
second process manager to a service whose whole job is to hold one model in
memory and answer JSON.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Torch is not safe to load from two threads at once, and `run_inference`
# constructs the model on every call — one at a time keeps the cache warm instead
# of racing it.
INFERENCE_LOCK = threading.Lock()

_inference = None


def _worker_scripts_dir() -> str:
    """Where `yolo_inference.py` lives, in the repo and inside the image."""
    here = os.path.dirname(os.path.abspath(__file__))
    # In the repository: <root>/vision-worker -> <root>/scripts
    # In the image:      /app/server.py        -> /app/scripts
    for candidate in (os.path.dirname(here), here):
        scripts = os.path.join(candidate, "scripts")
        if os.path.isfile(os.path.join(scripts, "yolo_inference.py")):
            return scripts
    raise FileNotFoundError(
        "yolo_inference.py not found next to this server or one level up. "
        f"Searched from {here}."
    )


def get_inference():
    """
    Import the worker once and cache the function.

    The expensive part is the import, not the call — that is where cv2 and
    ultralytics are loaded — so warming this at startup is what makes the first
    request cost what every later request costs.
    """
    global _inference
    if _inference is None:
        scripts = _worker_scripts_dir()
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import yolo_inference  # pyright: ignore[reportMissingImports] -- resolved via sys.path above

        _inference = yolo_inference.run_inference
    return _inference


def detect(image: str, model: str | None = None, conf: float = 0.25) -> dict:
    """Run one inference. Returns the worker's dict, never raises for a bad image."""
    if model is None:
        # Same knob /health reports: env default, payload override, then the
        # stock weights.
        model = os.environ.get("ONETEAM_YOLO_MODEL", "yolo11n.pt")
    with INFERENCE_LOCK:
        return get_inference()(image, model, conf)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server naming)
        if self.path.rstrip("/") in ("", "/health"):
            self._send(
                {
                    "ok": True,
                    "service": "oneTeam-vision-worker",
                    "model": os.environ.get("ONETEAM_YOLO_MODEL", "yolo11n.pt"),
                    # True once the worker module has been imported. The socket
                    # only opens after that, so this is a belt-and-braces signal
                    # for a probe that arrives during a restart.
                    "ready": _inference is not None,
                }
            )
            return
        self._send({"success": False, "error": f"Unknown path: {self.path}"}, 404)

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/detect":
            self._send({"success": False, "error": f"Unknown path: {self.path}"}, 404)
            return

        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError) as error:
            self._send({"success": False, "error": f"Invalid JSON body: {error}"}, 400)
            return

        image = payload.get("image")
        if not isinstance(image, str) or not image.strip():
            self._send(
                {"success": False, "error": 'A non-empty "image" field is required.'},
                400,
            )
            return

        try:
            result = detect(
                image,
                model=(str(payload["model"]) if payload.get("model") else None),
                conf=float(payload.get("conf", os.environ.get("ONETEAM_YOLO_CONF", 0.25))),
            )
        except Exception as error:  # the worker's own failures are JSON, not 500s
            self._send({"success": False, "error": f"{type(error).__name__}: {error}"}, 500)
            return

        self._send(result, 200)

    def log_message(self, format, *args):  # keep the access log one line per request
        sys.stdout.write(
            json.dumps(
                {
                    "ts": self.log_date_time_string(),
                    "msg": format % args,
                    "peer": self.client_address[0] if self.client_address else None,
                }
            )
            + "\n"
        )
        sys.stdout.flush()


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))

    # Warm before listening: a probe that succeeds is a model that is loaded.
    print(
        json.dumps({"ts": "startup", "msg": "loading worker", "port": port}),
        flush=True,
    )
    get_inference()
    print(json.dumps({"ts": "startup", "msg": "ready"}), flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
