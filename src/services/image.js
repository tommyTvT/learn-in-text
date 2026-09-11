// 图片预处理工具：把用户选择的图片压缩/转换为适合视觉模型输入的 Data URL。

const MAX_DIMENSION = 2000
// 体积阈值（字节）：小图且体积不超限时原样返回，保留无损文本细节（利于 OCR）
const MAX_ORIGINAL_BYTES = 3.5 * 1024 * 1024
const JPEG_QUALITY = 0.9

/** 将 File 读取为 Data URL */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败，可能是不支持的格式（如 HEIC）'))
    img.src = src
  })
}

/**
 * 将用户选择的图片预处理为适合视觉模型输入的 Data URL。
 * - 小图（边长 ≤ 2000px 且体积 ≤ 3.5MB）原样返回
 * - 大图缩放至最长边 2000px：无损格式（png/gif/webp）导出 PNG，照片导出 JPEG
 */
export async function prepareImageForAI(file) {
  if (!file || !/^image\//.test(file.type || '')) {
    throw new Error('请选择图片文件')
  }

  const dataUrl = await fileToDataUrl(file)
  const img = await loadImage(dataUrl)

  const naturalWidth = img.naturalWidth || img.width
  const naturalHeight = img.naturalHeight || img.height

  if (
    naturalWidth <= MAX_DIMENSION &&
    naturalHeight <= MAX_DIMENSION &&
    dataUrl.length <= MAX_ORIGINAL_BYTES
  ) {
    return dataUrl
  }

  let width = naturalWidth
  let height = naturalHeight
  if (Math.max(width, height) > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('当前浏览器不支持图片处理')
  }
  ctx.drawImage(img, 0, 0, width, height)

  const lossless = /png|gif|webp/i.test(file.type || '')
  return lossless
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}
