<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  addCustomSize,
  allPapers,
  allSizes,
  clearItemPhoto,
  clearItemPhotos,
  createTask,
  deleteTask,
  getItemPhoto,
  itemPhotoCount,
  leftovers,
  markLeftoverUsed,
  photoKey,
  photoVersion,
  pruneOrphanPhotos,
  runPack,
  setItemPhoto,
  settings,
  tasks,
  templates,
  trimItemPhotos,
} from '../store'
import { findPhotoSize, newId } from '../logic/library'
import { adviseRotation, checkOrientation } from '../logic/orientation'
import { loadImage } from '../logic/image'
import { formatCents, formatPercent } from '../logic/units'
import FilmStrip from '../components/FilmStrip.vue'
import type { Item, Paper, PhotoRef, Task } from '../logic/types'

const router = useRouter()

const draft = reactive({
  name: '',
  paperId: 'p5x7',
  customPaper: {
    id: 'custom',
    name: '自定义相纸',
    wMm: 152,
    hMm: 210,
    marginMm: 3,
    priceCents: 200,
    kind: 'sheet',
  } as Paper,
  items: [] as Item[],
  gapMm: settings.value.gapMm,
  kerfMm: settings.value.kerfMm,
  safeEdgeMm: settings.value.safeEdgeMm,
  allowRotate: settings.value.allowRotate,
  headerText: '',
  footerText: '',
  /** 空位策略：false = 拦住不许排；true = 空位提示并用第 1 张底片顶替 */
  fallbackFirstPhoto: false,
})

const error = ref('')
const hint = ref('')
const newSize = reactive({ name: '', wMm: 50, hMm: 70 })

const currentPaper = computed<Paper>(() =>
  draft.paperId === 'custom'
    ? draft.customPaper
    : allPapers.value.find((p) => p.id === draft.paperId) ?? allPapers.value[0],
)

const usableText = computed(() => {
  const p = currentPaper.value
  const w = p.wMm - 2 * (p.marginMm + draft.safeEdgeMm)
  const h = p.hMm - 2 * (p.marginMm + draft.safeEdgeMm)
  if (w <= 0 || h <= 0) return '安全边已超过相纸尺寸'
  return `${w.toFixed(1)} × ${h.toFixed(1)} mm`
})

const totalQty = computed(() => draft.items.reduce((a, i) => a + Math.max(0, i.qty), 0))

/** 「只出现一次」且还缺底片的条目：itemId -> 缺几张 */
const missingByItem = computed(() => {
  void photoVersion.value
  const m = new Map<string, number>()
  for (const item of draft.items) {
    if (item.repeatSamePhoto) continue
    const need = Math.max(0, item.qty)
    const have = itemPhotoCount(item.id)
    if (have < need) m.set(item.id, need - have)
  }
  return m
})

const totalMissing = computed(() => {
  let n = 0
  for (const v of missingByItem.value.values()) n += v
  return n
})

/** 提交是否被空位策略拦住 */
const blockedByMissing = computed(
  () => !draft.fallbackFirstPhoto && totalMissing.value > 0,
)

function addItem(sizeId?: string) {
  const size = sizeId ?? allSizes.value[0]?.id
  if (!size) return
  const s = findPhotoSize(allSizes.value, size)
  draft.items.push({
    id: newId('item'),
    sizeId: size,
    qty: 1,
    rotateAllowed: s?.rotateByDefault ?? false,
    repeatSamePhoto: true,
    keepTogether: false,
  })
}

/** 删除一条清单：对应的全部底片一起清掉，不能留着 */
function removeItem(id: string) {
  draft.items = draft.items.filter((i) => i.id !== id)
  clearItemPhotos(id)
}

function clearAllItems() {
  for (const item of draft.items) clearItemPhotos(item.id)
  draft.items = []
}

function onSizeChange(item: Item) {
  const s = findPhotoSize(allSizes.value, item.sizeId)
  item.rotateAllowed = s?.rotateByDefault ?? false
}

/** 数量变化：多出来的空位留空；数量减少时多余底片一并清掉 */
function onQtyChange(item: Item) {
  if (item.repeatSamePhoto) {
    trimItemPhotos(item.id, 1)
  } else {
    trimItemPhotos(item.id, Math.max(0, item.qty))
  }
}

/** 在「重复排 / 只出现一次」之间切换：改成重复排只保留第 1 张；改成只出现一次空位待填 */
function onRepeatChange(item: Item) {
  if (item.repeatSamePhoto) trimItemPhotos(item.id, 1)
}

function applyTemplate(tplId: string) {
  // 套模板会整单替换清单，先把当前草稿条目对应的底片全部回收
  for (const old of draft.items) clearItemPhotos(old.id)
  const tpl = templates.value.find((t) => t.id === tplId)
  if (!tpl) return
  draft.paperId = tpl.paperId
  draft.name = tpl.name
  draft.items = tpl.items.map((i) => ({
    id: newId('item'),
    sizeId: i.sizeId,
    qty: i.qty,
    rotateAllowed: i.rotateAllowed,
    repeatSamePhoto: true,
    keepTogether: i.keepTogether,
  }))
  hint.value = `已套用模板「${tpl.name}」：底片槽已重置，请逐行选择底片`
}

async function readFileInto(item: Item, copyIndex: number, file: File): Promise<PhotoRef | undefined> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const refInfo: PhotoRef = {
      name: file.name,
      wPx: img.naturalWidth,
      hPx: img.naturalHeight,
      landscape: img.naturalWidth >= img.naturalHeight,
    }
    setItemPhoto(photoKey(item.id, copyIndex), url, refInfo)
    return refInfo
  } catch {
    URL.revokeObjectURL(url)
    return undefined
  }
}

/** FilmStrip 上抛：从 startIndex 开始按顺序填入多张图片（选择/拖入统一入口） */
async function onFiles(item: Item, startIndex: number, files: File[]) {
  error.value = ''
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!images.length) return
  const slotCount = item.repeatSamePhoto ? 1 : Math.max(1, item.qty)
  const accepted: File[] = []
  let overflow = 0
  images.forEach((f, k) => {
    const target = startIndex + k
    if (target < slotCount) accepted.push(f)
    else overflow++
  })
  let lastRef: PhotoRef | undefined
  let failed = 0
  for (let k = 0; k < accepted.length; k++) {
    const ref = await readFileInto(item, startIndex + k, accepted[k])
    if (ref) lastRef = ref
    else failed++
  }
  if (failed) error.value = `${failed} 张图片读取失败（仅在本机内存中读取尺寸与方向，不上传）`
  if (accepted.length > 1) {
    hint.value = `已按顺序填入 ${accepted.length} 张底片${overflow ? `，另有 ${overflow} 张超出空位未填入` : ''}`
  } else if (lastRef) {
    const s = findPhotoSize(allSizes.value, item.sizeId)
    const mismatch = checkOrientation(item, s, lastRef)
    if (mismatch?.mismatch && !item.rotateAllowed) {
      hint.value = `底片是${mismatch.filmText}的，而「${s?.name}」成品是${mismatch.printText}：可点下方「允许旋转并重新试算」看怎样更省纸`
    } else {
      hint.value = `已在本机读取「${accepted[0].name}」：${lastRef.wPx}×${lastRef.hPx}px（${lastRef.landscape ? '横向' : '纵向'}，不会上传）`
    }
  }
}

function removeFile(item: Item, copyIndex: number) {
  clearItemPhoto(photoKey(item.id, copyIndex))
}

function useLeftoverPick(id: string) {
  const l = leftovers.value.find((x) => x.id === id)
  if (!l) return
  draft.paperId = 'custom'
  draft.customPaper = {
    id: 'custom',
    name: `余料 ${l.name}`,
    wMm: l.wMm,
    hMm: l.hMm,
    marginMm: l.marginMm,
    priceCents: l.priceCents,
    kind: 'sheet',
  }
  markLeftoverUsed(id)
  hint.value = `已使用余料「${l.name}」${l.wMm}×${l.hMm}mm`
}

function addSize() {
  if (!newSize.name.trim()) {
    error.value = '请填写自定义尺寸名称'
    return
  }
  if (newSize.wMm <= 0 || newSize.hMm <= 0) {
    error.value = '自定义尺寸必须大于 0'
    return
  }
  const s = addCustomSize({
    name: newSize.name.trim(),
    wMm: newSize.wMm,
    hMm: newSize.hMm,
    rotateByDefault: false,
  })
  newSize.name = ''
  addItem(s.id)
}

/** 行内方向提示（底片横/纵 vs 成品横/纵）；只出现一次时以第 1 张底片为准 */
function rowOrientation(item: Item) {
  void photoVersion.value
  const ph = getItemPhoto(photoKey(item.id, 0))
  const s = findPhotoSize(allSizes.value, item.sizeId)
  return checkOrientation(item, s, ph?.ref)
}

/** 方向试算：把当前清单按「不转」和「只翻不匹配条目」各排一次，看哪种省纸 */
const rotationAdvice = computed(() => {
  void photoVersion.value
  if (!draft.items.some((i) => !i.repeatSamePhoto || getItemPhoto(photoKey(i.id, 0)))) {
    return undefined
  }
  const filmLandscape = new Map<string, boolean>()
  let anyMismatch = false
  for (const item of draft.items) {
    const ph = getItemPhoto(photoKey(item.id, 0))
    if (!ph) continue
    filmLandscape.set(item.id, ph.ref.landscape)
    const s = findPhotoSize(allSizes.value, item.sizeId)
    const m = checkOrientation(item, s, ph.ref)
    if (m?.mismatch) anyMismatch = true
  }
  if (!anyMismatch) return undefined
  const p = currentPaper.value
  return adviseRotation({
    items: draft.items.map((i) => ({ ...i })),
    sizes: allSizes.value,
    paperW: p.wMm,
    paperH: p.hMm,
    marginMm: p.marginMm,
    safeEdgeMm: draft.safeEdgeMm,
    gapMm: draft.gapMm,
    kerfMm: draft.kerfMm,
    allowRotate: draft.allowRotate,
    filmLandscape,
  })
})

/** 一键采纳建议：打开整体旋转开关，并把方向不匹配的条目改成允许旋转 */
function acceptRotationAdvice() {
  const advice = rotationAdvice.value
  if (!advice?.suggestRotate) return
  draft.allowRotate = true
  for (const item of draft.items) {
    const ph = getItemPhoto(photoKey(item.id, 0))
    if (!ph) continue
    const s = findPhotoSize(allSizes.value, item.sizeId)
    const m = checkOrientation(item, s, ph.ref)
    if (m?.mismatch) item.rotateAllowed = true
  }
  hint.value = `已允许旋转：${advice.layoutText}（${advice.detail}）`
}

function submit() {
  error.value = ''
  hint.value = ''
  if (!draft.items.length) {
    error.value = '请先添加照片清单'
    return
  }
  if (draft.items.some((i) => i.qty <= 0)) {
    error.value = '照片数量必须大于 0'
    return
  }
  if (blockedByMissing.value) {
    error.value = `还有 ${totalMissing.value} 个底片空位没选文件：请逐张选好（或直接把多张图片拖入槽位），或勾选「空位用第 1 张底片顶替」后再排样`
    return
  }
  const task: Task = createTask({
    name: draft.name || undefined,
    paperId: draft.paperId,
    customPaper: draft.paperId === 'custom' ? { ...draft.customPaper } : undefined,
    items: draft.items.map((i) => ({ ...i })),
    gapMm: draft.gapMm,
    kerfMm: draft.kerfMm,
    safeEdgeMm: draft.safeEdgeMm,
    allowRotate: draft.allowRotate,
    headerText: draft.headerText,
    footerText: draft.footerText,
    fallbackFirstPhoto: draft.fallbackFirstPhoto,
  })
  const err = runPack(task)
  if (err) {
    error.value = err
    return
  }
  router.push(`/layout/${task.id}`)
}

function openTask(t: Task, route: string) {
  router.push(`/${route}/${t.id}`)
}

function taskPaperName(t: Task) {
  if (t.paperId === 'custom' && t.customPaper) return t.customPaper.name
  return allPapers.value.find((p) => p.id === t.paperId)?.name ?? '未知相纸'
}

onMounted(() => {
  // 清掉上一次放弃的草稿底片（已保存任务的条目会保留）
  pruneOrphanPhotos(new Set(draft.items.map((i) => i.id)))
})
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">新建拼版任务</h1>
      <span class="badge brand">相纸 + 照片清单</span>
      <div class="spacer"></div>
      <span class="badge">共 {{ totalQty }} 张照片</span>
      <span v-if="totalMissing" class="badge warn">{{ totalMissing }} 个底片空位</span>
    </div>

    <div v-if="error" class="note danger">{{ error }}</div>
    <div v-if="hint" class="note ok">{{ hint }}</div>

    <div class="grid sidebar">
      <div class="stack">
        <div class="card">
          <h3>① 相纸规格</h3>
          <div class="card-sub">可用区已扣掉纸边留白与四周安全边</div>
          <div class="stack">
            <label class="field">
              相纸
              <select v-model="draft.paperId">
                <option v-for="p in allPapers" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ p.wMm }}×{{ p.hMm }}mm · {{ formatCents(p.priceCents) }}/张
                </option>
                <option value="custom">自定义相纸…</option>
              </select>
            </label>
            <div v-if="draft.paperId === 'custom'" class="grid cols-2">
              <label class="field">
                宽 mm
                <input v-model.number="draft.customPaper.wMm" type="number" min="10" step="0.1" />
              </label>
              <label class="field">
                高 mm
                <input v-model.number="draft.customPaper.hMm" type="number" min="10" step="0.1" />
              </label>
              <label class="field">
                纸边留白 mm
                <input v-model.number="draft.customPaper.marginMm" type="number" min="0" step="0.5" />
              </label>
              <label class="field">
                单价（分）
                <input v-model.number="draft.customPaper.priceCents" type="number" min="0" step="10" />
              </label>
            </div>
            <div class="kv">
              <dt>相纸尺寸</dt>
              <dd>{{ currentPaper.wMm }} × {{ currentPaper.hMm }} mm</dd>
              <dt>可用区</dt>
              <dd>{{ usableText }}</dd>
              <dt>单张成本</dt>
              <dd>{{ formatCents(currentPaper.priceCents) }}</dd>
            </div>
            <div class="grid cols-2">
              <label class="field">
                页眉（打印在纸边）
                <input v-model="draft.headerText" type="text" placeholder="如 Studio 2026" />
              </label>
              <label class="field">
                落款（打印在纸边）
                <input v-model="draft.footerText" type="text" placeholder="如 2026-09-20" />
              </label>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>③ 裁切参数</h3>
          <div class="card-sub">间隙 0 = 共边裁切；刀宽补偿从照片外侧向内缩</div>
          <div class="stack">
            <label class="field">
              相邻照片间距 gapMm：{{ draft.gapMm }} mm
              <input v-model.number="draft.gapMm" type="range" min="0" max="10" step="0.5" />
            </label>
            <label class="field">
              最小裁切余量（刀宽补偿）kerfMm：{{ draft.kerfMm }} mm
              <input v-model.number="draft.kerfMm" type="range" min="0" max="3" step="0.1" />
            </label>
            <label class="field">
              四周安全边 safeEdgeMm：{{ draft.safeEdgeMm }} mm
              <input v-model.number="draft.safeEdgeMm" type="range" min="0" max="20" step="0.5" />
            </label>
            <label class="check">
              <input v-model="draft.allowRotate" type="checkbox" />
              允许整体旋转 90°（证件照建议关闭）
            </label>
          </div>
        </div>

        <div class="card">
          <h3>余料库</h3>
          <div class="card-sub">排样剩下的纸边可以登记，下次优先用余料</div>
          <div v-if="!leftovers.length" class="note">暂无登记余料，可在「排样预览」页把剩余纸边登记进来</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>余料</th>
                <th class="num">尺寸 mm</th>
                <th class="num">用过</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in leftovers" :key="l.id">
                <td>{{ l.name }}</td>
                <td class="num">{{ l.wMm }}×{{ l.hMm }}</td>
                <td class="num">{{ l.usedCount }}</td>
                <td>
                  <button class="btn small" @click="useLeftoverPick(l.id)">用作相纸</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <h3>
            ② 照片清单
            <span class="row tight">
              <button class="btn small" @click="addItem()">+ 添加一行</button>
              <button class="btn small" :disabled="!draft.items.length" @click="clearAllItems">
                清空
              </button>
            </span>
          </h3>
          <div class="card-sub">
            底片只在浏览器内存里读尺寸与方向，不上传服务器。选「只出现一次」后，每个空位都能单独指定底片，
            也可一次多选或把多张图片直接拖到槽位上，从该位置按顺序填入
          </div>
          <div v-if="!draft.items.length" class="note">还没有照片，点「+ 添加一行」或直接套用下方证件照模板</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>照片尺寸</th>
                <th class="num" style="width: 72px">数量</th>
                <th>旋转</th>
                <th>不拆散</th>
                <th>底片用法</th>
                <th style="min-width: 260px">底片（点击槽位选择，或拖入多张按顺序填）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in draft.items" :key="item.id">
                <td>
                  <select v-model="item.sizeId" @change="onSizeChange(item)">
                    <option v-for="s in allSizes" :key="s.id" :value="s.id">
                      {{ s.name }} {{ s.wMm }}×{{ s.hMm }}mm
                    </option>
                  </select>
                </td>
                <td>
                  <input
                    v-model.number="item.qty"
                    type="number"
                    min="1"
                    step="1"
                    @change="onQtyChange(item)"
                  />
                </td>
                <td>
                  <input v-model="item.rotateAllowed" type="checkbox" title="允许旋转 90°" />
                </td>
                <td>
                  <input
                    v-model="item.keepTogether"
                    type="checkbox"
                    title="该尺寸尽量排在同一张相纸上"
                  />
                </td>
                <td>
                  <select v-model="item.repeatSamePhoto" @change="onRepeatChange(item)">
                    <option :value="true">重复排（共用 1 张）</option>
                    <option :value="false">只出现一次（每张各 1 张）</option>
                  </select>
                </td>
                <td>
                  <FilmStrip
                    :item-id="item.id"
                    :count="Math.max(1, item.qty)"
                    :repeat="item.repeatSamePhoto"
                    :strict="!draft.fallbackFirstPhoto"
                    @files="(start, files) => onFiles(item, start, files)"
                    @remove="(i) => removeFile(item, i)"
                  />
                  <div
                    v-if="missingByItem.get(item.id)"
                    class="note warn"
                    style="margin-top: 4px; padding: 3px 8px; font-size: 11.5px"
                  >
                    还缺 {{ missingByItem.get(item.id) }} 张底片：
                    <template v-if="draft.fallbackFirstPhoto">排样时这些位置会用第 1 张底片顶替</template>
                    <template v-else>未补齐前不能排样</template>
                  </div>
                  <div
                    v-else-if="rowOrientation(item)?.mismatch"
                    class="note"
                    style="margin-top: 4px; padding: 3px 8px; font-size: 11.5px"
                  >
                    底片{{ rowOrientation(item)?.filmText }} / 成品{{ rowOrientation(item)?.printText }}，方向不一致
                  </div>
                </td>
                <td>
                  <button class="btn small danger" @click="removeItem(item.id)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="draft.items.some((i) => !i.repeatSamePhoto)" class="stack" style="margin-top: 10px">
            <label class="check" style="font-size: 12.5px">
              <input v-model="draft.fallbackFirstPhoto" type="checkbox" />
              空位允许用第 1 张底片顶替（不勾选则严格拦住，必须每张都选到底片才能排样）
            </label>
            <div v-if="blockedByMissing" class="note danger" style="font-size: 12px">
              当前为严格模式：还有 {{ totalMissing }} 个空位，请补齐底片，或勾选上面的顶替选项
            </div>
            <div v-else-if="totalMissing && draft.fallbackFirstPhoto" class="note warn" style="font-size: 12px">
              有 {{ totalMissing }} 个空位，导出与纸面预览中这些位置将显示第 1 张底片（顶替），建议尽快补齐
            </div>
          </div>

          <div v-if="rotationAdvice" class="note" :class="rotationAdvice.suggestRotate ? 'warn' : 'ok'" style="margin-top: 10px">
            <div class="row" style="justify-content: space-between">
              <strong>方向与省纸试算</strong>
              <button
                v-if="rotationAdvice.suggestRotate"
                class="btn small"
                @click="acceptRotationAdvice"
              >
                允许旋转并采纳
              </button>
            </div>
            <div style="margin-top: 4px">{{ rotationAdvice.layoutText }}</div>
            <div style="margin-top: 2px">{{ rotationAdvice.detail }}</div>
          </div>

          <div class="row" style="margin-top: 12px">
            <label class="field" style="max-width: 150px">
              自定义尺寸名称
              <input v-model="newSize.name" type="text" placeholder="如 3 寸" />
            </label>
            <label class="field" style="max-width: 100px">
              宽 mm
              <input v-model.number="newSize.wMm" type="number" min="1" step="0.1" />
            </label>
            <label class="field" style="max-width: 100px">
              高 mm
              <input v-model.number="newSize.hMm" type="number" min="1" step="0.1" />
            </label>
            <button class="btn" @click="addSize">加入尺寸库并添加</button>
          </div>
        </div>

        <div class="card">
          <h3>证件照 / 冲印模板</h3>
          <div class="card-sub">一键生成常用排版清单（会清掉当前清单与已选底片）</div>
          <div class="row">
            <button v-for="t in templates" :key="t.id" class="btn small" @click="applyTemplate(t.id)">
              {{ t.name }}
            </button>
          </div>
        </div>

        <div class="card">
          <h3>
            开始排样
            <span class="badge">guillotine 约束</span>
          </h3>
          <div class="row">
            <label class="field" style="max-width: 260px">
              任务名称
              <input v-model="draft.name" type="text" placeholder="可留空自动命名" />
            </label>
            <button class="btn primary" :disabled="blockedByMissing" @click="submit">排样并预览 →</button>
          </div>
          <div v-if="blockedByMissing" class="note danger" style="margin-top: 8px; font-size: 12px">
            已被空位拦住：{{ totalMissing }} 个底片槽还空着
          </div>
        </div>

        <div class="card">
          <h3>已保存任务（{{ tasks.length }}）</h3>
          <div v-if="!tasks.length" class="note">暂无任务</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>任务</th>
                <th>相纸</th>
                <th class="num">照片</th>
                <th class="num">张数</th>
                <th class="num">利用率</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in tasks" :key="t.id">
                <td>{{ t.name }}</td>
                <td>{{ taskPaperName(t) }}</td>
                <td class="num">{{ t.result?.stats.totalPhotos ?? 0 }}</td>
                <td class="num">{{ t.result?.stats.sheets ?? 0 }}</td>
                <td class="num">
                  {{ t.result ? formatPercent(t.result.stats.avgUtilization) : '—' }}
                </td>
                <td>
                  <div class="row tight">
                    <button class="btn small" @click="openTask(t, 'layout')">排样</button>
                    <button class="btn small" @click="openTask(t, 'cut')">裁切</button>
                    <button class="btn small" @click="openTask(t, 'export')">导出</button>
                    <button class="btn small danger" @click="deleteTask(t.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
