"use strict";

// Frozen client tables omit the server-only monster score groups. Offline
// defence awards 100 points per actual enemy death, including timeout results.
const OFFLINE_POINTS_PER_ENEMY = 100;
function calculateScore(records, isEnemy = defaultEnemy) {
  const rows = Array.isArray(records) ? records : Object.values(records || {});
  const deaths = rows.filter(row => row && isEnemy(row.teamType ?? row.TeamType ?? row.team))
    .reduce((sum,row) => {
      const value = Number(row.recordDieCount ?? row.RecordDieCount ?? 0);
      return sum + (Number.isFinite(value) ? Math.max(0,Math.floor(value)) : 0);
    },0);
  return Math.min(2147483647, deaths * OFFLINE_POINTS_PER_ENEMY);
}
function defaultEnemy(team) { return team === 3 || team === 4 || /^NTT_B[12]$|^B$|^BT[12]$/.test(String(team)); }
module.exports = {OFFLINE_POINTS_PER_ENEMY,calculateScore};
