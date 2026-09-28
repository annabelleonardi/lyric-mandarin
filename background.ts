import type {
  CultureExplainRequest,
  CultureExplainResponse,
  CultureInsight,
  FetchLrcByIdRequest,
  FetchLrcByQueryRequest,
  FetchLrcResponse,
  LyricAnalysis,
  LyricAnalysisRequest,
  LyricAnalysisResponse,
  LyricToken,
  LrcLine,
  WordLookup,
  WordLookupRequest,
  WordLookupResponse
} from "./types"

type Provider = "openai" | "deepseek"

interface LlmSettings {
  provider: Provider
  apiKey: string
  targetHsk: number
}

const PROVIDER_CONFIG: Record<Provider, { endpoint: string; model: string }> = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini"
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat"
  }
}

const DEFAULT_SETTINGS: LlmSettings = {
  provider: "deepseek",
  apiKey: "",
  targetHsk: 3
}

async function getSettings(): Promise<LlmSettings> {
  const stored = await chrome.storage.local.get(["llmProvider", "llmApiKey", "targetHsk"])

  const provider: Provider =
    stored.llmProvider === "openai" || stored.llmProvider === "deepseek"
      ? stored.llmProvider
      : DEFAULT_SETTINGS.provider

  return {
    provider,
    apiKey: typeof stored.llmApiKey === "string" ? stored.llmApiKey : "",
    targetHsk:
      typeof stored.targetHsk === "number" && stored.targetHsk >= 1 && stored.targetHsk <= 9
        ? stored.targetHsk
        : DEFAULT_SETTINGS.targetHsk
  }
}

function buildPrompt(lyric: string, targetHsk: number): string {
  const advancedNote =
    targetHsk >= 7
      ? `\nNote: the learner targets HSK 7–9, the advanced band of HSK 3.0. Tag literary words, chengyu (成语), and advanced vocabulary with their real HSK 7, 8, or 9 level instead of collapsing them into 0. Use 0 only for genuine slang or internet slang.`
      : ""

  return `Analyze this Mandarin song lyric for a language learner studying at HSK level ${targetHsk}:

"${lyric}"

Respond ONLY with a JSON object in this exact shape:
{
  "pinyin": "<full-sentence pinyin with tone marks>",
  "hsk_level": "<approximate difficulty tag like 'HSK 3' — use the highest level among the line's vocabulary>",
  "translation": "<natural English translation of the line, 1-2 sentences>",
  "tokens": [
    {
      "word": "<each segmented Chinese word, in lyric order>",
      "pinyin": "<word-level pinyin with tone marks>",
      "hsk": <integer HSK level: 1-6 standard, or 7-9 for the advanced HSK 3.0 band; use 0 only for slang or internet slang>
    }
  ]
}

The "tokens" array must cover the entire line: concatenating every "word" must reproduce the original lyric exactly (ignore spaces/punctuation). Segment natural words, not individual characters (e.g. 月亮 is one token, not 月 + 亮).${advancedNote}`
}

async function callLlm(settings: LlmSettings, lyric: string): Promise<LyricAnalysis> {
  const { endpoint, model } = PROVIDER_CONFIG[settings.provider]

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a Mandarin language teacher for Chinese songs. You always reply with valid JSON only."
        },
        { role: "user", content: buildPrompt(lyric, settings.targetHsk) }
      ]
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`LLM API error ${response.status}: ${detail.slice(0, 200)}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error("LLM returned an empty response.")

  return parseAnalysis(content)
}

function parseAnalysis(content: string): LyricAnalysis {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const parsed = JSON.parse(raw) as Partial<LyricAnalysis>

  if (!parsed.pinyin || !parsed.hsk_level || !parsed.translation) {
    throw new Error("LLM response was missing required fields.")
  }

  // Tokens are the basis of the word-tagging UI; drop malformed entries but
  // don't fail the whole analysis if the model skipped them.
  const tokens = (Array.isArray(parsed.tokens) ? parsed.tokens : []).filter(
    (token) => token && typeof token.word === "string" && token.word.length > 0
  )

  return {
    pinyin: parsed.pinyin,
    hsk_level: parsed.hsk_level,
    translation: parsed.translation,
    tokens
  }
}

function buildLookupPrompt(word: string, context: string, targetHsk: number): string {
  const advancedNote =
    targetHsk >= 7
      ? ` If the word belongs to the HSK 7–9 advanced band, tag it 7, 8, or 9 rather than 0. Use 0 only for genuine slang.`
      : ""

  return `Act as a Mandarin dictionary for a language learner at HSK level ${targetHsk}.

Word: "${word}"
Lyric line it appeared in: "${context || "(none)"}"

Respond ONLY with a JSON object in this exact shape:
{
  "word": "<the word as given>",
  "pinyin": "<pinyin with tone marks>",
  "hsk": <integer HSK level: 1-6 standard, or 7-9 for the advanced HSK 3.0 band; use 0 only for slang or internet slang>,
  "definition": "<concise English meaning, 1-2 sentences. If the word has a special meaning or nuance in the lyric context, mention it.>"
}${advancedNote}`
}

async function callLookupLlm(
  settings: LlmSettings,
  word: string,
  context: string
): Promise<WordLookup> {
  const { endpoint, model } = PROVIDER_CONFIG[settings.provider]

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a Mandarin dictionary for song lyrics. You always reply with valid JSON only."
        },
        { role: "user", content: buildLookupPrompt(word, context, settings.targetHsk) }
      ]
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`LLM API error ${response.status}: ${detail.slice(0, 200)}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error("LLM returned an empty response.")

  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const parsed = JSON.parse(raw) as Partial<WordLookup>

  if (!parsed.word || !parsed.pinyin || !parsed.definition) {
    throw new Error("LLM lookup response was missing required fields.")
  }

  return {
    word: parsed.word,
    pinyin: parsed.pinyin,
    definition: parsed.definition,
    hsk: typeof parsed.hsk === "number" ? parsed.hsk : 0
  }
}

function buildCulturePrompt(lyric: string, targetHsk: number): string {
  return `You are a cultural guide for a Mandarin learner at HSK level ${targetHsk}.

Song lyric: "${lyric}"

Respond ONLY with a JSON object in this exact shape:
{
  "cultural_meaning": "<1-3 sentences in simple English explaining slang, idioms, wordplay, or cultural metaphors in the line. Explain any chengyu (成语) or internet slang. If the line is literal, say what it means and note anything distinctly Chinese about it.>"
}`
}

async function callCultureLlm(settings: LlmSettings, lyric: string): Promise<CultureInsight> {
  const { endpoint, model } = PROVIDER_CONFIG[settings.provider]

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a warm, knowledgeable guide to Chinese language and pop culture. You always reply with valid JSON only."
        },
        { role: "user", content: buildCulturePrompt(lyric, settings.targetHsk) }
      ]
    })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`LLM API error ${response.status}: ${detail.slice(0, 200)}`)
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error("LLM returned an empty response.")

  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const parsed = JSON.parse(raw) as Partial<CultureInsight>

  if (!parsed.cultural_meaning) {
    throw new Error("LLM culture response was missing required fields.")
  }

  return { cultural_meaning: parsed.cultural_meaning }
}

// ---------------------------------------------------------------------------
// Mock fallback: lets the full pipeline (content script -> background -> UI)
// be tested without an API key. Swap in real keys via the popup for live data.
// ---------------------------------------------------------------------------

const MOCK_SAMPLES: Record<string, LyricAnalysis & CultureInsight> = {
  月亮代表我的心: {
    pinyin: "yuè liang dài biǎo wǒ de xīn",
    hsk_level: "HSK 4",
    translation: "The moon represents my heart.",
    tokens: [
      { word: "月亮", pinyin: "yuèliang", hsk: 3 },
      { word: "代表", pinyin: "dàibiǎo", hsk: 4 },
      { word: "我", pinyin: "wǒ", hsk: 1 },
      { word: "的", pinyin: "de", hsk: 1 },
      { word: "心", pinyin: "xīn", hsk: 4 }
    ],
    cultural_meaning:
      "From Teresa Teng's 1977 classic. In Chinese pop, the moon is a stock image of longing and tenderness — asking 'the moon to speak for my heart' means confessing love indirectly, which fits traditional reticence about saying 我爱你 outright."
  },
  朋友一生一起走: {
    pinyin: "péngyou yīshēng yīqǐ zǒu",
    hsk_level: "HSK 3",
    translation: "Friends walk together through a whole lifetime.",
    tokens: [
      { word: "朋友", pinyin: "péngyou", hsk: 1 },
      { word: "一生", pinyin: "yīshēng", hsk: 4 },
      { word: "一起", pinyin: "yīqǐ", hsk: 2 },
      { word: "走", pinyin: "zǒu", hsk: 2 }
    ],
    cultural_meaning:
      "The opening line of Emil Chau's anthem 朋友. Friendship framed as walking the whole road of life together reflects the high cultural value placed on loyalty (义气) and long-term bonds between friends."
  }
}

// Token colors cycle through easy / mid / beyond-level buckets so the
// color-tagging UI can be verified without an API key.
const MOCK_TOKEN_HSK = [2, 5, 0, 3, 1, 6]

function mockTokens(lyric: string): LyricToken[] {
  const chars = lyric.replace(/[\s，。！？、"'…—,.!?]+/g, "")
  const tokens: LyricToken[] = []
  for (let i = 0; i < chars.length; i += 2) {
    tokens.push({
      word: chars.slice(i, i + 2),
      pinyin: "[mock]",
      hsk: MOCK_TOKEN_HSK[(i / 2) % MOCK_TOKEN_HSK.length]
    })
  }
  return tokens
}

function mockAnalysis(lyric: string): LyricAnalysis {
  const sample = MOCK_SAMPLES[lyric.trim()]
  if (sample) return sample

  const hsk = Math.min(6, Math.max(1, Math.ceil(lyric.length / 4)))
  return {
    pinyin: `[mock pinyin] ${lyric}`,
    hsk_level: `HSK ${hsk}`,
    translation: "[mock translation] The pipeline is working — add an API key for a real translation.",
    tokens: mockTokens(lyric)
  }
}

function mockExplain(lyric: string): CultureInsight {
  const sample = MOCK_SAMPLES[lyric.trim()]
  if (sample) return { cultural_meaning: sample.cultural_meaning }

  return {
    cultural_meaning:
      "Mock cultural insight — no API key configured. Add a DeepSeek or OpenAI key in the popup to get real explanations of slang, idioms, and cultural metaphors."
  }
}

const MOCK_DICT: Record<string, Omit<WordLookup, "word">> = {
  月亮: { pinyin: "yuèliang", hsk: 3, definition: "The moon; a common symbol of longing and love in Chinese songs." },
  代表: { pinyin: "dàibiǎo", hsk: 4, definition: "To represent; to stand for." },
  朋友: { pinyin: "péngyou", hsk: 1, definition: "Friend." },
  心: { pinyin: "xīn", hsk: 4, definition: "Heart; mind. Often refers to feelings rather than the organ." },
  走: { pinyin: "zǒu", hsk: 2, definition: "To walk; to go. In songs, often means journeying through life together." }
}

function mockLookup(word: string): WordLookup {
  const entry = MOCK_DICT[word]
  if (entry) return { word, ...entry }

  return {
    word,
    pinyin: "[mock pinyin]",
    hsk: MOCK_TOKEN_HSK[word.length % MOCK_TOKEN_HSK.length],
    definition: `Mock definition for "${word}" — no API key configured. Add a DeepSeek or OpenAI key in the popup for real dictionary entries.`
  }
}

async function handleAnalyze(lyric: string): Promise<LyricAnalysisResponse> {
  if (!lyric.trim()) {
    return { success: false, error: "Lyric line is empty." }
  }

  const settings = await getSettings()
  if (!settings.apiKey) {
    // Fallback mock response for testing without a configured LLM key.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { success: true, data: mockAnalysis(lyric) }
  }

  try {
    const data = await callLlm(settings, lyric.trim())
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error while analyzing."
    }
  }
}

async function handleLookup(
  word: string,
  context: string
): Promise<WordLookupResponse> {
  if (!word.trim()) {
    return { success: false, error: "Word is empty." }
  }

  const settings = await getSettings()
  if (!settings.apiKey) {
    // Fallback mock response for testing without a configured LLM key.
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { success: true, data: mockLookup(word.trim()) }
  }

  try {
    const data = await callLookupLlm(settings, word.trim(), context)
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error while looking up."
    }
  }
}

async function handleExplainCulture(lyric: string): Promise<CultureExplainResponse> {
  if (!lyric.trim()) {
    return { success: false, error: "Lyric line is empty." }
  }

  const settings = await getSettings()
  if (!settings.apiKey) {
    // Fallback mock response for testing without a configured LLM key.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { success: true, data: mockExplain(lyric) }
  }

  try {
    const data = await callCultureLlm(settings, lyric.trim())
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error while explaining."
    }
  }
}

// ---------------------------------------------------------------------------
// NetEase timed-lyrics (LRC) engine: official lyrics fetched from NetEase's
// public API and time-synced to the player, independent of site DOM markup.
// ---------------------------------------------------------------------------

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = []
  for (const raw of lrc.split("\n")) {
    const match = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
    if (!match) continue
    const time = parseInt(match[1], 10) * 60 + parseFloat(match[2])
    const text = match[3].trim()
    if (text) lines.push({ time, text })
  }
  return lines.sort((a, b) => a.time - b.time)
}

async function fetchNeteaseLrc(songId: string): Promise<LrcLine[]> {
  const response = await fetch(
    `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`
  )
  if (!response.ok) throw new Error(`NetEase lyric API error ${response.status}`)

  const payload = (await response.json()) as { lrc?: { lyric?: string } }
  const lines = parseLrc(payload.lrc?.lyric ?? "")
  if (lines.length === 0) throw new Error("No timed lyrics found for this song.")
  return lines
}

async function handleFetchLrcById(songId: string): Promise<FetchLrcResponse> {
  if (!songId.trim()) return { success: false, error: "Song id is empty." }
  try {
    const lines = await fetchNeteaseLrc(songId.trim())
    return { success: true, data: { songId: Number(songId), lines } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not fetch lyrics."
    }
  }
}

async function handleFetchLrcByQuery(query: string): Promise<FetchLrcResponse> {
  if (!query.trim()) return { success: false, error: "Search query is empty." }
  try {
    const search = await fetch(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query.trim())}&type=1&limit=3`
    )
    if (!search.ok) throw new Error(`NetEase search API error ${search.status}`)

    const payload = (await search.json()) as {
      result?: { songs?: { id: number; name: string; artists?: { name: string }[] }[] }
    }
    const song = payload.result?.songs?.[0]
    if (!song) return { success: false, error: `No NetEase match for “${query.trim()}”.` }

    const lines = await fetchNeteaseLrc(String(song.id))
    return {
      success: true,
      data: {
        songId: song.id,
        songName: song.name,
        artist: song.artists?.[0]?.name,
        lines
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not fetch lyrics."
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: Partial<
      LyricAnalysisRequest | WordLookupRequest | CultureExplainRequest | FetchLrcByIdRequest | FetchLrcByQueryRequest
    >,
    _sender,
    sendResponse
  ) => {
    if (message?.type === "ANALYZE_LYRIC") {
      handleAnalyze(message.lyric ?? "").then(sendResponse)
      return true // keep the message channel open for the async response
    }

    if (message?.type === "LOOKUP_WORD") {
      handleLookup(message.word ?? "", message.context ?? "").then(sendResponse)
      return true
    }

    if (message?.type === "EXPLAIN_CULTURE") {
      handleExplainCulture(message.lyric ?? "").then(sendResponse)
      return true
    }

    if (message?.type === "FETCH_LRC_BY_ID") {
      handleFetchLrcById(message.songId ?? "").then(sendResponse)
      return true
    }

    if (message?.type === "FETCH_LRC_BY_QUERY") {
      handleFetchLrcByQuery(message.query ?? "").then(sendResponse)
      return true
    }

    return false
  }
)

export {}
