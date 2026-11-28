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
import dev.openan.workflow.engine.model.MessageContent;
import dev.openan.workflow.engine.model.ReceivedMessage;
import dev.openan.workflow.engine.model.SendMessageResult;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import net.openan.a2at.sdk.core.model.MetadataContent;
import net.openan.a2at.sdk.negotiation.runtime.helper.NegotiationPayloadMapper;
import net.openan.a2at.sdk.server.model.PromptComplianceResult;
import net.openan.observability.LogSeverity;
import net.openan.observability.Observability;
import net.openan.observability.ObservationSpan;
import net.openan.observability.SignalKind;
import org.a2aproject.sdk.spec.TextPart;

/** Routes workflow messages to deterministic MockAgent roles and records their execution. */
final class MockAgentRouter {
    private final String caseName;
    private final Observability observe;
    private final TaskTCodec taskT;
    private final WorkflowEngineClient regionalClient;
    private final TraceParentRegistry traceParents;
    private final LayeredTransportWorkflow transportWorkflow;
    private final ConcurrentLinkedQueue<Map<String, Object>> records = new ConcurrentLinkedQueue<>();

    MockAgentRouter(String caseName, Observability observe, TaskTCodec taskT) {
        this(caseName, observe, taskT, null, null);
    }

    MockAgentRouter(
            String caseName,
            Observability observe,
            TaskTCodec taskT,
            WorkflowEngineClient regionalClient) {
        this(caseName, observe, taskT, regionalClient, null);
    }

    MockAgentRouter(
            String caseName,
            Observability observe,
            TaskTCodec taskT,
            WorkflowEngineClient regionalClient,
            TraceParentRegistry traceParents) {
        this(caseName, observe, taskT, regionalClient, traceParents, null);
    }

    MockAgentRouter(
            String caseName,
            Observability observe,
            TaskTCodec taskT,
            WorkflowEngineClient regionalClient,
            TraceParentRegistry traceParents,
            LayeredTransportWorkflow transportWorkflow) {
        this.caseName = caseName;
        this.observe = observe;
        this.taskT = taskT;
        this.regionalClient = regionalClient;
        this.traceParents = traceParents;
        this.transportWorkflow = transportWorkflow;
    }

    SendMessageResult dispatch(String agentName, MessageContent content) {
        return dispatch(agentName, content, null);
    }

  SendMessageResult dispatch(
      String agentName, MessageContent content, ObservationSpan traceParent) {
        Map<String, Object> metadata = content.metadata();
        String step = String.valueOf(metadata.getOrDefault("demo.step", "unknown"));
        String skill = String.valueOf(metadata.getOrDefault("demo.skill", "unknown"));
        String runId = String.valueOf(metadata.getOrDefault("demo.run_id", "unknown"));
        long started = System.nanoTime();
    Map<String, Object> attributes = taskAttributes(agentName, metadata);
    ObservationSpan client =
        traceParent == null
                ? observe.trace("SendMessage", SignalKind.CLIENT, attributes)
                : observe.trace("SendMessage", SignalKind.CLIENT, attributes, traceParent);
        try (client) {
      try (ObservationSpan server =
          observe.trace("SendMessage", SignalKind.SERVER, attributes, client)) {
        SendMessageResult result =
            dispatchOnServer(
                agentName, content, step, skill, runId, started, metadata, attributes, server);
        if (result.getFailureCode() == null) client.ok();
        else client.error();
        return result;
      }
    }
  }

  SendMessageResult dispatchInbound(
      String agentName, MessageContent content, Map<String, Object> protocolAttributes) {
    Map<String, Object> metadata = content.metadata();
    String step = String.valueOf(metadata.getOrDefault("demo.step", "unknown"));
    String skill = String.valueOf(metadata.getOrDefault("demo.skill", "unknown"));
    String runId = String.valueOf(metadata.getOrDefault("demo.run_id", "unknown"));
    long started = System.nanoTime();
    Map<String, Object> attributes = new LinkedHashMap<>(taskAttributes(agentName, metadata));
    attributes.putAll(protocolAttributes);
    try (ObservationSpan server = observe.trace("SendMessage", SignalKind.SERVER, attributes)) {
      return dispatchOnServer(
          agentName, content, step, skill, runId, started, metadata, attributes, server);
    }
  }

  private SendMessageResult dispatchOnServer(
      String agentName,
      MessageContent content,
      String step,
      String skill,
      String runId,
      long started,
      Map<String, Object> metadata,
      Map<String, Object> attributes,
      ObservationSpan server) {
                String prompt = extractPrompt(content);
    PromptComplianceResult compliance = isTaskT(metadata) ? taskT.validate(prompt) : null;
    if (compliance != null && !compliance.success()) {
      String detail =
          compliance.failure() == null
                            ? "Task-T prompt rejected"
              : compliance.failure().code()
                  + ": "
                  + compliance.failure().message()
                  + " (stage="
                  + compliance.failure().stage()
                  + ")";
      server.attributes(Map.of("error.type", "taskt.invalid"));
                    server.error();
                    return failure(agentName, step, skill, runId, started, "taskt.invalid", detail);
                }
                SendMessageResult result;
                try (var scope = server.makeCurrent()) {
                    result = process(agentName, step, skill, prompt, runId, server, attributes, started, content);
                }
                if (result.getFailureCode() == null) {
                    server.ok();
                } else {
      server.attributes(Map.of("error.type", result.getFailureCode()));
                    server.error();
                }
                observe.log(
                        "gen_ai.agent.a2at.message",
                        result.getFailureCode() == null ? LogSeverity.INFO : LogSeverity.ERROR,
        result.getFailureCode() == null
            ? "MockAgent completed " + skill
            : result.getFailureMessage(),
        extensionAttributes(metadata, skill, step),
                        server);
                try (var scope = server.makeCurrent()) {
                    observe.logRecord(
                            "demo.task",
                            result.getFailureCode() == null ? LogSeverity.INFO : LogSeverity.ERROR,
          result.getFailureCode() == null
              ? "MockAgent completed " + skill
              : result.getFailureMessage(),
                            Map.of(
              "run_id",
              runId,
              "task_id",
              String.valueOf(metadata.getOrDefault("demo.task_id", "unknown")),
              "step",
              step,
              "skill",
              skill,
              "agent",
              agentName,
              "status",
              result.getFailureCode() == null ? "completed" : "failed"),
                            null,
                            null,
                            null);
                }
                boolean success = result.getFailureCode() == null;
                String taskStatus = success ? "completed" : "failed";
                Map<String, Object> taskMetric = Map.of("task.type", skill, "task.object", step, "task.status", taskStatus);
                if (isTaskT(metadata)) {
                    observe.metric("task.duration", (System.nanoTime() - started) / 1_000_000.0, taskMetric);
                    observe.metric("task.count", 1, taskMetric);
                }
                Map<String, Object> substepMetric = Map.of("gen_ai.agent.name", agentName, "substep.status", success ? "success" : "failed");
                observe.metric("substep.duration", (System.nanoTime() - started) / 1_000_000.0, substepMetric);
                observe.metric("substep.count", 1, substepMetric);
                if (skill.equals("Network Operation Authorization") || skill.equals("Network Operation Authorization Request")) {
                    String authorizationResult = success ? "allowed" : "authorization.denied".equals(result.getFailureCode()) ? "denied" : "error";
                    Map<String, Object> authMetric = Map.of("authorization.policy.operation.type", "tunnel-optimization", "authorization.result", authorizationResult);
                    if (skill.equals("Network Operation Authorization")) {
                        observe.metric("authorization.preauthorize.count", 1, authMetric);
                        observe.metric("authorization.preauthorize.duration", (System.nanoTime() - started) / 1_000_000.0, authMetric);
                    } else {
                        observe.metric("authorization.execute.count", 1, authMetric);
                    }
                }
                if (skill.contains("Notification") || skill.equals("Restoration Result Reply") || skill.equals("Root Cause Summarization")) {
                    observe.metric("notification.count", 1, Map.of("notification.topic", notificationTopic(skill), "notification.result", success ? "sent" : "failed"));
                }
                return result;
            }

  private static Map<String, Object> taskAttributes(
      String agentName, Map<String, Object> metadata) {
    Map<String, Object> attributes = new LinkedHashMap<>();
    attributes.put("operation.name", "SendMessage");
    attributes.put("gen_ai.agent.name", agentName);
    String extension = String.valueOf(metadata.getOrDefault("demo.extension.name", "task-t"));
    attributes.putAll(
        extensionAttributes(
            metadata,
            String.valueOf(metadata.getOrDefault("demo.skill", "unknown")),
            String.valueOf(metadata.getOrDefault("demo.step", "unknown"))));
    return attributes;
  }

  private static boolean isTaskT(Map<String, Object> metadata) {
    return "task-t".equals(metadata.getOrDefault("demo.extension.name", "task-t"));
        }

  private static Map<String, Object> extensionAttributes(
      Map<String, Object> metadata, String skill, String step) {
    String extension = String.valueOf(metadata.getOrDefault("demo.extension.name", "task-t"));
    Map<String, Object> attributes = new LinkedHashMap<>();
    attributes.put("extension.name", extension);
    switch (extension) {
      case "authorization-t" -> {
        attributes.put(
            "authorization.stage", skill.endsWith("Request") ? "execute" : "preauthorize");
        attributes.put("authorization.policy.operation.type", "tunnel-optimization");
      }
      case "notification-t" -> {
        attributes.put("notification.topic", notificationTopic(skill));
        attributes.put(
            "push.notification.url",
            "https://notification.demo.local/complaints/"
                + metadata.getOrDefault("demo.run_id", "unknown"));
      }
      default -> A2AObservationAttributes.addTaskT(attributes, metadata);
    }
    return attributes;
    }

    List<Map<String, Object>> records() {
        return new ArrayList<>(records);
    }

    private SendMessageResult process(
            String agentName,
            String step,
            String skill,
            String prompt,
            String runId,
            ObservationSpan parent,
            Map<String, Object> attributes,
            long started,
            MessageContent content) {
    if (transportWorkflow != null
        && agentName.equals("Transport Complaint Agent")
                && skill.equals("Leased-Line Complaint Diagnosis")) {
            return transportWorkflow.execute(content);
        }
    if ("authorization-denied".equals(caseName)
        && skill.equals("Network Operation Authorization Request")) {
      return failure(
          agentName,
          step,
          skill,
          runId,
          started,
          "authorization.denied",
          "Network operation authorization denied");
    }
        if ("authorization-denied".equals(caseName) && skill.contains("Complaint Handling Dispatch")) {
            return processRestorationDenied(agentName, step, skill, runId, parent, attributes, started);
        }
        if ("authorization-denied".equals(caseName) && skill.contains("Regional Authorization")) {
            sleep(60);
            return failure(
                    agentName,
                    step,
                    skill,
                    runId,
                    started,
                    "authorization.denied",
                    "Network operation authorization denied");
        }
        if (skill.startsWith("Regional ")) {
            sleep(45);
      return success(
          agentName, "Regional operation completed: " + skill, step, skill, runId, started);
        }
        if (skill.contains("Leased-Line Complaint Diagnosis")) {
            return processDiagnosis(agentName, step, skill, prompt, runId, parent, attributes, started);
        }
        if (skill.contains("Complaint Handling Dispatch")) {
            return processRestoration(agentName, step, skill, runId, parent, attributes, started);
        }
        if (skill.contains("Service SLA Verification")) {
            sleep(80);
      return success(
          agentName,
          "SLA verification passed: bandwidth=100M, latency=12ms, packetLoss=0.1%",
          step,
          skill,
          runId,
          started);
        }
        sleep(35);
        return success(agentName, "MockAgent completed " + skill, step, skill, runId, started);
    }

    private SendMessageResult processDiagnosis(
            String agentName,
            String step,
            String skill,
            String prompt,
            String runId,
            ObservationSpan parent,
            Map<String, Object> attributes,
            long started) {
    emitInformationNegotiation(parent, runId);
        if (regionalClient != null) {
            return processDiagnosisOverHttp(agentName, step, skill, runId, parent, started);
        }
    CompletableFuture<String> west =
        CompletableFuture.supplyAsync(
                () -> regional("West-GD NETSpirit", "west", 150, runId, parent, attributes));
    CompletableFuture<String> east =
        CompletableFuture.supplyAsync(
                () -> regional("East-GD NETSpirit", "east", 110, runId, parent, attributes));
        String westResult = west.join();
        String eastResult = east.join();
        return success(
                agentName,
                "Root cause summary: west=" + westResult + "; east=" + eastResult,
                step,
                skill,
                runId,
                started);
    }

  @SuppressWarnings("unchecked")
  private void emitInformationNegotiation(ObservationSpan parent, String runId) {
    Map<String, Object> payload =
        taskT.startInformationNegotiation(
            "A端诊断缺少cvlan和子接口信息，请补充。", Map.of("site", "A", "issue", "missing-cvlan"));
    Map<String, Object> context = NegotiationPayloadMapper.extractContextMap(payload);
    String negotiationId = String.valueOf(context.get("negotiationId"));
    Map<String, Object> propose =
        Map.of(
            "extension.name",
            "negotiation-t",
            "negotiation.id",
            negotiationId,
            "negotiation.round",
            context.get("round"),
            "negotiation.total_rounds",
            2,
            "negotiation.max_rounds",
            3,
            "negotiation.performative",
            "propose",
            "negotiation.result",
            "in-progress");
    try (ObservationSpan negotiation =
        observe.trace("SendStreamingMessage-negotiation", SignalKind.SERVER, propose, parent)) {
      observe.log(
          "gen_ai.agent.a2at.message",
          LogSeverity.INFO,
          "West-GD NETSpirit requested cvlan and subinterface details",
          propose,
          negotiation);
      Map<String, Object> accepted = new LinkedHashMap<>(propose);
      accepted.put("negotiation.round", 2);
      accepted.put("negotiation.performative", "accept");
      accepted.put("negotiation.result", "agreed");
      observe.log(
          "gen_ai.agent.a2at.message",
          LogSeverity.INFO,
          "Transport Complaint Agent supplied cvlan=409 and accepted the diagnosis continuation",
          accepted,
          negotiation);
      observe.metric(
          "negotiation.rounds",
          2,
          Map.of("negotiation.id", negotiationId, "negotiation.result", "agreed"));
      observe.metric(
          "negotiation.count",
          1,
          Map.of("negotiation.result", "agreed"));
      negotiation.ok();
    }
  }

    private SendMessageResult processRestoration(
            String agentName,
            String step,
            String skill,
            String runId,
            ObservationSpan parent,
            Map<String, Object> attributes,
            long started) {
        if (regionalClient != null) {
      RegionalResponse authorization =
          remoteRegional(
                    "West-GD NETSpirit", step, "Regional Authorization", "authorization", runId, parent);
            if (!authorization.success()) {
                return failure(
                        agentName,
                        step,
                        skill,
                        runId,
                        started,
                        authorization.errorCode(),
                        authorization.errorMessage());
            }
      RegionalResponse restoration =
          remoteRegional(
                    "West-GD NETSpirit", step, "Regional Restoration", "restoration", runId, parent);
            if (!restoration.success()) {
                return failure(
                        agentName,
                        step,
                        skill,
                        runId,
                        started,
                        restoration.errorCode(),
                        restoration.errorMessage());
            }
            return success(agentName, "Automatic restoration completed", step, skill, runId, started);
        }
        regional("West-GD NETSpirit", "authorization accepted", 60, runId, parent, attributes);
        regional("West-GD NETSpirit", "tunnel optimized", 120, runId, parent, attributes);
        return success(agentName, "Automatic restoration completed", step, skill, runId, started);
    }

    private SendMessageResult processRestorationDenied(
            String agentName,
            String step,
            String skill,
            String runId,
            ObservationSpan parent,
            Map<String, Object> attributes,
            long started) {
        if (regionalClient != null) {
      RegionalResponse authorization =
          remoteRegional(
                    "West-GD NETSpirit", step, "Regional Authorization", "authorization", runId, parent);
            if (!authorization.success()) {
                return failure(
                        agentName,
                        step,
                        skill,
                        runId,
                        started,
                        authorization.errorCode(),
                        authorization.errorMessage());
            }
        }
        regional("West-GD NETSpirit", "authorization denied", 60, runId, parent, attributes);
    return failure(
        agentName,
        step,
        skill,
        runId,
        started,
        "authorization.denied",
        "Network operation authorization denied");
    }

    private SendMessageResult processDiagnosisOverHttp(
            String agentName,
            String step,
            String skill,
            String runId,
            ObservationSpan parent,
            long started) {
    CompletableFuture<RegionalResponse> west =
        CompletableFuture.supplyAsync(
            () ->
                remoteRegional(
                    "West-GD NETSpirit",
                    step,
                    "Regional Diagnosis",
                    "diagnosis-west",
                    runId,
                    parent));
    CompletableFuture<RegionalResponse> east =
        CompletableFuture.supplyAsync(
            () ->
                remoteRegional(
                    "East-GD NETSpirit",
                    step,
                    "Regional Diagnosis",
                    "diagnosis-east",
                    runId,
                    parent));
        RegionalResponse westResult = west.join();
        RegionalResponse eastResult = east.join();
        if (!westResult.success()) {
      return failure(
          agentName,
          step,
          skill,
          runId,
          started,
          westResult.errorCode(),
          westResult.errorMessage());
        }
        if (!eastResult.success()) {
      return failure(
          agentName,
          step,
          skill,
          runId,
          started,
          eastResult.errorCode(),
          eastResult.errorMessage());
        }
        return success(
                agentName,
                "Root cause summary: west=" + westResult.text() + "; east=" + eastResult.text(),
                step,
                skill,
                runId,
                started);
    }

    private RegionalResponse remoteRegional(
            String agentName,
            String step,
            String skill,
            String operation,
            String runId,
            ObservationSpan parent) {
        MetadataContent encoded = taskT.encode("Execute " + operation + " for complaint " + runId);
        Map<String, Object> metadata = new java.util.LinkedHashMap<>(encoded.buildMetadataContent());
        String taskId = UUID.randomUUID().toString();
        if (traceParents != null) {
            traceParents.register(taskId, parent);
        }
        metadata.put("demo.run_id", runId);
        metadata.put("demo.task_id", taskId);
        metadata.put("demo.step", step);
        metadata.put("demo.skill", skill);
        metadata.put("demo.operation", operation);
        metadata.put("demo.agent", agentName);
    MessageContent content =
        new MessageContent(
                List.of(new TextPart(encoded.promptText())), metadata, Set.of(encoded.extensionUri()));
        long started = System.nanoTime();
    try (var scope = parent.makeCurrent()) {
            SendMessageResult result;
            try {
                    result = regionalClient.sendTask(agentName, content).join();
            } catch (CompletionException error) {
                return new RegionalResponse(
                        false,
                        "",
                        "agent.http",
                        error.getCause() == null ? error.toString() : error.getCause().toString());
            }
      if (result == null
          || result.getFailureCode() != null
                    || !"TASK_STATE_COMPLETED".equals(result.getTaskState())) {
        String code =
            result == null || result.getFailureCode() == null
                        ? "remote.task_failed"
                        : result.getFailureCode();
        String message =
            result == null
                ? "Remote regional agent returned no result"
                        : result.getFailureMessage();
        records.add(
            Map.of(
                "agent",
                agentName,
                "kind",
                "nested-task-http",
                "operation",
                operation,
                "status",
                "failed",
                "errorCode",
                code,
                "runId",
                runId,
                "startedNanos",
                started,
                "finishedNanos",
                System.nanoTime()));
        return new RegionalResponse(
            false, "", code, message == null ? "Remote task failed" : message);
            }
            String text = responseText(result);
      records.add(
          Map.of(
              "agent",
              agentName,
              "kind",
              "nested-task-http",
              "operation",
              operation,
              "status",
              "completed",
              "result",
              text,
              "runId",
              runId,
              "startedNanos",
              started,
              "finishedNanos",
              System.nanoTime()));
            return new RegionalResponse(true, text, null, null);
        }
    }

    private static String responseText(SendMessageResult result) {
        if (result.getText() != null && !result.getText().isBlank()) {
            return result.getText();
        }
        for (ReceivedMessage received : result.getReceivedMessages()) {
            if (received.message() != null) {
        String text =
            received.message().parts().stream()
                        .filter(TextPart.class::isInstance)
                        .map(TextPart.class::cast)
                        .map(TextPart::text)
                        .reduce("", String::concat);
                if (!text.isBlank()) {
                    return text;
                }
            }
            for (var artifact : received.artifacts()) {
        String text =
            artifact.parts().stream()
                        .filter(TextPart.class::isInstance)
                        .map(TextPart.class::cast)
                        .map(TextPart::text)
                        .reduce("", String::concat);
                if (!text.isBlank()) {
                    return text;
                }
            }
        }
        return "";
    }

  private record RegionalResponse(
      boolean success, String text, String errorCode, String errorMessage) {}

    private String regional(
            String agentName,
            String result,
            long delayMillis,
            String runId,
            ObservationSpan parent,
            Map<String, Object> parentAttributes) {
    Map<String, Object> attributes =
        Map.of(
            "operation.name",
            "SendMessage",
            "extension.name",
            "task-t",
            "task.type",
            "Leased-Line Fault Locating and Restoration",
            "task.object",
            String.valueOf(parentAttributes.getOrDefault("task.object", "nested")),
            "context_id",
            runId,
            "gen_ai.agent.name",
            agentName);
        long started = System.nanoTime();
    try (ObservationSpan client =
            observe.trace("SendMessage", SignalKind.CLIENT, attributes, parent);
        ObservationSpan server =
            observe.trace("SendMessage", SignalKind.SERVER, attributes, client)) {
            sleep(delayMillis);
            boolean denied = "authorization denied".equals(result);
            if (denied) {
                server.error();
                client.error();
            } else {
                server.ok();
                client.ok();
            }
      records.add(
          Map.of(
              "agent",
              agentName,
              "kind",
              "nested-task-t",
              "status",
              denied ? "failed" : "completed",
              "result",
              result,
              "startedNanos",
              started,
              "finishedNanos",
              System.nanoTime()));
            observe.metric(
                    "task.count",
                    1,
                    Map.of(
              "task.type",
              "Leased-Line Fault Locating and Restoration",
              "task.object",
              String.valueOf(parentAttributes.getOrDefault("task.object", "nested")),
              "task.status", denied ? "failed" : "completed"));
            return result;
        }
    }

    private SendMessageResult success(
            String agent, String text, String step, String skill, String runId, long started) {
    records.add(
        Map.of(
            "agent",
            agent,
            "kind",
            "workflow-task",
            "skill",
            skill,
            "step",
            step,
            "status",
            "completed",
            "runId",
            runId,
            "startedNanos",
            started,
            "finishedNanos",
            System.nanoTime()));
        return SendMessageResult.builder()
                .taskState("TASK_STATE_COMPLETED")
        .receivedMessages(
            List.of(new ReceivedMessage(MessageContent.text(text), Map.of(), List.of())))
                .build();
    }

    private SendMessageResult failure(
            String agent,
            String step,
            String skill,
            String runId,
            long started,
            String code,
            String message) {
    records.add(
        Map.of(
            "agent",
            agent,
            "kind",
            "workflow-task",
            "skill",
            skill,
            "step",
            step,
            "status",
            "failed",
            "runId",
            runId,
            "errorCode",
            code,
            "startedNanos",
            started,
            "finishedNanos",
            System.nanoTime()));
        return SendMessageResult.builder()
                .taskState("TASK_STATE_FAILED")
                .failureCode(code)
                .failureMessage(message)
                .build();
    }

    private static String extractPrompt(MessageContent content) {
        return content.parts().stream()
                .filter(TextPart.class::isInstance)
                .map(TextPart.class::cast)
                .map(TextPart::text)
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Task-T message has no text part"));
    }

    private static void sleep(long millis) {
        try {
            TimeUnit.MILLISECONDS.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("MockAgent interrupted", error);
        }
    }

    static String notificationTopic(String skill) {
        return switch (skill) {
            case "Root Cause Summarization" -> "root-cause.reported";
            case "Restoration Plan Notification" -> "restoration-plan.reported";
            case "Restoration Notification" -> "restoration-result.reported";
            case "Restoration Result Reply" -> "sla-verification.reported";
            default -> "complaint.update";
        };
    }
}
