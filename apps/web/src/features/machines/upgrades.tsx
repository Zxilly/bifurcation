"use client";

import { TaskKind } from "@bifurcation/rpc";
import { maintenanceInfo } from "@/contracts/maintenance";
import { LayerCard, Banner, Table } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import type {
  MachineDetail,
  UpgradeCandidate,
} from "@bifurcation/rpc/panel/machines";
import { Modal, FormError } from "@/components/modal";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";
import { formatBytes } from "@/features/usage/format";

type Confirmation = {
  candidate: UpgradeCandidate;
  bundledCoreVersion: string | undefined;
  availableBundledCoreVersion: string | undefined;
  requestKey: string;
  stale: boolean;
};

export function MachineUpgrades({
  machine,
  onQueued,
}: {
  machine: MachineDetail;
  onQueued: () => Promise<void>;
}) {
  const resource = useResource(`machine-upgrades:${machine.id}`, () =>
    panel.machines
      .getMachineUpgrades({ machineId: machine.id })
      .then((r) => r.upgrades!),
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reauth, setReauth] = useState(false);
  const machineState = `${machine.coreVersion}/${machine.daemonVersion}/${machine.activeTaskCount}/${machine.maintenanceStatus}/${machine.capabilities.join(",")}`;
  const previousState = useRef(machineState);
  const refresh = resource.refresh;
  useEffect(() => {
    if (previousState.current !== machineState) {
      previousState.current = machineState;
      void refresh();
    }
  }, [machineState, refresh]);

  async function open() {
    setChecking(true);
    setError("");
    setNotice("");
    try {
      const latest = (
        await panel.machines.getMachineUpgrades({ machineId: machine.id })
      ).upgrades!;
      resource.update(latest);
      const candidate = latest.daemon!;
      if (
        !candidate.executable ||
        !candidate.sha256 ||
        !candidate.availableVersion
      ) {
        setConfirmation(null);
        setError(candidate.disabledReason ?? "当前没有可执行的升级制品。");
        return;
      }
      setConfirmation({
        candidate,
        bundledCoreVersion: latest.bundledCoreVersion,
        availableBundledCoreVersion: latest.availableBundledCoreVersion,
        requestKey: crypto.randomUUID(),
        stale: false,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  async function enqueue() {
    if (!confirmation || confirmation.stale) return;
    setBusy(true);
    setError("");
    try {
      await panel.machines.enqueueUpgrade({
        machineId: machine.id,
        expectedSha256: confirmation.candidate.sha256,
        requestKey: confirmation.requestKey,
      });
      setNotice("升级 daemon 任务已排队。");
      setConfirmation(null);
      await Promise.all([onQueued(), resource.refresh()]);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else if (e instanceof ApiError && e.code === "ARTIFACT_CHANGED") {
        setConfirmation({ ...confirmation, stale: true });
        setError("候选制品已更新，请刷新后重新确认版本与 SHA-256。");
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const maintenance = maintenanceInfo(
    machine.maintenanceStatus,
    machine.capabilities.includes(TaskKind.UPGRADE_DAEMON),
  );
  const candidate = resource.data?.daemon;
  const target = confirmation?.candidate;
  return (
    <LayerCard render={<section />} className="machine-upgrades">
      <div className="machine-section-heading">
        <h2>版本与更新</h2>
        <Button
          variant="ghost"
          disabled={resource.loading}
          onClick={resource.refresh}
        >
          检查可用版本
        </Button>
      </div>
      <FormError message={resource.error || (!confirmation ? error : "")} />
      {notice && (
        <Banner role="status" variant="secondary" className="mb-5">
          {notice}
        </Banner>
      )}
      {resource.loading && (
        <p className="subtle" role="status">
          正在检查制品…
        </p>
      )}
      <div className="mb-4">
        <Badge variant={maintenance.available ? "success" : "secondary"}>
          {maintenance.label}
        </Badge>
        <p className="subtle mt-2 leading-relaxed">{maintenance.description}</p>
      </div>
      {candidate && (
        <>
          <Table className="tabular-nums table-fixed">
            <Table.Header>
              <Table.Row>
                <Table.Head>组件</Table.Head>
                <Table.Head>当前版本</Table.Head>
                <Table.Head>可用版本</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <Table.Row>
                <Table.Cell>daemon</Table.Cell>
                <Table.Cell className="break-all">
                  {machine.daemonVersion ?? "未上报"}
                </Table.Cell>
                <Table.Cell className="break-all">
                  {candidate.availableVersion ?? "未提供"}
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.Cell>sing-box</Table.Cell>
                <Table.Cell className="break-all">
                  {resource.data?.bundledCoreVersion || "未上报"}
                </Table.Cell>
                <Table.Cell className="break-all">
                  {resource.data?.availableBundledCoreVersion || "未提供"}
                </Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 mt-5">
            <div className="min-w-0 flex-1">
              {candidate.disabledReason &&
                candidate.disabledReason !== maintenance.description && (
                  <p className="subtle text-xs">{candidate.disabledReason}</p>
                )}
              {candidate.executable && (
                <p className="subtle text-xs">
                  升级前需确认目标版本与文件摘要。
                </p>
              )}
            </div>
            <Button
              disabled={
                !candidate.executable || !maintenance.available || checking
              }
              loading={checking}
              onClick={open}
            >
              升级 daemon
            </Button>
          </div>
        </>
      )}
      {confirmation && target && (
        <Modal
          title="升级 daemon"
          open
          onClose={() => {
            if (!busy && !checking) setConfirmation(null);
          }}
        >
          <div className="stack">
            <p>
              {machine.name} · daemon {target.currentVersion ?? "未上报"} →{" "}
              {target.availableVersion}
            </p>
            <p className="subtle">
              内嵌 sing-box {confirmation.bundledCoreVersion || "未知"} →{" "}
              {confirmation.availableBundledCoreVersion || "未提供版本"}
            </p>
            <Banner
              variant="alert"
              title="代理连接会中断"
              description="daemon 重启会同时重启内嵌 sing-box，代理连接与管理连接都会暂时中断。"
            />
            <p className="subtle">
              重新连接并收到新版本状态后，才确认升级完成。启动失败时会尝试恢复上一版本。
            </p>
            <dl className="stack gap-2 text-xs">
              <div>
                <dt className="subtle mb-1">SHA-256</dt>
                <dd className="break-all font-mono">{target.sha256}</dd>
              </div>
              {target.sizeBytes && (
                <div>
                  <dt className="subtle inline">制品大小 </dt>
                  <dd className="inline">{formatBytes(target.sizeBytes)}</dd>
                </div>
              )}
            </dl>
            <FormError message={error} />
            <div className="actions">
              {confirmation.stale ? (
                <Button variant="primary" loading={checking} onClick={open}>
                  刷新候选版本
                </Button>
              ) : (
                <Button variant="primary" loading={busy} onClick={enqueue}>
                  开始升级
                </Button>
              )}
              <Button
                disabled={busy || checking}
                onClick={() => setConfirmation(null)}
              >
                取消
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {reauth && (
        <Reauthenticate
          onClose={() => setReauth(false)}
          onComplete={() => {
            setReauth(false);
            setError("身份已验证，请再次提交。");
          }}
        />
      )}
    </LayerCard>
  );
}
