# 原客户端减伤比较

本工具直接执行冻结客户端 `NKMUnitStatManager.GetFinalDamage`、`GetEvade`、`CalculateStat` 和 `NKMStatData.ApplyStatCap`。它只加载需要的公开类型，不启动 CombatHost、Unity 场景或手机服务。

```sh
dotnet build tools/DamageReductionProtocolCheck/DamageReductionProtocolCheck.csproj -o /tmp/revivalside-damage-tool
node tools/DamageReductionProtocolCheck/export-public-boss-samples.js /tmp/public-boss-cases.json
dotnet /tmp/revivalside-damage-tool/DamageReductionProtocolCheck.dll exports/managed-check/Data/Managed /tmp/public-boss-cases.json /tmp/public-boss-results.json
```

输入必须声明 `syntheticOnly: true`，每个 `cases` 元素包含 `name`、`attackerStats`、`defenderStats`、`skillType` 和 `variants`。属性对象使用原 `NST_*` 枚举名；每个 variant 提供 `name` 与 `defenderOverrides`。`skillType: null` 表示攻击来源没有原玩家技能模板。NPC 的技能动画名称不能据此改成 `NST_SKILL`。

可以设置攻击方的 `attackerAir`、`attackerStyle`、`attackerRole`、`attackerUnitType`、`attackerBoss`，双方 `*SourceType`/`*SourceTypeSub`、`*HpRate`，以及 `distance`、`attackFactor`、`maxHpDamageFactor`、`currentHpDamageFactor`、`trueDamage`、`forceCritical`、`noCritical`、`cleanHit`、`splash`、`buffDamage`、`attackCountOver`、`percentDamageImmune` 和 `defenderProtect`。穿防、近远抗、单位类别抗、MDL、伤害抗性穿透等通过原属性字典设置。

`rawAttackerStats` 加 `attackerLevel` 可替代 `attackerStats`；工具用原方法计算 HP/ATK/DEF/CRIT/HIT/EVA 的等级成长。`unitHpComparisons` 可提供公开角色的原统计表、level、limitBreakLevel、loyalty、permanentContract、gearFlatHp、gearHpFactor、additionalHpFactor，执行原 HP 成长和最终 HP 合成。

原伤害 IL 保持不变。工具把原线程内 `System.Random` 换成可控生成器，将 ±5% 伤害波动固定在中点；遍历全部 10000 个整数随机取值确认自然暴击、闪避概率。输出的期望伤害组合原普通、暴击、闪避及强制暴击闪避分支，包含原离散随机边界。

结果覆盖输入明确指定的最终属性与伤害事件。动态技能增益、战场条件、召唤单位、伤害转移、护盾与 `GetModifiedDMGAfterEventDEF` 后续处理需要各自的实际上下文，不应把本工具结果当成整场战斗胜负或存活验证。公开 Boss 导出保留其主体模板、引用增益及攻击标记，原等级属性不假设条件增益已经触发。`hypothetical_*` 变体用于说明公式，装备同槽合法性与最大值需另查装备模板。
