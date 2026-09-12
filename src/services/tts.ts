/**
 * 单词发音服务：基于浏览器原生 Web Speech API（speechSynthesis）。
 * 零依赖、零成本、离线可用；音色取决于系统/浏览器内置的英文语音包。
 */

// 保存当前 utterance 引用，避免被 GC 导致 Chrome 不发声（已知坑）
let currentUtterance: SpeechSynthesisUtterance | null = null
// 缓存选中的英文音色（voices 列表在部分浏览器异步加载）
let cachedVoice: SpeechSynthesisVoice | null = null
let voicesReady = false

/** 是否支持语音合成（极老浏览器降级隐藏发音入口） */
export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** 音色挑选偏好（本地名称含这些关键词的优先）：自然度较高的常见英文音色 */
const VOICE_NAME_PREFERENCES = ['Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Samantha']

/** 从系统音色列表中挑选一个英文音色 */
function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = (voices || []).filter(v => /^en([-_]|$)/i.test(v.lang))
  if (!english.length) return null
  for (const keyword of VOICE_NAME_PREFERENCES) {
    const hit = english.find(v => v.name && v.name.includes(keyword))
    if (hit) return hit
  }
  // 兜底：优先 en-US，其次任意英文音色
  return english.find(v => /^en[-_]us/i.test(v.lang)) || english[0]
}

/** 获取英文音色（带异步缓存） */
function getEnglishVoice(): SpeechSynthesisVoice | null {
  // voicesReady 为 true 代表音色列表已查询过：此时 cachedVoice 为 null（没有英文音色）
  // 也是「已确定的结果」，直接返回，避免每次调用都重新遍历整张音色表
  if (voicesReady) return cachedVoice
  const voices = window.speechSynthesis.getVoices()
  if (voices.length) {
    cachedVoice = pickEnglishVoice(voices)
    voicesReady = true
  }
  return cachedVoice
}

// 音色列表异步加载（Chrome 首次为空，触发 voiceschanged 后就绪）
if (isSpeechSupported()) {
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    voicesReady = false
    getEnglishVoice()
  })
}

/**
 * 播放英文文本发音（先取消上一次，避免连点叠音）
 * @param text 待发音的英文单词/短语
 */
export function speak(text: string): void {
  if (!isSpeechSupported() || !text) return
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 1
    const voice = getEnglishVoice()
    if (voice) utterance.voice = voice
    // 保存引用防止 GC；播放结束后释放
    currentUtterance = utterance
    utterance.onend = () => {
      if (currentUtterance === utterance) currentUtterance = null
    }
    window.speechSynthesis.speak(utterance)
  } catch {
    // 忽略发声异常（如音色不可用）
  }
}

/** 停止当前发音 */
export function stopSpeak(): void {
  if (!isSpeechSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // 忽略
  }
}
