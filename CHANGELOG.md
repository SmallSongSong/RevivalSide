# RevivalSide changelog

以下 Android 版本记录按 Git 提交、版本号和发布附件补齐；`local.2`、`local.3` 为本地测试修订，`local.4`～`local.6` 的修改汇总进入 `0.4.2a`，未作为独立 GitHub Release 发布。文末保留原 PC `0.4.0` 记录。

## 0.4.5a - 2026-10-11

- START 显示全屏启动进度，等待资源安装、战斗宿主、游戏端口、大厅预热和客户端服务器地址验证完成后才提示就绪；失败与超时显示原因。
- 修复大厅沙漏的限时剧情入口，补齐活动章节摘要日期；支线“特别记录”开放资源完整的全部 10 个剧情章节。
- 修复世界地图派遣后 Boss 图标未立即显示：先同步 Boss 列表与详情，再刷新地图。
- 修复空间修正三队连战后的黑屏与结算缺失，补齐通关等级通知和登录数据合并；重新登录后保留通关进度并解锁下一等级，重复结算不重复发奖。
- 保留激战支援 Boss 切换功能；APK 使用新签名，旧签名版本需备份存档与资源后卸载安装。后续同签名版本可覆盖更新。
- Android 真机已确认启动、10 章特别记录、派遣 Boss 图标、空间修正结算与等级进度正常。发布附件仅包含 APK 与 SHA-256 校验文件。

## 0.4.4a - 2026-10-10

- 最终登录回包合并纳入全部可选激战赛季日期；修复切换Boss后仍用旧官方时间的问题。使用明确关闭窗口覆盖旧活动日期，避免被合并逻辑当作缺省值跳过。
- 修复冻结 Android 公会赛季时间表为空时的登录重启，以及无战斗断线触发公会初始化的问题。
- 恢复防御 Boss 活动模块，关闭旧登录数据里抢占入口的活动窗口；补齐实际击杀计分、积分领奖和本地排名领奖，重复请求不重复发放奖励。大厅沙漏使用另一套活动章节摘要，其剧情入口在 `0.4.5a` 修复。
- 世界地图开始派遣时立即生成讨伐 Boss，保留已有遭遇；公会战据点和 Boss 次数保持可用。
- RevivalSide 主面板新增中文激战支援 Boss 列表，支持19种 Boss 热切换与配置保存；战斗中禁止切换，避免结算到错误赛季。
- 恢复单个 START/STOP 控制，直接启动本地服务；停止后不自动重启。重新编译 Android 界面，构建检查核对实际 DEX 与源码。
- 保留舰船第三个改造模块与正确技能槽，增加辅助员／舰船合法满级存档工具与原客户端减伤核算工具。个人存档不随发布上传。

## 0.4.3a - 2026-10-09

- 修复深潜胜利后的地图重建，补齐客户端通关标志，保持路线、节点位置、Boss、遗物和编队状态一致；探索奖励仍在整次探索结算时发放。
- 策略竞技场增加六套觉醒／SSR 本地 AI 阵容，使用 120 级、满技能和合法满配装备；镜像对手保留玩家角色与槽位，不修改玩家账号。
- 修复竞技场重复开战、目标校验、胜负历史与积分、平局、模拟战及加载前退出；补齐战斗属性表关联和召唤物筛选光环。
- 激战支援开放整个轮换周期，进入时同步当前赛季；按实际 Boss 伤害保存积分与最佳编队，重复结算不重复计分，较低成绩不覆盖历史最佳。
- 修复公会创建费用与奖励编码、登录后的公会资料合并、重复入会与名称错误响应；完整数据库替换和重载保留本地公会数据。
- 恢复公会联合作战的真实赛季、轮次、战区、Boss 与训练战斗，保存勋章、参战次数、神器、Boss 血量和阶段；结算发送客户端所需通知，保留 RAID 编队的 16／24 槽位。

## 0.4.2a - 2026-10-08

- 深潜恢复上游混合节点规则和现代关卡池，支持战斗、修复、遗物选择；修正节点位置、非战斗节点推进、战败退回和其他存活编队队长助战，将探索等级及怪物条件传入实际战斗。
- 修复深潜胜利后的路线连接及探索／待战状态，任一路线均可继续至 Boss；登录迁移旧版停住的探索，旧探索也可放弃后重新开始。
- 暗影殿堂第五战补齐整章结束信号、奖励、成绩和下一宫殿解锁；旧存档已完成五战时恢复通关状态，不重复发奖。本地宫殿成绩覆盖旧登录快照，重登保留解锁进度。
- 汇总 `local.4` 的本地规则：登录补足至少 1 个殿堂石和 6 张 PK 票，本地挑战不扣这两种票；深潜存活编队弹药不消耗，恢复旧存档耗尽弹药的编队。
- 汇总 `local.5` 的深潜路线与殿堂末战修复，以及 `local.6` 的混合节点、助战和登录进度修复。上述编号为开发期本地修订，正式发布版本为 `0.4.2a`。

## 0.4.1-local.3 - 2026-10-08（本地测试修订）

- 修复连战进入下一场准备界面时，新建战斗状态被场景切换误判为退出并清除的问题；每场单独记录是否已进入战斗场景，保留新战斗的加载与同步状态。
- 返回大厅、作战页面或实际离开战斗时仍执行退出清理，避免残留计时器和旧战斗状态影响下一场。

## 0.4.1-local.2 - 2026-10-08（本地测试修订）

- 修复 `local.1` 战斗启动回归：舰船模块枚举与辅助员技能等级按目标字段类型转换，避免反射赋值导致战斗宿主初始化异常；初始化失败返回错误并允许重试。
- 修正深潜全局 `cityID=0`、节点选择和楼层推进；选中节点不提前增加距离，待战节点正确显示战斗状态，并迁移旧探索存档。

## 0.4.1-local.1 - 2026-10-08

- 补齐主线及 Phase 关卡的子战斗顺序，支持第五章 5-6 的 Knight、Queen、King 三连战；保留血量与编队，整组只扣一次入场体力，末战结算整关奖励，重复请求不重复推进或发奖。
- 补齐暗影殿堂子战选择、胜利推进和失败生命扣除，以及空间修正按等级组织三队连战的基础状态；空间修正末战黑屏及等级持久化问题在 `0.4.5a` 进一步修复。
- 深潜保留舰船血量和编队状态，支持失败重试与旧探索迁移；后续节点规则及地图推进修复见 `local.2` 和 `0.4.2a`。
- Sephira 探索增加节点移动、独立临时部队、编队编辑、事件与奖励选择、神器条件、残血续战和跨区进度保存。
- 防御波次战斗使用专用结束响应，保存本地成绩并停止已结束的战斗循环；活动开放、击杀计分和领奖在 `0.4.4a` 补齐。
- 增加本地 AI 策略竞技场、玩家编队镜像与机器人对手，保存胜负和历史；增加本地公会创建、查询、加入审核、权限、公告、聊天、签到、捐赠及重命名等功能。
- 修复随机箱与选择箱请求编号、数量和奖励归属；装备发放过滤测试装备，新增 `/repair gears` 隔离旧存档中的异常装备并清理其穿戴引用，保留正常装备。
- 大型战斗宿主 JSON 响应超过共享缓冲区时改用临时文件传输并清理；增加本地玩法检查、Android 载荷打包与 APK 内容核验工具。

## 0.4.0a（Android 上游基线）- 2026-08-21

- 提供可在 Android 本机运行的启动器、Node 服务和战斗宿主，支持 ARM64／ARMv7、离线资源 ZIP 导入及校验；玩法基于 PC `0.4.0`，包含 Counter Pass 与活动时钟适配。
- 恢复官方服／RevivalSide 地址切换、官方账号捕获与自动导入流程；配套 Counter:Side 客户端改为单文件双架构 APK。
- 上游同一发布页后续补充官方大厅回包捕获修复，保存资料后保持转发，返回 RevivalSide 后自动导入；8 月 24 日热修复大型账号提取时战斗宿主共享缓冲区溢出的问题，原游戏客户端与离线资源包保持不变。
- 来源：[上游 Android 0.4.0a 发布说明](https://github.com/MadlyMoe/RevivalSide/releases/tag/0.4.0a)。本 fork 的后续玩法细节见 [Android 本地玩法](docs/android-local-gameplay.md) 和 [深潜流程](docs/dive-local-flow.md)。

## 0.4.0 - 2026-08-04

Changes since the PC v0.3.6 release.

### Mod tools

- Added the Mod:Side home, creator, loader, collision-safe editing/copying, and specialized Asset:Side, Story:Side, Unit:Side, Combat:Side, and Spine 3.7 Studio apps.
- Rebuilt Unit:Side as a complete unit maker with all employee, NPC, enemy, boss, ship, and BASE2 templates; multi-unit packs; existing-unit editing; accurate skills; appearances; lazy avatars/previews; collection/profile and association metadata; voice extraction/editing; new voice lines; and MP3 voice-bundle conversion.
- Expanded Story:Side with CounterSide-style episode organization, editable existing episodes, project copying, full stage/cutscene authoring, and dungeon-ID collision resolution.

### Runtime and launcher

- Made custom, duplicated, and boss-derived units load consistently in CombatHost with movement, skills, skill bars/icons, voices, skins, and full-squad support.
- Added independent Mod:Side and Combat:Side services, asset extraction progress, the Mod:Side home landing page, Cross Save capture/export/import, event login backgrounds, frozen-client controls, the updated Discord invite, and reliable log-folder opening.
- Allowed Mod Creator and Mod Loader to open without the full asset extraction, while keeping asset-backed workspaces locked until extraction completes.
- Prevented the launcher and backend from freezing another client while one is already installed.
- Added responsive launcher settings/state and single-instance focus behavior.

### Game and PC packaging

- Fixed Boss Raid duplicate handling plus tutorial/stage progression, squad loadouts, limit breaks, event shops, random-box rewards, and frozen-content compatibility.
- Added the lazy local wiki and content-addressed Windows components for x64, x86, and ARM64 while preserving profiles, settings, captures, exports, mods, and logs during upgrades.
