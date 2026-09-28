import { useCallback, useEffect, useRef, useState } from "react"
import type { PlasmoCSConfig } from "plasmo"

import type {
  CultureExplainResponse,
  FetchLrcByIdRequest,
  FetchLrcByQueryRequest,
  FetchLrcResponse,
  LyricAnalysis,
  LyricAnalysisResponse,
  LyricToken,
  LrcLine,
  SavedWord,
  WordLookup,
  WordLookupResponse
} from "./types"

export const config: PlasmoCSConfig = {
  matches: ["https://www.youtube.com/*", "https://music.163.com/*"],
  run_at: "document_idle",
  all_frames: true
}

const IS_TOP_FRAME = window.self === window.top

/** HSK 1–3 green, 4–5 amber, 6+ / slang (0) purple */
const hskBucket = (hsk: number) => (hsk >= 1 && hsk <= 3 ? "easy" : hsk >= 4 && hsk <= 5 ? "mid" : "hard")

// ---------------------------------------------------------------------------
// Lyric capture: per-site DOM selectors for the currently visible lyrics.
// ---------------------------------------------------------------------------

const LYRIC_SELECTORS: Record<string, string[]> = {
  "www.youtube.com": [
    "ytd-transcript-segment-renderer .segment-text",
    ".ytd-transcript-segment-renderer"
  ],
  "music.163.com": [
    "#lyricContent .txt",
    "#lyricContent",
    ".n-lyric__line",
    ".lyric-line"
  ]
}

const TIMESTAMP_RE = /^\[[\d:.]+\]\s*/

// Fallback: NetEase marks the currently-playing line with .z-slt / .z-crt.
const ACTIVE_LYRIC_SELECTORS = [".j-flag .z-slt", ".m-lyric .z-crt", ".lrcItem.z-crt"]

function extractActiveLyric(): string | null {
  // Known NetEase highlight classes first (stable conventions across versions).
  for (const selector of ACTIVE_LYRIC_SELECTORS) {
    const text = document
      .querySelector<HTMLElement>(selector)
      ?.textContent?.trim()
      .replace(TIMESTAMP_RE, "")

    if (text && /[\u4e00-\u9fff]/.test(text)) return text
  }

  // Generic fallback for redesigns: inside any lyric/transcript container,
  // find the element the site marks as current (crt/slt/active/current/playing
  // class fragments) and use its text. The length guard keeps outer wrappers
  // with whole-list text from matching.
  const lyricish = document.querySelectorAll<HTMLElement>(
    '[class*="lyric" i], [id*="lyric" i], [class*="lrc" i], [class*="transcript" i]'
  )
  for (const container of lyricish) {
    const marked = container.querySelectorAll<HTMLElement>(
      '[class*="crt" i], [class*="slt" i], [class*="active" i], [class*="current" i], [class*="playing" i]'
    )
    for (const el of marked) {
      const text = el.textContent?.trim().replace(TIMESTAMP_RE, "")
      if (text && text.length <= 60 && /[\u4e00-\u9fff]/.test(text)) return text
    }
  }
  return null
}

function extractLyrics(): string[] {
  const host = window.location.hostname
  const selectors = LYRIC_SELECTORS[host] ?? []

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector))
    if (nodes.length === 0) continue

    const lines = nodes
      .map((node) => node.textContent?.trim() ?? "")
      .map((line) => line.replace(TIMESTAMP_RE, ""))
      .filter((line) => line.length > 0 && /[\u4e00-\u9fff]/.test(line))

    // Deduplicate while keeping order; a translated duplicate is usually
    // interleaved with the Chinese line on YouTube transcripts.
    const unique = Array.from(new Set(lines))
    if (unique.length > 0) return unique.slice(0, 100)
  }

  return []
}

// ---------------------------------------------------------------------------
// LRC engine helpers: official timed lyrics synced to the media element.
// ---------------------------------------------------------------------------

function getNeteaseSongId(): string | null {
  const match = window.location.href.match(/song\?id=(\d+)/)
  return match ? match[1] : null
}

function getYouTubeTitle(): string | null {
  if (window.location.hostname !== "www.youtube.com" || window.location.pathname !== "/watch") {
    return null
  }
  const heading = document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim()
  if (heading) return heading
  return document.title.replace(/ - YouTube\s*$/, "").trim() || null
}

function getMediaTime(): number | null {
  const el =
    document.querySelector<HTMLMediaElement>("audio#mainPlayer") ??
    document.querySelector<HTMLMediaElement>("video.html5-main-video") ??
    document.querySelector<HTMLMediaElement>("audio")
  return el && el.currentTime > 0 ? el.currentTime : null
}

// ---------------------------------------------------------------------------
// Overlay UI
// ---------------------------------------------------------------------------

function LyricOverlay() {
  const [open, setOpen] = useState(true)
  // Display mode: passive "karaoke" view vs. active "breakdown" view
  const [mode, setMode] = useState<"karaoke" | "breakdown">("breakdown")
  const [lyrics, setLyrics] = useState<string[]>([])
  const [manualLine, setManualLine] = useState("")
  const [activeLine, setActiveLine] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<LyricAnalysis | null>(null)

  // Word lookup + flashcard deck
  const [lookup, setLookup] = useState<WordLookup | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<"idle" | "saved" | "duplicate">("idle")

  // Cultural insight (on-demand via Explain Culture)
  const [culture, setCulture] = useState<string | null>(null)
  const [cultureLoading, setCultureLoading] = useState(false)
  const [cultureError, setCultureError] = useState<string | null>(null)

  const busyRef = useRef(false)
  const lookupBusyRef = useRef(false)
  const cultureBusyRef = useRef(false)
  const lastAutoRef = useRef<string | null>(null)

  // LRC engine: official timed lyrics synced to the player's currentTime
  const lrcRef = useRef<LrcLine[]>([])
  const lrcIndexRef = useRef(-1)
  const [lrcIndex, setLrcIndex] = useState(-1)
  const pendingRef = useRef<string | null>(null)
  const lyricsListRef = useRef<HTMLUListElement | null>(null)

  const refresh = useCallback(() => setLyrics(extractLyrics()), [])

  useEffect(() => {
    chrome.storage.local.get("displayMode", (stored) => {
      if (stored.displayMode === "karaoke" || stored.displayMode === "breakdown") {
        setMode(stored.displayMode)
      }
    })
  }, [])

  const switchMode = (next: "karaoke" | "breakdown") => {
    setMode(next)
    void chrome.storage.local.set({ displayMode: next })
  }

  const analyze = useCallback(async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    // If an analysis is already running, queue the newest line instead of
    // dropping it — keeps the overlay locked to the song even when the LLM
    // is slower than the lyrics.
    if (busyRef.current) {
      pendingRef.current = trimmed
      return
    }
    busyRef.current = true

    setActiveLine(trimmed)
    setLoading(true)
    setError(null)
    setAnalysis(null)
    setLookup(null)
    setLookupError(null)
    setSaveState("idle")
    setCulture(null)
    setCultureError(null)

    try {
      const response = await chrome.runtime.sendMessage<
        { type: string; lyric: string },
        LyricAnalysisResponse
      >({ type: "ANALYZE_LYRIC", lyric: trimmed })

      if (!response?.success) {
        setError(response?.error ?? "Analysis failed.")
        return
      }
      setAnalysis(response.data)
    } catch {
      setError("Could not reach the background worker. Try reloading the page.")
    } finally {
      setLoading(false)
      busyRef.current = false
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending && pending !== trimmed) void analyze(pending)
    }
  }, [])

  const lookupWord = useCallback(
    async (token: LyricToken) => {
      if (lookupBusyRef.current) return
      lookupBusyRef.current = true

      setLookupLoading(true)
      setLookupError(null)
      setLookup(null)
      setSaveState("idle")

      try {
        const response = await chrome.runtime.sendMessage<
          { type: "LOOKUP_WORD"; word: string; context?: string },
          WordLookupResponse
        >({ type: "LOOKUP_WORD", word: token.word, context: activeLine ?? "" })

        if (!response?.success) {
          setLookupError(response?.error ?? "Lookup failed.")
          return
        }
        setLookup(response.data)
      } catch {
        setLookupError("Could not reach the background worker. Try reloading the page.")
      } finally {
        setLookupLoading(false)
        lookupBusyRef.current = false
      }
    },
    [activeLine]
  )

  const saveToDeck = useCallback(
    async (entry: WordLookup) => {
      try {
        const stored = await chrome.storage.local.get("deck")
        const deck: SavedWord[] = Array.isArray(stored.deck) ? stored.deck : []

        if (deck.some((word) => word.word === entry.word)) {
          setSaveState("duplicate")
          return
        }

        deck.push({ ...entry, sourceLyric: activeLine ?? "", savedAt: Date.now() })
        await chrome.storage.local.set({ deck })
        setSaveState("saved")
      } catch {
        setLookupError("Could not save the word.")
      }
    },
    [activeLine]
  )

  const explainCulture = useCallback(async () => {
    if (!activeLine || cultureBusyRef.current) return
    cultureBusyRef.current = true

    setCultureLoading(true)
    setCultureError(null)

    try {
      const response = await chrome.runtime.sendMessage<
        { type: "EXPLAIN_CULTURE"; lyric: string },
        CultureExplainResponse
      >({ type: "EXPLAIN_CULTURE", lyric: activeLine })

      if (!response?.success) {
        setCultureError(response?.error ?? "Could not explain the culture.")
        return
      }
      setCulture(response.data?.cultural_meaning ?? null)
    } catch {
      setCultureError("Could not reach the background worker. Try reloading the page.")
    } finally {
      setCultureLoading(false)
      cultureBusyRef.current = false
    }
  }, [activeLine])

  useEffect(() => {
    refresh()

    // Fallback pipeline: poll the active-line selectors (NetEase highlights
    // the current line with .z-slt / .z-crt). If one is found, analyze it.
    const runPipeline = () => {
      // Don't let DOM scraping overwrite the official LRC list once loaded
      if (lrcRef.current.length === 0) refresh()

      const line = extractActiveLyric()
      if (!line || line === lastAutoRef.current) return
      lastAutoRef.current = line

      if (IS_TOP_FRAME) {
        void analyze(line)
      } else {
        // The visible panel only lives in the top frame; forward the active
        // line there so it triggers the analysis instead of this frame.
        window.parent.postMessage({ source: "lyricmandarin", type: "ACTIVE_LYRIC", lyric: line }, "*")
      }
    }

    const onMessage = (event: MessageEvent) => {
      if (event.data?.source !== "lyricmandarin" || event.data?.type !== "ACTIVE_LYRIC") return
      const line = event.data.lyric
      if (typeof line !== "string" || line === lastAutoRef.current) return
      lastAutoRef.current = line
      void analyze(line)
    }
    if (IS_TOP_FRAME) window.addEventListener("message", onMessage)

    // Re-capture when the player swaps in new lyric lines (playback progress,
    // SPA navigation, transcript panel opening, scrolling lyric views, etc.).
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(runPipeline, 800)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    // Safety net: poll in case a frame swaps its active lyric line without a
    // DOM mutation we can observe (style/class-only changes).
    const poll = setInterval(runPipeline, 2000)

    return () => {
      observer.disconnect()
      clearTimeout(timer)
      clearInterval(poll)
      window.removeEventListener("message", onMessage)
    }
  }, [analyze, refresh])

  // LRC engine (top frame only): fetch official NetEase timed lyrics for the
  // current song — by NetEase song id, or by YouTube title search — and
  // auto-analyze each line as the media element crosses its timestamp. This
  // is independent of site DOM markup, so redesigns can't break detection.
  useEffect(() => {
    if (!IS_TOP_FRAME) return

    let source = "" // song id or video title the loaded LRC belongs to
    let lastAttempt = 0

    const loadLrc = async (request: FetchLrcByIdRequest | FetchLrcByQueryRequest) => {
      try {
        const response = await chrome.runtime.sendMessage<
          FetchLrcByIdRequest | FetchLrcByQueryRequest,
          FetchLrcResponse
        >(request)
        if (response?.success && response.data?.lines.length) {
          lrcRef.current = response.data.lines
          lrcIndexRef.current = -1
          setLrcIndex(-1)
          lastAutoRef.current = null
          setLyrics(response.data.lines.map((line) => line.text))
        }
      } catch {
        // Retry on the next 15s window; DOM scraping remains the fallback.
      }
    }

    const tick = () => {
      const songId = getNeteaseSongId()
      const key = songId ?? getYouTubeTitle()

      // Load (or reload on song change) the official lyrics for this page.
      if (key && (key !== source || (lrcRef.current.length === 0 && Date.now() - lastAttempt > 15000))) {
        source = key
        lastAttempt = Date.now()
        lrcRef.current = []
        lrcIndexRef.current = -1
        setLrcIndex(-1)
        void (songId ? loadLrc({ type: "FETCH_LRC_BY_ID", songId }) : loadLrc({ type: "FETCH_LRC_BY_QUERY", query: key }))
        return
      }

      const lines = lrcRef.current
      const time = getMediaTime()
      if (lines.length === 0 || time == null) return

      let index = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= time + 0.3) index = i
        else break
      }
      if (index === lrcIndexRef.current) return
      lrcIndexRef.current = index
      setLrcIndex(index)

      const text = index >= 0 ? lines[index].text : null
      if (text && /[\u4e00-\u9fff]/.test(text) && text !== lastAutoRef.current) {
        lastAutoRef.current = text
        void analyze(text)
      }
    }

    const poll = setInterval(tick, 500)
    return () => clearInterval(poll)
  }, [analyze])

  // Keep the Breakdown lyric list scrolled to the line that's playing
  useEffect(() => {
    if (lrcIndex < 0) return
    const list = lyricsListRef.current
    const active = list?.querySelector<HTMLElement>(".lm-line-active")
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const target =
      list.scrollTop + (activeRect.top - listRect.top) - list.clientHeight / 2 + activeRect.height / 2
    list.scrollTo({ top: Math.max(0, target), behavior: "smooth" })
  }, [lrcIndex])

  if (!open) {
    return (
      <button className="lm-fab" onClick={() => setOpen(true)} title="Open LyricMandarin">
        学
      </button>
    )
  }

  return (
    <div className="lm-panel">
      <div className="lm-header">
        <span className="lm-title">LyricMandarin</span>
        <div className="lm-header-actions">
          <button className="lm-icon-btn" onClick={refresh} title="Re-capture lyrics">
            ↻
          </button>
          <button className="lm-icon-btn" onClick={() => setOpen(false)} title="Minimize">
            —
          </button>
        </div>
      </div>

      <div className="lm-modes">
        <button
          className={`lm-mode-btn ${mode === "karaoke" ? "lm-mode-active" : ""}`}
          onClick={() => switchMode("karaoke")}>
          Karaoke
        </button>
        <button
          className={`lm-mode-btn ${mode === "breakdown" ? "lm-mode-active" : ""}`}
          onClick={() => switchMode("breakdown")}>
          Breakdown
        </button>
      </div>

      <div className="lm-body">
        {mode === "karaoke" ? (
          <div className="lm-karaoke">
            {loading && <p className="lm-hint">Analyzing…</p>}
            {error && <p className="lm-error">{error}</p>}
            {!analysis && !loading && !error && (
              <p className="lm-karaoke-hint">
                Play a song — the current line will appear here, big and clear. Switch to
                Breakdown to dig into the words.
              </p>
            )}
            {analysis && activeLine && (
              <>
                <p className="lm-karaoke-line">{activeLine}</p>
                {analysis.pinyin && <p className="lm-karaoke-py">{analysis.pinyin}</p>}
                {analysis.translation && <p className="lm-karaoke-tr">{analysis.translation}</p>}
              </>
            )}
          </div>
        ) : (
          <>
        {lyrics.length === 0 ? (
          <p className="lm-hint">
            No lyrics detected yet. On YouTube, open the transcript panel (… → Show transcript);
            NetEase lines are picked up automatically while the song plays. You can also paste a
            line below.
          </p>
        ) : (
          <ul className="lm-lyrics" ref={lyricsListRef}>
            {lyrics.map((line, index) => (
              <li key={`${index}-${line}`}>
                <button
                  className={`lm-line ${
                    (lrcIndex >= 0 ? index === lrcIndex : line === activeLine) ? "lm-line-active" : ""
                  }`}
                  onClick={() => analyze(line)}>
                  {line}
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="lm-manual"
          onSubmit={(event) => {
            event.preventDefault()
            analyze(manualLine)
          }}>
          <input
            className="lm-input"
            placeholder="Paste a lyric line…"
            value={manualLine}
            onChange={(event) => setManualLine(event.target.value)}
          />
          <button className="lm-btn" type="submit" disabled={!manualLine.trim() || loading}>
            Go
          </button>
        </form>

        {loading && <p className="lm-hint">Analyzing…</p>}

        {error && <p className="lm-error">{error}</p>}

        {analysis && (
          <div className="lm-result">
            <p className="lm-current">{activeLine}</p>

            {analysis.tokens.length > 0 ? (
              <div className="lm-row">
                <span className="lm-label">Words — click to look up</span>
                <div className="lm-tokens">
                  {analysis.tokens.map((token, index) => (
                    <button
                      key={`${index}-${token.word}`}
                      className={`lm-token lm-hsk-${hskBucket(token.hsk)}`}
                      title={token.hsk === 0 ? "Slang / internet slang" : `HSK ${token.hsk}`}
                      onClick={() => void lookupWord(token)}>
                      <span className="lm-token-py">{token.pinyin}</span>
                      <span className="lm-token-hz">{token.word}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="lm-row">
                <span className="lm-label">Pinyin</span>
                <p className="lm-pinyin">{analysis.pinyin}</p>
              </div>
            )}

            <div className="lm-row">
              <span className="lm-label">Level</span>
              <span className="lm-badge">{analysis.hsk_level}</span>
            </div>
            <div className="lm-row">
              <span className="lm-label">Translation</span>
              <p className="lm-meaning">{analysis.translation}</p>
            </div>

            {culture === null && !cultureLoading && (
              <button className="lm-culture-btn" onClick={() => void explainCulture()}>
                Explain Culture
              </button>
            )}
            {cultureLoading && <p className="lm-hint">Thinking…</p>}
            {cultureError && <p className="lm-error">{cultureError}</p>}
            {culture && (
              <div className="lm-row">
                <span className="lm-label">Cultural Insight</span>
                <p className="lm-meaning">{culture}</p>
              </div>
            )}

            {lookupLoading && <p className="lm-hint">Looking up…</p>}
            {lookupError && <p className="lm-error">{lookupError}</p>}

            {lookup && (
              <div className="lm-lookup">
                <div className="lm-lookup-head">
                  <span className={`lm-lookup-word lm-c-${hskBucket(lookup.hsk)}`}>{lookup.word}</span>
                  <span className="lm-lookup-py">{lookup.pinyin}</span>
                  <span className={`lm-badge lm-badge-${hskBucket(lookup.hsk)}`}>
                    {lookup.hsk === 0 ? "Slang" : `HSK ${lookup.hsk}`}
                  </span>
                </div>
                <p className="lm-lookup-def">{lookup.definition}</p>
                <button
                  className="lm-btn"
                  disabled={saveState !== "idle"}
                  onClick={() => void saveToDeck(lookup)}>
                  {saveState === "idle" && "Save to Deck"}
                  {saveState === "saved" && "Saved ✓"}
                  {saveState === "duplicate" && "Already in deck"}
                </button>
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  )
}

export const getContainer = () => {
  const container = document.createElement("div")
  container.id = "lyricmandarin-root"
  document.body.append(container)
  return container
}

export const getShadowHostId = () => "lyricmandarin-host"

export default function ContentMain() {
  // With all_frames: true the script also runs in NetEase/YouTube player
  // iframes — only render the overlay UI once, in the top document.
  if (!IS_TOP_FRAME) return null

  return (
    <>
      <style>{`
        #lyricmandarin-host {
          all: initial;
        }
        .lm-fab {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 2147483647;
          width: 44px;
          height: 44px;
          border: none;
          border-radius: 50%;
          background: #e63946;
          color: #fff;
          font-size: 18px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        }
        .lm-panel {
          position: fixed;
          right: 20px;
          bottom: 20px;
          z-index: 2147483647;
          width: 320px;
          max-height: 60vh;
          display: flex;
          flex-direction: column;
          border-radius: 12px;
          background: #1d1d27;
          color: #f2f2f7;
          font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
          font-size: 13px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
        }
        .lm-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .lm-title {
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .lm-header-actions {
          display: flex;
          gap: 6px;
        }
        .lm-icon-btn {
          width: 22px;
          height: 22px;
          border: none;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.08);
          color: #f2f2f7;
          cursor: pointer;
          line-height: 1;
        }
        .lm-modes {
          display: flex;
          gap: 6px;
          padding: 8px 12px 0;
        }
        .lm-mode-btn {
          flex: 1;
          padding: 5px 0;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 7px;
          background: transparent;
          color: rgba(242, 242, 247, 0.6);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .lm-mode-btn:hover {
          color: #f2f2f7;
        }
        .lm-mode-active {
          background: #e63946;
          border-color: #e63946;
          color: #fff;
        }
        .lm-karaoke {
          display: flex;
          min-height: 150px;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 14px 4px 6px;
        }
        .lm-karaoke::before {
          content: "";
          width: 26px;
          height: 3px;
          border-radius: 2px;
          background: #e63946;
          margin-bottom: 14px;
        }
        .lm-karaoke-line {
          margin: 0 0 10px;
          font-size: 26px;
          font-weight: 700;
          line-height: 1.5;
        }
        .lm-karaoke-py {
          margin: 0 0 8px;
          color: rgba(242, 242, 247, 0.72);
          font-size: 15px;
          letter-spacing: 0.03em;
          line-height: 1.5;
        }
        .lm-karaoke-tr {
          margin: 0;
          color: rgba(242, 242, 247, 0.55);
          font-size: 13px;
          line-height: 1.55;
        }
        .lm-karaoke-hint {
          margin: 0;
          color: rgba(242, 242, 247, 0.55);
          font-size: 12.5px;
          line-height: 1.6;
        }
        .lm-body {
          padding: 10px 12px 12px;
          overflow-y: auto;
        }
        .lm-lyrics {
          margin: 0 0 10px;
          padding: 0;
          list-style: none;
          max-height: 180px;
          overflow-y: auto;
        }
        .lm-line {
          width: 100%;
          padding: 6px 8px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: #f2f2f7;
          text-align: left;
          font-size: 13px;
          cursor: pointer;
        }
        .lm-line:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .lm-line-active {
          background: rgba(230, 57, 70, 0.25);
        }
        .lm-manual {
          display: flex;
          gap: 6px;
          margin-bottom: 10px;
        }
        .lm-input {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.06);
          color: #f2f2f7;
          font-size: 13px;
        }
        .lm-btn {
          padding: 6px 12px;
          border: none;
          border-radius: 6px;
          background: #e63946;
          color: #fff;
          font-size: 13px;
          cursor: pointer;
        }
        .lm-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .lm-hint {
          margin: 0 0 10px;
          color: rgba(242, 242, 247, 0.6);
          font-size: 12px;
          line-height: 1.5;
        }
        .lm-error {
          margin: 0 0 10px;
          color: #ff8b94;
          font-size: 12px;
        }
        .lm-result {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          padding-top: 10px;
        }
        .lm-current {
          margin: 0 0 10px;
          padding: 6px 8px;
          border-radius: 6px;
          background: rgba(230, 57, 70, 0.15);
          font-size: 13px;
          line-height: 1.5;
        }
        .lm-row {
          margin-bottom: 10px;
        }
        .lm-label {
          display: block;
          margin-bottom: 4px;
          color: rgba(242, 242, 247, 0.55);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .lm-pinyin {
          margin: 0;
          font-size: 14px;
          line-height: 1.5;
        }
        .lm-badge {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          background: #2a9d8f;
          color: #fff;
          font-size: 11px;
          font-weight: 700;
        }
        .lm-meaning {
          margin: 0;
          line-height: 1.55;
        }
        .lm-tokens {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .lm-token {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 3px 7px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.05);
          cursor: pointer;
        }
        .lm-token:hover {
          background: rgba(255, 255, 255, 0.12);
        }
        .lm-token-py {
          color: rgba(242, 242, 247, 0.55);
          font-size: 9px;
          letter-spacing: 0.02em;
          white-space: nowrap;
        }
        .lm-token-hz {
          font-size: 15px;
          line-height: 1.3;
        }
        /* HSK color coding: 1-3 green, 4-5 amber, 6+/slang purple */
        .lm-token.lm-hsk-easy .lm-token-hz {
          color: #4ade80;
        }
        .lm-token.lm-hsk-mid .lm-token-hz {
          color: #fbbf24;
        }
        .lm-token.lm-hsk-hard .lm-token-hz {
          color: #c084fc;
        }
        .lm-c-easy {
          color: #4ade80;
        }
        .lm-c-mid {
          color: #fbbf24;
        }
        .lm-c-hard {
          color: #c084fc;
        }
        .lm-badge-easy {
          background: #16a34a;
        }
        .lm-badge-mid {
          background: #d97706;
        }
        .lm-badge-hard {
          background: #7c3aed;
        }
        .lm-lookup {
          margin-top: 10px;
          padding: 10px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.04);
        }
        .lm-lookup-head {
          display: flex;
          align-items: baseline;
          gap: 8px;
          margin-bottom: 6px;
        }
        .lm-lookup-word {
          font-size: 17px;
          font-weight: 700;
        }
        .lm-lookup-py {
          color: rgba(242, 242, 247, 0.65);
          font-size: 12px;
        }
        .lm-lookup-def {
          margin: 0 0 10px;
          font-size: 12.5px;
          line-height: 1.55;
        }
        .lm-culture-btn {
          width: 100%;
          margin: 2px 0 10px;
          padding: 7px 0;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 7px;
          background: transparent;
          color: #f2f2f7;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
        }
        .lm-culture-btn:hover {
          background: rgba(255, 255, 255, 0.08);
        }
      `}</style>
      <LyricOverlay />
    </>
  )
}
