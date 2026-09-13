# 面板备份与恢复

面板提供 `scripts/backup.mjs`。备份使用 SQLite online backup API，包含已提交的 WAL 数据，能够在面板运行时执行；不通过直接复制正在写入的 `.sqlite` 文件取得快照。

每份备份目录包含 `panel.sqlite` 和 `metadata.json`。元数据记录生成时间、原公开地址、站点时区、数据库 SHA-256、迁移记录和应用密钥的 SHA-256。**元数据不含应用密钥。必须另外保存原 `BIFURCATION_APP_KEY` 或包含它的 `.env`**；丢失密钥后，数据库中的机器 token、代理凭据、订阅链接、配置和证书私钥无法恢复解密。

## 在线备份

将下面的 `backup-name` 换成唯一名称。目录已存在时命令会拒绝覆盖。

```sh
docker compose exec panel node scripts/backup.mjs create /data/backups/backup-name
docker compose exec panel node scripts/backup.mjs inspect /data/backups/backup-name
docker compose cp panel:/data/backups/backup-name ./backups/backup-name
```

`inspect` 校验数据库摘要、结构、外键、迁移记录和当前应用密钥。备份成功不等于已经离开面板数据卷；把备份目录和原密钥分别保存到独立、受访问权限保护的位置。备份目录中出现数据库文件但没有有效 `metadata.json`，表示备份没有完成，不应当作为可恢复快照。

Windows 本地开发也可以运行：

```powershell
pnpm --filter @bifurcation/web build:admin
# 使用开发面板原有的环境变量，工作目录为 apps/web。
node scripts/backup.mjs create C:/Backups/bifurcation/backup-name
```

## 离线恢复

自动恢复仅支持 Linux，并与生产面板入口共用 `${BIFURCATION_DATABASE_PATH}.lock`。运行中的面板持有 `flock`；恢复命令不能取得独占锁时会停止，不使用跨容器 PID 推断是否在线。Windows 开发环境不提供自动覆盖库的恢复命令。

1. 保留当前 `.env` 和应用密钥，确认准备恢复的备份对应哪一把密钥。将目标备份完整放入面板数据卷。恢复不会改写 `.env` 或自动生成替代密钥。
2. 停止面板，使所有使用同一数据库的面板进程退出。不要删除数据卷。
3. 使用与备份匹配的 `BIFURCATION_APP_KEY`，通过一次性容器运行恢复。这里覆盖默认 entrypoint，使恢复 CLI 自己取得同一个锁。
4. 恢复成功后再启动面板，检查迁移、登录、机器连接和待处理任务。

```sh
docker compose stop panel
docker compose run --rm --no-deps --entrypoint node panel scripts/backup.mjs restore /data/backups/backup-name
docker compose up -d panel
docker compose logs --tail 100 panel
```

恢复先验证快照和密钥，将文件复制到目标数据库同目录的临时文件并再次校验。现有库会先保存为 `*.before-restore-*.sqlite`；正常旧库使用一致备份，并在替换前完成 WAL checkpoint。损坏的旧库会保留原始字节为 `.raw`，相关 WAL/SHM 也保留。最后使用同文件系统的原子 rename 替换目标文件。恢复前的保留文件不会自动删除；确认恢复结果并另外保存需要保留的旧密钥后，再由操作者处理。

自动恢复要求面板使用项目的共享锁入口。不要让手工 `node server.js`、开发服务器或其他 SQLite 写入程序绕过这个入口并同时操作生产数据库。

## 旧快照的恢复边界

数据库一致恢复不能补回快照之后的信息，也不代表节点控制状态已经自动恢复：

- 已经在面板确认、且已被 daemon 从 outbox 删除的用量，可能在旧备份中不存在。daemon 检测到服务端高水位倒退时应报告缺口，不能跳号确认、凭空补数或把缺失数据显示成完整的零流量。
- 快照之后可能发生过禁用用户、代理凭据轮换和权限撤销。先核对当前应有授权及每台节点的实际状态，再执行配置协调；不要盲目恢复旧用户的接入权限。
- daemon 持久化的授权版本下限可能高于旧面板快照。恢复脚本不会下调这个下限，不会清空节点 journal/outbox，也不会自动提高一个计数来绕过授权核对。出现版本冲突时保留节点状态，核对最新授权后再处理。
- 保留原公开 origin 可以维持 Passkey 的 RP/origin 关系和已有节点地址。迁移域名需要另外处理凭据和节点连接配置，不能仅依靠数据库复制。

面板数据库、应用密钥和节点本地状态分别承担不同恢复职责。这里的 CLI 只处理面板一致快照与离线文件恢复，不对节点进行卸载、覆盖配置或回退二进制。
