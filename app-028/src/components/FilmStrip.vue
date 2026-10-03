<script setup lang="ts">
/**
 * 底片槽位条：一个条目（一行清单）对应一排缩略位。
 * - 「重复排」只有一个槽；「只出现一次」按数量摆 qty 个槽，每张贴自己的底片。
 * - 已填的槽显示缩略图，空槽显示虚线占位与序号，空/实一眼可分。
 * - 支持一次选多张 / 一次拖入多张，从被点（或被放下）的槽开始按顺序填入。
 * 文件本身不在此解码：统一上抛给父组件读取尺寸与方向（只在本机内存处理）。
 */
import { computed, ref } from 'vue'
import { getItemPhoto, photoKey, photoVersion } from '../store'
import type { PhotoRef } from '../logic/types'

const props = withDefaults(
  defineProps<{
    itemId: string
    count: number
    /** true = 同一张底片重复排（单槽）；false = 每张各需一张底片 */
    repeat: boolean
    /** 严格模式：空槽不允许顶替，用警示色标出 */
    strict?: boolean
  }>(),
  { strict: false },
)

const emit = defineEmits<{
  (e: 'files', startIndex: number, files: File[]): void
  (e: 'remove', index: number): void
}>()

interface Slot {
  index: number
  url?: string
  ref?: PhotoRef
}

const slotIndexes = computed(() => {
  if (props.repeat) return [0]
  const n = Number.isFinite(props.count) ? Math.max(1, Math.floor(props.count)) : 1
  return Array.from({ length: n }, (_, i) => i)
})

/** 渲染期读取 photoVersion，底片增删后整排重绘 */
const slots = computed<Slot[]>(() => {
  void photoVersion.value
  return slotIndexes.value.map((i) => {
    const ph = getItemPhoto(photoKey(props.itemId, i))
    return { index: i, url: ph?.url, ref: ph?.ref }
  })
})

function firstEmptyIndex(): number {
  return slots.value.find((s) => !s.url)?.index ?? 0
}

function onPick(i: number, ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  if (files.length) emit('files', i, files)
  input.value = ''
}

const dragOverSlot = ref<number | null>(null)
const dragOverBand = ref(false)

function hasFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes('Files')
}

function onSlotDragOver(i: number, ev: DragEvent) {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  ev.dataTransfer!.dropEffect = 'copy'
  dragOverSlot.value = i
  dragOverBand.value = false
}

function onBandDragOver(ev: DragEvent) {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  ev.dataTransfer!.dropEffect = 'copy'
  dragOverBand.value = true
}

function dropFiles(ev: DragEvent): File[] {
  return Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
}

function onSlotDrop(i: number, ev: DragEvent) {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  ev.stopPropagation()
  const files = dropFiles(ev)
  dragOverSlot.value = null
  dragOverBand.value = false
  if (files.length) emit('files', i, files)
}

/** 拖到槽位条空白处：从第一个空槽开始填 */
function onBandDrop(ev: DragEvent) {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  const files = dropFiles(ev)
  dragOverSlot.value = null
  dragOverBand.value = false
  if (files.length) emit('files', firstEmptyIndex(), files)
}

function onDragLeave() {
  dragOverSlot.value = null
  dragOverBand.value = false
}
</script>

<template>
  <div
    class="film-band"
    :class="{ 'drop-active': dragOverBand }"
    @dragover="onBandDragOver"
    @drop="onBandDrop"
    @dragleave="onDragLeave"
  >
    <label
      v-for="s in slots"
      :key="s.index"
      class="film-slot"
      :class="[
        s.url ? 'filled' : 'empty',
        { strict: strict && !repeat && !s.url, target: dragOverSlot === s.index },
      ]"
      :title="
        s.url
          ? `第 ${s.index + 1} 张：${s.ref?.name}（点击可替换）`
          : repeat
            ? '选择底片（所有位置共用这一张）'
            : `第 ${s.index + 1} 张底片还没选，点击选择，或把多张图片一起拖进来`
      "
      @dragover="onSlotDragOver(s.index, $event)"
      @drop="onSlotDrop(s.index, $event)"
      @dragleave="onDragLeave"
    >
      <input type="file" accept="image/*" multiple hidden @change="onPick(s.index, $event)" />
      <img v-if="s.url" :src="s.url" alt="" draggable="false" />
      <span v-else class="film-plus">＋</span>
      <span class="film-idx">{{ repeat ? '共用' : s.index + 1 }}</span>
      <button
        v-if="s.url"
        type="button"
        class="film-x"
        title="移除这张底片"
        @click.prevent="emit('remove', s.index)"
      >
        ×
      </button>
      <span v-if="strict && !repeat && !s.url" class="film-warn-dot" title="空位：未选底片">!</span>
    </label>
  </div>
</template>
