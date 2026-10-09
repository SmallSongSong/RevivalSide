# 本地竞技场机器人

策略竞技场保留一个玩家编队镜像，新增六套固定满配预设，替换原来按玩家等级缩放、未配装备的 Evolved-001 和 Siege 队伍。镜像保留所选 PvP 编队（`NDT_PVP = 2`）的角色、槽位、队长、皮肤、舰船类型、操作员类型及副技能类型；角色、技能、战术、合法反应堆和装备按同一满配规则重建，舰船与操作员升至表内最大档位。没有操作员时补 Serina。预设与镜像使用独立 UID，装备只进入战斗数据，不发到玩家仓库。

## 满配预设

配置见 [bots.json](./bots.json)。角色与职业组合以公开攻略的核心定位为依据，再按冻结版本可用角色组成固定练习队；它们不代表某周禁用轮换中的官方固定榜单。

| 预设 | 核心及船 | 资料依据 |
| --- | --- | --- |
| Rosaria 空袭 | 觉醒 Rosaria、Ecclesia、觉醒 Karin、Shin Jia；Enterprise | [Rosaria](https://www.prydwen.gg/counter-side/characters/awakened-rosaria)、[Shin Jia](https://www.prydwen.gg/counter-side/characters/awakened-shin-jia) |
| Regina 冰控 | 觉醒 Jake、Regina、Lyudmila；New Ohio | [Regina](https://www.prydwen.gg/counter-side/characters/awakened-regina)、[Jake](https://www.prydwen.gg/counter-side/characters/awakened-jake) |
| Curian 士兵 | Curian、Felix、Felicette、Revenant、重装 Han Sorim / Rivet；Matador | [Curian 与 Matador 的配合](https://www.prydwen.gg/counter-side/characters/curian)、[Matador](https://www.prydwen.gg/counter-side/ships/matador) |
| Shiyoon 反击 | 觉醒 Joo Shiyoon、Jake、Ministra；Lake Superior | [Joo Shiyoon](https://www.prydwen.gg/counter-side/characters/awakened-joo-shiyoon)、[Ministra](https://www.prydwen.gg/counter-side/characters/ministra) |
| Hilde 坦克墙 | 觉醒 Hilde、Surya、Ecclesia，以及 Rosaria / Karin 后排；Lake Superior | [Hilde](https://www.prydwen.gg/counter-side/characters/awakened-hilde)、[Rosaria](https://www.prydwen.gg/counter-side/characters/awakened-rosaria) |
| Ministra 减益 | Ministra、Lyudmila、Christina、Gremory 和重装 Laura；Enterprise | [Ministra 的召唤、减益与二级反应堆](https://www.prydwen.gg/counter-side/characters/ministra) |

每队八名角色均为 SSR（含觉醒及重装），固定 120 级、表内 13 阶限界、6 级战术、表内满技能；重装角色保留 10 级技能及 5 级队长技能。只给实际存在的反应堆对应最高等级，不生成不存在的反应堆。舰船按游戏表升到 130 级、3 阶限界，操作员 100 级、主技能 8 级、AoE 减伤副技能 11 级。操作员使用 [Olivie / Serina](https://www.prydwen.gg/counter-side/guides/operators-and-you) 的合法游戏表技能。

## 装备

采用用户要求的专属或 CDR 路线，按 [PVP Gearing](https://www.prydwen.gg/counter-side/guides/pvp-gearing) 区分输出、前排和辅助。Rosaria 的攻略更优先自动攻击套，但也列出 CDR 方案；这里固定采用 CDR，方便形成可复现的满配挑战。

- 每个角色四件装备，共 32 件；四件使用合法 CDR 套装 `241900`。
- 输出使用对应职业的 T7 Maze；前排使用 T7 Inhibitor 武器、Maze 护甲与 Gordias 饰品；辅助使用 Hummingbird、Maze、Gordias，缺少该职业 Hummingbird 时使用合法 Maze。
- 角色有合法 T7 专属且可洗出技能急速时，优先替换对应槽位；每角色最多一件专属，避免重复专属饰品。
- 全部 +10、两项精度 100。主属性、强化增量、副属性与三槽潜能均从对应游戏表读取最大值，不写入该装备不能获得的属性。Inhibitor 使用三槽满技能急速潜能。套装及属性仍受游戏原生上限约束。
- 禁止 `TEST`、职业错误、槽位错误及角色限制不符的装备。预设舰船不能依赖 KOR 初始化没有启用的专用标签；Albion `26039` 需要 `SHIP_C_ALBION`，因此使用无此限制的 Enterprise。

## 匹配与结算

普通对战不扣策略竞技场票。真实胜负沿用 `LUA_PVP_CONST`：胜利 75、失败 50，消耗可领奖预算（物品 6），发放实际竞技场货币（物品 5），不足时仅发剩余预算。冻结表没有平局奖励项，因此平局不生成额外奖励、分数不变，并单独记录 `draws`。模拟战与加载完成前的退出不增加普通战绩、奖励或任务。

同一启动请求可重试，但可靠 TCP 中已成功发送的 `2618` 不会再次发送：原客户端每次成功 ACK 都会重新预约场景 26，双 ACK 会干扰匹配转场。首次响应发送失败时保留同一准备完成的对局供重试。`2618` 同时包含选中的完整对手和七人列表，避免空对象清掉客户端选择缓存；其原生 gameData/runtimeData 保持不变，并严格检查冻结协议的空目标尾部后补齐字段。活动对战中不同目标、编队或模式会返回冲突错误，避免把另一个对手当作旧请求的重试。完整准备 `2618` 后，客户端进入场景 26 才发 `2604`；发送失败不会提前标记匹配已通知。启动失败会清理不可用战斗并记录具体原因。

结算先完成双方编队、历史和结果数据的序列化，再提交货币与战绩。结果缓存保证重复通知不会重复领奖。历史的 `GainScore` / `MyScore` 与真实本地分数变化一致。每次实际结束至多计一次 `PVP_PLAY_ASYNC`；放弃对战按失败，实际原生平局按平局，缺少胜方信息不能自行猜测平局。

## 验证

`node tools/check-local-pvp.js` 核对满配镜像不会修改原账号，以及全部预设的等级、技能、职业、槽位、套装、满词条、满潜能、专属限制、UID 和库存隔离，并覆盖启动失败、不同请求冲突、匹配通知失败重试、胜败平局、加载前退出和结算序列化失败不发奖。`node tools/check-local-pvp-flow.js` 使用实际 listener 函数验证结算路由、权威胜方、平局、放弃、任务门禁与一次结算。

原生验证必须用当前 C# 服务、真实冻结游戏程序集与 Lua 表；只有 `managed=true`、完整 `804/2618`、`807 → 808/809/822` 和实际单位进入 `NGS_PLAY` 才算战斗启动通过，不能以空状态或 866 字节占位包作为证据。公开合成配置可用于 Android 临时目录的独立 CLI，不需要读取或改写用户存档。联网实时玩家匹配和 League Draft 尚未实现。

公开协议与 native 输入由 `node tools/make-local-pvp-protocol-fixtures.js --out /tmp/revivalside-pvp-max-fixtures --device-root /data/local/tmp/revivalside-managed-probe-20261008` 重建。包含七队 `startBattle` 输入、`2616` 列表和每队胜败平局三份 `2623` 反序列化请求；镜像输入以 80 级无装备角色验证对手升级到 120 级、32 件满装，完全不读取私有存档。

匹配 ACK 可脱离完整游戏 runtime 验证：先运行 `PvpStartClientProtocolCheck <Managed目录> --make <原生JSON>`，再运行 `node tools/make-local-pvp-start-protocol-fixture.js <原生JSON> <补齐JSON>`，最后 `PvpStartClientProtocolCheck <Managed目录> --check <补齐JSON>`。工具只加载明确的原客户端协议类型，不遍历整个程序集；它验证原生 `PacketWriter/PacketReader` 的完整 round-trip、gameUID 与 game/runtime 保留、Jake 1202 的选中信息、七个目标，以及原客户端每个成功 `2618` 回调都会预约场景切换的 IL。
