/**
 * 底片方向（本机读到的横向/纵向）与冲印方向的匹配，以及「怎么摆更省纸」的试算。
 * 照片像素与尺寸库只在浏览器本地读取，本模块只做纯几何计算。
 */
import { pack, type PackGroup, type PackOptions } from './packer'
import type { Item, PhotoSize } from './types'

export interface OrientationMismatch {
  /** 底片方向与成品方向是否一致 */
  mismatch: boolean
  /** 底片方向描述 */
  filmText: string
  /** 成品（印出来）方向描述 */
  printText: string
  /** 当前是否允许排样器把照片旋转 90° */
  canRotate: boolean
}

/**
 * 判断单条清单的底片方向与成品方向。
 * - 底片横向（wPx>hPx）而成品纵向（hMm>wMm），或反过来，即方向不一致。
 */
export function checkOrientation(
  item: Item,
  size: PhotoSize | undefined,
  firstPhoto: { landscape: boolean } | undefined,
): OrientationMismatch | undefined {
  if (!size || !firstPhoto) return undefined
  const printLandscape = size.wMm > size.hMm + 1e-9
  const filmLandscape = firstPhoto.landscape
  return {
    mismatch: filmLandscape !== printLandscape,
    filmText: filmLandscape ? '横向' : '纵向',
    printText: printLandscape ? '横向' : '纵向',
    canRotate: item.rotateAllowed,
  }
}

export interface RotationAdvice {
  /** 是否建议把底片旋转 90° 再印 */
  suggestRotate: boolean
  /** 建议的摆放方式描述（按哪一边摆） */
  layoutText: string
  /** 建议方案用几张相纸 */
  sheets: number
  /** 不旋转方案用几张相纸 */
  baseSheets: number
  /** 建议方案的平均利用率 */
  utilization: number
  /** 不旋转方案的平均利用率 */
  baseUtilization: number
  detail: string
}

export interface RotationAdviceInput {
  items: Item[]
  sizes: PhotoSize[]
  paperW: number
  paperH: number
  marginMm: number
  safeEdgeMm: number
  gapMm: number
  kerfMm: number
  /** 任务级「允许整体旋转 90°」总开关 */
  allowRotate: boolean
  /** 每条清单第一张底片是否横向（仅「重复排」条目需要，只出现一次的逐张匹配） */
  filmLandscape: Map<string, boolean>
}

function groupsOf(
  items: Item[],
  sizes: PhotoSize[],
  filmLandscape: Map<string, boolean>,
  /** true = 仅把「方向不匹配」的条目翻成允许旋转；false/null = 用条目当前设置 */
  flipMismatched: boolean,
): PackGroup[] {
  const out: PackGroup[] = []
  for (const item of items) {
    const s = sizes.find((x) => x.id === item.sizeId)
    if (!s || item.qty <= 0) continue
    let allowRotate = item.rotateAllowed
    if (flipMismatched && filmLandscape.has(item.id)) {
      const printLandscape = s.wMm > s.hMm
      if (filmLandscape.get(item.id) !== printLandscape) {
        allowRotate = true
      }
    }
    out.push({
      itemId: item.id,
      copies: item.qty,
      photoW: s.wMm,
      photoH: s.hMm,
      allowRotate,
      keepTogether: item.keepTogether,
    })
  }
  return out
}

/**
 * 试算「底片方向与成品不一致」时怎样摆更省纸：
 * 比较「保持当前方向」与「把不匹配的底片旋转 90°」两种排样所需的相纸张数与利用率。
 */
export function adviseRotation(input: RotationAdviceInput): RotationAdvice | undefined {
  // 两次试算都打开总开关，唯一差别是「方向不匹配的条目」是否允许旋转，
  // 这样省纸收益才能归因到底片旋转本身（采纳建议时也会一并打开总开关）。
  const baseOpts: PackOptions = {
    paperW: input.paperW,
    paperH: input.paperH,
    marginMm: input.marginMm,
    safeEdgeMm: input.safeEdgeMm,
    gapMm: input.gapMm,
    kerfMm: input.kerfMm,
    allowRotate: true,
  }
  const base = pack(groupsOf(input.items, input.sizes, input.filmLandscape, false), baseOpts)
  const rotated = pack(groupsOf(input.items, input.sizes, input.filmLandscape, true), baseOpts)
  if (base.error || rotated.error) return undefined

  const baseSheets = base.result.stats.sheets
  const rotSheets = rotated.result.stats.sheets
  const baseUtil = base.result.stats.avgUtilization
  const rotUtil = rotated.result.stats.avgUtilization

  const paperLandscape = input.paperW >= input.paperH
  const paperSideText = paperLandscape ? '相纸长边横放' : '相纸长边竖放'
  const firstItem = input.items.find((i) => i.qty > 0)
  const firstSize = firstItem
    ? input.sizes.find((s) => s.id === firstItem.sizeId)
    : undefined
  // 旋转 90° 后，照片是用「横边」还是「竖边」沿相纸长边排布
  const rotatedPhotoSideText = firstSize
    ? firstSize.hMm > firstSize.wMm
      ? '让照片横边沿相纸长边摆'
      : '让照片竖边沿相纸长边摆'
    : '沿相纸长边摆'

  const better =
    rotSheets < baseSheets || (rotSheets === baseSheets && rotUtil > baseUtil + 0.005)
  if (better) {
    return {
      suggestRotate: true,
      layoutText: `建议把底片旋转 90° 再印，${rotatedPhotoSideText}（${paperSideText}更省纸）`,
      sheets: rotSheets,
      baseSheets,
      utilization: rotUtil,
      baseUtilization: baseUtil,
      detail:
        baseSheets === rotSheets
          ? `张数同为 ${rotSheets} 张，但旋转后平均利用率 ${(rotUtil * 100).toFixed(1)}% 高于不转的 ${(baseUtil * 100).toFixed(1)}%`
          : `旋转后只需 ${rotSheets} 张相纸，不转要 ${baseSheets} 张（少用 ${baseSheets - rotSheets} 张）`,
    }
  }
  return {
    suggestRotate: false,
    layoutText: `保持底片原方向即可（${paperSideText}），旋转并不省纸`,
    sheets: rotSheets,
    baseSheets,
    utilization: rotUtil,
    baseUtilization: baseUtil,
    detail: `不旋转用 ${baseSheets} 张（利用率 ${(baseUtil * 100).toFixed(1)}%），旋转用 ${rotSheets} 张（${(rotUtil * 100).toFixed(1)}%），无需旋转`,
  }
}
