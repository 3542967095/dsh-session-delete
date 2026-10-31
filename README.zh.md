# 实现与运维说明（session-delete）

> 面向用户的安装、使用和功能介绍请看 [README.md](README.md)。本文保留实现细节、路径、API 和排障说明。

给 Harness 侧边栏每个对话的 “…” 菜单加一项红色的 **删除**，确认后把该对话移入**回收站**；侧边栏底部同时有一个 **回收站** 入口，可以预览、恢复或彻底删除已删除的对话。

> DSH 本身只提供“归档”，不提供会话删除（ui-workspace README 明确写着 “没有 Session 删除”）。本插件通过 Host 半侧的受权 `/api` 路由补上删除与回收站能力。

## 效果

```
对话行 “…” 菜单
  置顶
  重命名
  分叉
  归档
  复制 Session ID
  ─────────────
  删除            ← 红色，本插件添加

侧边栏底部
  🗑 回收站 (2)    ← 本插件添加，数字是当前条数
  ⚙ 设置
```

点击“删除”弹出确认框：

> **删除对话**
> “<标题>”将被移入回收站，可随时恢复或彻底删除。已安装的插件、S 盘插件目录和安装脚本不受影响。
> [取消] [移入回收站]

确认后对话从列表消失，页面刷新；它仍在回收站里。

点击侧边栏底部的“回收站”会打开预览：

- 列出每条已删除对话的标题、删除时间、占用大小；
- 每条可以 **恢复**（回到原来的 Workspace 位置）或 **彻底删除**（二次确认）；
- 底部可以 **清空回收站**（二次确认）。

## 回收站位置

```
C:\Users\35429\.dsh\trash\session-delete\
└─ 20261026-223927-aaaaaaaa\
   ├─ meta.json      标题、原路径、删除时间、大小、原 Workspace/置顶/归档状态
   ├─ session\       原样移动过来的会话日志目录
   └─ projcache\     投影缓存（恢复时一并移回）
```

移动的是同一个卷内的目录（`sessions` → `trash`，都在 `~/.dsh`），所以删除是瞬时的，不复制大文件。

## 安装位置

已经为当前桌面版安装好（Host 与浏览器半侧均已加载，无需重启）：

| 内容 | 路径 |
|---|---|
| 插件源码 / 安装包 / 脚本 | `S:\Deepseek Harness\plugins\session-delete` |
| 实际加载入口 | `C:\Users\35429\.dsh\profiles\desktop\node_modules\dsh-plugin-session-delete`（**只是指向 S 盘插件目录的目录联接**，实体文件都在 S 盘） |
| profile 配置项 | `C:\Users\35429\.dsh\profiles\desktop\cordis.patch.yml` 里的 `# >>> dsh-plugin:session-delete` 块 |
| 运行诊断 | `S:\Deepseek Harness\plugins\session-delete\session-delete-plugin.json` |
| 回收站数据 | `C:\Users\35429\.dsh\trash\session-delete` |

> **为什么删对话不会把功能删掉**
>
> 功能实体全部在 `S:\Deepseek Harness\plugins\session-delete`；profile 的 `node_modules` 里只有一个目录联接（junction），不占空间、也不是副本。  
> 删除一个对话只是把它移动到 `~/.dsh/trash/`，**不会触碰** `profiles/`、插件目录或 S 盘上的任何文件。  
> 即使删掉创建它时所在的那个对话、清空 `D:\Deepseek Files` 工作区，甚至换一个工作区，按钮、回收站和脚本都还在。

DSH 的 HMR 会监听 profile 配置；写入配置后插件通常**无需重启**即可加载（客户端插件也会动态加入）。如果没有生效，退出并重新打开 Harness 即可。

## 重新安装 / 更新

最方便：双击本目录的 `install.cmd`，或在 `S:\Deepseek Harness\plugins` 下运行：

```powershell
.\install-plugin.cmd session-delete
```

本目录的 `install.ps1` 只是兼容入口，会委托给上层的统一安装器。安装器会校验插件文件、建立/刷新指向 S 盘插件目录的目录联接、写入带标记的 profile 配置块，并更新 `plugins.json`；不会碰其他插件。

### 卸载

双击 `uninstall.cmd`，或在 `S:\Deepseek Harness\plugins` 下运行：

```powershell
.\uninstall-plugin.cmd session-delete
```

然后重启 Harness（或等 HMR 卸载）。卸载只移除本插件的配置块和 junction，S 盘插件目录和回收站里的数据都保留；不影响其他插件。

## 实现

### 浏览器半侧（`lib/client.js`）

- 通过 `ctx.slots.inject('sidebar.workspaces.session.menu.item', …)` 注册 `id: 'session-delete'`、`order: 500`、`separatorBefore: true` 的菜单项。
- 通过 `ctx.slots.inject('sidebar.footer.action', …)` 注册 `id: 'session-delete.trash'` 的侧边栏底部按钮，带条数徽标。
- 两个入口都用独立的 React 根挂载 `Modal`，菜单关闭不会带走对话框。
- 删除成功后会广播 `dsh-session-delete:trash-changed` 事件，底部徽标刷新，随后 `location.reload()` 让列表重新读取。

### Host 半侧（`lib/index.js`）

通过 `ctx.connection.fetch.register()` 注册这些**需要浏览器登录态**的精确路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/session-delete` | POST | `{ sessionId, title? }` 移入回收站 |
| `/api/session-delete/trash` | GET | 列出回收站条目 |
| `/api/session-delete/trash/restore` | POST | `{ entryId }` 恢复 |
| `/api/session-delete/trash/purge` | POST | `{ entryId }` 彻底删除一条 |
| `/api/session-delete/trash/empty` | POST | 清空回收站 |
| `/api/session-delete/ping` | POST | 客户端加载握手（诊断） |

删除流程：

1. 校验 `sessionId` 格式；
2. 仅当该会话的 Agent `status === 'running'` 时返回 `409 session-live`；空闲但已打开/已附加的会话允许删除。其它对话正在运行不影响本对话；
3. 扫描 `$DSH_HOME/sessions/<project>/<session-id>/`，记录原路径、大小、Workspace 归属、置顶/归档状态；
4. 创建 `$DSH_HOME/trash/session-delete/<entryId>/`，把会话目录 `rename` 成 `session/`，把投影缓存 `rename` 成 `projcache/`；
5. 写 `meta.json`（状态 `ready`）；
6. 通过 `ctx.workspaceRegistry` 取消归档 / 置顶并 `detachSession()`，从工作区列表移除引用；
7. 中途失败会尽量回滚；回滚不了时保留回收站目录并在错误里给出路径，绝不静默删数据。

恢复流程：

1. 校验 `entryId` 与 `meta.originalDir` 必须是 `$DSH_HOME/sessions/<project>/<sessionId>` 形状；
2. 原路径不存在时，`rename` 回来并恢复投影缓存；
3. 通过 `ctx.workspaceRegistry` 重新 `attachSession()`，并尽量恢复原来的置顶/归档状态；
4. 删除该回收站条目。

## 会移动什么，不会动什么

**会移动**

- 该会话的 JSONL 日志目录（整个 `session-<id>` 目录）。
- 该会话的投影缓存文档（含 `.bak` 隔离副本）。
- 工作区归属、置顶、归档集合中的引用（删除时移除，恢复时尽量恢复）。

**不会动**

- 其他对话、Workspace 本身、共享附件/Blob 存储。
- 该会话派生出的子智能体（subagent）会话。若一个对话大量使用 subagent，删除主对话后子会话可能成为不可见的孤儿；目前不递归处理，避免误删共享分支。
- 已导出到磁盘的 `\export` 文件。
- `S:\Deepseek Harness\plugins` 里的插件代码和脚本。

## 已知限制

- **回收站不会自动清理**：需要手动“彻底删除”或“清空回收站”；清空后不可恢复。
- **只有正在运行（有进行中回合）的对话不能删**：停止该对话的回答即可；空闲对话随时可删。文件短暂占用会自动重试，仍失败时重启 Harness。
- **恢复位置**：按删除时记录的原始路径恢复；如果原 Workspace 目录已不存在，会话文件会回到原路径，但可能无法自动挂回工作区。
- **搜索结果的恢复行没有菜单**：只能在侧边栏对话行的 “…” 菜单里删除。
- **版本兼容**：按 DSH `0.2.1-rc.3` 的 slot 与 `/api` 契约编写。升级大版本后若菜单不出现，查看 `~/.dsh` 下是否有加载错误，或删除配置项中的 `insert` 后重启。
- **HMR 未启用时**：需要重启 Harness 才会出现菜单和底部入口。

## 诊断

`S:\Deepseek Harness\plugins\session-delete\session-delete-plugin.json` 会在 Host 加载插件时生成/更新：

```json
{
  "hostLoadedAt": "…",
  "hostPid": 1234,
  "route": "/api/session-delete",
  "clientLoadedAt": "…",
  "clientVersion": "1.1.1",
  "version": 1
}
```

- 只有 `hostLoadedAt`：Host 半侧已加载，但浏览器半侧尚未执行（检查浏览器控制台 / 插件列表同步错误）。
- 两者都有：两侧都已加载。

## 测试

```powershell
$node = 'S:\Deepseek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node "S:\Deepseek Harness\plugins\session-delete\test-host.mjs"
& $node "S:\Deepseek Harness\plugins\session-delete\test-client.mjs"
```

- `test-host.mjs`：真实临时目录下的移入回收站、缓存搬运、恢复、彻底删除、清空、路径篡改拒绝、live/agent 拒绝、not-found。
- `test-client.mjs`：无浏览器环境下用桩替换 React/DOM，验证菜单/底部入口注册、确认框、请求体、成功刷新。
