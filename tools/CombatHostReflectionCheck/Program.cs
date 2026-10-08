using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using RevivalSide.CombatHost;

var runtimeType = typeof(HostOptions).Assembly.GetType("RevivalSide.CombatHost.ManagedCombatBridge")!
    .GetNestedType("ManagedRuntime", BindingFlags.NonPublic)!;
var runtime = RuntimeHelpers.GetUninitializedObject(runtimeType);
var setField = runtimeType.GetMethod("SetField", BindingFlags.Instance | BindingFlags.Public)!;

void Assign(object target, string name, object? value) => setField.Invoke(runtime, [target, name, value]);
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var fixture = new EnumFields();
Assign(fixture, nameof(EnumFields.Stat), "Attack");
Check(fixture.Stat == FixtureStat.Attack, "named enum conversion");
Assign(fixture, nameof(EnumFields.Stat), 1L);
Check(fixture.Stat == FixtureStat.Attack, "numeric enum conversion");
Assign(fixture, nameof(EnumFields.Stat), OtherStat.Attack);
Check(fixture.Stat == FixtureStat.Attack, "cross-enum conversion");
Assign(fixture, nameof(EnumFields.Stat), FixtureStat.Defence);
Check(fixture.Stat == FixtureStat.Defence, "already typed enum conversion");
Assign(fixture, nameof(EnumFields.Stat), "1");
Check(fixture.Stat == FixtureStat.Attack, "numeric string conversion");
Assign(fixture, nameof(EnumFields.OptionalStat), "Defence");
Check(fixture.OptionalStat == FixtureStat.Defence, "nullable enum conversion");
Assign(fixture, nameof(EnumFields.OptionalStat), null);
Check(fixture.OptionalStat == null, "nullable enum clearing");
Assign(fixture, nameof(EnumFields.SmallStat), (sbyte)-1);
Check(fixture.SmallStat == SmallStat.None, "signed enum underlying type");
Assign(fixture, nameof(EnumFields.Level), 5);
Check(fixture.Level == 5, "Int32 to byte conversion");
Assign(fixture, nameof(EnumFields.UnsignedShort), 65000);
Check(fixture.UnsignedShort == 65000, "Int32 to UInt16 conversion");
Assign(fixture, nameof(EnumFields.UnsignedInt), 4000000000L);
Check(fixture.UnsignedInt == 4000000000U, "Int64 to UInt32 conversion");
Assign(fixture, nameof(EnumFields.UnsignedLong), "18000000000000000000");
Check(fixture.UnsignedLong == 18000000000000000000UL, "numeric string to UInt64 conversion");
try
{
    Assign(fixture, nameof(EnumFields.SmallStat), 128);
    throw new InvalidOperationException("out-of-range enum values must fail");
}
catch (TargetInvocationException ex) when (ex.InnerException is InvalidOperationException fieldError && fieldError.InnerException is OverflowException)
{
    Check(fieldError.Message.Contains(nameof(EnumFields.SmallStat)), "field context in conversion failures");
}

if (args.Length > 0)
{
    var managedDir = Path.GetFullPath(args[0]);
    AppDomain.CurrentDomain.AssemblyResolve += (_, request) =>
    {
        var file = Path.Combine(managedDir, new AssemblyName(request.Name).Name + ".dll");
        return File.Exists(file) ? Assembly.LoadFrom(file) : null;
    };
    var assembly = Assembly.LoadFrom(Path.Combine(managedDir, "Assembly-CSharp.dll"));
    var slotType = assembly.GetType("NKM.NKMShipCmdSlot", true)!;
    var slot = RuntimeHelpers.GetUninitializedObject(slotType);
    var stat = slotType.GetField("statType")!;
    Check(stat.FieldType.IsEnum, "the installed ship command statType is an enum");
    Assign(slot, "statType", "NST_ATK");
    Check(stat.GetValue(slot)!.ToString() == "NST_ATK", "real CounterSide ship command string enum");
    Assign(slot, "statType", Convert.ToInt64(Enum.Parse(stat.FieldType, "NST_HP"), CultureInfo.InvariantCulture));
    Check(stat.GetValue(slot)!.ToString() == "NST_HP", "real CounterSide ship command numeric enum");
    var gameType = assembly.GetType("NKM.NKMGameData", true)!;
    var game = RuntimeHelpers.GetUninitializedObject(gameType);
    Assign(game, "m_NKM_GAME_TYPE", "NGT_DIVE");
    Check(gameType.GetField("m_NKM_GAME_TYPE")!.GetValue(game)!.ToString() == "NGT_DIVE", "real CounterSide game type enum");
    Assign(game, "m_NKMGameStatRateID", "PVP_STAT_DEFAULT");
    Check(Equals(gameType.GetField("m_NKMGameStatRateID")!.GetValue(game), "PVP_STAT_DEFAULT"), "PvP stat rate ID remains a string");
    runtimeType.GetField("assembly", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(runtime, assembly);
    var shipType = assembly.GetType("NKM.NKMUnitData", true)!;
    var operatorSkillType = assembly.GetType("NKM.NKMOperatorSkill", true)!;
    var operatorSkill = RuntimeHelpers.GetUninitializedObject(operatorSkillType);
    Assign(operatorSkill, "level", 5);
    Check(Equals(operatorSkillType.GetField("level")!.GetValue(operatorSkill), (byte)5), "real operator skill Int32 level to Byte field");
    var deckOperator = runtimeType.GetMethod("CreateDeckOperator", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(runtime, [new PlayerDeckData {
            OperatorUid = "1001", OperatorId = 31301, OperatorLevel = 100,
            OperatorData = new OfficialOperatorSnapshot {
                MainSkill = new OfficialOperatorSkillSnapshot { Id = 1, Level = 5 },
                SubSkill = new OfficialOperatorSkillSnapshot { Id = 2, Level = 3 },
            },
        }])!;
    var mainSkill = deckOperator.GetType().GetField("mainSkill")!.GetValue(deckOperator)!;
    var subSkill = deckOperator.GetType().GetField("subSkill")!.GetValue(deckOperator)!;
    Check(Equals(operatorSkillType.GetField("level")!.GetValue(mainSkill), (byte)5)
        && Equals(operatorSkillType.GetField("level")!.GetValue(subSkill), (byte)3), "real operator deck skills retain their levels");
    var ship = Activator.CreateInstance(shipType)!;
    var styleType = slotType.GetField("targetStyleType")!.FieldType.GetGenericArguments()[0];
    var roleType = slotType.GetField("targetRoleType")!.FieldType.GetGenericArguments()[0];
    var modules = JsonSerializer.SerializeToElement(new[] { new { slots = new[] { new {
        targetStyleType = new[] { Enum.GetNames(styleType)[0] },
        targetRoleType = new[] { Enum.GetNames(roleType)[0] },
        statType = "NST_ATK", statValue = 0.05f, isLock = false,
    } } } });
    runtimeType.GetMethod("ApplyShipCommandModules", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(runtime, [ship, modules]);
    var shipModules = (System.Collections.IEnumerable)shipType.GetField("ShipCommandModule")!.GetValue(ship)!;
    var appliedModule = shipModules.Cast<object>().Single();
    var appliedSlots = (Array)appliedModule.GetType().GetField("slots")!.GetValue(appliedModule)!;
    Check(stat.GetValue(appliedSlots.GetValue(0))!.ToString() == "NST_ATK", "real ship command module JSON application");
    Console.WriteLine("CounterSide reflection passed: complete ship command module JSON and operator deck skills, game type enum, PvP stat rate string.");
}

var engineType = typeof(HostOptions).Assembly.GetType("RevivalSide.CombatHost.CombatEngine")!;
var engine = Activator.CreateInstance(engineType, [new HostOptions()])!;
var failedStartup = (HostResponse)engineType.GetMethod("Handle")!.Invoke(engine, [new HostRequest
{
    Command = "startBattle",
    Data = JsonSerializer.SerializeToElement(new StartBattleData { Req = new GameLoadReq { DungeonID = 1004 } }),
}])!;
Check(!failedStartup.Ok && failedStartup.PayloadBase64 == null && failedStartup.DynamicGame == null,
    "failed native startup cannot return a successful empty battle");
var editableFixture = (HostResponse)engineType.GetMethod("Handle")!.Invoke(engine, [new HostRequest
{
    Command = "startBattle",
    Data = JsonSerializer.SerializeToElement(new StartBattleData { Stage = new StageData { InitialUnits = [new UnitState { GameUnitUID = 1, Team = 1, Hp = 100 }] } }),
}])!;
Check(editableFixture.Ok && editableFixture.DynamicGame is { ManagedCombat: false } && editableFixture.BattleState?.Units.Count == 1,
    "editable simulator's explicit synthetic units remain available without managed assemblies");
var unavailableEngine = Activator.CreateInstance(engineType, [new HostOptions { ManagedDir = Path.Combine(Path.GetTempPath(), "missing-revivalside-managed-reflection-test") }])!;
var unavailableFixture = (HostResponse)engineType.GetMethod("Handle")!.Invoke(unavailableEngine, [new HostRequest
{
    Command = "startBattle",
    Data = JsonSerializer.SerializeToElement(new StartBattleData { Stage = new StageData { InitialUnits = [new UnitState { GameUnitUID = 1, Team = 1, Hp = 100 }] } }),
}])!;
Check(!unavailableFixture.Ok && unavailableFixture.DynamicGame == null && unavailableFixture.PayloadBase64 == null,
    "configured native startup failures cannot reuse synthetic fixtures as a successful battle");
Console.WriteLine("Reflection regression passed: enum and numeric field conversions, failed-native startup, and editable simulator fixtures.");

enum FixtureStat { None, Attack, Defence }
enum OtherStat : long { Attack = 1 }
enum SmallStat : sbyte { None = -1 }
sealed class EnumFields
{
    public FixtureStat Stat = default;
    public FixtureStat? OptionalStat = default;
    public SmallStat SmallStat = default;
    public byte Level = default;
    public ushort UnsignedShort = default;
    public uint UnsignedInt = default;
    public ulong UnsignedLong = default;
}
