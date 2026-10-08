# 本地竞技场机器人

策略竞技场的对手列表提供 3 个机器人。默认镜像使用玩家选择的 PvP 编队（`NDT_PVP = 2`），复制单位等级、技能、强化、反应堆、装备属性、舰船等级与限界、舰船指令模块、操作员主副技能。机器人拥有独立的账号、单位和装备 UID，不写入玩家军队或装备仓库。

另两队由公开攻略中明确提到的核心与可选角色组成，配置见 [bots.json](./bots.json)。它们是供本地练习的组合；固定队伍不应用每周禁用轮换，预设队伍没有完整毕业装备。单位等级按玩家当前编队平均等级调整，上限 110，技能等级从本地技能表读取。普通排位入口映射为同一策略竞技场 AI 对战。

| 机器人 | 编队与来源 |
| --- | --- |
| Evolved-001 | Evolved-001、Sparrow、Glitch、Overflow、Ifrit、Grendel、Kyle Wong、Rearm Gaeun；Coffin-6。[Prydwen Evolved-001 Playbook](https://www.prydwen.gg/counter-side/guides/evolved-playbook/) 与作者的 [完整攻略](https://docs.google.com/document/d/1j5DyHPH3IAMIWkmhrgetf5ClJG1GNcDNGPhNUHiv3oU/edit) 说明了献祭、前排和反角色输出选项。 |
| Goliath Siege | Goliath、ATF-35 Thunderbolt、Ironside、Awakened Yoo Mina、Blue Blood Elizabeth、Gremory、Horizon、Administration Shieldmen；Coffin-6。[Prydwen Siege Playbook](https://www.prydwen.gg/counter-side/guides/siege-playbook/) 与作者的 [完整攻略](https://docs.google.com/document/d/1SJJyj-8KrzUq0Sdy8mW2P1y2I15S4OQRJqlmBaxMWIQ/edit) 推荐这些攻船、治疗、收尾及保护角色。该攻略也说明此流派在舰船高等级时的弱点。 |

## 战斗与消费

普通对战成功创建战斗后扣 1 张策略竞技场票（物品 13）。启动失败不扣票，重发请求不重复扣票，加载前取消匹配退票。正常胜负采用 `LUA_PVP_CONST` 的基础奖励：胜利 75、失败 50 点。奖励从剩余可领奖点数（物品 6）扣除，同时增加实际竞技场货币（物品 5）；预算不足时只领取剩余点数。点数恢复时间继续由共享 stamina 模块管理。模拟模式不扣票、不领奖，不更新普通战绩。

每场结果只结算一次，账号保存最近 30 场胜负历史和本地分数、连胜记录。分数用于本地练习状态，不发放官方赛季排名或周结算奖励。

## 客户端协议

- `2615 → 2616` 返回镜像和攻略机器人。
- `2617 → 2618` 创建两边编队。客户端进入匹配场景 26 后发送 `606`，服务端再推送 `2604`。重复场景通知不会重复匹配，也不会因上场场景标记为 3 而放弃新战斗。
- 普通排位 `2600` 直接返回 `2601` 并推送 `2604`。客户端 `NKMGameData` 使用 `NGT_PVP_STRATEGY = 20`，从而沿用本地 AI 和策略竞技场结果界面。
- `807` 使用共享 managed 战斗启动链。Team B 开启自动部署、自动技能，保留游戏原生单位行为；两边使用游戏表的 `PVP_STAT_DEFAULT` 数值缩放。
- 结算使用 `2623`，包含双方编队、实际胜负、消耗后的库存和基础奖励。结果重发不重复增加战绩或奖励。放弃对战按失败结算。PvP 不进入剧情或深潜奖励路径。

上述枚举、`PvpState` 的 13 个字段顺序、匹配场景和自动部署入口已核对上游 Android APK 内的 `Assembly-CSharp.dll`。自动检查通过 `node tools/check-local-pvp.js` 和 `node tools/check-local-pvp-flow.js` 运行。启动日志记录目标、编队索引和单位类型；启动异常、缺失或无效的 managed 数据会返回失败，不扣票、不保留不可用战斗。

修复后的 C# 服务已在 Android 独立临时目录使用真实游戏程序集和数据表验证。以去身份的 8 单位、27 件装备及操作员编队为输入，三种机器人均成功生成完整 `804` 与 `2618`；`807` 后输出 `808/809/822`，敌队原生单位和召唤物实际部署，三场均推进至 `NGS_FINISH`。另验证了在 `NGS_PLAY` 中主动部署玩家单位并收到成功的 `817`，双方战斗后的 `2623` 结算包通过真实客户端程序集完整反序列化和重序列化，胜负分别发放 75/50 点基础奖励。该验证没有启动游戏 UI、安装 APK 或修改应用存档。客户端触屏操作、动画和结果 UI 仍需安装新版后实测。联网实时玩家匹配和 League Draft 未实现。
