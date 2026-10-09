# 原生公会协作战检查

此工具直接加载未修改的客户端 `Assembly-CSharp.dll`，验证 Node 合成回包和原生协作战状态条件。

```sh
node tools/make-guild-cooperative-fixture.js /tmp/revivalside-guild-cooperative-client-fixture.json
/tmp/revivalside-dotnet/dotnet run --project tools/GuildCooperativeClientCheck/GuildCooperativeClientCheck.csproj -- exports/managed-check/Data/Managed /tmp/revivalside-guild-cooperative-client-fixture.json
```

fixture 使用合成用户与公会，以及公开 gameplay 表。必填字段：

- `infoPayloadBase64`、`memberPayloadBase64`、`chatPayloadBase64`：实际 handler 编码的 `3472`、`3474`、`3455` payload。
- `serviceTime`、`userUid`、`guildUid`：合成服务时间和身份。
- `season`、`interval`：选定赛季行与应用后的 interval，包含 `m_DateStart`、`m_DateEnd`。
- `schedules`、`dungeons`：该赛季组的公开完整 schedule 与 dungeon info 行。
- `artifacts`：公开 artifact 行，保留每组原始升序。
- `constants`：`ArenaPlayCountBasic`、`ArenaTicketBuyCount`、`BossPlayCountBasic`、`ArtifactFulificationCount`。

工具用公开 `NKMTempletContainer<T>.SetForTest` / `Add` 注册赛季和 interval，为原生 manager 填入合成表与解码状态，调用原生 `ServiceTime.Recent`、`GuildSeasonTemplet.Find`、`GetCurrentSeasonTemplet`、`JoinIntervalTemplet`、`GetCurrentSession`、Member `OnRecv`、`CanStartBoss`、`CanStartArena` 和 `GetMyArtifactDictionary`。

`CanStartBoss` 与 Member `OnRecv` 的当前用户来源使用未初始化的 `NKCScenManager` 包装对象，填入合成 `NKMUserData`；其 Unity cached pointer 只用于通过原生对象存活判断，没有调用该对象的 Unity 实体行为。此检查不启动完整客户端，不注册 PacketController。

检查包括 5 天活动与 2 天间隔、边界与赛季结束后的轮次、ACK 日期与静态 arena 索引、重复 sector 的不同 grade 历史、次数耗尽与 Boss 占用，以及全局勋章解锁的神器和真实 battle-condition ID。

公会返回场景仅验证原生 Chat/Info 接收标志 setter。真实 packet dispatch、计时等待、scene `35` 跳转、地图点击、黑屏恢复与 Boss 战斗增益应用需要 Android/Unity 或完整 combat-host 集成验证。工具成功不代表这些验证已通过。
