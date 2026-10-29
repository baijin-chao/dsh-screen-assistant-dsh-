# 识屏助手 · dsh-screen-assistant

<p align="center">
  <img src="icon.svg" width="88" alt="识屏助手图标">
</p>

<p align="center">
  给 DeepSeek Harness 的识屏插件：<b>全局快捷键截屏 → 视觉模型识别 → 给出方法、答案或总结</b>。
</p>

> Windows only · DSH `>= 0.2.1-rc.3 < 0.3.0` · 需要支持图片输入的模型

GitHub：<https://github.com/baijin-chao/dsh-screen-assistant-dsh->

## 能做什么

- **解决问题**：题目、报错、代码、表格、表单，先给答案或修复步骤，再给关键依据。
- **教我操作**：告诉你点哪个按钮、输入什么、按什么快捷键。
- **总结内容**：一句话结论 + 3–7 个要点，保留关键数字和名称。
- **提取文字**：按原有结构转写屏幕文字，表格用 `|` 分列。
- **自由提问**：在截图基础上追问，例如「这个报错怎么修」「这页的重点是什么」。
- **后台全局热键**：在任意窗口按 `Ctrl+Shift+S`，立即截屏并分析，DSH 自动到前台显示结果。
- **对话里也能用**：Agent 多了一个 `capture_screen` 工具，可以直接说「看一下我的屏幕」。

## 安装

### 方式一：在 DSH 里直接装（推荐）

1. 打开 DSH 左侧栏的「插件」→「添加插件」。
2. 在输入框里填 GitHub 仓库地址：

   ```text
   https://github.com/baijin-chao/dsh-screen-assistant-dsh-.git
   ```

   注意仓库名结尾有一个 `-`，请完整复制。
3. 安装源如果有 GitHub 就选 GitHub；没有的话保留默认，粘贴完整 URL 会被识别为 git 地址，不会去 npm 找包名。
4. 安装完成后**重启一次 DSH**。

本插件是纯 JavaScript，没有构建步骤，GitHub 安装会直接拉取源码，不需要 `pnpm build`。

### 方式二：命令行安装

```powershell
git clone https://github.com/baijin-chao/dsh-screen-assistant-dsh-.git
cd dsh-screen-assistant
dsh plugin --profile desktop add .
```

没有 `git` 时，在 GitHub 页面下载 ZIP，解压后进入 `dsh-screen-assistant` 目录，执行同样的 `dsh plugin --profile desktop add .`，或者直接运行：

```powershell
.\install.ps1
```

`install.ps1` 会自动查找 DSH 自带的 CLI、备份 profile 配置、安装并检查 bundles 列表。

### 方式三：本地目录安装

在 DSH 左侧栏打开「插件」→ 添加插件 → 选择本地目录（本仓库根目录）。

### 安装后

**全局热键需要重启一次 DSH**：全局 helper 是宿主进程启动时注册的，只刷新页面不会生效。重启后 DSH 右下角会出现「识屏」按钮，任意窗口按 `Ctrl+Shift+S` 即可。

## 使用

1. 点右下角「识屏」。
2. 选截屏延时：默认 3 秒，点「截取当前屏幕」后切到你要问的窗口（立即截取适合问当前 DSH 页面）。
3. 在预览里确认截到的是想要的内容，选模式，必要时补一句问题。
4. 点「开始分析」，等结果出来；可以复制，也可以重新分析。

### 全局快捷键

默认 **Ctrl + Shift + S**，系统级生效：不管当前焦点在哪个程序，按一下就会立即截取当前屏幕（不需要先把 DSH 切到前台），后台自动分析，然后把 DSH 窗口带到前台，面板里直接显示结果。

- 实现方式：宿主启动一个常驻 PowerShell helper，用 `RegisterHotKey` 注册全局热键；截图在按键瞬间完成，所以截到的是你正在看的那个窗口。
- 如果默认组合被其它程序占用，会依次尝试 `Ctrl+Alt+S` → `Ctrl+Shift+X` → `Ctrl+Alt+Shift+S` → `Ctrl+Alt+C`；面板顶部会显示实际生效的键。
- 全部候选都被占用时，会退回**窗口内快捷键**：DSH 在前台时按 `Ctrl+Shift+S`，利用 3 秒倒计时切到目标窗口。窗口内键位可以在 DSH「设置 → 快捷键」里搜索「识屏」修改；全局键目前由候选链自动选。
- 全局键按下后 DSH 会自动到前台；如果系统不允许抢焦点，面板也会在后台准备好，切回来就能看到。
- helper 带看门狗：DSH 退出或崩溃后，它会在约 60 秒内自行退出，不会永久占着热键。
- 实际键位可以访问 `http://127.0.0.1:<DSH 端口>/dsh-screen-7421/status` 查看。

对话里的用法：

> 帮我看一下屏幕，这个报错是什么意思？
>
> 切到我刚打开的 Excel，3 秒后截图，告诉我这个表怎么汇总。

Agent 调用 `capture_screen` 时默认等 3 秒，方便你切换窗口；它会在回答前先看图。

## 模型要求

分析走当前对话选中的模型，因此需要**支持图片输入**的模型。DeepSeek-V4.1-Flash 等视觉模型可以直接用；如果切到纯文本模型（如 `deepseek-v4-pro`），插件会提示切换，不会把图片当文字硬发。

## 隐私说明

- 截图只在你的电脑上生成，暂存在宿主内存里，10 分钟后自动过期。
- 只有你点「开始分析」、按全局热键，或 Agent 调用 `capture_screen` 时，截图才会作为图片附件发给当前模型。
- 截屏范围是**整个虚拟桌面（所有显示器）**；如果屏幕上有密码、聊天记录等敏感内容，先关掉或换到干净窗口再截。
- 插件不落盘保存截图（临时 PNG 读完即删），但 harness 的附件服务会为分析保存一份归一化图片，和普通聊天图片一样。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-screen-assistant
```

然后刷新或重启 DSH。用 `install.ps1` 安装时，profile 里的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 会各留一份 `.bak-时间戳` 备份，确认没问题后可以删掉。

## 目录结构

```
dsh-screen-assistant/
├── package.json           # dsh.bundle + dsh.client 声明
├── cordis.patch.yml       # 注册宿主插件
├── index.js               # 宿主：路由 + SSE + 全局 helper + capture_screen 工具
├── client.js              # 浏览器：悬浮按钮、结果面板、全局事件订阅
├── runtime/
│   ├── capture-screen.ps1 # Windows GDI 截屏（多显示器、DPI 感知、最长边 2560）
│   └── global-hotkey.ps1  # RegisterHotKey 全局热键 + 看门狗
├── install.ps1            # 本地一键安装
├── icon.svg
├── LICENSE
└── README.md
```

## 兼容性

- DeepSeek Harness `0.2.1-rc.3` 及以上（`package.json` 的 `engines.dsh` 已声明范围）。
- Windows 10/11，PowerShell 5.1；不依赖原生模块。
- 需要支持图片输入的模型。

## 已知限制

- 目前只支持 Windows（截屏和全局热键依赖 PowerShell / Win32）。
- 截的是整屏，不是单个窗口；需要单窗口时可以先用系统截图工具裁剪，或在对话里说明区域。
- 面板分析是一次性请求，不是流式输出；长题目可能需要十几秒。
- 截图里的文字如果太小或分辨率太低，识别会下降；尽量让目标窗口最大化。
- 全局键位目前按候选链自动选择，暂不能在 DSH 设置里固定；窗口内键位可以改。

## License

[MIT](LICENSE)
