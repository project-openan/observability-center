#!/usr/bin/env python3
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
# All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0
#
#    Licensed under the Apache License, Version 2.0 (the "License"); you may
#    not use this file except in compliance with the License. You may obtain
#    a copy of the License at
#
#         http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
#    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
#    License for the specific language governing permissions and limitations
#    under the License.

"""HTTP entry point for the observability workflow query service."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from .repository import WorkflowRepository
from .service import WorkflowQueryService

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8787"))


def create_handler(service):
    class ObservabilityHandler(BaseHTTPRequestHandler):
        def do_OPTIONS(self):
            self.send_response(204)
            self._send_cors_headers()
            self.end_headers()

        def do_GET(self):
            segments = self.path_segments()
            if segments == ["healthz"]:
                self.send_json(200, service.health())
            elif self.is_workflow_detail_path(segments):
                self.send_json_or_not_found(service.get_workflow(segments[4]))
            else:
                self.send_json(404, self.route_not_found())

        def do_POST(self):
            segments = self.path_segments()
            if segments == ["api", "v1", "observability", "workflows"]:
                self.send_json(200, service.list_workflows(self.read_json_body()))
            elif self.is_signal_path(segments):
                run_id, signal = segments[4], segments[5]
                method = getattr(service, f"get_{signal}")
                self.send_json_or_not_found(method(run_id, self.read_json_body()))
            else:
                self.send_json(404, self.route_not_found())

        def is_workflow_detail_path(self, segments):
            return len(segments) == 5 and segments[:4] == ["api", "v1", "observability", "workflows"]

        def is_signal_path(self, segments):
            return (
                len(segments) == 6
                and segments[:4] == ["api", "v1", "observability", "workflows"]
                and segments[5] in {"trace", "logs", "metrics"}
            )

        def path_segments(self):
            return [unquote(segment) for segment in urlparse(self.path).path.split("/") if segment]

        def read_json_body(self):
            length = int(self.headers.get("content-length", 0))
            return {} if length == 0 else json.loads(self.rfile.read(length))

        def send_json_or_not_found(self, body):
            if body is None:
                self.send_json(404, self.workflow_not_found())
            else:
                self.send_json(200, body)

        def send_json(self, status, body):
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(payload)

        def _send_cors_headers(self):
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")

        def route_not_found(self):
            return {"error": {"code": "NOT_FOUND", "message": "route not found"}}

        def workflow_not_found(self):
            return {"error": {"code": "NOT_FOUND", "message": "workflow not found"}}

        def log_message(self, format, *args):
            return

    return ObservabilityHandler


def main():
    repository = WorkflowRepository.from_environment()
    query_service = WorkflowQueryService(repository)
    server = ThreadingHTTPServer((HOST, PORT), create_handler(query_service))
    print(f"Observability query service listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
