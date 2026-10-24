"use client";

import { useState } from "react";
import { LayerCard, Banner, Table, Button } from "@cloudflare/kumo";
import { InlineEmpty } from "@/components/inline-empty";
import { Badge } from "@cloudflare/kumo/components/badge";
import { TaskKind } from "@bifurcation/rpc";
import {
  RollbackState,
  TaskState,
  type Task,
} from "@bifurcation/rpc/panel/machines";
import { DiagnosticResult } from "./diagnostic";

const taskName: Record<number, string> = {
  [TaskKind.INSPECT]: "运行信息与日志",
  [TaskKind.APPLY_CONFIG]: "应用配置",
  [TaskKind.UPGRADE_DAEMON]: "升级 daemon",
  [TaskKind.UNINSTALL]: "卸载",
};
const taskState: Record<number, string> = {
  [TaskState.QUEUED]: "等待执行",
  [TaskState.ACCEPTED]: "已接受",
  [TaskState.RUNNING]: "执行中",
  [TaskState.SUCCEEDED]: "已完成",
  [TaskState.FAILED]: "失败",
  [TaskState.CANCELED]: "已取消",
  [TaskState.SUPERSEDED]: "已替代",
};
const phaseName: Record<string, string> = {
  running: "执行中",
  completed: "已完成",
  complete: "已完成",
  downloading: "下载制品",
  downloaded: "制品已下载",
  verifying: "校验制品",
  verified: "校验通过",
  prepared: "已准备候选版本",
  updater_ready: "更新器已接手",
  switching: "切换版本",
  starting: "启动候选版本",
  local_healthy: "本地健康检查通过",
  result_pending_ack: "等待面板确认",
  waiting_for_reconnect: "等待重连",
  rollback: "正在回滚",
  rolling_back: "正在回滚",
  rolled_back: "已回滚",
  draining_usage: "提交积压用量",
  stopping_core: "停止代理",
  stopping_daemon: "停止 daemon",
  removing_services: "移除服务",
  uninstalled: "已卸载",
};
const timestamp = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
});

const ACTIVE_STATES = new Set<TaskState>([
  TaskState.QUEUED,
  TaskState.ACCEPTED,
  TaskState.RUNNING,
]);
function isActiveTask(task: Task) {
  return ACTIVE_STATES.has(task.state);
}

export function ActiveTasks({
  tasks,
  streamConnected,
}: {
  tasks: Task[];
  streamConnected: boolean;
}) {
  const active = tasks.filter(isActiveTask);
  if (!active.length) return null;
  return (
    <LayerCard render={<section />} className="machine-active-tasks">
      <h2>进行中的任务</h2>
      <div className="stack mt-4">
        {active.map((task) => (
          <div key={task.id} className="stack gap-3">
            <div className="actions">
              <Badge variant="secondary">{taskState[task.state]}</Badge>
              <h3 className="font-medium">{taskName[task.kind]}</h3>
              {task.phase && (
                <span className="subtle">
                  {phaseName[task.phase] ?? task.phase}
                </span>
              )}
              {task.progressPercent != null && (
                <span>{task.progressPercent}%</span>
              )}
            </div>
            {task.progressPercent != null && (
              <progress
                className="task-progress"
                value={task.progressPercent}
                max={100}
                aria-label={`${taskName[task.kind]}进度`}
              />
            )}
            {task.message && <p>{task.message}</p>}
            {task.kind === TaskKind.UPGRADE_DAEMON &&
              task.state === TaskState.RUNNING &&
              !streamConnected && (
                <Banner role="status" variant="secondary">
                  等待机器重连和执行结果，尚未确认升级是否完成。
                </Banner>
              )}
            {task.kind === TaskKind.UPGRADE_DAEMON &&
              task.state === TaskState.RUNNING &&
              streamConnected &&
              task.phase &&
              [
                "updater_ready",
                "switching",
                "starting",
                "local_healthy",
                "result_pending_ack",
              ].includes(task.phase) && (
                <Banner role="status" variant="secondary">
                  更新器已接手，等待执行结果。
                </Banner>
              )}
          </div>
        ))}
      </div>
    </LayerCard>
  );
}

export function TaskHistory({ tasks }: { tasks: Task[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const history = tasks.filter((task) => !isActiveTask(task));
  const selected = history.find((task) => task.id === selectedId) ?? history[0];
  if (!selected) {
    return (
      <LayerCard className="machine-section">
        <InlineEmpty title="暂无已完成操作" description="任务执行完成后会记录在这里。" />
      </LayerCard>
    );
  }
  return (
    <LayerCard className="machine-task-inspector p-0">
      <div className="machine-task-list">
        <Table className="machine-task-table tabular-nums" aria-label="操作历史">
          <Table.Header>
            <Table.Row>
              <Table.Head>任务</Table.Head>
              <Table.Head>状态</Table.Head>
              <Table.Head>更新时间</Table.Head>
              <Table.Head><span className="sr-only">结果</span></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {history.map((task) => (
              <Table.Row key={task.id} data-selected={task.id === selected.id || undefined}>
                <Table.Cell>
                  {taskName[task.kind]}
                  <span className="machine-task-mobile-meta">
                    <time dateTime={new Date(Number(task.updatedAt)).toISOString()}>{timestamp.format(Number(task.updatedAt))}</time>
                    <span>{task.id.slice(0, 8)}</span>
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Badge
                    variant={
                      task.state === TaskState.FAILED
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {taskState[task.state]}
                  </Badge>
                </Table.Cell>
                <Table.Cell className="machine-task-updated">
                  <time dateTime={new Date(Number(task.updatedAt)).toISOString()}>{timestamp.format(Number(task.updatedAt))}</time>
                </Table.Cell>
                <Table.Cell>
                  <Button variant="ghost" size="sm" aria-pressed={task.id === selected.id} aria-controls="machine-task-detail" onClick={() => setSelectedId(task.id)}>
                    查看详情
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <section id="machine-task-detail" className="machine-task-detail" aria-label="任务详情">
        <div className="machine-section-heading">
          <h3>{taskName[selected.kind] ?? "节点任务"}</h3>
          <Badge variant={selected.state === TaskState.FAILED ? "destructive" : "secondary"}>
            {taskState[selected.state]}
          </Badge>
        </div>
        <dl className="machine-task-facts">
          <div><dt>任务 ID</dt><dd>{selected.id}</dd></div>
          <div><dt>创建时间</dt><dd>{timestamp.format(Number(selected.createdAt))}</dd></div>
          <div><dt>更新时间</dt><dd>{timestamp.format(Number(selected.updatedAt))}</dd></div>
          {selected.phase && <div><dt>最终阶段</dt><dd>{phaseName[selected.phase] ?? selected.phase}</dd></div>}
        </dl>
        {selected.message && <p className="break-words">{selected.message}</p>}
        {selected.errorCode && <p className="form-error">错误代码：{selected.errorCode}</p>}
        {selected.rollback === RollbackState.SUCCEEDED && <p>机器已报告回滚成功。</p>}
        {selected.rollback === RollbackState.FAILED && <p className="form-error">机器已报告回滚失败，需要检查节点。</p>}
        {selected.diagnostic != null && <DiagnosticResult key={selected.id} value={selected.diagnostic} />}
      </section>
    </LayerCard>
  );
}
