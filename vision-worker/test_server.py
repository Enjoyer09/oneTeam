#!/usr/bin/env python3
"""
oneTeam — vision worker HTTP contract
======================================

Runs without a real model: `server._inference` is replaced with
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
    "sku": "unverified_bottle",
    "label": "Butulka — marka təsdiqlənməyib",
    "confidence": 0.91,
    "objectClass": "bottle",
    "box": {"x": 10, "y": 20, "width": 8, "height": 40},
    "color": "#F40009",
    "shelfRow": 1,
    "facingIndex": 1,
}


def stub_ok(image, conf=0.25, mode="coco", checkpoint=None):
    return {
        "success": True,
        "engine": "torchvision-detection",
        "model": "test-model",
        "detected_count": 1,
        "synthetic_fallback": False,
        "detections": [DETECTION],
        "received": {"image": image, "conf": conf, "mode": mode, "checkpoint": checkpoint},
    }


def stub_raises(image, conf=0.25, mode="disabled", checkpoint=None):
    raise RuntimeError("Import error: cv2")


def stub_disabled(image, conf=0.25, mode="disabled", checkpoint=None):
    return {"success": False, "error": "TorchVision detector is disabled pending an approved checkpoint."}


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
    server._load_model = None
    server._model_status = None
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def main():
    os.environ["ONETEAM_TORCHVISION_MODE"] = "coco"
    httpd, port = start_server(stub_ok)
    try:
        status, body = call(port, "/health")
        check("GET /health is 200 and ok", status == 200 and body.get("ok") is True, str(body))

        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA"})
        check(
            "POST /detect forwards the image and returns the worker payload",
            status == 200
            and body.get("success") is True
            and body["received"]["image"] == "data:image/jpeg;base64,AAAA"
            and body["detections"][0]["sku"] == "unverified_bottle",
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA", "conf": 0.5})
        check(
            "an optional conf threshold reaches the worker",
            status == 200 and body["received"]["conf"] == 0.5,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {"image": "https://internal.example/photo.jpg"})
        check(
            "remote URLs are rejected before inference",
            status == 400 and body.get("success") is False,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA", "conf": 0})
        check(
            "unsafe confidence override is rejected",
            status == 400 and body.get("success") is False,
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

        status, body = call(
            port,
            "/detect",
            {"image": "data:image/jpeg;base64,AAAA", "conf": 0.4},
        )
        check(
            "a data: URL body is accepted and forwarded as-is",
            status == 200
            and body["received"]["image"] == "data:image/jpeg;base64,AAAA"
            and body["received"]["conf"] == 0.4,
            json.dumps(body)[:300],
        )

        status, body = call(port, "/other", {"image": "data:image/jpeg;base64,AAAA"})
        check(
            "an unknown path is 404",
            status == 404,
            str(body)[:200],
        )

        status, body = call(port, "/health")
        check(
            "health reports the TorchVision backend and configured mode",
            status == 200 and body.get("backend") == "torchvision" and body.get("mode") == "coco",
            json.dumps(body)[:300],
        )
        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA"})
        check(
            "worker mode is selected by server configuration, not the request",
            status == 200 and body["received"].get("mode") == "coco",
            json.dumps(body)[:300],
        )

        # The confidence setting reaches inference when the request omits it.
        os.environ["ONETEAM_TORCHVISION_CONF"] = "0.55"
        try:
            status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA"})
            check(
                "inference uses ONETEAM_TORCHVISION_CONF when the payload has none",
                status == 200 and body["received"].get("conf") == 0.55,
                json.dumps(body)[:300],
            )
        finally:
            os.environ.pop("ONETEAM_TORCHVISION_CONF", None)

    finally:
        httpd.shutdown()
        httpd.server_close()
        os.environ.pop("ONETEAM_TORCHVISION_MODE", None)

    # The failure path: the worker raising must become JSON with the error text,
    # because the Node client reads `success:false` and turns it into
    # `worker-failed` — an uncaught exception would arrive as an empty 500 body
    # and lose the reason entirely.
    httpd, port = start_server(stub_raises)
    try:
        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA"})
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

    # The deployment default must remain unavailable until a reviewed model exists.
    os.environ["ONETEAM_TORCHVISION_MODE"] = "disabled"
    httpd, port = start_server(stub_disabled)
    try:
        status, body = call(port, "/detect", {"image": "data:image/jpeg;base64,AAAA"})
        check(
            "disabled mode returns 503 and never emits detections",
            status == 503 and body.get("success") is False and "disabled" in body.get("error", ""),
            json.dumps(body)[:300],
        )
    finally:
        httpd.shutdown()
        httpd.server_close()
        os.environ.pop("ONETEAM_TORCHVISION_MODE", None)

    # _worker_scripts_dir must find the TorchVision adapter from this layout.
    server._inference = None
    try:
        found = server._worker_scripts_dir()
        check(
            "the real worker script is discoverable from this layout",
            os.path.isfile(os.path.join(found, "torchvision_inference.py")),
            found,
        )
    except FileNotFoundError as error:
        check("the real worker script is discoverable from this layout", False, str(error))

    print(f"\n{passed + failed} checks: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
