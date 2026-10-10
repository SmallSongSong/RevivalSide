# RevivalSide changelog

## 0.4.4a - 2026-10-10

- 最终登录回包合并纳入全部可选激战赛季日期；修复切换Boss后仍用旧官方时间的问题。使用明确关闭窗口覆盖旧活动日期，避免被合并逻辑当作缺省值跳过。
- 修复冻结 Android 公会赛季时间表为空时的登录重启，以及无战斗断线触发公会初始化的问题。
- 恢复大厅限时防御 Boss 活动，关闭旧登录数据里抢占入口的活动窗口；补齐实际击杀计分、积分领奖和本地排名领奖，重复请求不重复发放奖励。
- 世界地图开始派遣时立即生成讨伐 Boss，保留已有遭遇；公会战据点和 Boss 次数保持可用。
- RevivalSide 主面板新增中文激战支援 Boss 列表，支持19种 Boss 热切换与配置保存；战斗中禁止切换，避免结算到错误赛季。
- 恢复单个 START/STOP 控制，直接启动本地服务；停止后不自动重启。重新编译 Android 界面，构建检查核对实际 DEX 与源码。
- 保留舰船第三个改造模块与正确技能槽，增加辅助员／舰船合法满级存档工具与原客户端减伤核算工具。个人存档不随发布上传。

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
