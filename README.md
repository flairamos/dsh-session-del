# 会话清理 / Session cleanup

一个 DeepSeek Harness 插件：**删除已归档的会话**（DSH 本身没有删除会话的能力），并顺带清理项目生成过程中留下的 Harness 临时文件。所有删除都先进入**可恢复的隔离区**，项目源码永远不会被碰。

A Harness plugin that permanently removes archived Sessions (DSH has no delete verb) plus stale Harness scratch data. Every removal lands in a restorable trash first; project source files are never touched.

## 安装形态 / What gets installed

| 部分 | 内容 |
| --- | --- |
| Bundle 名 | `@local/dsh-session-cleanup` |
| Host 行 | `include:session-cleanup` |
| Client 模块 | `@local/dsh-session-cleanup`（`./client`） |
| 来源 | `link:D:\Projects\dsh-session-del`（本地目录链接，改代码后重载插件即可生效） |

## 界面 / UI

- **设置 → 存储清理**：完整清单。已归档会话（标题、目录、大小、时间）可多选后移入隔离区；隔离区可单批恢复或整体清空；临时文件区列出过期目录并可一键移入隔离区。
- **侧边栏会话行 “…” 菜单 →「永久删除」**：只对已归档的会话显示，一次删除一个会话（连同它的子代理会话）。

## 删除时到底发生什么 / What a delete actually does

删除一个已归档会话时，插件按下面的顺序执行，任何一步都不会碰到项目目录：

1. 从它所属的 Workspace 里 `detachSession`（会话行随之从侧边栏消失）。
2. 通过 `workspaceRegistry.unarchiveSession` 清掉归档登记（不写坏 `workspace.json` 的结构）。
3. 把会话日志目录 `~/.dsh/sessions/<workspace>/<session-id>/` 移入隔离区。
4. 把投影缓存 `~/.dsh/storages/session_projcache/sessions/<session-id>.json` 移入隔离区。
5. 该会话的**子代理会话**（`parentSession` 指向它的日志）一并删除。
6. 写一份 `manifest.json`，记录原路径、所属 Workspace、原来的位置与归档状态，供恢复使用。

拒绝删除的情况：会话没有归档（可在 API 层用 `requireArchived: false` 关闭）、会话正在运行（`agent.status === 'running'`）。

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

## 卸载 / Removing it

在 Plugin Manager 里移除 bundle `@local/dsh-session-cleanup`（或 `plugin_manager` 的 `remove_bundle`）。隔离区不会自动删除，需要时可手动删 `~/.dsh/trash`。

