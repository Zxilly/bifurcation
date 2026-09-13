import { Badge } from "@cloudflare/kumo/components/badge";
import { DiagnosticResult } from "./diagnostic";
import type { MachineTaskKind, TaskDto } from "@/contracts/machines";

const taskName: Record<MachineTaskKind, string> = {
  inspect: "运行信息与日志",
  apply_config: "应用配置",
  upgrade_daemon: "升级 daemon",
  uninstall: "卸载",
};
const taskState = {
  queued: "等待执行",
  accepted: "已接受",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  superseded: "已替代",
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

function isActiveTask(task: TaskDto) {
  return ["queued", "accepted", "running"].includes(task.state);
}

export function ActiveTasks({
  tasks,
  streamConnected,
}: {
  tasks: TaskDto[];
  streamConnected: boolean;
}) {
  const active = tasks.filter(isActiveTask);
  if (!active.length) return null;
  return (
    <section className="panel">
      <h2>进行中的任务</h2>
      <div className="stack mt-5">
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
              {task.progressPercent !== null && (
                <span>{task.progressPercent}%</span>
              )}
            </div>
            {task.progressPercent !== null && (
              <progress
                className="task-progress"
                value={task.progressPercent}
                max={100}
                aria-label={`${taskName[task.kind]}进度`}
              />
            )}
            {task.message && <p>{task.message}</p>}
            {task.kind === "upgrade_daemon" &&
              task.state === "running" &&
              !streamConnected && (
                <p role="status" className="notice">
                  等待机器重连和执行结果，尚未确认升级是否完成。
                </p>
              )}
            {task.kind === "upgrade_daemon" &&
              task.state === "running" &&
              streamConnected &&
              task.phase &&
              [
                "updater_ready",
                "switching",
                "starting",
                "local_healthy",
                "result_pending_ack",
              ].includes(task.phase) && (
                <p role="status" className="notice">
                  更新器已接手，等待执行结果。
                </p>
              )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function TaskHistory({ tasks }: { tasks: TaskDto[] }) {
  const history = tasks.filter((task) => !isActiveTask(task));
  if (!history.length) return <p className="empty-state">暂无已完成操作</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>更新时间</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {history.map((task) => (
            <tr key={task.id}>
              <td>{taskName[task.kind]}</td>
              <td>
                <Badge
                  variant={
                    task.state === "failed" ? "destructive" : "secondary"
                  }
                >
                  {taskState[task.state]}
                </Badge>
              </td>
              <td>{timestamp.format(task.updatedAt)}</td>
              <td>
                <details>
                  <summary className="cursor-pointer py-1">查看详情</summary>
                  <div className="stack gap-3 min-w-64 max-w-xl whitespace-normal break-words py-3">
                    {task.message && <p>{task.message}</p>}
                    {task.errorCode && (
                      <p className="form-error">错误代码：{task.errorCode}</p>
                    )}
                    {task.phase && (
                      <p>最终阶段：{phaseName[task.phase] ?? task.phase}</p>
                    )}
                    {task.rollback === "succeeded" && (
                      <p>机器已报告回滚成功。</p>
                    )}
                    {task.rollback === "failed" && (
                      <p className="form-error">
                        机器已报告回滚失败，需要检查节点。
                      </p>
                    )}
                    <p className="subtle text-xs">
                      创建于 {timestamp.format(task.createdAt)}
                    </p>
                    <p className="subtle text-xs break-all">
                      任务 ID：{task.id}
                    </p>
                    {task.diagnostic !== null && (
                      <DiagnosticResult value={task.diagnostic} />
                    )}
                  </div>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
