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

"""Read demo run reports and query the observability storage services."""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class SourceUnavailable(RuntimeError):
    """A configured storage source did not answer a query."""


class WorkflowRepository:
    """Repository backed by demo run reports and the three storage services."""

    METRICS = {
        "workflowCount": "gen_ai_agent_a2at_workflow_count_total",
        "workflowDurationCount": "gen_ai_agent_a2at_workflow_duration_milliseconds_count",
        "workflowDurationSum": "gen_ai_agent_a2at_workflow_duration_milliseconds_sum",
        "workflowDurationBuckets": "gen_ai_agent_a2at_workflow_duration_milliseconds_bucket",
        "taskDurationCount": "gen_ai_agent_a2at_task_duration_milliseconds_count",
        "taskDurationSum": "gen_ai_agent_a2at_task_duration_milliseconds_sum",
        "taskDurationBuckets": "gen_ai_agent_a2at_task_duration_milliseconds_bucket",
        "stepDurationCount": "gen_ai_agent_a2at_step_duration_milliseconds_count",
        "stepDurationSum": "gen_ai_agent_a2at_step_duration_milliseconds_sum",
        "stepDurationBuckets": "gen_ai_agent_a2at_step_duration_milliseconds_bucket",
        "substepDurationCount": "gen_ai_agent_a2at_substep_duration_milliseconds_count",
        "substepDurationSum": "gen_ai_agent_a2at_substep_duration_milliseconds_sum",
        "substepDurationBuckets": "gen_ai_agent_a2at_substep_duration_milliseconds_bucket",
        "authorizationCount": "gen_ai_agent_a2at_authorization_preauthorize_count_total",
        "authorizationDurationCount": "gen_ai_agent_a2at_authorization_preauthorize_duration_milliseconds_count",
        "authorizationDurationSum": "gen_ai_agent_a2at_authorization_preauthorize_duration_milliseconds_sum",
        "authorizationDurationBuckets": "gen_ai_agent_a2at_authorization_preauthorize_duration_milliseconds_bucket",
        "notificationCount": "gen_ai_agent_a2at_notification_count_total",
        "negotiationCount": "gen_ai_agent_a2at_negotiation_count_total",
        "negotiationRoundsCount": "gen_ai_agent_a2at_negotiation_rounds_count",
        "negotiationRoundsSum": "gen_ai_agent_a2at_negotiation_rounds_sum",
        "negotiationRoundsBuckets": "gen_ai_agent_a2at_negotiation_rounds_bucket",
        "clientOperationDurationCount": "gen_ai_client_operation_duration_seconds_count",
        "clientOperationDurationSum": "gen_ai_client_operation_duration_seconds_sum",
        "clientOperationDurationBuckets": "gen_ai_client_operation_duration_seconds_bucket",
    }

    def __init__(self, artifact_dir, prometheus_url, jaeger_url, opensearch_url,
                 opensearch_index, timeout_ms):
        self.artifact_dir = Path(artifact_dir)
        self.prometheus_url = prometheus_url.rstrip("/")
        self.jaeger_url = jaeger_url.rstrip("/")
        self.opensearch_url = opensearch_url.rstrip("/")
        self.opensearch_index = opensearch_index
        self.timeout = max(int(timeout_ms), 1) / 1000

    @classmethod
    def from_environment(cls):
        root = Path(__file__).resolve().parents[2]
        return cls(
            os.environ.get("OBS_ARTIFACT_DIR", root / "complaint-observability-demo" / "artifacts"),
            os.environ.get("OBS_PROMETHEUS_URL", "http://127.0.0.1:19090"),
            os.environ.get("OBS_JAEGER_URL", "http://127.0.0.1:16686"),
            os.environ.get("OBS_OPENSEARCH_URL", "http://127.0.0.1:19200"),
            os.environ.get("OBS_OPENSEARCH_INDEX", "a2at-logs-v2"),
            os.environ.get("OBS_QUERY_TIMEOUT_MS", "5000"),
        )

    def health(self):
        return {"trace": self._check(self.jaeger_url + "/api/v3/services"),
                "metric": self._check(self.prometheus_url + "/api/v1/status/buildinfo"),
                "log": self._check(self.opensearch_url + "/_cluster/health")}

    def tasks(self):
        if not self.artifact_dir.is_dir():
            return []
        tasks = []
        for path in self.artifact_dir.glob("*.json"):
            if path.name.endswith(".storage.json") or ".role-" in path.name:
                continue
            try:
                report = self._read_json(path)
                if "runId" in report and "history" in report:
                    tasks.append(self._task_from_report(report, path))
            except (OSError, ValueError, TypeError):
                continue
        return tasks

    def find(self, run_id):
        return next((task for task in self.tasks() if task["runId"] == run_id), None)

    def trace(self, task, options):
        trace_id = task.get("traceId")
        if not trace_id:
            return {"resourceSpans": [], "partial": True,
                    "sourceStatus": {"trace": {"status": "empty"}}}
        payload = self._request_json(self.jaeger_url + "/api/v3/traces/" + trace_id)
        resource_spans = payload.get("result", {}).get("resourceSpans", [])
        if options.get("spanId"):
            resource_spans = self._filter_resource_spans(resource_spans, options["spanId"])
        status = "ready" if resource_spans else "empty"
        return {"resourceSpans": resource_spans, "partial": False,
                "sourceStatus": {"trace": {"status": status}}}

    def logs(self, task, query):
        clauses = [{"term": {"attributes.run_id.keyword": task["runId"]}},
                   {"term": {"attributes.run_id": task["runId"]}}]
        filters = []
        if query.get("severity"):
            filters.append({"term": {"severityText.keyword": query["severity"]}})
        if query.get("spanId"):
            filters.append({"term": {"spanId": query["spanId"]}})
        if query.get("keyword"):
            filters.append({"match": {"body": query["keyword"]}})
        limit = min(max(int(query.get("limit", 50)), 1), 200)
        body = {"size": limit, "sort": [{"observedTimestamp": {"order": "asc", "unmapped_type": "date"}}],
                "query": {"bool": {"minimum_should_match": 1, "should": clauses,
                                    "filter": filters}}}
        payload = self._request_json(self.opensearch_url + "/" + self.opensearch_index + "/_search", body)
        hits = payload.get("hits", {})
        total = hits.get("total", 0)
        if isinstance(total, dict):
            total = total.get("value", 0)
        return {"items": [self._log_record(hit.get("_source", {})) for hit in hits.get("hits", [])],
                "nextCursor": None, "total": total, "partial": False,
                "sourceStatus": {"log": {"status": "ready" if total else "empty"}}}

    def metrics(self, task, query):
        start, end = self._metric_window(task, query)
        services = "|".join(task["metricServiceNames"])
        labels = 'service_name=~"%s"' % services
        signals = []
        requested = query.get("metric")
        for key, metric in self.METRICS.items():
            if requested and requested != key and requested != metric:
                continue
            result = self._prom_query_range(metric + "{" + labels + "}", start, end, query.get("step", "15s"))
            signals.append({"name": key, "metric": metric,
                            "unit": ("s" if metric.endswith(("_seconds_count", "_seconds_sum", "_seconds_bucket")) and key.endswith("Sum") else "ms" if "DurationSum" in key else "count"), "series": result})
        has_metric = any(signal["series"] for signal in signals)
        return {"runId": task["runId"], "workflowId": task["workflowId"],
                "collection": {"from": start.isoformat(), "to": end.isoformat(),
                               "scope": "service", "serviceNames": task["metricServiceNames"]},
                "summary": {"workflowCount": self._last_value(signals, "workflowCount"),
                            "workflowDuration": {"avg": self._ratio(signals, "workflowDurationSum", "workflowDurationCount"),
                                                 "p95": None, "unit": "ms"},
                            "spanCount": task["spanCount"]},
                "signals": signals, "charts": None, "partial": True,
                "sourceStatus": {"metric": {"status": "ready" if has_metric else "empty"}}}

    def _task_from_report(self, report, path):
        storage = self._storage_report(path)
        summaries = ((storage.get("trace") or {}).get("response") or {}).get("summaries") or []
        verification = ((storage.get("trace") or {}).get("verification") or {})
        trace_id = (verification.get("traceIds") or [None])[0] or self._trace_id_for_run(report["runId"])
        trace = next((item for item in summaries if item.get("traceId") == trace_id), {})
        metric_results = ((((storage.get("metric") or {}).get("response") or {}).get("data") or {}).get("result") or [])
        metric_service_name = ((metric_results[0].get("metric") or {}).get("service_name") if metric_results else None)
        start_ns, end_ns = int(trace.get("minStartTimeUnixNano", "0")), int(trace.get("maxEndTimeUnixNano", "0"))
        started_at = datetime.fromtimestamp(start_ns / 1_000_000_000, timezone.utc) if start_ns else datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        duration_ms = max((end_ns - start_ns) // 1_000_000, 0)
        workflow_id = report.get("workflowId", report["runId"])
        psop = self._find_psop(workflow_id)
        return {"runId": report["runId"], "workflowId": workflow_id, "psop": psop,
                "workflowType": ((report.get("events") or [{}])[0].get("data") or {}).get("workflow", ""),
                "name": report.get("case", "workflow"), "status": "success" if report.get("success") else "error",
                "startedAt": started_at.isoformat().replace("+00:00", "Z"), "durationMs": duration_ms,
                "traceId": trace_id or "", "spanCount": trace.get("spanCount", 0),
                "serviceName": report.get("serviceName", "complaint-waimo"),
                "metricServiceNames": self._metric_service_names(report, path, metric_service_name),
                "steps": [{"name": item.get("task", ""), "owner": item.get("agent", ""), "status": item.get("status", "")} for item in report.get("history", [])]}

    @staticmethod
    def _find_psop(workflow_id):
        scenario_dir = Path(__file__).resolve().parents[2] / "complaint-observability-demo" / "src" / "main" / "resources" / "scenario"
        for path in scenario_dir.glob("*.json"):
            try:
                psop = WorkflowRepository._read_json(path)
                if psop.get("id") == workflow_id:
                    return psop
            except (OSError, ValueError, TypeError, AttributeError):
                continue
        return None

    def _storage_report(self, report_path):
        storage_path = report_path.with_name(report_path.stem + ".storage.json")
        return self._read_json(storage_path) if storage_path.exists() else {}

    def _metric_service_names(self, report, report_path, storage_service_name):
        services = [storage_service_name or report.get("serviceName", "complaint-waimo")]
        run_id = report["runId"]
        for role_path in report_path.parent.glob(run_id + ".*.json"):
            try:
                service_name = self._read_json(role_path).get("serviceName")
                if service_name and service_name not in services:
                    services.append(service_name)
            except (OSError, ValueError, TypeError):
                continue
        return services

    def _trace_id_for_run(self, run_id):
        body = {"size": 1, "sort": [{"observedTimestamp": {"order": "asc", "unmapped_type": "date"}}],
                "_source": ["traceId"],
                "query": {"bool": {"minimum_should_match": 1, "should": [
                    {"term": {"attributes.run_id.keyword": run_id}},
                    {"term": {"attributes.run_id": run_id}},
                ]}}}
        try:
            hits = self._request_json(self.opensearch_url + "/" + self.opensearch_index + "/_search", body)
            sources = hits.get("hits", {}).get("hits", [])
            return (sources[0].get("_source") or {}).get("traceId", "") if sources else ""
        except SourceUnavailable:
            return ""

    def _metric_window(self, task, query):
        start = datetime.fromisoformat(task["startedAt"].replace("Z", "+00:00"))
        end = start + timedelta(milliseconds=max(task["durationMs"], 1_000))
        if query.get("windowMin"):
            end = start + timedelta(minutes=min(max(int(query["windowMin"]), 1), 60))
        return start, end

    def _prom_query_range(self, expression, start, end, step):
        params = urlencode({"query": expression, "start": start.isoformat(), "end": end.isoformat(), "step": step})
        payload = self._request_json(self.prometheus_url + "/api/v1/query_range?" + params)
        if payload.get("status") != "success":
            raise SourceUnavailable("Prometheus query failed: " + str(payload.get("error", "unknown error")))
        return payload.get("data", {}).get("result", [])

    def _request_json(self, url, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(url, data=data, headers={"content-type": "application/json"} if data else {})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, OSError, ValueError) as error:
            raise SourceUnavailable(str(error)) from error

    def _check(self, url):
        try:
            self._request_json(url)
            return "ready"
        except SourceUnavailable:
            return "unavailable"

    @staticmethod
    def _read_json(path):
        with path.open(encoding="utf-8") as file:
            return json.load(file)

    @staticmethod
    def _filter_resource_spans(resource_spans, span_id):
        filtered = []
        for resource_span in resource_spans:
            scopes = []
            for scope in resource_span.get("scopeSpans", []):
                spans = [span for span in scope.get("spans", []) if span.get("spanId") == span_id]
                if spans:
                    scopes.append({**scope, "spans": spans})
            if scopes:
                filtered.append({**resource_span, "scopeSpans": scopes})
        return filtered

    @staticmethod
    def _log_record(source):
        attributes = source.get("attributes") if isinstance(source.get("attributes"), dict) else {}
        return {"timeUnixNano": source.get("timeUnixNano", "0"), "observedTimestampUnixNano": source.get("observedTimestampUnixNano", "0"),
                "severityText": source.get("severityText", ""), "severityNumber": source.get("severityNumber", 0),
                "body": {"stringValue": source.get("body", "")},
                "attributes": [{"key": key, "value": {"stringValue": str(value)}} for key, value in attributes.items()],
                "traceId": source.get("traceId", ""), "spanId": source.get("spanId", "")}

    @staticmethod
    def _last_value(signals, name):
        signal = next((item for item in signals if item["name"] == name), None)
        if not signal or not signal["series"]:
            return None
        values = signal["series"][0].get("values", [])
        return float(values[-1][1]) if values else None

    @classmethod
    def _ratio(cls, signals, numerator, denominator):
        top = cls._last_value(signals, numerator)
        bottom = cls._last_value(signals, denominator)
        return top / bottom if top is not None and bottom else None
