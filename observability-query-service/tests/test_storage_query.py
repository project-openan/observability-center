# Copyright (c) 2026 Huawei Technologies Co., Ltd.
# All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from observability_query_service.repository import SourceUnavailable, WorkflowRepository
from observability_query_service.service import WorkflowQueryService


class StorageQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "run-1.json").write_text(json.dumps({
            "runId": "run-1", "workflowId": "unknown", "success": True,
            "serviceName": "complaint-waimo", "history": []
        }), encoding="utf-8")
        self.repo = WorkflowRepository(self.root, "http://prom", "http://jaeger", "http://search", "logs", 1000)

    def test_trace_id_requires_exact_log_match_and_no_nearest_trace_guess(self):
        requests = []
        def request(url, body=None):
            requests.append((url, body))
            return {"hits": {"hits": []}}
        with patch.object(self.repo, "_request_json", side_effect=request):
            task = self.repo.find("run-1")
        self.assertEqual(task["traceId"], "")
        self.assertFalse(any("trace-summaries" in url for url, _ in requests))
        self.assertIn({"term": {"attributes.run_id": "run-1"}}, requests[0][1]["query"]["bool"]["should"])

    def test_signals_query_three_backends(self):
        task = {"runId": "run-1", "workflowId": "w", "traceId": "abc", "spanCount": 1,
                "startedAt": "2026-11-28T00:00:00Z", "durationMs": 1000, "metricServiceNames": ["complaint-waimo"]}
        def request(url, body=None):
            if "/api/v3/traces/" in url:
                return {"result": {"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": "1"}]}]}]}}
            if "/_search" in url:
                return {"hits": {"total": {"value": 1}, "hits": [{"_source": {"body": "ok"}}]}}
            return {"status": "success", "data": {"result": [{"values": [[1, "2"]]}]}}
        with patch.object(self.repo, "_request_json", side_effect=request):
            self.assertEqual(self.repo.trace(task, {})["sourceStatus"]["trace"]["status"], "ready")
            self.assertEqual(self.repo.logs(task, {})["items"][0]["body"]["stringValue"], "ok")
            metrics = self.repo.metrics(task, {"metric": "workflowCount"})
            self.assertEqual(metrics["collection"]["scope"], "service")
            self.assertTrue(metrics["partial"])

    def test_unavailable_source_is_reported(self):
        with patch.object(self.repo, "_trace_id_for_run", return_value="abc"), \
             patch.object(self.repo, "_request_json", side_effect=SourceUnavailable("offline")):
            result = WorkflowQueryService(self.repo).get_trace("run-1", {})
        self.assertTrue(result["partial"])
        self.assertEqual(result["sourceStatus"]["trace"]["status"], "unavailable")

    def test_detail_reports_actual_health_and_missing_psop(self):
        with patch.object(self.repo, "_trace_id_for_run", return_value=""), \
             patch.object(self.repo, "health", return_value={"trace": "unavailable", "log": "ready", "metric": "ready"}):
            result = WorkflowQueryService(self.repo).get_workflow("run-1")
        self.assertIsNone(result["psop"])
        self.assertTrue(result["partial"])
        self.assertEqual(result["sourceStatus"]["trace"]["status"], "unavailable")

    def test_prometheus_error_is_not_treated_as_empty(self):
        with patch.object(self.repo, "_request_json", return_value={"status": "error", "error": "bad query"}):
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc)
            with self.assertRaises(SourceUnavailable):
                self.repo._prom_query_range("x", now, now, 15)


if __name__ == "__main__":
    unittest.main()
