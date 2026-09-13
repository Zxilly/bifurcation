"use client";

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
    panel.machines.getMachineUpgrades({ machineId: machine.id }).then((r) => r.upgrades!),
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reauth, setReauth] = useState(false);
  const machineState = `${machine.coreVersion}/${machine.daemonVersion}/${machine.activeTaskCount}`;
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

  const candidate = resource.data?.daemon;
  const target = confirmation?.candidate;
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>daemon 更新</h2>
        <Button variant="ghost" onClick={resource.refresh}>
          检查可用版本
        </Button>
      </div>
      <FormError message={resource.error || (!confirmation ? error : "")} />
      {notice && (
        <p role="status" className="notice mb-5">
          {notice}
        </p>
      )}
      {resource.loading && (
        <p className="subtle" role="status">
          正在检查制品…
        </p>
      )}
      {candidate && (
        <div className="upgrade-row">
          <div className="stack gap-2 min-w-0 break-words">
            <p>
              <span className="subtle">当前 daemon </span>
              {machine.daemonVersion ?? "未上报"}
            </p>
            <p>
              <span className="subtle">内嵌 sing-box </span>
              {resource.data?.bundledCoreVersion || "未上报"}
            </p>
            {candidate.availableVersion && (
              <>
                <p>
                  <span className="subtle">可用 daemon </span>
                  {candidate.availableVersion}
                  {candidate.sameVersion && (
                    <Badge className="ml-2" variant="secondary">
                      同版本
                    </Badge>
                  )}
                </p>
                <p>
                  <span className="subtle">携带 sing-box </span>
                  {resource.data?.availableBundledCoreVersion || "未提供版本"}
                </p>
              </>
            )}
            {candidate.disabledReason && (
              <p className="subtle text-xs">{candidate.disabledReason}</p>
            )}
          </div>
          <Button
            disabled={!candidate.executable || checking}
            loading={checking}
            onClick={open}
          >
            升级 daemon
          </Button>
        </div>
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
            <div className="notice">
              <p className="font-medium">代理连接会中断</p>
              <p className="mt-1">
                daemon 重启会同时重启内嵌
                sing-box，代理连接与管理连接都会暂时中断。
              </p>
            </div>
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
    </section>
  );
}
