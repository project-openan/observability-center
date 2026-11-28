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
param()

$ErrorActionPreference = 'Stop'
$demoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vendorRoot = Join-Path $demoRoot '.vendor'
$lock = Get-Content -LiteralPath (Join-Path $demoRoot 'sdk-lock.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null

function Sync-LockedRepository {
    param(
        [string]$Path,
        [string]$Repository,
        [string]$Commit
    )

    $newClone = -not (Test-Path -LiteralPath (Join-Path $Path '.git'))
    if ($newClone) {
        & git clone --no-checkout $Repository $Path
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    Push-Location $Path
    try {
        if (-not $newClone) {
            $changes = @(git status --porcelain --untracked-files=no)
            if ($changes.Count -gt 0) {
                throw "Repository has local changes and cannot be pinned safely: $Path"
            }
        }
        & git fetch --depth 1 origin $Commit
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & git checkout --detach $Commit
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $actual = (git rev-parse HEAD).Trim()
        if ($actual -ne $Commit) {
            throw "Pinned commit mismatch for $Path. Expected $Commit, got $actual"
        }
    }
    finally {
        Pop-Location
    }
}

$observabilityRoot = Join-Path $vendorRoot 'observability-sdk-java'
Sync-LockedRepository $observabilityRoot $lock.'observability-sdk-java'.repository $lock.'observability-sdk-java'.commit

$workflowRoot = Join-Path $vendorRoot 'workflow-engine-sdk-java'
Sync-LockedRepository $workflowRoot $lock.'workflow-engine-sdk-java'.repository $lock.'workflow-engine-sdk-java'.commit

$a2atRoot = Join-Path $vendorRoot 'a2a-t-sdk-java'
Sync-LockedRepository $a2atRoot $lock.'a2a-t-sdk-java'.repository $lock.'a2a-t-sdk-java'.commit

$mockagentRoot = Join-Path $vendorRoot 'openan-demo'
Sync-LockedRepository $mockagentRoot $lock.'openan-demo-mockagent'.repository $lock.'openan-demo-mockagent'.commit

Set-Location $observabilityRoot
& mvn -B -ntp install '-DskipTests' '-Dcheckstyle.skip=true' '-Dmaven.javadoc.skip=true' '-Dmaven.source.skip=true'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $workflowRoot
& mvn -B -ntp install '-DskipTests' '-Dcheckstyle.skip=true' '-Dmaven.javadoc.skip=true' '-Dmaven.source.skip=true'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $demoRoot
& mvn -B -ntp test '-Ddemo.otel.enabled=false'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
