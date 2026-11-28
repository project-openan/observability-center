/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 *    Licensed under the Apache License, Version 2.0 (the "License"); you may
 *    not use this file except in compliance with the License. You may obtain
 *    a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 *    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 *    License for the specific language governing permissions and limitations
 *    under the License.
 */

package net.openan.demo.complaint;

import dev.openan.workflow.engine.client.WorkflowEngineClient;
import dev.openan.workflow.engine.control.ControlPoint;
import dev.openan.workflow.engine.control.EventCallback;
import dev.openan.workflow.engine.control.NegotiationStrategy;
import dev.openan.workflow.engine.model.MessageContent;
import dev.openan.workflow.engine.model.SendMessageResult;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import net.openan.observability.LogSeverity;
import net.openan.observability.ObservationSpan;
import net.openan.observability.Observability;
import net.openan.observability.SignalKind;
import org.a2aproject.sdk.jsonrpc.common.wrappers.ListTasksResult;
import org.a2aproject.sdk.spec.ListTasksParams;

/** Keeps tasks owned by the running agent inside that agent process. */
final class LocalTaskWorkflowEngineClient implements WorkflowEngineClient {
    private final WorkflowEngineClient delegate;
    private final Observability observe;
    private final String localAgentName;

    LocalTaskWorkflowEngineClient(WorkflowEngineClient delegate, Observability observe, String localAgentName) {
        this.delegate = delegate;
        this.observe = observe;
        this.localAgentName = localAgentName;
    }

    @Override public CompletableFuture<SendMessageResult> sendTask(String agentName, MessageContent content) {
        return isLocal(agentName) ? completeLocal(content) : delegate.sendTask(agentName, content);
    }
    @Override public CompletableFuture<SendMessageResult> sendTask(String agentName, MessageContent content, NegotiationStrategy strategy) {
        return isLocal(agentName) ? completeLocal(content) : delegate.sendTask(agentName, content, strategy);
    }
    @Override public CompletableFuture<SendMessageResult> sendTask(String agentName, MessageContent content, NegotiationStrategy strategy, EventCallback callback) {
        return isLocal(agentName) ? completeLocal(content) : delegate.sendTask(agentName, content, strategy, callback);
    }
    @Override public long callbackTimeoutSeconds() { return delegate.callbackTimeoutSeconds(); }
    @Override public void setControlPoint(ControlPoint controlPoint) { delegate.setControlPoint(controlPoint); }
    @Override public void setEventCallback(EventCallback callback) { delegate.setEventCallback(callback); }
    @Override public CompletableFuture<SendMessageResult> getTask(String agentName, String taskId) { return delegate.getTask(agentName, taskId); }
    @Override public CompletableFuture<ListTasksResult> listTasks(String agentName, ListTasksParams params) { return delegate.listTasks(agentName, params); }
    @Override public CompletableFuture<SendMessageResult> cancelTask(String agentName, String taskId) { return delegate.cancelTask(agentName, taskId); }
    @Override public CompletableFuture<SendMessageResult> subscribeToTask(String agentName, String taskId, Consumer<Map<String, Object>> callback) { return delegate.subscribeToTask(agentName, taskId, callback); }
    @Override public void close() { delegate.close(); }

    private boolean isLocal(String agentName) { return localAgentName.equals(agentName); }

    private CompletableFuture<SendMessageResult> completeLocal(MessageContent content) {
        Map<String, Object> metadata = content.metadata();
        String step = text(metadata, "demo.step", "unknown-step");
        String skill = text(metadata, "demo.skill", "local-work");
        long started = System.nanoTime();
        Map<String, Object> attributes = Map.of("gen_ai.agent.name", localAgentName, "substep.name", skill, "substep.status", "completed");
        try (ObservationSpan substep = observe.trace("a2at.substep." + spanSegment(skill), SignalKind.INTERNAL, attributes)) {
            observe.log("gen_ai.agent.a2at.substep", LogSeverity.INFO, "Local agent substep completed: " + skill,
                    Map.of("gen_ai.agent.name", localAgentName, "substep.name", skill, "substep.status", "completed", "workflow.step.name", step), substep);
            Map<String, Object> metricAttributes = Map.of("gen_ai.agent.name", localAgentName, "substep.status", "success");
            observe.metric("substep.duration", (System.nanoTime() - started) / 1_000_000.0, metricAttributes);
            observe.metric("substep.count", 1, metricAttributes);
            // These PSOP skills model a successful notification inside the local mock agent.
            if (skill.contains("Notification") || skill.equals("Restoration Result Reply") || skill.equals("Root Cause Summarization")) {
                observe.metric("notification.count", 1, Map.of("notification.topic", MockAgentRouter.notificationTopic(skill), "notification.result", "sent"));
            }
            substep.ok();
            return CompletableFuture.completedFuture(SendMessageResult.builder().taskState("TASK_STATE_COMPLETED").text("Local substep completed: " + skill).build());
        }
    }
    private static String text(Map<String, Object> metadata, String key, String fallback) {
        Object value = metadata == null ? null : metadata.get(key);
        return value == null || String.valueOf(value).isBlank() ? fallback : String.valueOf(value);
    }
    private static String spanSegment(String value) {
        return value.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-+|-+$)", "");
    }
}
