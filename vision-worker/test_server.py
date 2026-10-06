#!/usr/bin/env python3
"""
oneTeam — vision worker HTTP contract
======================================

Runs without torch, ultralytics or a model: `server._inference` is replaced with
a stub before anything is imported, so this checks routing, status codes and the
JSON the Node client parses — the parts that break when someone edits the
handler. It deliberately does NOT check detection quality, which needs a real
model and a real shelf.

    .venv/bin/python vision-worker/test_server.py
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402

passed = 0
failed = 0


def check(label, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ [PASS] {label}")
    else:
        failed += 1
        print(f"  ❌ [FAIL] {label}")
        if detail:
            print(f"         {detail}")


DETECTION = {
    "id": "det-1",
    "sku": "coca_cola_classic",
    "label": "Coca-Cola Classic 0.5L",
    "confidence": 0.91,
    "box": {"x": 10, "y": 20, "width": 8, "height": 40},
    "color": "#F40009",
    "shelfRow": 1,
    "facingIndex": 1,
}


def stub_ok(image, model="yolov8n.pt", conf=0.25):
    return {
        "success": True,
        "engine": "ultralytics-yolo",
        "model": model,
        "detected_count": 1,
        "synthetic_fallback": False,
        "detections": [DETECTION],
        "received": {"image": image, "conf": conf},
    }


def stub_raises(image, model="yolov8n.pt", conf=0.25):
    raise RuntimeError("Import error: cv2")


def call(port, path, body=None, method=None) -> tuple[int, dict]:
    url = f"http://127.0.0.1:{port}{path}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    # `body is not None`, not truthiness: an empty `{}` is still a POST with a
    # body, and defaulting it to GET would test nothing but the helper itself.
    req = urllib.request.Request(url, data=data, method=method or ("POST" if body is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw}


def start_server(inference):
    server._inference = inference
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def main():
    httpd, port = start_server(stub_ok)
    try:
        status, body = call(port, "/health")
        check("GET /health is 200 and ok", status == 200 and body.get("ok") is True, str(body))

        status, body = call(port, "/detect", {"image": "https://cdn.test/shelf.jpg"})
        check(
            "POST /detect forwards the image and returns the worker payload",
            status == 200
            and body.get("success") is True
            and body["received"]["image"] == "https://cdn.test/shelf.jpg"
            and body["detections"][0]["sku"] == "coca_cola_classic",
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {"image": "x", "conf": 0.5})
        check(
            "an optional conf threshold reaches the worker",
            status == 200 and body["received"]["conf"] == 0.5,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {})
        check(
            "a body with no image is 400 with success:false",
            status == 400 and body.get("success") is False,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {"image": "   "})
        check(
            "a blank image is rejected rather than inferred on",
            status == 400 and body.get("success") is False,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", method="POST")
        check(
            "an empty body is a 400, not a traceback",
            status == 400 and body.get("success") is False,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/other", {"image": "x"})
        check(
            "an unknown path is 404",
            status == 404,
            str(body)[:200],
        )
    finally:
        httpd.shutdown()
        httpd.server_close()

    # The failure path: the worker raising must become JSON with the error text,
    # because the Node client reads `success:false` and turns it into
    # `worker-failed` — an uncaught exception would arrive as an empty 500 body
    # and lose the reason entirely.
    httpd, port = start_server(stub_raises)
    try:
        status, body = call(port, "/detect", {"image": "x"})
        check(
            "a worker exception is 500 with success:false and the message",
            status == 500
            and body.get("success") is False
            and "Import error: cv2" in body.get("error", ""),
            json.dumps(body)[:300],
        )
    finally:
        httpd.shutdown()
        httpd.server_close()

    # _worker_scripts_dir must find the real worker from wherever this file sits.
    server._inference = None
    try:
        found = server._worker_scripts_dir()
        check(
            "the real worker script is discoverable from this layout",
            os.path.isfile(os.path.join(found, "yolo_inference.py")),
            found,
        )
    except FileNotFoundError as error:
        check("the real worker script is discoverable from this layout", False, str(error))

    print(f"\n{passed + failed} checks: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
