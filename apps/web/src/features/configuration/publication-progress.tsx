"use client";

import { useEffect, useRef } from "react";
import { Banner, Button, Collapsible, LayerCard, LinkButton } from "@cloudflare/kumo";
import { Progress } from "@cloudflare/kumo/primitives/progress";
import { Reconciliation, type MachineConfiguration, type PublishConfigurationResponse } from "@bifurcation/rpc/panel/configuration";
import { MachineConnection, RollbackState, TaskState } from "@bifurcation/rpc/panel/machines";
import { ResourceFeedback } from "@/components/resource-feedback";
import { resourceKeys } from "@/features/shared/keys";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";

export function PublicationProgress({
  machineId,
  publication,
  onEdit,
}: {
  machineId: string;
  publication: PublishConfigurationResponse;
  onEdit: (configuration: MachineConfiguration | null) => void;
}) {
  const configurationResource = useResource(
    resourceKeys.machineConfiguration(machineId),
    () => panel.configuration.getMachineConfiguration({ machineId }).then((r) => r.configuration!),
    { refreshInterval: 2_000 },
  );
  const machineResource = useResource(
    resourceKeys.machine(machineId),
    () => panel.machines.getMachine({ machineId }).then((r) => r.machine!),
    { refreshInterval: 2_000 },
  );
  const configuration = configurationResource.data;
  // The configuration's latest task may belong to a later publication. Follow
  // this receipt's immutable task, and require the node's applied revision too.
  const task = machineResource.data?.tasks.find((entry) => entry.id === publication.task?.id) ?? publication.task;
  const fresh = !configurationResource.error && !machineResource.error;
  const replaced = !!configuration && configuration.version > publication.version && configuration.desiredRevisionId !== publication.revisionId;
  const applied = fresh && !replaced && task?.state === TaskState.SUCCEEDED &&
    configuration?.desiredRevisionId === publication.revisionId &&
    configuration.appliedRevisionId === publication.revisionId &&
    configuration.reconciliation === Reconciliation.APPLIED;
  const failed = task?.state === TaskState.FAILED;
  const stopped = task?.state === TaskState.CANCELED || task?.state === TaskState.SUPERSEDED;
  const title = !fresh ? "发布状态暂时无法确认"
    : replaced ? "已有更新的配置发布"
    : applied ? "节点已确认应用配置"
    : failed ? "配置应用失败"
    : stopped ? "本次发布已停止"
    : task?.state === TaskState.SUCCEEDED ? "等待节点确认生效"
    : task?.state === TaskState.RUNNING ? "节点正在检查并应用配置"
    : "配置已发布，等待节点执行";
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <LayerCard render={<section aria-labelledby="publication-heading" />} className="configuration-publication stack">
      <div role="status" aria-live="polite">
        <h2 id="publication-heading" ref={heading} tabIndex={-1}>{title}</h2>
        <p className="subtle mt-2">
          本次发布：版本 {publication.version}。{!fresh ? "已保留发布记录，恢复连接后会继续更新。" : replaced
            ? "本次结果与当前目标配置不同，请查看最新配置再决定下一步。"
            : applied ? "可创建自己的订阅，或邀请用户加入。"
            : failed || stopped ? "发布内容已保存，可以返回修改并重新生成预览。"
            : "此页面会自动更新，无需手动刷新。"}
        </p>
      </div>
      <ResourceFeedback {...configurationResource} onRetry={configurationResource.refresh} />
      <ResourceFeedback {...machineResource} onRetry={machineResource.refresh} />
      {fresh && !applied && !replaced && machineResource.data?.connection === MachineConnection.OFFLINE && (
        <Banner variant="alert" role="status">机器已失联，尚不能确认本次配置是否生效。机器重新连接后会继续回报结果。</Banner>
      )}
      {task?.message && <p className="break-words">{task.message}</p>}
      {task?.progressPercent != null && task.state === TaskState.RUNNING && (
        <div className="stack gap-2">
          <p className="subtle text-sm">节点报告进度：{task.progressPercent}%</p>
          <Progress.Root className="w-full" aria-label="配置应用进度" value={task.progressPercent} max={100} locale="zh-CN">
            <Progress.Track className="h-2 w-full overflow-hidden rounded-full bg-kumo-fill">
              <Progress.Indicator className="h-full rounded-full bg-kumo-brand" />
            </Progress.Track>
          </Progress.Root>
        </div>
      )}
      {failed && task.rollback === RollbackState.SUCCEEDED && <p>节点报告已恢复上一可用配置。</p>}
      {failed && task.rollback === RollbackState.FAILED && <Banner variant="error" role="alert">回滚失败，请立即检查节点运行日志。</Banner>}
      <div className="actions">
        {applied ? (
          <>
            <LinkButton variant="primary" href="/subscription">管理我的订阅</LinkButton>
            <LinkButton variant="secondary" href="/admin/users?action=create">邀请用户</LinkButton>
          </>
        ) : (failed || stopped || replaced) ? (
          <Button variant="primary" disabled={replaced && (!configuration || !fresh)} onClick={() => onEdit(replaced ? configuration : null)}>
            {replaced ? "编辑最新配置" : "返回修改并重试"}
          </Button>
        ) : null}
        <LinkButton variant="secondary" href={`/admin/machines/${machineId}?tab=activity`}>查看操作与日志</LinkButton>
        <LinkButton variant="ghost" href={`/admin/machines/${machineId}`}>返回机器详情</LinkButton>
      </div>
      <Collapsible.Root>
        <Collapsible.DefaultTrigger>发布记录</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
        <dl className="space-y-2 break-all text-sm text-kumo-subtle">
          <div><dt>本次配置</dt><dd>{publication.revisionId}</dd></div>
          <div><dt>本次任务</dt><dd>{publication.task?.id ?? "未返回"}</dd></div>
          <div><dt>节点已应用配置</dt><dd>{configuration?.appliedRevisionId || "尚未确认"}</dd></div>
        </dl>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </LayerCard>
  );
}
