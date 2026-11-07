# 会话清理 / Session cleanup

一个 DeepSeek Harness 插件：**删除已归档的会话**（DSH 本身没有删除会话的能力），并清理项目生成过程中留下的 Harness 临时文件。所有删除都先进入**可恢复的隔离区**，项目源码永远不会被碰。

A DeepSeek Harness plugin that permanently removes archived Sessions — DSH has no delete verb of its own — plus stale Harness scratch data. Every removal lands in a restorable trash first; project source files are never touched.

- 仓库 / Repository: <https://github.com/flairamos/dsh-session-del>
- 包名 / Package: `dsh-plugin-session-cleanup`
- 许可证 / License: MIT

## 安装 / Install

在 Harness 的 **设置 → 插件**（Plugin Manager）里选择安装，并填入下面任意一种地址：

| 方式 | 填入的地址 |
| --- | --- |
| GitHub 仓库地址 | `https://github.com/flairamos/dsh-session-del` |
| GitHub 简写 | `github:flairamos/dsh-session-del` |
| 本地开发（绝对路径） | `D:\Projects\dsh-session-del` |

也可以让 Agent 调 `plugin_manager` 的 `install_bundle`，`target` 传同样三种字符串之一。安装后 profile 里记录的依赖形如 `github:flairamos/dsh-session-del`，重启或换会话都仍然生效。

> **网络提示**：安装前 Harness 会用 5 秒超时做一次 GitHub 连通性预检。国内网络对 github.com 的连接时常被重置，若提示 `connection to github.com timed out`，直接重试即可；git 侧的重试通常能成功。

卸载：在插件管理里移除 `dsh-plugin-session-cleanup` 这个 bundle。

## 界面 / What you get

- **设置 → 存储清理**：完整清单。已归档会话（标题、目录、大小、时间）可多选后移入隔离区；隔离区可单批恢复或整体清空；临时文件区列出过期目录并可一键移入隔离区。
- **侧边栏会话行 “…” 菜单 →「永久删除」**：只对已归档的会话显示，一次删除一个会话（连同它的子代理会话）。

## 删除时到底发生什么 / What a delete actually does

1. 从它所属的 Workspace 里 `detachSession`（会话行随之从侧边栏消失）。
2. 通过 `workspaceRegistry.unarchiveSession` 清掉归档登记（走官方 API，不手改 `workspace.json`）。
3. 把会话日志目录 `~/.dsh/sessions/<workspace>/<session-id>/` 移入隔离区。
4. 把投影缓存 `~/.dsh/storages/session_projcache/sessions/<session-id>.json` 移入隔离区。
5. 该会话的**子代理会话**（`parentSession` 指向它的日志）一并删除。
6. 写一份 `manifest.json`，记录原路径、所属 Workspace、原来的位置与归档状态，供恢复使用。

特殊情况：

- **文件已经不在、只剩归档登记**：不产生隔离批次，只清掉登记，结果里记为 `cleaned`。设置页会把这类行标成「文件已不在」。
- **拒绝删除**：会话没有归档（API 层可用 `requireArchived: false` 关闭），或会话正在运行（`agent.status === 'running'`）。

## 隔离区 / Trash

```
~/.dsh/trash/session-cleanup/<批次时间戳>/
├── manifest.json        # 恢复所需的原始路径与归属
├── sessions/<session-id>/session.v4.jsonl.zstd
├── projcache/<session-id>.json
└── temp/<临时目录名>/
```

- **恢复**：把文件搬回原处，重新挂回原 Workspace（含原位置），并恢复归档状态。
- **清空隔离区**：`rm -rf` 整个 `trash/session-cleanup`，此操作不可撤销。

## 临时文件的范围 / Scratch-file scope

只清理操作系统临时目录里、**超过 6 小时未改动**的 Harness 目录：

- `dsh-spill-*`（工具输出溢出）
- `dsh-workspace-changes-*`（工作区变更记录）
- `dsh-subprocess-*`（子进程临时文件）

刻意**不**动：`dsh-acl-*`（沙箱 ACL 锁）、`~/.dsh/attachments`、`~/.dsh/cache`、任何项目目录内的文件。

## 实现要点 / How it is wired

- Host 半在 `ctx.webServer` 上注册一条同源 JSON 路由 `POST /dsh-session-cleanup/rpc`，随插件装卸而生效；请求必须带 `x-dsh-cleanup: 1` 头，跨站请求因此被 CORS 预检挡掉。
- 所有写操作串行执行（一个队列），读操作可并发。
- 根目录不是写死的：优先从 `sessionPersistence` 的快照路径反推 `~/.dsh`，其次 `DSH_PROFILE_DIR`、`DSH_HOME`、`~/.dsh`。
- 迁移用 `rename`，跨卷时退化为复制后删除。
- 打包元数据在 `package.json` 的 `dsh` 字段：`dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` 声明浏览器半。

## 开发 / Development

```powershell
# 改了代码想让本机立刻生效：用绝对路径装回来（链接，不复制）
plugin_manager install_bundle target=D:\Projects\dsh-session-del
```

链接安装后改动是即时可见的（Host 半重载插件、Client 半刷新页面）；从 GitHub 安装的是快照，更新需要重新安装。

## 卸载后 / After removal

隔离区不会自动删除，需要时可手动删 `~/.dsh/trash`。
