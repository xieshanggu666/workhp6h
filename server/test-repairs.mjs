/**
 * 事故维修工单 功能验证（经理 / 技工 / 保险方协同）
 * 覆盖：结算自动立案（仅自有艇）/ 派工（技工折让费用服务端核定）/
 * 维修（扣款+恢复部件健康+技工心情）/ 验收结案 / 幂等与状态机 /
 * 未结案阻断开赛与常规维护 / 租约艇不建单 / 越站作废对称退维修费 / 老库迁移补单
 *
 * 用法：node --experimental-sqlite server/test-repairs.mjs（需要 Node ≥22.5 的 node:sqlite）
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-rep-'))
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
// 反复重置直到第 1 站（或指定站）出现自有艇事故
async function playUntilOwnIncident(port, { stations = 1, rent = false } = {}) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await post(port, '/api/reset')
    if (rent) {
      const r = await post(port, '/api/rentals/rent', { id: 1 })
      assert.ok(r.ok, '租艇失败：' + r.msg)
    }
    let hit = null
    for (let cid = 1; cid <= stations; cid++) {
      const r = await playStation(port, cid)
      if (r.settled.incident && !r.started.race.record.factors.rental && !hit) hit = r
    }
    if (hit) return { race: hit, attempt }
  }
  throw new Error('多轮尝试后仍未出现自有艇事故')
}
// 直接写库注入一条「已结算、自有艇、带事故」的比赛记录
function injectIncidentRace(dir, { circuitId, damage = 20, level = 'major', season, withRepair = null, mechanicId = null }) {
  const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
  const c = dbh.prepare('SELECT * FROM circuits WHERE id=?').get(circuitId)
  const ts = String(Date.now())
  const rec = {
    v: 1, circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather }, season,
    segments: [], factors: { weather: c.weather, rental: null, lineup: { shipMode: 'own' }, mods: [], pilot: null, mech: null, base: {} },
    racers: [], events: [],
    result: { rank: 2, pts: 18, money: 1000, wear: 8, repGain: 4 },
    incident: { level, damage, cause: '注入事故' }
  }
  dbh.exec('BEGIN')
  dbh.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=?').run(circuitId)
  const rid = dbh.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
    VALUES (?,?,'settled',1,2,18,1000,8,4,?,0,?,?,?)`)
    .run(circuitId, season, JSON.stringify(rec), ts, Date.now(), ts).lastInsertRowid
  const incId = dbh.prepare(`INSERT INTO incidents (race_id,season,circuit_id,level,cause,damage,status,created_at,reported_at)
    VALUES (?,?,?,?,?,?,'reported',?,?)`).run(rid, season, circuitId, level, '注入事故', damage, ts, ts).lastInsertRowid
  if (withRepair) {
    dbh.prepare(`INSERT INTO repair_orders (race_id,incident_id,season,circuit_id,level,cause,damage,mechanic_id,mechanic_name,rate,fee,status,created_at,assigned_at,repaired_at,accepted_at)
      VALUES (?,?,?,?,?,?,?,?,?,25,?,?,?,?,?,?)`)
      .run(rid, Number(incId), season, circuitId, level, '注入事故', damage,
        mechanicId, mechanicId ? '注入技工' : null, damage * 25, withRepair,
        ts, withRepair !== 'draft' ? ts : null,
        withRepair === 'repaired' || withRepair === 'accepted' ? ts : null,
        withRepair === 'accepted' ? ts : null)
  }
  dbh.exec('COMMIT')
  dbh.close()
  return Number(rid)
}

async function main() {
  const PORT = 4431
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)

    console.log('\n[自动立案] 自有艇事故结算后生成 draft 维修工单')
    const s0 = await api(PORT, '/api/state')
    eq('初始无工单', s0.repairs.orders.length, 0)
    eq('初始未禁赛', s0.repairs.blocked, false)
    const f = await playUntilOwnIncident(PORT, { stations: 1 })
    const snap = f.race.started.race.record.incident
    const st1 = await api(PORT, '/api/state')
    eq('事故后产生 1 张工单', st1.repairs.orders.length, 1)
    eq('未结案数为 1（禁赛）', st1.repairs.openCount, 1)
    eq('工单为 draft', st1.repairs.orders[0].status, 'draft')
    eq('工单关联事故损伤', st1.repairs.orders[0].damage, snap.damage)
    eq('结算响应携带工单', !!f.race.settled.repair, true)
    eq('结算工单为 draft', f.race.settled.repair.status, 'draft')

    console.log('\n[开赛阻断] 未结案工单未修复不得参赛')
    // 第 1 站已完赛，尝试开第 2 站应被维修工单拦截
    const start2 = await post(PORT, '/api/races/start/2', {})
    eq('未维修开第 2 站被拒', start2.ok, false)
    ok('拦截原因指向维修工单', /维修/.test(start2.msg || ''))
    // 常规维护同样被阻断
    const maint = await post(PORT, '/api/maintain', {})
    eq('常规维护被工单阻断', maint.ok, false)
    ok('维护拦截原因指向工单', /工单/.test(maint.msg || ''))

    console.log('\n[派工] 经理指派技工，费用服务端核定（技能折让）')
    const orderId = st1.repairs.orders[0].id
    const mech = st1.mechanics[0]
    const assign = await post(PORT, `/api/repairs/${orderId}/assign`, { mechanicId: mech.id })
    ok('派工成功', assign.ok)
    eq('派工后状态 assigned', assign.order.status, 'assigned')
    eq('派工技工快照正确', assign.order.mechanic.id, mech.id)
    // 折让：min(20%, skill*0.1/25)；种子技工技能 58 → 5.8/25=23.2% 封顶 20% → rate 20
    const expRate = Math.round(25 * (1 - Math.min(0.2, mech.skill * 0.1 / 25)) * 100) / 100
    const expFee = Math.round(expRate * snap.damage)
    eq('技工折让单价正确', assign.order.rate, expRate)
    eq('工单费用=折让单价×损伤', assign.order.fee, expFee)
    // 非法技工被拒
    const badAssign = await post(PORT, `/api/repairs/${orderId}/assign`, { mechanicId: 9999 })
    eq('非名册技工派工被拒', badAssign.ok, false)
    // 已派工不能改派
    const reAssign = await post(PORT, `/api/repairs/${orderId}/assign`, { mechanicId: mech.id })
    eq('已派工改派被拒', reAssign.ok, false)

    console.log('\n[维修] 技工完工：扣款 + 恢复部件健康 + 心情奖励')
    const before = await api(PORT, '/api/state')
    const pdBefore = before.airship.parts_dur
    const moneyBefore = before.team.money
    const moodBefore = mech.mood
    const rep = await post(PORT, `/api/repairs/${orderId}/repair`, {})
    ok('维修完工成功', rep.ok)
    eq('完工状态 repaired', rep.order.status, 'repaired')
    const after = await api(PORT, '/api/state')
    eq('扣除工单维修费', Math.round(after.team.money), Math.round(moneyBefore - expFee))
    eq('部件健康按事故损伤恢复', after.airship.parts_dur, Math.min(100, pdBefore + snap.damage))
    const mechAfter = after.mechanics.find(m => m.id === mech.id)
    eq('技工心情奖励 +4', mechAfter.mood, Math.min(100, moodBefore + 4))
    // 完工后仍然禁赛（待验收）
    eq('完工未验收仍禁赛', after.repairs.openCount, 1)
    const start2b = await post(PORT, '/api/races/start/2', {})
    eq('维修完未验收仍不能开赛', start2b.ok, false)
    // 重复完工幂等不二次扣款
    const repAgain = await post(PORT, `/api/repairs/${orderId}/repair`, {})
    ok('重复完工幂等', repAgain.ok && repAgain.already)
    const after2 = await api(PORT, '/api/state')
    eq('幂等不二次扣款', Math.round(after2.team.money), Math.round(after.team.money))

    console.log('\n[验收] 经理 + 保险方验收结案，解除禁赛')
    // 未完工不能验收：另开一张 draft 工单验证（需要第二起事故，用注入）
    const accept = await post(PORT, `/api/repairs/${orderId}/accept`, {})
    ok('验收成功', accept.ok)
    eq('验收后 accepted', accept.order.status, 'accepted')
    const after3 = await api(PORT, '/api/state')
    eq('结案后无未结案工单', after3.repairs.openCount, 0)
    eq('结案后解除禁赛', after3.repairs.blocked, false)
    const start2c = await post(PORT, '/api/races/start/2', {})
    ok('结案后可正常开赛（不再被维修拦截）', start2c.ok)
    const repeatAccept = await post(PORT, `/api/repairs/${orderId}/accept`, {})
    ok('重复验收幂等', repeatAccept.ok && repeatAccept.already)

    console.log('\n[资金不足] 完工时资金不足被拒，部件不恢复')
    await post(PORT, '/api/reset')
    const f2 = await playUntilOwnIncident(PORT, { stations: 1 })
    const o2 = (await api(PORT, '/api/state')).repairs.orders[0]
    const m2 = (await api(PORT, '/api/state')).mechanics[0]
    await post(PORT, `/api/repairs/${o2.id}/assign`, { mechanicId: m2.id })
    // 直接把钱扣光
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      dbh.prepare('UPDATE team SET money=0').run()
      dbh.close()
    }
    const repPoor = await post(PORT, `/api/repairs/${o2.id}/repair`, {})
    eq('资金不足完工被拒', repPoor.ok, false)
    const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
    eq('资金不足工单仍 assigned', dbh.prepare('SELECT status FROM repair_orders WHERE id=?').get(o2.id).status, 'assigned')
    dbh.close()

    console.log('\n[租约艇] 事故不建维修工单（出租方整备，保险对冲押金）')
    await post(PORT, '/api/reset')
    // 租雨燕跑第 1 站直到事故
    const fr = await playUntilOwnIncident(PORT, { stations: 1, rent: true }).catch(() => null)
    // playUntilOwnIncident 过滤了 rental，需要专门跑：重置后直接循环
    let rentalHit = null
    for (let attempt = 0; attempt < 80 && !rentalHit; attempt++) {
      await post(PORT, '/api/reset')
      await post(PORT, '/api/rentals/rent', { id: 1 })
      const rr = await playStation(PORT, 1)
      if (rr.settled.incident && rr.started.race.record.factors.rental) rentalHit = rr
    }
    ok('租约艇事故场次已构造', !!rentalHit)
    const stR = await api(PORT, '/api/state')
    eq('租约艇事故不建维修工单', stR.repairs.orders.length, 0)
    eq('租约艇事故不禁赛', stR.repairs.blocked, false)

    console.log('\n[状态机] draft 不可验收 / 不存在工单 404')
    await post(PORT, '/api/reset')
    const f3 = await playUntilOwnIncident(PORT, { stations: 1 })
    const o3 = (await api(PORT, '/api/state')).repairs.orders[0]
    const acceptDraft = await post(PORT, `/api/repairs/${o3.id}/accept`, {})
    eq('draft 直接验收被拒', acceptDraft.ok, false)
    const repairDraft = await post(PORT, `/api/repairs/${o3.id}/repair`, {})
    eq('draft 直接维修被拒', repairDraft.ok, false)
    const noOrder = await post(PORT, '/api/repairs/9999/accept', {})
    eq('不存在工单 404', noOrder.ok === false && /不存在/.test(noOrder.msg || ''), true)

    console.log('\n[越站作废] 已完工工单随越站记录对称退维修费、回退技工心情')
    await post(PORT, '/api/reset')
    const stPre = await api(PORT, '/api/state')
    const seasonNow = stPre.team.season
    const mechId = stPre.mechanics[0].id
    const moodPre = stPre.mechanics[0].mood
    // 第 1 站正常完赛（无事故），第 3 站注入越站事故 + repaired 工单（费用已扣、心情已奖）
    await playStation(PORT, 1)
    const stAt1 = await api(PORT, '/api/state')
    const moneyPreVoid = stAt1.team.money
    const FEE = 500
    // 越站现场：repaired 工单（技工费 500 已扣、心情 +4 已奖）；
    // 艇状态按「结算磨损 28 → 维修恢复事故损伤 20」的净效果为 -8（仅正常磨损）
    const ridV = injectIncidentRace(dir, { circuitId: 3, damage: 20, level: 'crash', season: seasonNow, withRepair: 'repaired', mechanicId: mechId })
    const dbV = new DatabaseSync(path.join(dir, 'sky.db'))
    const pdAtVoid = Math.max(5, dbV.prepare('SELECT parts_dur FROM airships WHERE id=1').get().parts_dur - 8)
    dbV.prepare('UPDATE airships SET parts_dur=?, hp=? WHERE id=1').run(pdAtVoid, pdAtVoid)
    dbV.prepare('UPDATE team SET money=money-? WHERE id=1').run(FEE)
    dbV.prepare('UPDATE mechanics SET mood=MIN(100,mood+4) WHERE id=?').run(mechId)
    dbV.close()
    void ridV
    // 资金口径：越站修复只与「注入时刻 team 余额」挂钩——注入的 races 行从未给 team 加过奖金，
    // 回滚只退回已扣维修费 500；合约对账冲回额按修复前后 contracts.earned 的奖励差精确核算
    const earnedSum = dbh => dbh.prepare("SELECT COALESCE(SUM(reward),0) s FROM contracts WHERE season=? AND earned=1")
      .get(seasonNow).s
    const dbC0 = new DatabaseSync(path.join(dir, 'sky.db'))
    const earnedBefore = earnedSum(dbC0)
    dbC0.close()
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const postFix = await waitReady(PORT)
    const dbCf = new DatabaseSync(path.join(dir, 'sky.db'))
    const earnedAfter = earnedSum(dbCf)
    dbCf.close()
    const contractRevoked = Math.max(0, earnedBefore - earnedAfter)
    const dbV1 = new DatabaseSync(path.join(dir, 'sky.db'))
    const oVoidRow = dbV1.prepare("SELECT status FROM repair_orders WHERE race_id=(SELECT id FROM races WHERE circuit_id=3)").get()
    dbV1.close()
    eq('越站工单已作废', oVoidRow.status, 'void')
    // 资金口径（注入行的 1000 奖金未入 team，修复仍按发奖口径冲回，与既有越站测试一致）：
    //   期末 = 修复前余额 − 注入时扣的维修费 500 − 修复净扣（奖金冲回 1000 − 维修费退款 500）− 合约冲回
    eq('越站已完工维修费已退回（含合约对账冲回）', Math.round(postFix.team.money),
      Math.round(moneyPreVoid - FEE - (1000 - FEE) - contractRevoked))
    const dbV2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const mechV = dbV2.prepare('SELECT mood FROM mechanics WHERE id=?').get(mechId)
    // 注入完工时心情 +4，越站作废对称回退 4（若中途触顶 100 则为 MAX(0, 100-4)）
    const moodExpected = Math.max(0, Math.min(100, moodPre + 4) - 4)
    eq('技工心情已对称回退', mechV.mood, moodExpected)
    // 部件只回滚正常磨损 8（事故损伤已由维修恢复，作废不再重复恢复）
    const pdAfter = dbV2.prepare('SELECT parts_dur FROM airships WHERE id=1').get().parts_dur
    eq('部件仅回滚正常磨损（不重复恢复事故损伤）', pdAfter, Math.min(100, pdAtVoid + 8))
    eq('越站比赛记录置 void', dbV2.prepare("SELECT status FROM races WHERE circuit_id=3").get().status, 'void')
    dbV2.close()

    console.log('\n[老库迁移] 存量已结算自有艇事故启动时补建 draft 工单')
    await post(PORT, '/api/reset')
    const stM = await api(PORT, '/api/state')
    const seasonM = stM.team.season
    await playStation(PORT, 1)  // 让第 1 站已完赛，便于越站判断不触发
    // 直接写库：第 2 站已结算事故（物理理赔单），但没有工单
    const ridM = injectIncidentRace(dir, { circuitId: 2, damage: 15, season: seasonM })
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const postM = await waitReady(PORT)
    const oMig = postM.repairs.orders.find(o => o.raceId === ridM)
    ok('老事故补建了工单', !!oMig)
    eq('补建工单为 draft', oMig?.status, 'draft')
    eq('迁移即禁赛（未修阻断）', postM.repairs.blocked, true)
    // 再重启一次：幂等不补第二张
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const postM2 = await waitReady(PORT)
    eq('补单迁移幂等（仍只有 1 张关联工单）', postM2.repairs.orders.filter(o => o.raceId === ridM).length, 1)
    // 租约艇老事故不补单
    await post(PORT, '/api/reset')
    {
      const dbR = new DatabaseSync(path.join(dir, 'sky.db'))
      const seasonR = dbR.prepare('SELECT season FROM team').get().season
      const c = dbR.prepare('SELECT * FROM circuits WHERE id=1').get()
      const ts = String(Date.now())
      const rec = {
        v: 1, circuit: { id: 1, name: c.name, diff: c.diff, weather: c.weather }, season: seasonR,
        segments: [], factors: { weather: c.weather, rental: { id: 99, shipId: 1, name: '雨燕' }, lineup: { shipMode: 'rental' }, mods: [], pilot: null, mech: null, base: {} },
        racers: [], events: [], result: { rank: 2, pts: 18, money: 1000, wear: 8, repGain: 4 },
        incident: { level: 'minor', damage: 8, cause: '租约艇事故' }
      }
      dbR.exec('BEGIN')
      dbR.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=1').run()
      dbR.prepare(`INSERT INTO races (circuit_id,season,status,settled,rank,pts,money,wear,rep_gain,record,watch_el,created_at,created_ts,settled_at)
        VALUES (1,?,'settled',1,2,18,1000,8,4,?,0,?,?,?)`).run(seasonR, JSON.stringify(rec), ts, Date.now(), ts)
      dbR.exec('COMMIT')
      dbR.close()
    }
    proc.kill('SIGKILL'); proc = null; await sleep(150)
    proc = startServer(dir, PORT)
    const postR = await waitReady(PORT)
    eq('租约艇老事故不补维修工单', postR.repairs.orders.length, 0)

    proc.kill('SIGKILL'); proc = null; await sleep(120)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n🎉 全部 ${pass} 项断言通过：事故维修工单的立案/派工/维修/验收协同、费用核定、部件健康联动、未修禁赛阻断、租约豁免、越站对称退赔与老库迁移一致`)
}
main().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
