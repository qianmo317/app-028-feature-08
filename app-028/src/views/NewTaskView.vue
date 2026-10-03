<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  addCustomSize,
  allPapers,
  allSizes,
  clearItemPhoto,
  clearItemPhotos,
  createTask,
  deleteTask,
  filledCopyCount,
  getItemPhoto,
  leftovers,
  markLeftoverUsed,
  photoKey,
  photoVersion,
  pruneItemPhotos,
  runPack,
  setItemPhoto,
  settings,
  tasks,
  templates,
  validateItemPhotos,
} from '../store'
import { findPhotoSize, newId } from '../logic/library'
import { loadImage } from '../logic/image'
import { rotationAdvice, type OrientationAdvice } from '../logic/orientation'
import { formatCents, formatPercent } from '../logic/units'
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
})

const error = ref('')
const hint = ref('')
const newSize = reactive({ name: '', wMm: 50, hMm: 70 })

/** 提交时未选齐底片而被拦下的清单行（用来把空位标红） */
const blockedIds = ref<Set<string>>(new Set())
/** 拖拽悬停中的底片条（高亮拖放区） */
const dragOverId = ref('')
/** 拖入/拖出计数：避免在子元素间移动时高亮闪烁 */
const dragDepth = new Map<string, number>()

function dragEnter(id: string) {
  dragDepth.set(id, (dragDepth.get(id) ?? 0) + 1)
  dragOverId.value = id
}

function dragLeave(id: string) {
  const n = Math.max(0, (dragDepth.get(id) ?? 1) - 1)
  dragDepth.set(id, n)
  if (n === 0) {
    dragDepth.delete(id)
    if (dragOverId.value === id) dragOverId.value = ''
  }
}

function dragDrop(id: string) {
  dragDepth.delete(id)
  if (dragOverId.value === id) dragOverId.value = ''
}
/** 每个隐藏 file input 本次选择从哪个位开始：-1 = 按顺序填空位 */
const pickStart = new Map<string, number>()

function slotCount(item: Item): number {
  const n = Math.floor(item.qty)
  if (!Number.isFinite(n) || n <= 0) return 0
  return item.repeatSamePhoto ? 1 : n
}

/** 读取内存照片（依赖 photoVersion 触发重绘） */
function slotUrl(item: Item, copyIndex: number): string | undefined {
  void photoVersion.value
  return getItemPhoto(photoKey(item.id, copyIndex))?.url
}

function slotRef(item: Item, copyIndex: number): PhotoRef | undefined {
  void photoVersion.value
  return getItemPhoto(photoKey(item.id, copyIndex))?.ref
}

function firstFilledRef(item: Item): PhotoRef | undefined {
  for (let i = 0; i < slotCount(item); i++) {
    const r = slotRef(item, i)
    if (r) return r
  }
  return undefined
}

function filledOf(item: Item): number {
  void photoVersion.value
  return filledCopyCount(item.id)
}

function isMissing(item: Item, copyIndex: number): boolean {
  if (item.repeatSamePhoto || !blockedIds.value.has(item.id)) return false
  return !slotUrl(item, copyIndex)
}

/** 每行一条：底片方向与成品方向不匹配时的省纸试算建议 */
const advices = computed(() => {
  void photoVersion.value
  const map = new Map<string, OrientationAdvice>()
  for (const item of draft.items) {
    if (item.qty <= 0) continue
    const refInfo = firstFilledRef(item)
    const size = findPhotoSize(allSizes.value, item.sizeId)
    if (!refInfo || !size) continue
    const others = draft.items
      .filter((o) => o.id !== item.id && o.qty > 0)
      .map((o) => ({ size: findPhotoSize(allSizes.value, o.sizeId), copies: o.qty }))
      .filter((o): o is { size: NonNullable<typeof o.size>; copies: number } => !!o.size)
    map.set(
      item.id,
      rotationAdvice({
        size,
        ref: refInfo,
        copies: item.qty,
        paper: currentPaper.value,
        safeEdgeMm: draft.safeEdgeMm,
        gapMm: draft.gapMm,
        kerfMm: draft.kerfMm,
        allowRotate: draft.allowRotate && item.rotateAllowed,
        others,
      }),
    )
  }
  return map
})

function canEnableRotation(item: Item): boolean {
  return !draft.allowRotate || !item.rotateAllowed
}

function enableRotation(item: Item) {
  draft.allowRotate = true
  item.rotateAllowed = true
  hint.value = '已勾选「允许旋转」，排样器会按省纸方向自动旋转 90°'
}

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

function removeItem(id: string) {
  // 底片存在内存里，行没了底片必须一起清掉（含 objectURL）
  clearItemPhotos(id)
  blockedIds.value.delete(id)
  draft.items = draft.items.filter((i) => i.id !== id)
}

function clearAllItems() {
  for (const i of draft.items) clearItemPhotos(i.id)
  blockedIds.value = new Set()
  draft.items = []
}

function onQtyChange(item: Item) {
  blockedIds.value.delete(item.id)
  pruneItemPhotos(item.id, Math.max(0, Math.floor(item.qty) || 0))
  if (slotCount(item) === 0 && item.photo) item.photo = undefined
}

function onPhotoModeChange(item: Item) {
  blockedIds.value.delete(item.id)
  if (item.repeatSamePhoto) {
    // 改成「重复排」后，第 2 张及以后的底片不再使用
    pruneItemPhotos(item.id, 1)
    if (!slotUrl(item, 0)) item.photo = undefined
  }
}

function onSizeChange(item: Item) {
  const s = findPhotoSize(allSizes.value, item.sizeId)
  item.rotateAllowed = s?.rotateByDefault ?? false
}

function applyTemplate(tplId: string) {
  const tpl = templates.value.find((t) => t.id === tplId)
  if (!tpl) return
  clearAllItems()
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
  hint.value = `已套用模板「${tpl.name}」`
}

/** 在本机解码一张图片，只读尺寸与方向（objectURL 保留在内存，不上传） */
async function readPhotoFile(file: File): Promise<{ url: string; ref: PhotoRef }> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    return {
      url,
      ref: {
        name: file.name,
        wPx: img.naturalWidth,
        hPx: img.naturalHeight,
        landscape: img.naturalWidth > img.naturalHeight,
      },
    }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

/** 点击某个底片位 / 批量按钮：打开隐藏的多选 file input */
function openPicker(item: Item, start: number) {
  pickStart.set(item.id, start)
  const el = document.getElementById(`filein-${item.id}`) as HTMLInputElement | null
  el?.click()
}

async function onFilesPicked(item: Item, ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  const start = pickStart.get(item.id) ?? -1
  await assignFiles(item, files, start)
}

/**
 * 多张文件按顺序填进底片位。
 * start = -1：从第 1 个空位开始，只填空位，不覆盖已选；
 * start >= 0：从指定位开始顺序放入（拖到某位/点某位，会覆盖该位）。
 */
async function assignFiles(item: Item, files: File[], start: number) {
  error.value = ''
  blockedIds.value.delete(item.id)
  const n = slotCount(item)
  let targets: number[]
  if (start >= 0) {
    targets = Array.from({ length: Math.min(files.length, n - start) }, (_, k) => start + k)
  } else {
    const empties: number[] = []
    for (let i = 0; i < n; i++) if (!slotUrl(item, i)) empties.push(i)
    targets = empties.slice(0, files.length)
  }
  const extra = files.length - targets.length
  let failed = 0
  const decoded = await Promise.all(
    files.slice(0, targets.length).map((f) => readPhotoFile(f).catch(() => undefined)),
  )
  decoded.forEach((d, k) => {
    if (!d) {
      failed++
      return
    }
    const ci = targets[k]
    setItemPhoto(photoKey(item.id, ci), d.url, d.ref)
    if (ci === 0) item.photo = d.ref
  })
  if (failed) {
    error.value = `${failed} 个文件读取失败，请换用常见图片格式（仅在本机内存中读取尺寸与方向）`
  } else {
    hint.value = `已在本机读取 ${targets.length} 张底片（不会上传）`
  }
  if (extra > 0) {
    hint.value = `底片位只有 ${n} 个，多出的 ${extra} 张没有放入；可先增加数量，或删掉重选`
  }
}

function onStripDrop(item: Item, ev: DragEvent) {
  dragDrop(item.id)
  const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  void assignFiles(item, files, -1)
}

function onSlotDrop(item: Item, copyIndex: number, ev: DragEvent) {
  dragDrop(item.id)
  const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  void assignFiles(item, files, copyIndex)
}

function removeFile(item: Item, copyIndex: number) {
  clearItemPhoto(photoKey(item.id, copyIndex))
  if (copyIndex === 0) item.photo = undefined
  blockedIds.value.delete(item.id)
}

function useLeftover(id: string) {
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

function itemDisplayName(item: Item): string {
  return findPhotoSize(allSizes.value, item.sizeId)?.name ?? '自定义尺寸'
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
  // 「一张只出现一次」时逐位校验底片：没选齐要么拦截，要么用户已勾选「用第 1 张顶替」
  const photoErr = validateItemPhotos(draft.items, itemDisplayName)
  if (photoErr) {
    blockedIds.value = new Set(
      draft.items
        .filter((i) => !i.repeatSamePhoto && i.qty > 0 && filledOf(i) < i.qty && !(i.photoFallback && filledOf(i) > 0))
        .map((i) => i.id),
    )
    error.value = photoErr
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
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">新建拼版任务</h1>
      <span class="badge brand">相纸 + 照片清单</span>
      <div class="spacer"></div>
      <span class="badge">共 {{ totalQty }} 张照片</span>
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
                <td><button class="btn small" @click="useLeftover(l.id)">用作相纸</button></td>
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
            尺寸库为毫米；底片只在浏览器内存里读尺寸与方向，不上传服务器。选「只出现一次」后每一张都要单独指定底片，可一次多选/拖入多张按顺序填入
          </div>
          <div v-if="!draft.items.length" class="note">还没有照片，点「+ 添加一行」或直接套用下方证件照模板</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>照片尺寸</th>
                <th class="num" style="width: 76px">数量</th>
                <th>旋转</th>
                <th>不拆散</th>
                <th>底片模式</th>
                <th>底片（按顺序逐位指定）</th>
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
                  <input v-model="item.keepTogether" type="checkbox" title="该尺寸尽量排在同一张相纸上" />
                </td>
                <td>
                  <select v-model="item.repeatSamePhoto" @change="onPhotoModeChange(item)">
                    <option :value="true">重复排（共用 1 张）</option>
                    <option :value="false">只出现一次（每张各 1 张）</option>
                  </select>
                </td>
                <td class="film-cell">
                  <!-- 隐藏的多选文件框，两个入口共用：批量填空位 / 从某位开始覆盖 -->
                  <input
                    :id="`filein-${item.id}`"
                    type="file"
                    accept="image/*"
                    multiple
                    class="file-hidden"
                    @change="onFilesPicked(item, $event)"
                  />

                  <div
                    class="film-strip"
                    :class="{ dragover: dragOverId === item.id }"
                    @dragenter.prevent="dragEnter(item.id)"
                    @dragover.prevent
                    @dragleave.prevent="dragLeave(item.id)"
                    @drop.prevent="onStripDrop(item, $event)"
                  >
                    <button
                      type="button"
                      class="btn small film-add"
                      title="多选照片，按顺序填进空底片位"
                      @click="openPicker(item, -1)"
                    >
                      + 多选
                    </button>

                    <button
                      v-for="ci in slotCount(item)"
                      :key="ci - 1"
                      type="button"
                      class="film-slot"
                      :class="{
                        missing: isMissing(item, ci - 1),
                        filled: !!slotUrl(item, ci - 1),
                        'is-over': dragOverId === item.id,
                      }"
                      :title="
                        slotRef(item, ci - 1)
                          ? `第 ${ci} 张：${slotRef(item, ci - 1)?.name}（${slotRef(item, ci - 1)?.wPx}×${slotRef(item, ci - 1)?.hPx}px，${slotRef(item, ci - 1)?.landscape ? '横向' : '纵向'}）；点击可替换`
                          : `第 ${ci} 张底片：未选；点击选文件，或把照片拖进来`
                      "
                      @click="openPicker(item, ci - 1)"
                      @dragover.prevent
                      @drop.prevent.stop="onSlotDrop(item, ci - 1, $event)"
                    >
                      <img v-if="slotUrl(item, ci - 1)" :src="slotUrl(item, ci - 1)" alt="" />
                      <template v-else>
                        <span class="film-no">{{ ci }}</span>
                        <span
                          v-if="item.photoFallback && slotUrl(item, 0)"
                          class="film-tail"
                        >
                          ①顶
                        </span>
                      </template>
                      <span
                        v-if="isMissing(item, ci - 1) && !slotUrl(item, ci - 1)"
                        class="film-bang"
                      >
                        !
                      </span>
                      <span
                        v-if="slotUrl(item, ci - 1)"
                        class="film-x"
                        title="移除这张底片"
                        @click.stop.prevent="removeFile(item, ci - 1)"
                      >
                        ×
                      </span>
                    </button>
                  </div>

                  <div class="film-meta">
                    <template v-if="item.repeatSamePhoto">
                      所有副本共用这 1 张底片
                    </template>
                    <template v-else>
                      已选 <strong>{{ filledOf(item) }}</strong> / {{ slotCount(item) }} 张
                      <span v-if="filledOf(item) < slotCount(item)" class="film-empty">
                        （空 {{ slotCount(item) - filledOf(item) }} 位）
                      </span>
                      <span v-else class="badge ok">已选齐</span>
                    </template>
                    <template v-if="firstFilledRef(item)">
                      · {{ firstFilledRef(item)?.wPx }}×{{ firstFilledRef(item)?.hPx }}px
                      {{ firstFilledRef(item)?.landscape ? '横向' : '纵向' }}
                    </template>
                  </div>

                  <!-- 只出现一次：空位要么用第 1 张顶替，要么直接拦住 -->
                  <label v-if="!item.repeatSamePhoto" class="check film-fallback">
                    <input type="checkbox" v-model="item.photoFallback" />
                    空位用第 1 张底片顶替
                  </label>
                  <div
                    v-if="!item.repeatSamePhoto && item.photoFallback && slotUrl(item, 0)"
                    class="note warn film-note"
                  >
                    未选的副本位将统一使用第 1 张底片（缩略图角标「①顶」）；第 1 张必须先选。
                  </div>

                  <!-- 本机横/竖方向 vs 成品方向：真实试算后给省纸建议 -->
                  <div
                    v-if="advices.get(item.id)?.mismatch"
                    class="note"
                    :class="advices.get(item.id)!.savedSheets > 0 ? 'warn' : ''"
                  >
                    {{ advices.get(item.id)!.message }}
                    <button
                      v-if="canEnableRotation(item) && advices.get(item.id)!.savedSheets > 0"
                      type="button"
                      class="btn small"
                      style="margin-left: 6px"
                      @click="enableRotation(item)"
                    >
                      允许旋转
                    </button>
                  </div>
                </td>
                <td>
                  <button class="btn small danger" @click="removeItem(item.id)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>

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
          <div class="card-sub">一键生成常用排版清单</div>
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
            <button class="btn primary" @click="submit">排样并预览 →</button>
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
