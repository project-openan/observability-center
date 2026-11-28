<#
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
 #>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,
    [ValidateSet('success', 'authorization-denied')]
    [string]$Case = 'success',
    [string]$ServiceName = "complaint-demo-$Case",
    [ValidateRange(5, 300)]
    [int]$QueryTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$demoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reportPath = Join-Path $demoRoot "artifacts/$RunId.json"
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if (-not $report.observabilityEnabled -or -not $report.otelFlush) {
    throw 'The report was not produced with successful OTLP flush; run with -EnableTelemetry first.'
}

$failures = [System.Collections.Generic.List[string]]::new()
$metricFound = $false
$traceFound = $false
$traceRelationFound = $false
$logFound = $false
$rawResults = [ordered]@{
    runId = $RunId
    case = $Case
    serviceName = $ServiceName
    checkedAtUtc = $null
    metric = [ordered]@{ uri = $null; response = $null; error = $null }
    trace = [ordered]@{
        uri = $null
        response = $null
        detailsUri = $null
        details = $null
        verification = $null
        error = $null
    }
    log = [ordered]@{ uri = $null; request = $null; response = $null; error = $null }
}

function Get-TraceSpans {
    param([object]$TraceResponse)
    $spans = [System.Collections.Generic.List[object]]::new()
    foreach ($resourceSpan in @($TraceResponse.result.resourceSpans)) {
        $serviceName = @($resourceSpan.resource.attributes | Where-Object { $_.key -eq 'service.name' } |
                Select-Object -First 1).value.stringValue
        foreach ($scopeSpan in @($resourceSpan.scopeSpans)) {
            foreach ($span in @($scopeSpan.spans)) {
                $attributes = @{}
                foreach ($attribute in @($span.attributes)) {
                    $value = $attribute.value.stringValue
                    if ($null -eq $value) { $value = $attribute.value.intValue }
                    if ($null -eq $value) { $value = $attribute.value.boolValue }
                    if ($null -ne $value) { $attributes[$attribute.key] = $value }
                }
                $spans.Add([pscustomobject]@{
                        traceId = [string]$span.traceId
                        spanId = [string]$span.spanId
                        parentSpanId = [string]$span.parentSpanId
                        name = [string]$span.name
                        kind = $span.kind
                        serviceName = [string]$serviceName
                        attributes = $attributes
                    })
            }
        }
    }
    return @($spans)
}

function Get-TraceVerification {
    param(
        [object]$TraceResponse,
        [string]$Case
    )
    $spans = @(Get-TraceSpans $TraceResponse)
    $traceIds = @($spans | ForEach-Object { $_.traceId } | Sort-Object -Unique)
    $spanById = @{}
    foreach ($span in $spans) {
        if (-not [string]::IsNullOrWhiteSpace($span.spanId)) {
            $spanById[$span.spanId] = $span
        }
    }
    $parentFailures = @($spans | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_.parentSpanId) -and -not $spanById.ContainsKey($_.parentSpanId)
        } | ForEach-Object {
            [ordered]@{
                spanId = $_.spanId
                name = $_.name
                parentSpanId = $_.parentSpanId
            }
        })
    $workflowSpans = @($spans | Where-Object { $_.name -eq 'a2at.workflow' })
    $rootWorkflowSpans = @($workflowSpans | Where-Object { [string]::IsNullOrWhiteSpace($_.parentSpanId) })
    $stepSpans = @($spans | Where-Object { $_.name -like 'a2at.step.*' })
    $substepSpans = @($spans | Where-Object { $_.name -like 'a2at.substep.*' })
    $sendMessageSpans = @($spans | Where-Object { $_.name -eq 'SendMessage' })
    $waimoWorkflowRoots = @($rootWorkflowSpans | Where-Object { $_.serviceName -eq 'complaint-waimo' })
    $waimoSteps = @($stepSpans | Where-Object { $_.serviceName -eq 'complaint-waimo' })
    $waimoStepParentOk = $waimoWorkflowRoots.Count -eq 1 -and $waimoSteps.Count -gt 0
    if ($waimoStepParentOk) {
        $waimoRootId = [string]$waimoWorkflowRoots[0].spanId
        $waimoStepParentOk = @($waimoSteps | Where-Object { $_.parentSpanId -ne $waimoRootId }).Count -eq 0
    }

    $substepParentFailures = @(
        foreach ($substep in $substepSpans) {
            $parent = $spanById[[string]$substep.parentSpanId]
            if ($null -eq $parent -or $parent.name -notlike 'a2at.step.*' -or $parent.serviceName -ne $substep.serviceName) {
                [ordered]@{
                    spanId = $substep.spanId
                    name = $substep.name
                    serviceName = $substep.serviceName
                    parentSpanId = $substep.parentSpanId
                    parentName = if ($null -eq $parent) { $null } else { $parent.name }
                }
            }
        }
    )
    $substepsParentedToStep = $substepSpans.Count -gt 0 -and $substepParentFailures.Count -eq 0

    $requiredWaimoSubsteps = @(
        [pscustomobject]@{ name = 'a2at.substep.complaint-ticket-intake'; parent = 'a2at.step.投诉受理' },
        [pscustomobject]@{ name = 'a2at.substep.complaint-intent-recognition'; parent = 'a2at.step.投诉识别' },
        [pscustomobject]@{ name = 'a2at.substep.complaint-localization'; parent = 'a2at.step.定界定位' },
        [pscustomobject]@{ name = 'a2at.substep.agent-card-search'; parent = 'a2at.step.检索传输智能体' }
    )
    if ($Case -eq 'success') {
        $requiredWaimoSubsteps += [pscustomobject]@{ name = 'a2at.substep.complaint-closure'; parent = 'a2at.step.投诉报结' }
    }
    $waimoSubstepFailures = @(
        foreach ($expected in $requiredWaimoSubsteps) {
            $matches = @($substepSpans | Where-Object {
                    $_.serviceName -eq 'complaint-waimo' -and $_.name -eq $expected.name
                })
            $parentName = if ($matches.Count -eq 1) {
                $parent = $spanById[[string]$matches[0].parentSpanId]
                if ($null -eq $parent) { $null } else { [string]$parent.name }
            } else {
                $null
            }
            if ($matches.Count -ne 1 -or $parentName -ne $expected.parent) {
                [ordered]@{
                    name = $expected.name
                    expectedParent = $expected.parent
                    actualParent = $parentName
                    matchCount = $matches.Count
                }
            }
        }
    )
    $requiredWaimoSubstepsParented = $waimoSubstepFailures.Count -eq 0

    $waimoDiagnosticSteps = @($waimoSteps | Where-Object { $_.name -eq 'a2at.step.投诉诊断处置' })
    $waimoClientSendMessages = @($sendMessageSpans | Where-Object {
            $_.serviceName -eq 'complaint-waimo' -and $_.kind -eq 3
        })
    $waimoDiagnosticSendMessages = @(
        foreach ($step in $waimoDiagnosticSteps) {
            $waimoClientSendMessages | Where-Object { $_.parentSpanId -eq $step.spanId }
        }
    )
    $waimoSendMessageLinkedToDiagnosticStep = $waimoDiagnosticSteps.Count -eq 1 `
        -and $waimoDiagnosticSendMessages.Count -eq 1

    $transportWorkflows = @($workflowSpans | Where-Object { $_.serviceName -eq 'complaint-transport' })
    $transportWorkflowParents = @(
        foreach ($workflowSpan in $transportWorkflows) {
            if ($spanById.ContainsKey($workflowSpan.parentSpanId)) {
                $spanById[$workflowSpan.parentSpanId]
            }
        }
    )
    $transportWorkflowLinked = $transportWorkflows.Count -gt 0 -and @($transportWorkflowParents | Where-Object {
            $_.name -eq 'SendMessage' -and $_.kind -eq 2 -and $_.serviceName -eq 'complaint-transport'
        }).Count -eq $transportWorkflows.Count
    $requiredInboundAttributes = @(
        'gen_ai.agent.a2a.operation.name',
        'gen_ai.agent.a2a.task_id',
        'gen_ai.agent.a2a.context_id',
        'gen_ai.agent.a2a.message_id',
        'gen_ai.agent.a2a.role',
        'gen_ai.agent.a2a.extensions',
        'gen_ai.agent.a2a.parts.number',
        'gen_ai.agent.a2a.transport',
        'gen_ai.agent.a2a.protocol.version',
        'gen_ai.agent.a2at.extension.name',
        'gen_ai.agent.a2at.task.type',
        'gen_ai.agent.a2at.task.object',
        'gen_ai.agent.name',
        'gen_ai.agent.version'
    )
    $transportInbound = @($sendMessageSpans | Where-Object {
            $_.serviceName -eq 'complaint-transport' -and $_.kind -eq 2
        })
    $waimoClientSpanIds = @($waimoDiagnosticSendMessages | ForEach-Object { $_.spanId })
    $transportInboundFromWaimo = @($transportInbound | Where-Object {
            $waimoClientSpanIds -contains $_.parentSpanId
        })
    $transportInboundLinkedToWaimoSendMessage = $transportInbound.Count -gt 0 `
        -and $transportInboundFromWaimo.Count -eq $transportInbound.Count
    $transportInboundWithCompleteAttributes = @(
        foreach ($inboundSpan in $transportInbound) {
            $missingAttributes = @($requiredInboundAttributes | Where-Object {
                    -not $inboundSpan.attributes.ContainsKey($_)
                })
            if ($missingAttributes.Count -eq 0) { $inboundSpan }
        }
    )
    $transportInboundAttributesComplete = $transportInbound.Count -gt 0 `
        -and $transportInboundWithCompleteAttributes.Count -eq $transportInbound.Count
    $valid = $spans.Count -gt 0 `
        -and $traceIds.Count -eq 1 `
        -and $workflowSpans.Count -gt 0 `
        -and $rootWorkflowSpans.Count -gt 0 `
        -and $stepSpans.Count -gt 0 `
        -and $waimoStepParentOk `
        -and $substepsParentedToStep `
        -and $requiredWaimoSubstepsParented `
        -and $sendMessageSpans.Count -gt 0 `
        -and $parentFailures.Count -eq 0 `
        -and $waimoSendMessageLinkedToDiagnosticStep `
        -and $transportInboundLinkedToWaimoSendMessage `
        -and $transportWorkflowLinked `
        -and $transportInboundAttributesComplete
    return [pscustomobject]@{
        valid = $valid
        traceIds = $traceIds
        spanCount = $spans.Count
        workflowSpanCount = $workflowSpans.Count
        rootWorkflowSpanCount = $rootWorkflowSpans.Count
        stepSpanCount = $stepSpans.Count
        substepSpanCount = $substepSpans.Count
        sendMessageSpanCount = $sendMessageSpans.Count
        parentClosureOk = $parentFailures.Count -eq 0
        parentClosureFailures = $parentFailures
        waimoWorkflowRootCount = $waimoWorkflowRoots.Count
        waimoStepParentOk = $waimoStepParentOk
        substepsParentedToStep = $substepsParentedToStep
        substepParentFailures = $substepParentFailures
        requiredWaimoSubstepsParented = $requiredWaimoSubstepsParented
        waimoSubstepFailures = $waimoSubstepFailures
        waimoDiagnosticSendMessageCount = $waimoDiagnosticSendMessages.Count
        waimoSendMessageLinkedToDiagnosticStep = $waimoSendMessageLinkedToDiagnosticStep
        transportWorkflowCount = $transportWorkflows.Count
        transportWorkflowLinked = $transportWorkflowLinked
        transportInboundSpanCount = $transportInbound.Count
        transportInboundLinkedToWaimoSendMessage = $transportInboundLinkedToWaimoSendMessage
        transportInboundAttributesComplete = $transportInboundAttributesComplete
        requiredTransportInboundAttributes = $requiredInboundAttributes
        spans = $spans
    }
}

function Wait-ForStorageResult {
    param(
        [scriptblock]$QueryAction,
        [scriptblock]$Predicate,
        [int]$TimeoutSeconds
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastResponse = $null
    $lastError = $null
    do {
        try {
            $lastResponse = & $QueryAction
            if (& $Predicate $lastResponse) {
                return [pscustomobject]@{
                    found = $true
                    response = $lastResponse
                    error = $null
                }
            }
        }
        catch {
            $lastError = $_.Exception.Message
        }
        if ([DateTimeOffset]::UtcNow -lt $deadline) {
            Start-Sleep -Seconds 2
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject]@{
        found = $false
        response = $lastResponse
        error = $lastError
    }
}

try {
    $metricQuery = [uri]::EscapeDataString('gen_ai_agent_a2at_workflow_count_total')
    $metricStart = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(-1).ToString('o'))
    $metricEnd = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddMinutes(1).ToString('o'))
    $metricUri = "http://127.0.0.1:19090/api/v1/query_range?query=$metricQuery&start=$metricStart&end=$metricEnd&step=60"
    $rawResults.metric.uri = $metricUri
    $metricResult = Wait-ForStorageResult -TimeoutSeconds $QueryTimeoutSeconds -QueryAction {
        Invoke-RestMethod -Uri $metricUri -Method Get
    } -Predicate {
        param($response)
        @($response.data.result | Where-Object {
                $_.metric.service_name -eq $ServiceName -or $_.metric.'service.name' -eq $ServiceName
            } | Where-Object { @($_.values).Count -gt 0 }).Count -gt 0
    }
    $rawResults.metric.response = $metricResult.response
    $rawResults.metric.error = $metricResult.error
    $metricFound = $metricResult.found
    if (-not $metricFound -and $null -ne $metricResult.error) {
        $failures.Add("Metric query failed: $($metricResult.error)")
    }
}
catch {
    $failures.Add("Metric query failed: $($_.Exception.Message)")
    $rawResults.metric.error = $_.Exception.Message
}

try {
    # Resolve this run from its business log before selecting the trace. The most recent
    # workflow may belong to a different run (including a different test case).
    $traceLookup = @{
        size = 10
        _source = @('traceId')
        query = @{ bool = @{ should = @(
            @{ term = @{ 'attributes.run_id.keyword' = $RunId } },
            @{ term = @{ 'attributes.run_id' = $RunId } }
        ); minimum_should_match = 1 } }
    } | ConvertTo-Json -Depth 10
    $runLogs = Wait-ForStorageResult -TimeoutSeconds $QueryTimeoutSeconds -QueryAction {
        Invoke-RestMethod -Uri 'http://127.0.0.1:19200/a2at-logs-v2/_search' -Method Post -ContentType 'application/json' -Body $traceLookup
    } -Predicate { param($response) @($response.hits.hits | Where-Object { $_._source.traceId }).Count -gt 0 }
    $runTraceIds = @($runLogs.response.hits.hits | ForEach-Object { [string]$_._source.traceId } | Where-Object { $_ } | Sort-Object -Unique)
    if ($runTraceIds.Count -ne 1) { throw "Expected one trace ID for run $RunId, found $($runTraceIds.Count)" }
    $traceService = [uri]::EscapeDataString($ServiceName)
    $traceStart = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(-1).ToString('yyyy-MM-ddTHH:mm:ssZ'))
    $traceEnd = [uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(1).ToString('yyyy-MM-ddTHH:mm:ssZ'))
    $traceUri = "http://127.0.0.1:16686/api/v3/trace-summaries?query.serviceName=$traceService&query.startTimeMin=$traceStart&query.startTimeMax=$traceEnd"
    $rawResults.trace.uri = $traceUri
    $traceResult = Wait-ForStorageResult -TimeoutSeconds $QueryTimeoutSeconds -QueryAction {
        Invoke-RestMethod -Uri $traceUri -Method Get
    } -Predicate {
        param($response)
        @($response.summaries).Count -gt 0
    }
    $rawResults.trace.response = $traceResult.response
    $rawResults.trace.error = $traceResult.error
    $traceFound = $traceResult.found
    if (-not $traceFound -and $null -ne $traceResult.error) {
        $failures.Add("Trace query failed: $($traceResult.error)")
    }
    if ($traceFound) {
        $workflowSummary = @($traceResult.response.summaries |
                Where-Object { $_.rootOperationName -eq 'a2at.workflow' -and $_.traceId -eq $runTraceIds[0] } |
                Sort-Object { [Int64]$_.maxStartTimeUnixNano } -Descending |
                Select-Object -First 1)
        if ($workflowSummary.Count -eq 0) {
            $failures.Add('No a2at.workflow root trace was found for this run')
        } else {
            $traceId = [string]$workflowSummary[0].traceId
            $traceDetailsUri = "http://127.0.0.1:16686/api/v3/traces/$traceId"
            $rawResults.trace.detailsUri = $traceDetailsUri
            $traceDetailsResult = Wait-ForStorageResult -TimeoutSeconds $QueryTimeoutSeconds -QueryAction {
                $traceDetails = Invoke-RestMethod -Uri $traceDetailsUri -Method Get
                $verification = Get-TraceVerification $traceDetails $Case
                [pscustomobject]@{
                    response = $traceDetails
                    verification = $verification
                }
            } -Predicate {
                param($response)
                $response.verification.valid
            }
            if ($null -ne $traceDetailsResult.response) {
                $rawResults.trace.details = $traceDetailsResult.response.response
                $rawResults.trace.verification = $traceDetailsResult.response.verification
            }
            $traceRelationFound = $traceDetailsResult.found
            if (-not $traceRelationFound -and $null -ne $traceDetailsResult.error) {
                $failures.Add("Trace parent verification failed: $($traceDetailsResult.error)")
            }
        }
    }
}
catch {
    $failures.Add("Trace query failed: $($_.Exception.Message)")
    $rawResults.trace.error = $_.Exception.Message
}

try {
    $query = @{
        size = 1
        query = @{
            bool = @{
                should = @(
                    @{ match = @{ 'attributes.run_id' = $RunId } },
                    @{ match = @{ body = $RunId } }
                )
                minimum_should_match = 1
            }
        }
    } | ConvertTo-Json -Depth 10
    $logUri = 'http://127.0.0.1:19200/a2at-logs-v2/_search'
    $rawResults.log.uri = $logUri
    $rawResults.log.request = $query
    $logResult = Wait-ForStorageResult -TimeoutSeconds $QueryTimeoutSeconds -QueryAction {
        Invoke-RestMethod -Uri $logUri -Method Post -ContentType 'application/json' -Body $query
    } -Predicate {
        param($response)
        [int]$response.hits.total.value -gt 0
    }
    $rawResults.log.response = $logResult.response
    $rawResults.log.error = $logResult.error
    $logFound = $logResult.found
    if (-not $logFound -and $null -ne $logResult.error) {
        $failures.Add("Log query failed: $($logResult.error)")
    }
}
catch {
    $failures.Add("Log query failed: $($_.Exception.Message)")
    $rawResults.log.error = $_.Exception.Message
}

if (-not $metricFound) { $failures.Add('No matching metric sample was found') }
if (-not $traceFound) { $failures.Add('No matching trace was found') }
if (-not $traceRelationFound) { $failures.Add('Trace parent relationship was not verified') }
if (-not $logFound) { $failures.Add('No matching run_id log was found') }
$rawResults.checkedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
$rawPath = Join-Path $demoRoot "artifacts/$RunId.storage.json"
$rawResults | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $rawPath -Encoding utf8
$summary = [ordered]@{
    runId = $RunId
    case = $Case
    serviceName = $ServiceName
    metricFound = $metricFound
    traceFound = $traceFound
    traceRelationFound = $traceRelationFound
    logFound = $logFound
    failureCount = $failures.Count
    rawQueries = $rawPath
}
$summary | ConvertTo-Json
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}
