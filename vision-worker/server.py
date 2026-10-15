#!/usr/bin/env python3
"""
oneTeam — TorchVision inference over HTTP
==================================

WHY THIS EXISTS
---------------
`scripts/torchvision_inference.py` was reachable only by spawning a fresh Python
process per photo. That process pays for the interpreter, the torch and OpenCV
imports and the model load every single time: 47s cold, 3.3s warm, measured on
the machine this was written on. It ran under `spawnSync`, so the caller's event
loop was frozen for all of it — in the bot that is a Telegram handler that has
not answered for a minute.

This server imports the worker before the socket starts listening. A model is
loaded only when a reviewed mode/checkpoint is configured; otherwise the HTTP
service remains healthy and detections fail closed for human review.

It adds no inference logic of its own. `run_inference` is imported as-is and its
JSON contract is passed through untouched, so the Node client cannot tell the
difference between this and the spawned worker — which is the point: one
contract, two transports.

    GET  /health          -> {"ok": true, ...}
    POST /detect {"image": "data:image/...;base64,..."} -> worker JSON

Stdlib server, on purpose. FastAPI would add a framework, an ASGI runtime and a
second process manager to a service whose whole job is to hold one model in
memory and answer JSON.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Serialize inference through the shared model instance.
INFERENCE_LOCK = threading.Lock()
MAX_REQUEST_BYTES = 8 * 1024 * 1024

_inference = None
_load_model = None
_model_status = None


def configured_mode() -> str:
    return os.environ.get("ONETEAM_TORCHVISION_MODE", "disabled").lower()


def configured_checkpoint() -> str | None:
    return os.environ.get("ONETEAM_TORCHVISION_CHECKPOINT") or None


def _worker_scripts_dir() -> str:
    """Where `torchvision_inference.py` lives, in the repo and image."""
    here = os.path.dirname(os.path.abspath(__file__))
    # In the repository: <root>/vision-worker -> <root>/scripts
    # In the image:      /app/server.py        -> /app/scripts
    for candidate in (os.path.dirname(here), here):
        scripts = os.path.join(candidate, "scripts")
        if os.path.isfile(os.path.join(scripts, "torchvision_inference.py")):
            return scripts
    raise FileNotFoundError(
        "torchvision_inference.py not found next to this server or one level up. "
        f"Searched from {here}."
    )


def get_inference():
    """
    Import the worker once and retain its inference and model-cache functions.

    Startup separately loads the configured model before opening the socket.
    """
    global _inference, _load_model, _model_status
    if _inference is None:
        scripts = _worker_scripts_dir()
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import torchvision_inference  # pyright: ignore[reportMissingImports] -- resolved via sys.path above

        _inference = torchvision_inference.run_inference
        _load_model = torchvision_inference.load_model
        _model_status = torchvision_inference.model_status
    return _inference


def detect(image: str, conf: float = 0.25) -> dict:
    """Run one inference. Returns the worker's dict, never raises for a bad image."""
    with INFERENCE_LOCK:
        return get_inference()(
            image,
            conf,
            mode=configured_mode(),
            checkpoint=configured_checkpoint(),
        )


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
            status = (
                _model_status(configured_mode(), configured_checkpoint())
                if _model_status
                else None
            )
            self._send(
                {
                    "ok": True,
                    "service": "oneTeam-vision-worker",
                    "backend": "torchvision",
                    "mode": configured_mode(),
                    "model": status["model"] if status else None,
                    "ready": bool(status and status["loaded"]),
                    "torch_version": status["torch_version"] if status else None,
                    "torchvision_version": status["torchvision_version"] if status else None,
                    "classes": status["classes"] if status else None,
                    "checkpoint_sha256": status["checkpoint_sha256"] if status else None,
                    "class_map_version": status["class_map_version"] if status else None,
                    "dataset_source": status["dataset_source"] if status else None,
                    "dataset_license": status["dataset_license"] if status else None,
                    "production_approved": status["production_approved"] if status else False,
                    "checkpoint_error": status["checkpoint_error"] if status else None,
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
            if length > MAX_REQUEST_BYTES:
                self.close_connection = True
                self._send({"success": False, "error": "Image request is too large."}, 413)
                return
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
        # The HTTP worker only needs the bytes sent by the bot. Accepting a
        # caller-supplied URL here lets a public endpoint probe internal hosts.
        if not image.startswith("data:image/"):
            self._send({"success": False, "error": "Only inline image data is accepted."}, 400)
            return

        try:
            conf = float(payload.get("conf", os.environ.get("ONETEAM_TORCHVISION_CONF", 0.25)))
            if not 0.0 < conf <= 1.0:
                raise ValueError("Confidence threshold must be greater than 0 and at most 1.")
            result = detect(image, conf=conf)
        except ValueError as error:
            self._send({"success": False, "error": str(error)}, 400)
            return
        except Exception as error:  # the worker's own failures are JSON, not 500s
            self._send({"success": False, "error": f"{type(error).__name__}: {error}"}, 500)
            return

        if result.get("success") is not True:
            error = result.get("error", "Detector is not ready.")
            status = 503 if "disabled" in str(error).lower() or "checkpoint" in str(error).lower() else 422
            self._send(result, status)
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

    # Keep the API available when no approved weights are configured.
    print(
        json.dumps({"ts": "startup", "msg": "loading worker", "port": port}),
        flush=True,
    )
    get_inference()
    status = _model_status(configured_mode(), configured_checkpoint())
    if configured_mode() != "disabled":
        try:
            with INFERENCE_LOCK:
                _load_model(configured_mode(), configured_checkpoint())
            status = _model_status(configured_mode(), configured_checkpoint())
        except Exception as error:
            print(json.dumps({"ts": "startup", "msg": "model unavailable", "error": str(error)}), flush=True)
    print(json.dumps({
        "ts": "startup",
        "msg": "ready" if status["loaded"] else "degraded-no-model",
        "backend": "torchvision",
        "mode": configured_mode(),
        "model": status["model"],
    }), flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
