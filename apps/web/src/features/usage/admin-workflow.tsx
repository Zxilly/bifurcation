"use client";

import { Badge, LinkButton } from "@cloudflare/kumo";
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
      <section aria-labelledby="admin-next-step" className="admin-workflow">
        <h2 id="admin-next-step">接入第一台机器</h2>
        <p className="subtle">先添加 Linux 机器并执行安装命令，再发布节点配置。节点就绪后，你和受邀用户都可以创建自己的订阅。</p>
        <ol className="admin-workflow-steps">
          <li>添加机器并完成安装</li>
          <li>配置端口与 TLS 证书</li>
          <li>创建订阅或邀请用户</li>
        </ol>
        <div className="actions">
          <LinkButton variant="primary" href="/admin/machines?action=create">添加第一台机器</LinkButton>
          <LinkButton variant="secondary" href="/admin/users?action=create">邀请用户</LinkButton>
        </div>
      </section>
    );
  }
  return (
    <section className="admin-workflow" aria-labelledby="admin-next-step">
      <div className="admin-workflow-heading">
        <h2 id="admin-next-step">接下来要做</h2>
        <LinkButton variant="ghost" href="/admin/machines">管理机器</LinkButton>
      </div>
      {pending.length > 0 && (
        <ul className="admin-workflow-list">
          {pending.slice(0, 5).map(({ machine, action }) => (
            <li key={machine.id} className="admin-workflow-item">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-words font-medium">{machine.name}</h3>
                  <Badge variant={action.urgent ? "destructive" : "secondary"}>{action.title}</Badge>
                </div>
                <p className="subtle mt-2">{action.detail}</p>
              </div>
              <LinkButton variant="secondary" href={action.href} className="justify-self-start">{action.label}</LinkButton>
            </li>
          ))}
          {pending.length > 5 && <li className="admin-workflow-item subtle">还有 {pending.length - 5} 台机器需要处理，可在机器列表查看。</li>}
        </ul>
      )}
      {invitations.length > 0 ? (
        <div className="admin-workflow-item admin-workflow-invitation">
          <div className="min-w-0">
            <h3 className="font-medium">{invitations.length} 位用户等待激活</h3>
            <p className="subtle mt-2 break-words">{invitations.slice(0, 3).map((user) => user.username).join("、")}{invitations.length > 3 ? "等" : ""}。将创建时的激活链接交给用户；链接遗失时可以重新生成。</p>
          </div>
          <LinkButton variant="secondary" href="/admin/users" className="justify-self-start">管理邀请</LinkButton>
        </div>
      ) : !hasMembers ? (
        <div className="admin-workflow-item admin-workflow-invitation">
          <div>
            <h3 className="font-medium">邀请用户加入</h3>
            <p className="subtle mt-2">设置账号与每月额度，通过一次性链接完成激活。</p>
          </div>
          <LinkButton variant="secondary" href="/admin/users?action=create" className="justify-self-start">邀请用户</LinkButton>
        </div>
      ) : null}
      {pending.length === 0 && (
        <div className="admin-workflow-item">
          <p className="subtle">暂无待处理的机器。可创建自己的订阅，或在下方查看用量。</p>
          <LinkButton variant="secondary" href="/subscription" className="justify-self-start">管理我的订阅</LinkButton>
        </div>
      )}
    </section>
  );
}
