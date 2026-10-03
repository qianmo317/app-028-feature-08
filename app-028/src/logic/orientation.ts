/**
 * 底片方向（本机读到的横/竖）与成品尺寸（印出来要竖/横）不匹配时，
 * 用真实排样器试算「竖摆」与「横摆」各需要多少张相纸，给出省纸建议。
 */
import { pack, type PackGroup, type PackOptions } from './packer'
import type { PhotoRef, PhotoSize } from './types'

export interface OrientationAdvice {
  /** 是否存在横/竖方向不匹配 */
  mismatch: boolean
  /** 建议文案（mismatch 为 false 时为空） */
  message: string
  /** 按现状（成品原方向）排样的张数 */
  portraitSheets: number
  /** 旋转 90°（成品改成与底片同方向）后的张数 */
  rotatedSheets: number
  /** 旋转后少用几张相纸（为负表示反而多用） */
  savedSheets: number
  /** 底片长边建议平行于相纸的哪条边 */
  longEdge: 'width' | 'height'
  /** 直接照排（保持成品方向）时底片长边平行于相纸的哪条边 */
  straightLongEdge: 'width' | 'height'
  /** 旋转后少用的相纸面积 mm²（0 = 张数相同） */
  savedAreaMm2: number
}

interface AdviceInput {
  size: PhotoSize
  ref: PhotoRef
  copies: number
  paper: { wMm: number; hMm: number; marginMm: number }
  safeEdgeMm: number
  gapMm: number
  kerfMm: number
  /** 全局是否允许旋转 90° */
  allowRotate: boolean
  /** 同行清单中除本行之外的尺寸（混排会影响张数对比） */
  others?: Array<{ size: PhotoSize; copies: number }>
}

function runTrial(
  groups: PackGroup[],
  paper: AdviceInput['paper'],
  input: AdviceInput,
): number | undefined {
  const opts: PackOptions = {
    paperW: paper.wMm,
    paperH: paper.hMm,
    marginMm: paper.marginMm,
    safeEdgeMm: input.safeEdgeMm,
    gapMm: input.gapMm,
    kerfMm: input.kerfMm,
    // 试算里两个方案都锁死旋转，避免排样器自己把方案转掉，确保对比的是两种摆法
    allowRotate: false,
  }
  const out = pack(groups, opts)
  return out.error ? undefined : out.result.stats.sheets
}

/**
 * 试算方向不匹配的省纸建议。底片方向与成品方向一致（含方形）时返回 mismatch=false。
 */
export function rotationAdvice(input: AdviceInput): OrientationAdvice {
  const size = input.size
  const sizeLandscape = size.wMm > size.hMm
  const photoLandscape = input.ref.landscape
  const mismatch = sizeLandscape !== photoLandscape
  const straightLongEdge: 'width' | 'height' = photoLandscape ? 'height' : 'width'

  const base: OrientationAdvice = {
    mismatch,
    message: '',
    portraitSheets: 0,
    rotatedSheets: 0,
    savedSheets: 0,
    longEdge: photoLandscape ? 'width' : 'height',
    straightLongEdge,
    savedAreaMm2: 0,
  }
  if (!mismatch) return base

  const others = (input.others ?? []).map((o, i) => ({
    itemId: `o${i}`,
    copies: Math.max(0, o.copies),
    photoW: o.size.wMm,
    photoH: o.size.hMm,
    allowRotate: false,
    keepTogether: false,
  }))

  // 方案一：成品保持原方向（底片横着塞进竖框，会裁掉左右）
  const straightGroups: PackGroup[] = [
    ...others,
    {
      itemId: 'target',
      copies: Math.max(1, input.copies),
      photoW: size.wMm,
      photoH: size.hMm,
      allowRotate: false,
      keepTogether: false,
    },
  ]
  // 方案二：整组照片旋转 90°，让成品方向跟底片一致
  const rotatedGroups: PackGroup[] = [
    ...others,
    {
      itemId: 'target',
      copies: Math.max(1, input.copies),
      photoW: size.hMm,
      photoH: size.wMm,
      allowRotate: false,
      keepTogether: false,
    },
  ]

  const straight = runTrial(straightGroups, input.paper, input)
  const rotated = runTrial(rotatedGroups, input.paper, input)

  base.portraitSheets = straight ?? 0
  base.rotatedSheets = rotated ?? 0
  const saved = (straight ?? 0) - (rotated ?? 0)
  base.savedSheets = saved
  base.savedAreaMm2 = Math.max(0, saved) * input.paper.wMm * input.paper.hMm

  const targetName = input.size.name
  if (straight === undefined || rotated === undefined) {
    base.message = `「${targetName}」底片是${photoLandscape ? '横' : '竖'}的、成品是${sizeLandscape ? '横' : '竖'}的，方向不一致；建议旋转 90° 后再排`
    return base
  }

  const edgeText =
    base.longEdge === 'width'
      ? `底片长边横着摆（平行于相纸 ${input.paper.wMm}mm 的宽边）`
      : `底片长边竖着摆（平行于相纸 ${input.paper.hMm}mm 的高边）`
  const straightText =
    straightLongEdge === 'width'
      ? `底片长边平行相纸宽边（横摆）`
      : `底片长边平行相纸高边（竖摆）`

  if (saved > 0) {
    base.message = input.allowRotate
      ? `「${targetName}」底片${photoLandscape ? '横' : '竖'}、成品${sizeLandscape ? '横' : '竖'}，排样器会自动旋转 90°：${edgeText}，从 ${straight} 张相纸省到 ${rotated} 张（少用 ${saved} 张）`
      : `「${targetName}」底片${photoLandscape ? '横' : '竖'}、成品${sizeLandscape ? '横' : '竖'}：建议旋转 90° 排样，${edgeText}，可比${straightText}少用 ${saved} 张相纸（${straight} → ${rotated} 张）；勾选「允许旋转」即生效`
  } else if (saved < 0) {
    base.message = `「${targetName}」底片方向与成品不一致：旋转 90° 反而要多用 ${-saved} 张相纸（${straight} → ${rotated} 张），建议保持成品${sizeLandscape ? '横' : '竖'}向、把底片本身旋转后再导入`
  } else {
    base.message = `「${targetName}」底片${photoLandscape ? '横' : '竖'}、成品${sizeLandscape ? '横' : '竖'}：两种摆法都是 ${straight} 张相纸；旋转后${edgeText}，画面不会被裁掉两边`
  }
  return base
}
