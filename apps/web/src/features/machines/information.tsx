"use client";

import { useState } from "react";
import { Button, Input } from "@cloudflare/kumo";
import { TaskState, type MachineDetail } from "@bifurcation/rpc/panel/machines";
import { Modal, FormError } from "@/components/modal";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";

export function MachineInformationAction({
  machine,
  mode,
  onChanged,
  triggerLabel,
}: {
  machine: MachineDetail;
  mode: "edit" | "rebind";
  onChanged: (machine: MachineDetail, message: string) => void;
  triggerLabel?: string;
}) {
  const [snapshot, setSnapshot] = useState<MachineDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const replacementBlocked =
    mode === "rebind" &&
    machine.tasks.some(
      (task) => task.state === TaskState.ACCEPTED || task.state === TaskState.RUNNING,
    );
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "edit"
          ? await panel.machines.updateMachine({
              machineId: machine.id,
              expectedVersion: snapshot.version,
              name: String(values.get("name")),
              address: String(values.get("address")),
              region: String(values.get("region") ?? ""),
            })
          : await panel.machines.rebindMachine({
              machineId: machine.id,
              expectedVersion: snapshot.version,
            });
      onChanged(
        result.machine!,
        mode === "edit"
          ? "机器信息已保存。"
          : "安装身份已重置，请使用新安装命令接入；已保存配置将自动安装。",
      );
      setSnapshot(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        try {
          const latest = await panel.machines.getMachine({ machineId: machine.id });
          onChanged(latest.machine!, "");
        } catch {
          /* The original conflict remains actionable. */
        }
        setError("机器信息已被更新，请取消后重新操作。");
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const label = mode === "edit" ? "编辑信息" : "替换安装实例";
  return (
    <>
      <Button
        variant={triggerLabel ? "primary" : "ghost"}
        disabled={replacementBlocked}
        title={replacementBlocked ? "请等待执行中的任务结束" : undefined}
        onClick={() => {
          setSnapshot(machine);
          setError("");
        }}
      >
        {triggerLabel ?? label}
      </Button>
      {snapshot && (
        <Modal
          title={mode === "edit" ? "编辑机器信息" : label}
          open
          onClose={() => {
            if (!busy) setSnapshot(null);
          }}
        >
          <form className="stack" onSubmit={submit}>
            {mode === "edit" ? (
              <>
                <Input
                  label="名称"
                  name="name"
                  defaultValue={snapshot.name}
                  maxLength={80}
                  required
                />
                <Input
                  label="地址"
                  name="address"
                  defaultValue={snapshot.address}
                  maxLength={253}
                  required
                />
                <Input
                  label="区域"
                  name="region"
                  defaultValue={snapshot.region}
                  maxLength={80}
                />
              </>
            ) : (
              <>
                <p>
                  旧 Token
                  将失效，新实例接入后会自动安装已保存配置，历史用量与操作记录保留。
                </p>
                {!snapshot.uninstalled && (
                  <p className="notice">旧机器上的程序不会自动卸载。</p>
                )}
                {replacementBlocked && (
                  <p className="subtle">
                    请等待正在执行的任务结束，再替换实例。
                  </p>
                )}
              </>
            )}
            <FormError message={error} />
            <div className="actions">
              <Button
                variant={mode === "edit" ? "primary" : "destructive"}
                type="submit"
                loading={busy}
                disabled={replacementBlocked}
              >
                {mode === "edit" ? "保存信息" : label}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setSnapshot(null)}
              >
                取消
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
