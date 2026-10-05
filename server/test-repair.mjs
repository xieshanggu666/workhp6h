/**
 * 事故维修工单 功能验证
 * 覆盖：定损后开工单（经理指派技工、预付维修费=定损额）→ 技工完工（部件健康恢复+技能加成）→
 * 经理验收结案 / 未验收停场阻断开赛与常规维护 / 租约艇不开工单 / 资金不足拒开 /
 * 赔付与维修费账目对冲 / 幂等与并发完工 / 越站作废对称冲回（退费+扣回恢复值）/ 跨赛季保留
 *
 * 用法：node --experimental-sqlite server/test-repair.mjs（需要 Node ≥22.5 的 node:sqlite）
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`) }
const eq = (name, a, b) => { assert.equal(a, b, `${name}（期望 ${b}，实际 ${a}）`); pass++; console.log(`  ✅ ${name}`) }

function api(port, p, opts) { return fetch(`http://127.0.0.1:${port}${p}`, opts).then(r => r.json()) }
const post = (port, p, b) => api(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-repair-'))
  cpSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'))
  cpSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'))
  symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
function startServer(dir, port) {
  return spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
}
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try { const s = await api(port, '/api/state'); if (s?.team) return s } catch { /* wait */ }
    await sleep(80)
  }
  throw new Error('server not ready')
}
async function playStation(port, cid) {
  const started = await post(port, `/api/races/start/${cid}`, {})
  assert.ok(started.ok, `第 ${cid} 站开赛失败：${started.msg || ''}`)
  const settled = await post(port, `/api/races/${started.race.id}/settle`, {})
  assert.ok(settled.ok, `第 ${cid} 站结算失败：${settled.msg || ''}`)
  return { started, settled }
}
// 反复重置赛季直到同一季出现 n 起事故（事故在开赛瞬间确定性生成，概率事件）
async function playUntilIncidents(port, n, { stations = 6, rent = false, plan = 3 } = {}) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await post(port, '/api/reset')
    if (plan) {
      const buy = await post(port, '/api/insurance/buy', { id: plan })
      assert.ok(buy.ok, '投保失败：' + buy.msg)
    }
    if (rent) {
      const r = await post(port, '/api/rentals/rent', { id: 1 })
      assert.ok(r.ok, '租艇失败：' + r.msg)
    }
    const races = []
    const hits = []
    for (let cid = 1; cid <= stations; cid++) {
      const r = await playStation(port, cid)
      races.push(r)
      if (r.settled.incident) hits.push(r)
      if (hits.length >= n) return { hits, races, attempt }
    }
  }
  throw new Error(`多轮尝试后仍未出现 ${n} 起事故`)
}
async function playUntilIncident(port, opts = {}) {
  const r = await playUntilIncidents(port, 1, opts)
  return { race: r.hits[0], races: r.races, attempt: r.attempt }
}
// 跑完整季 6 站且至少出现 1 起事故（跨赛季场景需要完季才能衔接）
async function playFullSeasonWithIncident(port, { plan = 2 } = {}) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await post(port, '/api/reset')
    if (plan) {
      const buy = await post(port, '/api/insurance/buy', { id: plan })
      assert.ok(buy.ok, '投保失败：' + buy.msg)
    }
    const races = []
    const hits = []
    for (let cid = 1; cid <= 6; cid++) {
      const r = await playStation(port, cid)
      races.push(r)
      if (r.settled.incident) hits.push(r)
    }
    if (hits.length >= 1) return { hits, races, attempt }
  }
  throw new Error('多轮尝试后整季仍未出现事故')
}

async function main() {
  const PORT = 4423
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)

    console.log('\n[工单全流程] 报案→定损→赔付→开工单→完工→验收（自有艇，全险对冲）')
    const r1 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const snap1 = r1.race.started.race.record.incident
    const wear1 = r1.race.started.race.record.result.wear
    const incId1 = r1.race.settled.incident.id
    const pdAfterRace = Math.max(5, 100 - wear1 - snap1.damage)
    eq('事故损伤已施加到自有艇部件', (await api(PORT, '/api/state')).airship.parts_dur, pdAfterRace)
    // 理赔链：报案（结算已自动立案，重复报案幂等）→ 定损 → 赔付（全险 100%）
    const rep1 = await post(PORT, `/api/incidents/${r1.race.started.race.id}/report`, {})
    ok('报案成功（结算自动立案，幂等）', rep1.ok)
    const ass1 = await post(PORT, `/api/incidents/${incId1}/assess`, {})
    eq('定损费=损伤×25（自有艇）', ass1.incident.assessed, snap1.damage * 25)
    const pay1 = await post(PORT, `/api/incidents/${incId1}/payout`, {})
    ok('全险赔付到账', pay1.ok && pay1.payout === snap1.damage * 25)
    const moneyAfterPayout = (await api(PORT, '/api/state')).team.money

    // 开工单：非法技工被拒 → 指定技工开具（维修费=定损额，预付）
    const mechId = (await api(PORT, '/api/state')).mechanics[0].id
    const badMech = await post(PORT, `/api/incidents/${incId1}/repair`, { mechanicId: 999 })
    eq('非法技工开工单被拒', badMech.ok, false)
    const open1 = await post(PORT, `/api/incidents/${incId1}/repair`, { mechanicId: mechId })
    ok('开具维修工单成功', open1.ok && !open1.already)
    eq('工单维修费=定损额', open1.repair.cost, snap1.damage * 25)
    eq('工单状态维修中', open1.repair.status, 'repairing')
    eq('技工快照进工单', open1.repair.mechanic.name, '格蕾丝·铆钉')
    const moneyAfterOpen = (await api(PORT, '/api/state')).team.money
    eq('开工单预付维修费（与赔付对冲，净支出 0）', moneyAfterOpen, moneyAfterPayout - snap1.damage * 25)
    const openAgain = await post(PORT, `/api/incidents/${incId1}/repair`, {})
    ok('重复开工单幂等返回同一张', openAgain.ok && openAgain.already && openAgain.repair.id === open1.repair.id)
    eq('重复开工单不再扣款', (await api(PORT, '/api/state')).team.money, moneyAfterOpen)

    // 未验收停场：开赛拦截、常规维护关闭
    const startBlocked = await post(PORT, '/api/races/start/2', {})
    eq('工单未结案自有艇禁止参赛', startBlocked.ok, false)
    ok('拦截提示指向工单验收', /维修工单|停场/.test(startBlocked.msg || ''))
    const maintBlocked = await post(PORT, '/api/maintain', {})
    eq('工单未结案常规维护关闭', maintBlocked.ok, false)
    const stPend = await api(PORT, '/api/state')
    ok('状态携带未结案工单', stPend.repairs.some(r => r.id === open1.repair.id && r.status === 'repairing'))

    // 技工完工：部件健康恢复（损伤 + 技能加成），技工心情 +2；并发完工只恢复一次
    const mechBefore = (await api(PORT, '/api/state')).mechanics[0]
    const [c1, c2] = await Promise.all([
      post(PORT, `/api/repairs/${open1.repair.id}/complete`, {}),
      post(PORT, `/api/repairs/${open1.repair.id}/complete`, {})
    ])
    const wins = [c1, c2].filter(r => r.ok && !r.already)
    const idems = [c1, c2].filter(r => r.ok && r.already)
    eq('并发完工只生效一次', wins.length, 1)
    eq('另一笔并发完工幂等返回', idems.length, 1)
    const expectRestored = snap1.damage + 1 // 格蕾丝技能 58 → 加成 floor(58/30)=1
    eq('完工恢复=损伤+技工加成', wins[0].restored, expectRestored)
    const stDone1 = await api(PORT, '/api/state')
    eq('部件健康按工单恢复', stDone1.airship.parts_dur, Math.min(100, pdAfterRace + expectRestored))
    const mechAfter = stDone1.mechanics[0]
    eq('技工完工心情 +2', mechAfter.mood, Math.min(100, mechBefore.mood + 2))
    eq('工单转待验收', stDone1.repairs.find(r => r.id === open1.repair.id).status, 'repaired')
    const startBlocked2 = await post(PORT, '/api/races/start/2', {})
    eq('待验收仍停场（未验收结案）', startBlocked2.ok, false)

    // 经理验收：结案解除停场；未完工不能验收的反向校验在跨赛季场景覆盖
    const acc1 = await post(PORT, `/api/repairs/${open1.repair.id}/accept`, {})
    ok('经理验收结案', acc1.ok && !acc1.already)
    eq('验收后工单结案', acc1.repair.status, 'done')
    const accAgain = await post(PORT, `/api/repairs/${open1.repair.id}/accept`, {})
    ok('重复验收幂等', accAgain.ok && accAgain.already)
    const maint2 = await post(PORT, '/api/maintain', {})
    ok('验收后常规维护恢复', maint2.ok)
    eq('维护后部件健康 100', (await api(PORT, '/api/state')).airship.parts_dur, 100)
    const start2 = await post(PORT, '/api/races/start/2', {})
    ok('验收结案后自有艇恢复参赛', start2.ok)
    await post(PORT, `/api/races/${start2.race.id}/settle`, {})

    console.log('\n[租约艇] 租约艇事故由出租方整备，不开工单')
    const r2 = await playUntilIncident(PORT, { rent: true, plan: 2, stations: 1 })
    const incId2 = r2.race.settled.incident.id
    await post(PORT, `/api/incidents/${r2.race.started.race.id}/report`, {})
    const ass2 = await post(PORT, `/api/incidents/${incId2}/assess`, {})
    ok('租约艇可定损（对冲押金）', ass2.ok)
    const openR = await post(PORT, `/api/incidents/${incId2}/repair`, {})
    eq('租约艇开工单被拒', openR.ok, false)
    ok('拒绝原因指出出租方整备', /出租方整备/.test(openR.msg || ''))
    ok('租约艇事故不产生工单', (await api(PORT, '/api/state')).repairs.length === 0)

    console.log('\n[资金校验] 资金不足拒开工单；无保单也可定损后开工单自付维修')
    const r3 = await playUntilIncident(PORT, { plan: null, stations: 1 })
    const snap3 = r3.race.started.race.record.incident
    const wear3 = r3.race.started.race.record.result.wear
    const incId3 = r3.race.settled.incident.id
    await post(PORT, `/api/incidents/${r3.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${incId3}/assess`, {})
    // 直接写库把资金压到维修费以下
    const dbA = new DatabaseSync(path.join(dir, 'sky.db'))
    dbA.prepare('UPDATE team SET money=10 WHERE id=1').run()
    dbA.close()
    const openPoor = await post(PORT, `/api/incidents/${incId3}/repair`, {})
    eq('资金不足开工单被拒', openPoor.ok, false)
    const dbB = new DatabaseSync(path.join(dir, 'sky.db'))
    dbB.prepare('UPDATE team SET money=20000 WHERE id=1').run()
    dbB.close()
    const open3 = await post(PORT, `/api/incidents/${incId3}/repair`, {})  // 不指定技工 → 自动最强
    ok('无保单可自付开工单', open3.ok)
    eq('自动指派最强技工', open3.repair.mechanic.name, '格蕾丝·铆钉')
    const pd3 = Math.max(5, 100 - wear3 - snap3.damage)
    const comp3 = await post(PORT, `/api/repairs/${open3.repair.id}/complete`, {})
    eq('完工恢复部件', (await api(PORT, '/api/state')).airship.parts_dur, Math.min(100, pd3 + snap3.damage + 1))
    const accPoor = await post(PORT, `/api/repairs/${open3.repair.id}/accept`, {})
    ok('自付工单验收结案', accPoor.ok)

    console.log('\n[越站冲回] 已完工工单随越站作废：退维修费、扣回已恢复部件、工单 void')
    await post(PORT, '/api/reset')
    const dbC = new DatabaseSync(path.join(dir, 'sky.db'))
    const seasonC = dbC.prepare('SELECT season FROM team').get().season
    const c3 = dbC.prepare('SELECT * FROM circuits WHERE id=3').get()
    const tsC = String(Date.now())
    // 越站注入：跳过 1-2 站，第 3 站一条带事故的已结算记录（自有艇，磨损 10 + 事故损伤 20）
    const recC = {
      v: 1, circuit: { id: 3, name: c3.name, diff: c3.diff, weather: c3.weather }, season: seasonC,
      segments: [], factors: { weather: c3.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
      racers: [], events: [],
      result: { rank: 2, pts: 18, money: 1000, wear: 10, repGain: 4 },
      incident: { level: 'major', damage: 20, cause: '越站受损' }
    }
    dbC.exec('BEGIN')
    dbC.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=3').run()
    const ridC = Number(dbC.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
      VALUES (3,?,'settled',1,2,18,1000,10,4,?,0,?,?,?)`)
      .run(seasonC, JSON.stringify(recC), tsC, Date.now(), tsC).lastInsertRowid)
    // 模拟结算后的部件现场（正常磨损 10 + 事故损伤 20 已施加）
    dbC.prepare('UPDATE airships SET parts_dur=70, hp=70 WHERE id=1').run()
    dbC.exec('COMMIT')
    dbC.close()
    // 走工单流程：报案 → 定损 → 开工单（自动技工）→ 完工
    const repC = await post(PORT, `/api/incidents/${ridC}/report`, {})
    ok('越站事故可报案', repC.ok)
    const assC = await post(PORT, `/api/incidents/${repC.incident.id}/assess`, {})
    eq('越站事故定损=20×25', assC.incident.assessed, 500)
    const openC = await post(PORT, `/api/incidents/${repC.incident.id}/repair`, {})
    ok('越站事故工单开具', openC.ok)
    eq('工单预付 500', (await api(PORT, '/api/state')).team.money, 20000 - 500)
    const compC = await post(PORT, `/api/repairs/${openC.repair.id}/complete`, {})
    eq('完工恢复 21 点（20+技能加成1）', compC.restored, 21)
    eq('完工后部件 91', (await api(PORT, '/api/state')).airship.parts_dur, 91)
    const moneyPreRestart = (await api(PORT, '/api/state')).team.money
    // 重启触发启动迁移：越站修复作废第 3 站记录
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const post2 = await waitReady(PORT)
    eq('越站冲回后部件恢复 100（扣回工单恢复值后再冲回全部磨损）', post2.airship.parts_dur, 100)
    eq('越站奖金冲回、工单维修费退还（净 -500）', Math.round(post2.team.money), Math.round(moneyPreRestart - 1000 + 500))
    const dbD = new DatabaseSync(path.join(dir, 'sky.db'))
    eq('越站比赛记录置 void', dbD.prepare('SELECT status FROM races WHERE id=?').get(ridC).status, 'void')
    eq('越站理赔单置 void', dbD.prepare('SELECT status FROM incidents WHERE race_id=?').get(ridC).status, 'void')
    eq('越站工单置 void', dbD.prepare('SELECT status FROM repairs WHERE id=?').get(openC.repair.id).status, 'void')
    dbD.close()
    eq('状态视图无未结案工单（不再停场）', post2.repairs.filter(r => r.status === 'repairing' || r.status === 'repaired').length, 0)

    console.log('\n[跨赛季] 未结案工单跨赛季保留：新赛季仍停场，可完工验收解除')
    const r5 = await playFullSeasonWithIncident(PORT, { plan: 2 })
    const incId5 = r5.hits[0].settled.incident.id
    await post(PORT, `/api/incidents/${r5.hits[0].started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${incId5}/assess`, {})
    const open5 = await post(PORT, `/api/incidents/${incId5}/repair`, {})
    ok('完季前开具工单', open5.ok)
    const adv = await post(PORT, '/api/seasons/advance', {})
    ok('衔接新赛季', adv.ok)
    const stS2 = await api(PORT, '/api/state')
    eq('工单跨赛季保留（仍维修中）', stS2.repairs.find(r => r.id === open5.repair.id)?.status, 'repairing')
    const startS2 = await post(PORT, '/api/races/start/1', {})
    eq('新赛季未验收仍禁止参赛', startS2.ok, false)
    // 未完工不能验收
    const accEarly = await post(PORT, `/api/repairs/${open5.repair.id}/accept`, {})
    eq('技工未完工不能验收', accEarly.ok, false)
    const comp5 = await post(PORT, `/api/repairs/${open5.repair.id}/complete`, {})
    ok('跨赛季工单可完工', comp5.ok)
    const acc5 = await post(PORT, `/api/repairs/${open5.repair.id}/accept`, {})
    ok('跨赛季工单可验收结案', acc5.ok && acc5.repair.status === 'done')
    const startS2b = await post(PORT, '/api/races/start/1', {})
    ok('验收后新赛季恢复参赛', startS2b.ok)
    await post(PORT, `/api/races/${startS2b.race.id}/settle`, {})

    console.log('\n[保险视图联动] 事故卡片携带工单与可执行动作（服务端判定）')
    const r6 = await playUntilIncident(PORT, { plan: 3, stations: 1 })
    const incId6 = r6.race.settled.incident.id
    await post(PORT, `/api/incidents/${r6.race.started.race.id}/report`, {})
    await post(PORT, `/api/incidents/${incId6}/assess`, {})
    const ins1 = await api(PORT, '/api/insurance')
    const card1 = ins1.incidents.find(i => i.id === incId6)
    ok('定损后可开工单（elig.canRepair）', card1.elig.canRepair === true)
    eq('尚未开工单时 repair 为 null', card1.repair, null)
    const open6 = await post(PORT, `/api/incidents/${incId6}/repair`, {})
    ok('开工单成功', open6.ok)
    const ins2 = await api(PORT, '/api/insurance')
    const card2 = ins2.incidents.find(i => i.id === incId6)
    eq('开工单后入口关闭', card2.elig.canRepair, false)
    eq('事故卡片携带工单视图', card2.repair.id, open6.repair.id)
    eq('工单状态同步', card2.repair.status, 'repairing')

    proc.kill('SIGKILL'); proc = null; await sleep(120)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n🎉 全部 ${pass} 项断言通过：事故维修工单（报案→定损→开工单→完工→验收）/ 停场阻断 / 赔付对冲 / 越站冲回 / 跨赛季保留一致`)
}
main().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
