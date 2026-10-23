"use client";

import { Badge, LayerCard, LinkButton } from "@cloudflare/kumo";
import { CoreHealth } from "@bifurcation/rpc";
import { MachineConnection, type Machine } from "@bifurcation/rpc/panel/machines";
import { Role, UserStatus, type User } from "@bifurcation/rpc/panel/types";

function nextMachineAction(machine: Machine) {
  const href = `/admin/machines/${machine.id}`;
  if (!machine.installationId || machine.connection === MachineConnection.WAITING)
    return { title: "等待接入", detail: "在这台 Linux 机器上执行安装命令，接入后即可发布配置。", label: "查看安装命令", href: `${href}?tab=maintenance`, urgent: false };
  if (machine.connection === MachineConnection.OFFLINE)
    return { title: "机器失联", detail: "当前运行状态无法确认。请检查机器与面板的连接；失联不代表代理已停止。", label: "检查接入状态", href: `${href}?tab=maintenance`, urgent: true };
  if (machine.coreHealth === CoreHealth.UNHEALTHY || machine.coreHealth === CoreHealth.STOPPED)
    return { title: machine.coreHealth === CoreHealth.STOPPED ? "代理已停止" : "代理异常", detail: "查看最近操作结果并获取运行日志，确认原因后再修改配置。", label: "查看操作与日志", href: `${href}?tab=activity`, urgent: true };
  if (machine.activeTaskCount > 0)
    return { title: "等待操作完成", detail: `${machine.activeTaskCount} 项任务正在等待或执行，查看节点回报后再继续。`, label: "查看执行进度", href: `${href}?tab=activity`, urgent: false };
  if (machine.coreHealth === CoreHealth.NOT_CONFIGURED || !machine.appliedRevisionId)
    return { title: "等待配置", detail: "机器已接入。设置监听端口和 TLS 证书，预览后发布到节点。", label: "准备节点配置", href: `${href}/configuration`, urgent: false };
  if (machine.coreHealth === CoreHealth.UNSPECIFIED)
    return { title: "等待状态上报", detail: "节点尚未报告代理运行状态，可在机器详情查看最近上报。", label: "查看节点状态", href, urgent: false };
  return null;
}

export function AdminWorkflow({ machines, users }: { machines: Machine[]; users: User[] }) {
  const installed = machines.filter((machine) => !machine.uninstalled);
  const pending = installed.flatMap((machine) => {
    const action = nextMachineAction(machine);
    return action ? [{ machine, action }] : [];
  }).sort((a, b) => Number(b.action.urgent) - Number(a.action.urgent));
  const invitations = users.filter((user) => user.status === UserStatus.PENDING);
  const hasMembers = users.some((user) => user.role === Role.USER);
  if (!installed.length) {
    return (
      <LayerCard render={<section aria-labelledby="admin-next-step" />} className="panel mb-6">
        <h2 id="admin-next-step">接入第一台机器</h2>
        <p className="subtle mt-2 max-w-2xl">先添加 Linux 机器并执行安装命令，再发布节点配置。节点就绪后，你和受邀用户都可以创建自己的订阅。</p>
        <ol className="mt-5 grid list-decimal gap-2 pl-5 text-sm sm:grid-cols-3 sm:gap-6">
          <li>添加机器并完成安装</li>
          <li>配置端口与 TLS 证书</li>
          <li>创建订阅或邀请用户</li>
        </ol>
        <div className="actions mt-5">
          <LinkButton variant="primary" href="/admin/machines?action=create">添加第一台机器</LinkButton>
          <LinkButton variant="secondary" href="/admin/users?action=create">邀请用户</LinkButton>
        </div>
      </LayerCard>
    );
  }
  return (
    <section className="panel-section stack mb-6" aria-labelledby="admin-next-step">
      <div className="panel-header">
        <h2 id="admin-next-step">接下来要做</h2>
        <LinkButton variant="ghost" href="/admin/machines">管理机器</LinkButton>
      </div>
      {pending.length > 0 && (
        <ul className="divide-y divide-kumo-line">
          {pending.slice(0, 5).map(({ machine, action }) => (
            <li key={machine.id} className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 max-w-2xl">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-words font-medium">{machine.name}</h3>
                  <Badge variant={action.urgent ? "destructive" : "secondary"}>{action.title}</Badge>
                </div>
                <p className="subtle mt-1 text-sm">{action.detail}</p>
              </div>
              <LinkButton variant="secondary" href={action.href} className="self-start shrink-0 sm:self-center">{action.label}</LinkButton>
            </li>
          ))}
          {pending.length > 5 && <li className="py-3 subtle text-sm">还有 {pending.length - 5} 台机器需要处理，可在机器列表查看。</li>}
        </ul>
      )}
      {invitations.length > 0 ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="font-medium">{invitations.length} 位用户等待激活</h3>
            <p className="subtle mt-1 break-words text-sm">{invitations.slice(0, 3).map((user) => user.username).join("、")}{invitations.length > 3 ? "等" : ""}。将创建时的激活链接交给用户；链接遗失时可以重新生成。</p>
          </div>
          <LinkButton variant="secondary" href="/admin/users" className="self-start shrink-0 sm:self-center">管理邀请</LinkButton>
        </div>
      ) : !hasMembers ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-medium">邀请用户加入</h3>
            <p className="subtle mt-1 text-sm">设置账号与每月额度，通过一次性链接完成激活。</p>
          </div>
          <LinkButton variant="secondary" href="/admin/users?action=create" className="self-start shrink-0 sm:self-center">邀请用户</LinkButton>
        </div>
      ) : null}
      {pending.length === 0 && (
        <div className="actions">
          <p className="subtle text-sm">暂无待处理的机器。可创建自己的订阅，或在下方查看用量。</p>
          <LinkButton variant="secondary" href="/subscription">管理我的订阅</LinkButton>
        </div>
      )}
    </section>
  );
}
