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

"""Application service for workflow observability queries."""

from .repository import SourceUnavailable


class WorkflowQueryService:
    def __init__(self, repository):
        self.repository = repository
    def health(self):
        statuses = self.repository.health()
        return {"status": "ready" if all(value == "ready" for value in statuses.values()) else "degraded",
                "sources": self.source_status(statuses)}

    def list_workflows(self, query):
        tasks = self.repository.tasks()
        if query.get("from"):
            tasks = [task for task in tasks if task["startedAt"] >= query["from"]]
        if query.get("to"):
            tasks = [task for task in tasks if task["startedAt"] <= query["to"]]
        if query.get("status") and query["status"] != "all":
            tasks = [task for task in tasks if task["status"] == query["status"]]
        if query.get("workflowType"):
            tasks = [task for task in tasks if task["workflowType"] == query["workflowType"]]
        if query.get("keyword"):
            keyword = query["keyword"].lower()
            tasks = [
                task
                for task in tasks
                if keyword in str(task).lower()
            ]

        tasks = self.sort_workflows(tasks, query)
        limit = min(max(int(query.get("limit", 20)), 1), 100)
        aggregates = self.aggregates(tasks)
        facets = self.workflow_type_facets(tasks)
        cursor = query.get("cursor")
        if cursor:
            position = next((index for index, task in enumerate(tasks) if task["runId"] == cursor), None)
            tasks = tasks[position + 1:] if position is not None else []
        page = tasks[:limit]
        statuses = self.repository.health()
        return {
            "items": [self.summary(task) for task in page],
            "nextCursor": None if len(tasks) <= limit else page[-1]["runId"],
            "aggregates": aggregates,
            "facets": {"workflowTypes": facets},
            "meta": {
                "dataset": "demo-runtime-reports",
                "source": "demo-runtime",
                "generatedAt": None,
            },
            "partial": any(status != "ready" for status in statuses.values()),
            "sourceStatus": self.source_status(statuses),
        }

    def sort_workflows(self, tasks, query):
        sort = query.get("sort", "startedAt")
        reverse = query.get("order", "desc") == "desc"
        if sort == "durationMs":
            return sorted(tasks, key=lambda task: task["durationMs"], reverse=reverse)
        return sorted(tasks, key=lambda task: task["startedAt"], reverse=reverse)

    def get_workflow(self, run_id):
        task = self.repository.find(run_id)
        if task is None:
            return None
        statuses = self.repository.health()
        return {**self.summary(task), "psop": self.psop(task), "partial": not task.get("psop") or any(status != "ready" for status in statuses.values()),
                "sourceStatus": self.source_status(statuses)}

    def get_trace(self, run_id, query):
        return self.signal(run_id, query, self.repository.trace, "trace")

    def get_logs(self, run_id, query):
        return self.signal(run_id, query, self.repository.logs, "log")

    def get_metrics(self, run_id, query):
        return self.signal(run_id, query, self.repository.metrics, "metric")

    def signal(self, run_id, query, method, source):
        task = self.repository.find(run_id)
        if task is None:
            return None
        try:
            return method(task, query)
        except SourceUnavailable as error:
            return {"partial": True, "sourceStatus": self.source_status({source: "unavailable"}),
                    "error": {"code": "SOURCE_UNAVAILABLE", "message": str(error)}}

    @staticmethod
    def source_status(statuses):
        return {source: {"status": status} for source, status in statuses.items()}

    @staticmethod
    def summary(task):
        return {key: task[key] for key in ("runId", "workflowId", "workflowType", "name", "status", "startedAt", "durationMs", "spanCount", "traceId")}

    @staticmethod
    def psop(task):
        # A missing scenario must not be presented as the original PSOP.
        return task.get("psop")

    @staticmethod
    def aggregates(tasks):
        total = len(tasks)
        success = sum(task["status"] == "success" for task in tasks)
        return {"total": total, "success": success, "error": total - success,
                "successRate": success / total if total else 0,
                "avgDurationMs": round(sum(task["durationMs"] for task in tasks) / total) if total else 0}

    @staticmethod
    def workflow_type_facets(tasks):
        facets = {}
        for task in tasks:
            facets[task["workflowType"]] = facets.get(task["workflowType"], 0) + 1
        return [{"value": value, "count": count} for value, count in facets.items()]
