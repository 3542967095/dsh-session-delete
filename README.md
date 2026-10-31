# DSH Session Delete & Recycle Bin

> A “delete conversation + recycle bin” plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
>
> 给 DeepSeek Harness 加一个“删除对话 + 回收站”的插件：删除不再永久丢失，误删可以恢复。

DSH 原生只支持“归档”，不支持删除会话。这个插件补上了删除能力，并把删除做成可恢复的回收站：

- 每个对话的 “…” 菜单里多一项红色 **删除**；
- 删除后对话进入回收站，而不是直接销毁；
- 侧边栏底部有 **回收站 (n)** 入口，可以预览、恢复、彻底删除；
- 插件代码和对话数据分离，删除对话不会影响任何插件。

---

## 目录

- [功能](#功能)
- [界面](#界面)
- [安装](#安装)
- [使用](#使用)
- [数据与安全](#数据与安全)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [卸载](#卸载)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [License](#license)

---

## 功能

| 功能 | 说明 |
|---|---|
| 删除对话 | 对话行 “…” → 红色 **删除**，确认后移入回收站 |
| 回收站预览 | 侧边栏底部 **回收站 (n)**，显示当前已删除条数 |
| 恢复 | 把会话日志和投影缓存移回原路径，并尽量恢复 Workspace 归属、置顶/归档状态 |
| 彻底删除 | 单条永久删除，二次确认 |
| 清空回收站 | 一次清空全部，二次确认 |
| 安全判断 | 有进行中回合的对话拒绝删除；空闲但已打开的对话可以删；文件被占用时重试并提示；失败尽量回滚 |
| 独立存储 | 插件代码在插件目录，删除数据在 `~/.dsh/trash/`，互不影响 |
| 无构建依赖 | 纯 JavaScript，不需要编译 |

## 界面

**对话行菜单**

```text
┌──────────────────────────┐
│  置顶                    │
│  重命名                  │
│  分叉                    │
│  归档                    │
│  复制 Session ID         │
│ ──────────────────────── │
│  🗑 删除                 │  ← 红色
└──────────────────────────┘
```

**侧边栏底部**

```text
┌──────────────────────────┐
│  ...会话列表...          │
│                          │
│  🗑 回收站 (2)           │  ← 本插件
│  ⚙ 设置                  │
└──────────────────────────┘
```

**删除确认**

```text
删除对话
“<标题>”将被移入回收站，可随时恢复或彻底删除。
已安装的插件、S 盘插件目录和安装脚本不受影响。

[取消]  [移入回收站]
```

**回收站**

```text
回收站
已删除的对话会暂时保留在这里；可以恢复，也可以彻底删除。

共 2 条，合计 1.4 MB
┌────────────────────────────────────────────┐
│ 测试对话 A                                 │
│ 2026/10/26 22:39 · 76.2 KB   [恢复] [彻底删除] │
├────────────────────────────────────────────┤
│ 测试对话 B                                 │
│ 2026/10/25 18:02 · 1.3 MB    [恢复] [彻底删除] │
└────────────────────────────────────────────┘

[关闭]  [清空回收站]
```

## 安装

### 前置条件

- DeepSeek Harness 桌面版（按 `0.2.1-rc.3` 的 Slot 与 `/api` 契约编写）；
- 插件目录可写；
- 默认 profile：`%USERPROFILE%\.dsh\profiles\desktop`。

插件有三种安装方式，任选一种。

> 本包同时声明了 `dsh.bundle.patch`（`cordis.patch.yml`）。如果你的 DSH 插件管理器支持从 GitHub 安装 bundle，可以直接选它；桌面版仍推荐下面的独立安装，因为独立安装不会把插件代码复制到 C: 盘 profile。

### 方式 A：使用插件管理器（推荐）

如果你的 `plugins` 目录里有统一的 `install-plugin.cmd`：

```powershell
cd "S:\Deepseek Harness\plugins"
.\install-plugin.cmd session-delete
```

安装器会：

1. 校验 `package.json`、`lib/index.js`、`lib/client.js`；
2. 在 profile 的 `node_modules` 建立指向插件目录的目录联接（junction）；
3. 在 `cordis.patch.yml` 写入 `# >>> dsh-plugin:session-delete` 配置块；
4. 更新 `plugins.json`。

> 注意：安装器只建立 junction，不把插件代码复制到 C 盘。

### 方式 B：独立安装

1. 把仓库文件夹放到插件目录，例如：

   ```text
   S:\Deepseek Harness\plugins\session-delete
   ```

2. 双击 `install.cmd`，或在 PowerShell 中运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. 如果 Harness 没有自动加载，刷新页面（`Ctrl+R`）或重启 Harness。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

### 方式 C：手动安装

1. 在 profile 的 `node_modules` 里建立 junction：

   ```powershell
   $plugin = "S:\Deepseek Harness\plugins\session-delete"
   $target = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-session-delete"
   New-Item -ItemType Junction -Path $target -Target $plugin
   ```

2. 在 `cordis.patch.yml` 末尾加入：

   ```yaml
   # >>> dsh-plugin:session-delete
   - insert:
       - id: session-delete
         name: "dsh-plugin-session-delete"
         config: {}
   # <<< dsh-plugin:session-delete
   ```

3. 刷新页面或重启 Harness。

## 使用

### 删除一个对话

1. 打开对话行右侧的 **“…”**；
2. 点击红色 **删除**；
3. 确认 **移入回收站**。

对话从侧边栏消失，进入回收站。页面会自动刷新。

> 只有**正在运行（有进行中回合）**的对话不能删除。其它对话正在生成时，删除一个空闲对话不受影响；空闲但之前打开过的会话也可以直接移入回收站。

### 查看和恢复

1. 点击侧边栏底部 **回收站 (n)**；
2. 在列表里选择：
   - **恢复**：回到原来的 Workspace 位置；
   - **彻底删除**：点一次变为“确认彻底删除”，再点一次永久删除；
   - **清空回收站**：点一次变为“确认清空”，再点一次全部永久删除。

恢复成功后页面自动刷新，对话重新出现在列表中。

## 数据与安全

### 回收站位置

```text
%USERPROFILE%\.dsh\trash\session-delete\
└─ 20261026-223927-xxxxxxxx\
   ├─ meta.json      标题、原路径、删除时间、大小、原 Workspace/置顶/归档状态
   ├─ session\       会话日志目录（原样移动）
   └─ projcache\     投影缓存（恢复时移回）
```

删除使用同卷 `rename`，不复制大文件，速度快。

### 会移动什么

- 会话的 JSONL 日志目录；
- 该会话的投影缓存（含 `.bak`）；
- 工作区归属、置顶、归档引用（删除时移除，恢复时尽量恢复）。

### 不会动什么

- 其他对话、Workspace、共享附件/Blob；
- `plugins/` 下的插件代码、脚本、配置；
- 子智能体（subagent）会话（目前不递归处理）；
- 已导出的会话文件。

### 安全判断

- 校验 `sessionId` / `entryId` 格式；
- 只拒绝**有进行中回合**的会话（`409 session-live`）；空闲但已打开的会话允许删除；
- Windows 文件句柄短暂占用时自动重试；
- 移动失败时尽量回滚；回滚失败会保留数据并报出路径，不会静默删除；
- 恢复时校验原始路径必须是 `~/.dsh/sessions/<project>/<sessionId>`，防止路径穿越；
- 所有 Host 路由走 DSH 自带的 `/api` 浏览器会话通道，不额外开放未鉴权端口。

> 插件以 Harness 的权限运行，能读写文件。安装第三方插件前请先审查代码。

## 工作原理

### 浏览器半侧

通过 DSH 的 Slot 系统注册两个入口：

| Slot | 作用 |
|---|---|
| `sidebar.workspaces.session.menu.item` | 对话行 “…” 里的红色删除项 |
| `sidebar.footer.action` | 侧边栏底部的“回收站”入口 |

两个入口都使用独立的 React 根挂载 `Modal`，所以菜单关闭不会带走对话框。

### Host 半侧

通过 `ctx.connection.fetch.register()` 注册带浏览器登录态的精确路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/session-delete` | POST | `{ sessionId, title? }` 移入回收站 |
| `/api/session-delete/trash` | GET | 列出回收站 |
| `/api/session-delete/trash/restore` | POST | `{ entryId }` 恢复 |
| `/api/session-delete/trash/purge` | POST | `{ entryId }` 彻底删除 |
| `/api/session-delete/trash/empty` | POST | 清空回收站 |
| `/api/session-delete/ping` | POST | 客户端加载握手（诊断） |

### 删除流程

```text
点击删除
  → 校验 sessionId
  → 仅当该会话有进行中回合时拒绝（其它对话运行不受影响）
  → 空闲但已打开时先 detach，释放持久化写句柄
  → 扫描 ~/.dsh/sessions/<project>/<sessionId>
  → 读取 Workspace 归属、置顶/归档状态
  → 创建 ~/.dsh/trash/session-delete/<entryId>/
  → rename session 目录 → session/
  → rename 投影缓存 → projcache/
  → 写 meta.json
  → 从 Workspace 移除引用
  → 页面刷新
```

### 恢复流程

```text
点击恢复
  → 校验 entryId 和原始路径
  → 原路径不存在时 rename 回来
  → 恢复投影缓存
  → attachSession() 回原 Workspace
  → 尽量恢复置顶/归档状态
  → 删除回收站条目
  → 页面刷新
```

## 常见问题

### 菜单/回收站入口没有出现

1. 刷新页面：`Ctrl+R`；
2. 确认 profile 的 `node_modules` 里有指向插件目录的 junction；
3. 确认 `cordis.patch.yml` 里有 `# >>> dsh-plugin:session-delete` 块；
4. 重启 Harness。

### 提示“该对话正在运行”

先停止该对话正在进行的回答，或等它结束后再删除。其它对话正在运行不影响删除空闲对话。

### 提示“文件仍被 Harness 占用”

插件会自动重试几秒。仍然失败时重启 Harness 后重试。

### 恢复时提示“原会话目录已存在”

说明删除后又创建了同 id 的会话。请先备份/移走现有目录，再恢复。

### 回收站会自己清理吗

不会。需要手动“彻底删除”或“清空回收站”。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

或使用插件管理器：

```powershell
.\uninstall-plugin.cmd session-delete
```

卸载只删除配置块和 junction，**不会删除插件目录和回收站数据**。之后可以重新安装。

## 开发与测试

### 文件结构

```text
session-delete/
├─ package.json
├─ lib/
│  ├─ index.js       Host 半侧
│  └─ client.js      浏览器半侧
├─ install.ps1 / install.cmd
├─ uninstall.ps1 / uninstall.cmd
├─ test-host.mjs
├─ test-client.mjs
├─ README.md
└─ README.zh.md      实现与运维说明
```

### 运行测试

使用 DSH 自带的 Node：

```powershell
$node = "S:\Deepseek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node .\test-host.mjs
& $node .\test-client.mjs
```

`test-host.mjs` 覆盖移入回收站、缓存搬运、恢复、彻底删除、清空、路径篡改拒绝、live/agent 拒绝、not-found。

`test-client.mjs` 用桩替换 React/DOM，验证菜单/底部入口注册、确认框、请求体与成功刷新。

## 已知限制

- 回收站不会自动清理；清空后不可恢复。
- 只有有进行中回合的对话不能删除；空闲对话随时可删。
- 如果原 Workspace 目录已不存在，恢复后可能无法自动挂回原 Workspace。
- 搜索结果的“已归档恢复行”没有 “…” 菜单。
- 按 DSH `0.2.1-rc.3` 的 Slot 与 `/api` 契约编写，升级大版本后可能需要适配。
- 子智能体（subagent）会话不会随主对话递归删除。

## License

MIT. See [LICENSE](LICENSE).
