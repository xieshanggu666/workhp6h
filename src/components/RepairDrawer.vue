<script setup>
import { computed, ref } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
defineEmits(['close', 'insurance'])

const repairs = computed(() => store.repairs)
const orders = computed(() => repairs.value.orders || [])
const mechanics = computed(() => store.state?.mechanics || [])
const openCount = computed(() => repairs.value.openCount || 0)

const LEVEL_META = {
  minor: { icon: '🩹', cls: 'lv-minor', name: '轻微' },
  major: { icon: '🛠️', cls: 'lv-major', name: '严重' },
  crash: { icon: '💥', cls: 'lv-crash', name: '坠毁' }
}
const STATUS_META = {
  draft: { text: '① 待经理派工', cls: 'rp-draft' },
  assigned: { text: '② 技工维修中', cls: 'rp-assigned' },
  repaired: { text: '③ 待经理 / 保险方验收', cls: 'rp-repaired' },
  accepted: { text: '✔ 已验收结案', cls: 'rp-accepted' },
  void: { text: '已随比赛作废', cls: 'rp-void' }
}
// 理赔单状态简表（工单卡上展示保险方进度，体现三方协同）
const CLAIM_TEXT = {
  unfiled: '保险未报案', reported: '保险已报案', assessed: '保险已定损',
  paid: '保险已赔付', rejected: '保险已拒付', void: '保险单已作废'
}

const busyId = ref(0)
const selMech = ref({})        // 每张 draft 工单当前选中的技工
function mechOf(o) {
  if (o.mechanic) return o.mechanic.id
  if (selMech.value[o.id] != null) return selMech.value[o.id]
  const top = [...mechanics.value].sort((a, b) => b.skill - a.skill)[0]
  return top?.id ?? ''
}
function setMech(o, e) { selMech.value = { ...selMech.value, [o.id]: Number(e.target.value) } }
// 选中技工的派工费用预估（与服务端 repairQuote 同口径，仅用于展示）
function quote(o, mid) {
  const m = mechanics.value.find(x => x.id === Number(mid))
  if (!m) return { fee: 0, discount: 0, rate: repairs.value.rate }
  const base = repairs.value.rate || 25
  const discount = Math.min(0.2, m.skill * 0.1 / base)
  const rate = Math.round(base * (1 - discount) * 100) / 100
  return { fee: Math.round(rate * o.damage), discount, rate }
}

async function assign(o) {
  const mid = mechOf(o)
  if (!mid) { store.tip('请先招募或选择一名技工'); return }
  busyId.value = o.id
  const r = await store.repairAssign(o.id, mid)
  if (r?.ok) store.tip(r.msg || '派工成功')
  busyId.value = 0
}
async function doRepair(o) {
  busyId.value = o.id
  const r = await store.repairComplete(o.id)
  busyId.value = 0
  if (r?.ok) {
    if (r.already) store.tip('该工单已完工，等待验收')
    else store.tip(`技工维修完成，耗资 ¥${r.fee}，部件已修复，等待验收`)
  }
}
async function accept(o) {
  busyId.value = o.id
  const r = await store.repairAccept(o.id)
  busyId.value = 0
  if (r?.ok) store.tip(r.already ? '该工单已验收结案' : '验收通过，飞艇恢复参赛资格')
}
</script>

<template>
  <div class="drawer-mask" @click.self="$emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🔧 事故维修工单</h3><div class="d-sub">经理派工 · 技工维修 · 保险方协验，未结案自有艇禁止参赛</div></div>
        <button class="d-x" @click="$emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 待办概览 -->
        <div class="ins-overview">
          <div class="io-stat"><b class="mono">{{ orders.length }}</b><span>工单总数</span></div>
          <div class="io-stat" :class="{ alert: openCount }"><b class="mono">{{ openCount }}</b><span>未结案（禁赛中）</span></div>
          <div class="io-stat"><b class="mono">¥{{ repairs.rate }}</b><span>基础维修单价/点</span></div>
        </div>
        <div v-if="openCount" class="rp-block-hud">
          🚫 自有艇尚有 {{ openCount }} 张事故维修工单未验收结案，<b>不能参加下一站比赛</b>，也不能做常规维护；租约艇出赛不受影响
        </div>

        <div v-if="!orders.length" class="empty" style="color:var(--muted)">
          暂无事故维修工单。自有艇在比赛中发生事故后，结算即自动立案；租约艇事故由出租方整备、走保险赔付对冲押金。
        </div>

        <div v-else class="rp-list">
          <div v-for="o in orders" :key="o.id" class="rp-card" :class="['st-' + o.status]">
            <div class="cl-head">
              <span class="cl-level" :class="LEVEL_META[o.level]?.cls">
                {{ LEVEL_META[o.level]?.icon }} {{ LEVEL_META[o.level]?.name || o.level }}
              </span>
              <b class="cl-place">工单 #{{ o.id }} · {{ o.circuit.name }}<em v-if="o.rank" class="cl-rank">第 {{ o.rank }} 名</em></b>
              <span class="rp-status" :class="STATUS_META[o.status]?.cls">{{ STATUS_META[o.status]?.text || o.status }}</span>
            </div>
            <div class="cl-cause">{{ o.cause }}（S{{ o.season }}）</div>
            <div class="cl-meta">
              <span class="tag b">🛸 自有艇</span>
              <span class="tag o">事故损伤 {{ o.damage }} 点</span>
              <span v-if="o.mechanic" class="tag m">🔧 {{ o.mechanic.name }}（技能{{ o.mechanic.skill }}）</span>
              <span class="tag" :class="o.claimStatus === 'paid' ? 'm' : o.claimStatus === 'rejected' ? '' : 'b'">
                🛡️ {{ CLAIM_TEXT[o.claimStatus] || '保险未报案' }}
              </span>
              <span v-if="o.payout" class="tag m">赔款 +¥{{ o.payout.toLocaleString() }}</span>
            </div>

            <!-- ① 待派工：经理选择技工，费用随技工技能折让，派工时锁定 -->
            <template v-if="o.status === 'draft'">
              <div class="rp-assign">
                <span class="rp-role">👔 经理派工</span>
                <select :value="mechOf(o)" :disabled="busyId === o.id" @change="e => setMech(o, e)">
                  <option v-for="m in mechanics" :key="m.id" :value="m.id">
                    {{ m.name }}（技能{{ m.skill }} · 心情{{ m.mood }}）
                  </option>
                </select>
              </div>
              <div class="rent-row" v-if="mechOf(o)">
                <span>技工折让后工单费（{{ Math.round(quote(o, mechOf(o)).discount * 100) }}% off · ¥{{ quote(o, mechOf(o)).rate }}/点）</span>
                <b class="mono" style="color:var(--gold2)">¥{{ quote(o, mechOf(o)).fee.toLocaleString() }}</b>
              </div>
              <div class="cl-actions">
                <button class="btn sm primary" :disabled="busyId === o.id || !mechanics.length" @click="assign(o)">
                  👔 派工给技工
                </button>
                <button class="btn sm ghost" @click="$emit('insurance')">🛡️ 同步保险理赔</button>
              </div>
            </template>

            <!-- ② 维修中：技工完工，扣维修费、恢复部件健康 -->
            <template v-else-if="o.status === 'assigned'">
              <div class="cl-rows">
                <div class="rent-row"><span>工单维修费（技工完工时扣款）</span><b class="mono" style="color:var(--gold2)">¥{{ o.fee.toLocaleString() }}</b></div>
              </div>
              <div class="cl-actions">
                <button class="btn sm primary" :disabled="busyId === o.id || store.team.money < o.fee" @click="doRepair(o)">
                  🔧 技工完工 · 扣 ¥{{ o.fee.toLocaleString() }} 修复 {{ o.damage }} 点
                </button>
                <button class="btn sm ghost" @click="$emit('insurance')">🛡️ 保险定损/赔付</button>
              </div>
              <div v-if="store.team.money < o.fee" class="cl-warn">⚠️ 车队资金不足支付维修费，保险赔付到账后可再来完工</div>
            </template>

            <!-- ③ 待验收：经理 + 保险方共同核对后结案 -->
            <template v-else-if="o.status === 'repaired'">
              <div class="cl-rows">
                <div class="rent-row"><span>维修费已支付</span><b class="mono">¥{{ o.fee.toLocaleString() }}</b></div>
                <div class="rent-row"><span>部件健康已恢复</span><b class="mono" style="color:var(--mint)">+{{ o.damage }} 点</b></div>
                <div class="rent-row"><span>保险方核对</span><b :style="o.claimStatus === 'paid' ? 'color:var(--mint)' : 'color:var(--muted)'">{{ CLAIM_TEXT[o.claimStatus] || '保险未报案' }}</b></div>
              </div>
              <div class="rp-accept-hint">经理确认部件修复、保险方核对定损赔付口径后共同验收；结案前飞艇仍处于禁赛状态</div>
              <div class="cl-actions">
                <button class="btn sm mint" :disabled="busyId === o.id" @click="accept(o)">✅ 经理 / 保险方验收结案</button>
                <button v-if="o.claimStatus !== 'paid' && o.claimStatus !== 'rejected'" class="btn sm ghost" @click="$emit('insurance')">🛡️ 去处理保险</button>
              </div>
            </template>

            <!-- 已结案 / 已作废 -->
            <template v-else>
              <div class="cl-actions">
                <span v-if="o.status === 'accepted'" class="cl-done">✔ 已验收结案，飞艇可正常参赛（维修费 ¥{{ o.fee.toLocaleString() }}）</span>
                <span v-else class="cl-done dim">该工单随越站比赛历史修复作废，已扣维修费已退回</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>
