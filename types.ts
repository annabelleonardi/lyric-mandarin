export interface LyricToken {
  /** A segmented Chinese word, e.g. "月亮" */
  word: string
  /** Word-level pinyin with tone marks */
  pinyin: string
  /** HSK level: 1-6 standard, 7-9 advanced (HSK 3.0 band); 0 = slang or internet slang */
  hsk: number
}

export interface LyricAnalysis {
  /** Full-sentence pinyin, e.g. "wǒ ài nǐ" */
  pinyin: string
  /** HSK difficulty tag, e.g. "HSK 3" */
  hsk_level: string
  /** Natural English translation of the line */
  translation: string
  /** Word segmentation with per-word pinyin + HSK level for color tagging */
  tokens: LyricToken[]
}

export interface LyricAnalysisRequest {
  type: "ANALYZE_LYRIC"
  lyric: string
}

export interface LyricAnalysisResponse {
  success: boolean
  data?: LyricAnalysis
  error?: string
}

export interface CultureExplainRequest {
  type: "EXPLAIN_CULTURE"
  lyric: string
}

export interface CultureInsight {
  /** Explanation of slang, idioms, or cultural metaphors (1-2 sentences) */
  cultural_meaning: string
}

export interface CultureExplainResponse {
  success: boolean
  data?: CultureInsight
  error?: string
}

export interface WordLookupRequest {
  type: "LOOKUP_WORD"
  word: string
  /** The lyric line the word appeared in, for context-aware definitions */
  context?: string
}

export interface WordLookup {
  word: string
  pinyin: string
  /** HSK level: 1-6 standard, 7-9 advanced (HSK 3.0 band); 0 = slang or internet slang */
  hsk: number
  /** Concise English dictionary definition */
  definition: string
}

export interface WordLookupResponse {
  success: boolean
  data?: WordLookup
  error?: string
}

export interface SavedWord extends WordLookup {
  /** The lyric line the word was saved from */
  sourceLyric: string
  savedAt: number
}

export interface LrcLine {
  /** Offset from the start of the track, in seconds */
  time: number
  text: string
}

export interface FetchLrcByIdRequest {
  type: "FETCH_LRC_BY_ID"
  songId: string
}

export interface FetchLrcByQueryRequest {
  type: "FETCH_LRC_BY_QUERY"
  query: string
}

export interface FetchLrcResponse {
  success: boolean
  data?: {
    songId?: number
    songName?: string
    artist?: string
    lines: LrcLine[]
  }
  error?: string
}
