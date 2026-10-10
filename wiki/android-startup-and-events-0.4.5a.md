# Android 启动与大厅活动入口（0.4.5a）

点击 START 后显示全屏进度页，依次等待资源准备、游戏端口、大厅/账号预热、客户端服务器地址验证。资源安装或 Node 线程创建成功不会提前关闭进度页。检查包括战斗宿主初始化、HTTP health、TCP 监听、JOIN_LOBBY 预热、ServerInfo 中的本地游戏地址以及真实 TCP 连接。预热失败、初始化失败、超时均显示原因和返回按钮。启动中的返回键不会绕过进度页；旋转/重建 Activity 会重新检查服务状态。

大厅“作战”旁的沙漏使用 `LUA_EPISODE_SUMMARY_TEMPLET`。客户端要求摘要时间有效、章节已开放、有大厅横幅，然后按排序选择一个章节。它是剧情章节的快捷入口，同一个章节也可在支线“特别记录”中出现。资源表含 10 个 EC_SEASONAL 普通难度章节；这个数是资源记录数，不能直接等同于当前账号能看到的章节数。

离线开放资源完整的 10 个特别记录章节：208、215、220、225、232、260、261、262、263、266，同时提供各章的开放标签与摘要展示窗口（2000–2099 年）。资源中不存在第一关模板的章节不会开放。已移除的联动摘要明确关闭为 1999 年。大厅按客户端原有排序显示其中一个带横幅的入口。`CS_EVENT_OFFLINE_EPISODE=0` 可关闭这项摘要时间补偿。

世界地图派遣开始后立即生成 Boss，发送顺序为派遣确认、Boss 列表、Boss 详情、地图刷新。客户端生成图标时需要查询 Boss 缓存，因此不能先发地图。不同分公司独立生成，重复派遣请求保留已有 Boss。派遣时间及领取奖励时间保留原规则。Android 两种 Node 启动路径均明确设置 `CS_WORLDMAP_FORCE_RAID=1`；电脑服务端可设置为 0 恢复派遣完成后的概率规则。

空间修正连战最后一队结束后保存完整三队状态；`TRIM_END_REQ`（1240）使用专用结算处理，返回完整 `TRIM_END_ACK`（1241），包括结算状态、最高分和通关奖励对象，再发送 `TRIM_INTERVAL_INFO_NOT`（1242）刷新客户端通关等级。结算响应只负责成绩页，客户端通过 1242 更新通关列表。成功记录保存至账号数据；托管宿主合并登录数据时复制本地 `trimClearList`、`trimModeState`、`trimIntervalData`，避免官方模板覆盖本地通关记录。离线周期 ID 为 0，登录和进度通知保持一致。重复结算请求使用缓存结果，避免重复发奖。失败或中断连战不会算通关。此前仅返回 6 字节的空结算响应会使客户端无法正常显示结果。

另一套 `EVENT_COLLECTION_INDEX_TEMPLET` 是活动模块首页。之前开放的 Event 58 关联 Defence 23，资源里的关卡名为 `Last Stand Season 22`（韩文 라스트 스탠드 시즌 22），使用固定活动编队、180 秒 Boss 战及击杀积分规则。其大厅小横幅配置为 `THUMB_EVENT_DEFENCE_02`，跳转 `SHORTCUT_EVENT_COLLECTION` 参数 58，并要求 `SURT_CLEAR_DUNGEON` 1007、活动开放标签和有效活动时间；战斗时间和结果领取时间另外控制。它与剧情摘要并列，也与“激战支援”的 Fierce Boss 选择独立。

验证命令：

```text
node tools/check-launcher-readiness.js
node tools/check-limited-event.js
node tools/check-managed-startup-gate.js
node tools/check-fierce-selection-listener.js
node tools/check-frozen-content-compat.js
node tools/check-world-map-guaranteed-raid.js
node tools/check-battle-continuation.js
powershell -File tools/check-trim-client-progress.ps1 -Dotnet exports/reference/dotnet-sdk/dotnet.exe
```

USB 真机已验证从原沙漏位置进入章节 263 的 ACT 1 页面；用户确认特别记录显示 10 章、派遣立即出现 Boss 图标、空间修正三队结束正常结算，并确认等级进度修复后没有问题。启动 UI 的真机测试验证了未就绪时阻止返回/重复启动、所有检查完成后关闭进度页。空间修正 1241、1242 完整响应通过原生协议反序列化；`tools/check-trim-client-progress.cs` 使用原生 `NKCTrimData.GetClearedTrimLevel` 和真实宿主登录合并验证即时升级、重登进度、连战恢复、空账号隔离。

0.4.5a 使用新签名，无法覆盖旧签名的安装；卸载前应保存账号数据与离线资源包。签名及私有账号备份保存在忽略的 exports 目录，不进入发布资源。用户已完成旧版卸载、新版安装与数据迁移，并确认新 APK 启动和游戏正常；后续同签名版本可直接覆盖更新。
