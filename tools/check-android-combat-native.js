"use strict";
// Runs public fixtures against an already prepared isolated Android host.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const path=require('node:path');
const arg=name=>process.argv[process.argv.indexOf(name)+1];
assert(process.argv.includes('--fixtures'), 'Usage: node tools/check-android-combat-native.js --fixtures <public fixture directory> [--probe-root <isolated device directory>]');
const fixturesDir=path.resolve(arg('--fixtures'));
const root=process.argv.includes('--probe-root') ? arg('--probe-root') : '/data/local/tmp/revivalside-managed-probe-20261008';
assert(/^\/data\/local\/tmp\/[a-zA-Z0-9_-]+$/.test(root), 'Only an isolated /data/local/tmp directory may be used');
const options={managedDir:root+'/managed',gameplayTablesDir:root+'/tables/gameplay-tables',contentsTags:['GLOBAL','LANGUAGE_KOR','SYSTEM_TRANSCENDENCE_LV120']};
const repoRoot=path.resolve(__dirname,'..');
const playerDeck=JSON.parse(fs.readFileSync(path.join(fixturesDir,'start-rosaria-air.json'))).data.stage.playerDeck;
const cmd=`env LD_LIBRARY_PATH=${root}/native:${root}/runtime REVIVALSIDE_DOTNET_ROOT=${root}/runtime REVIVALSIDE_DOTNET_NATIVE_ROOT=${root}/native REVIVALSIDE_NATIVE_LIBRARY_DIR=${root}/native DOTNET_EnableDiagnostics=0 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 ${root}/native/librevivalside_dotnet_host.so ${root}/runtime/CombatHost.dll --stdio`;
const child=spawn(process.env.ADB_BIN || 'adb',['shell',cmd],{stdio:['pipe','pipe','pipe']});
let pending=null,buf='',stderr='';
child.stderr.on('data',b=>stderr+=b);
child.stdout.on('data',b=>{buf+=b;let n;while((n=buf.indexOf('\n'))>=0){const s=buf.slice(0,n);buf=buf.slice(n+1);let r;try{r=JSON.parse(s)}catch{continue}if(pending){clearTimeout(pending.timer);pending.resolve(r);pending=null}}});
child.on('exit',()=>{if(pending)pending.reject(new Error('native host exited: '+stderr.slice(-1000)))});
function request(command,data={}){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('timeout '+command))},60000);pending={resolve,reject,timer};child.stdin.write(JSON.stringify({command,options,data})+'\n')}).then(r=>{assert(r.ok,r.error);return r})}
(async()=>{
 await request('warmup');
 for(const name of fs.readdirSync(fixturesDir).filter(x=>x.startsWith('validate-'))){const f=JSON.parse(fs.readFileSync(path.join(fixturesDir,name)));await request(f.command,f.data);}
 console.log('Native arena target/result packet readers PASS');
 for(const name of fs.readdirSync(fixturesDir).filter(x=>x.startsWith('start-'))){
  const f=JSON.parse(fs.readFileSync(path.join(fixturesDir,name)));
  const enemy=f.data.stage.enemyDeck;
  await request('validateUnitTemplets',{unitIds:[enemy.shipUnitId,...enemy.units.map(u=>u.unitId)]});
  const s=await request(f.command,f.data);assert(s.dynamicGame.managedCombat);
  await request('validatePacket',{packetId:804,payloadBase64:s.payloadBase64});
  const d={dynamicGame:s.dynamicGame,battleState:s.battleState};d.dynamicGame.autoRespawnEnabled=true;
  await request('buildInitialSync',d);
  const seen=new Set();let enemies=[];
  for(let i=0;i<2;i++){
   const t=await request('buildTimeline',{...d,delta:.1,maxFrames:450});
   const live=t.timeline.frames.flatMap(f=>f.units||[]).filter(u=>u.team===3&&enemy.units.some(x=>x.unitId===u.unitId));
   enemies.push(...live);for(const u of live)seen.add(u.unitId);
   if(t.timeline.finished)break;
  }
  assert(enemies.length, name+' must deploy opponents');assert(enemies.every(u=>u.level===120), name+' opponents must be Lv120');
  if(name.includes('curian'))assert(seen.has(1215),'Soldier multi-respawn aura must execute without missing StatTemplet');
  console.log(name+': original804 + live Lv120 battle PASS');
 }
 const tables=require(path.join(repoRoot,'modules/gameplay-jsons'));
 const maps=tables.readGameplayTableRecords('ab_script','LUA_MAP_TEMPLET.json',{rootDir:repoRoot});
 const dungeons=tables.readGameplayTableRecords('ab_script_dungeon_templet','LUA_DUNGEON_TEMPLET_BASE.json',{rootDir:repoRoot});
 const tests=[{name:'Fierce80',boss:5100251,dungeon:3001,level:80,bc:[221,336],damage:2000,time:500},{name:'Fierce150',boss:5100274,dungeon:3804,level:150,bc:[253,307],damage:20000,time:8000},{name:'pvp-timeout',dungeon:0}];
 for(const c of tests){let stage;
  if(c.name==='pvp-timeout'){
   const deck={...playerDeck,shipUnitId:26036,shipLevel:100,units:[{...playerDeck.units[0],unitId:1135,skillLevels:[5,5,5,5,0],equipItemUids:[]}],equipItems:[]};
   stage={stageId:0,dungeonID:0,mapID:1001,gameType:20,miscMode:'local-pvp',playerDeck:deck,enemyDeck:{...deck,userUid:'920000100',nickname:'Timeout Fixture',shipUid:'92000010018',units:[{...deck.units[0],unitUid:'92000010010'}],leaderUnitUid:'92000010010'}};
  }else{
   const dungeon=dungeons.find(x=>x.m_DungeonID===c.dungeon);assert(dungeon);
   const map=maps.find(x=>x.m_MapStrID===dungeon.m_DungeonMapStrID);assert(map);
   stage={stageId:c.dungeon,dungeonID:c.dungeon,mapID:map.m_MapID,gameType:14,miscMode:'fierce',fierceBossId:c.boss,battleConditionIds:c.bc,fierceBasePoint:0,fierceMaxDamagePoint:c.damage,fierceMaxTimePoint:c.time,fiercePenaltyRate:0,fiercePenaltyIds:[],playerDeck};
  }
  const s=await request('startBattle',{gameUID:String(985000000+c.dungeon),req:{stageID:c.dungeon,dungeonID:c.dungeon,gameType:stage.gameType},stage,gameLoadAckPayloadBase64:''});
  await request('validatePacket',{packetId:804,payloadBase64:s.payloadBase64});
  const data={dynamicGame:s.dynamicGame,battleState:s.battleState};data.dynamicGame.autoRespawnEnabled=c.name!=='pvp-timeout';
  await request('buildInitialSync',data);
  let packet=null;
  for(let i=0;i<2400;i++){
   const r=await request('buildSync',{...data,delta:.1});data.battleState=r.battleState;
   packet=r.packets?.find(p=>p.packetId===811);if(packet)break;
  }
  assert(packet,c.name+' must naturally emit811');assert.equal(typeof packet.battleWinTeam,'number');
  if(c.name==='pvp-timeout')assert([1,3,6].includes(packet.battleWinTeam),'Timeout must use the original HP comparison');
  else{assert(Number.isInteger(packet.fiercePoint) && packet.fiercePoint>=0,c.name+' actual damage score must be nonnegative');assert(packet.fiercePenaltyPoint>=0);}
  await request('validatePacket',{packetId:811,payloadBase64:packet.payloadBase64});
  console.log(c.name+' natural811 winner='+packet.battleWinTeam+' score='+(packet.fiercePoint??'NA')+' PASS');
 }
 child.stdin.end();
})().catch(e=>{console.error(e.stack);child.kill();process.exitCode=1});
