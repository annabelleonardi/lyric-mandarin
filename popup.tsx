import { useEffect, useState } from "react"

import type { SavedWord } from "./types"

type Provider = "openai" | "deepseek"
type Tab = "settings" | "deck"

const HSK_LEVELS = [1, 2, 3, 4, 5, 6, 9] // 9 renders as the "HSK 7–9" advanced band

/** HSK 1–3 green, 4–5 amber, 6+ / slang (0) purple */
const hskBucket = (hsk: number) =>
  hsk >= 1 && hsk <= 3 ? "easy" : hsk >= 4 && hsk <= 5 ? "mid" : "hard"

function IndexPopup() {
  const [tab, setTab] = useState<Tab>("settings")

  const [provider, setProvider] = useState<Provider>("deepseek")
  const [apiKey, setApiKey] = useState("")
  const [targetHsk, setTargetHsk] = useState(3)
  const [saved, setSaved] = useState(false)

  const [deck, setDeck] = useState<SavedWord[]>([])

  useEffect(() => {
    chrome.storage.local.get(["llmProvider", "llmApiKey", "targetHsk"], (stored) => {
      if (stored.llmProvider === "openai" || stored.llmProvider === "deepseek") {
        setProvider(stored.llmProvider)
      }
      if (typeof stored.llmApiKey === "string") setApiKey(stored.llmApiKey)
      if (typeof stored.targetHsk === "number") setTargetHsk(stored.targetHsk)
    })
  }, [])

  useEffect(() => {
    if (tab !== "deck") return
    chrome.storage.local.get("deck", (stored) => {
      const list: SavedWord[] = Array.isArray(stored.deck) ? stored.deck : []
      setDeck([...list].sort((a, b) => b.savedAt - a.savedAt))
    })
  }, [tab])

  const save = () => {
    chrome.storage.local.set({ llmProvider: provider, llmApiKey: apiKey.trim(), targetHsk }, () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    })
  }

  const removeWord = (word: string) => {
    chrome.storage.local.get("deck", (stored) => {
      const list: SavedWord[] = Array.isArray(stored.deck) ? stored.deck : []
      const next = list.filter((entry) => entry.word !== word)
      chrome.storage.local.set({ deck: next }, () => {
        setDeck((current) => current.filter((entry) => entry.word !== word))
      })
    })
  }

  /** Export the deck as Anki-ready CSV: Front = word, Back = pinyin + definition + source lyric */
  const exportCsv = () => {
    const esc = (value: string) => `"${value.replace(/"/g, '""')}"`
    const header = ["Front", "Back", "HSK"].map(esc).join(",")
    const rows = deck.map((entry) => {
      const back = [
        entry.pinyin,
        entry.definition,
        entry.sourceLyric ? `“${entry.sourceLyric}”` : ""
      ]
        .filter(Boolean)
        .join("\n")
      return [entry.word, back, entry.hsk === 0 ? "6+" : String(entry.hsk)]
        .map(esc)
        .join(",")
    })
    // \uFEFF BOM so Anki/Excel detect UTF-8 for the Chinese text
    const csv = "\uFEFF" + [header, ...rows].join("\r\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "lyricmandarin-anki.csv"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container">
      <h1 className="title">LyricMandarin</h1>

      <div className="tabs">
        <button
          className={`tab ${tab === "settings" ? "tab-active" : ""}`}
          onClick={() => setTab("settings")}>
          Settings
        </button>
        <button
          className={`tab ${tab === "deck" ? "tab-active" : ""}`}
          onClick={() => setTab("deck")}>
          My Deck{deck.length > 0 ? ` (${deck.length})` : ""}
        </button>
      </div>

      {tab === "settings" && (
        <>
          <label className="label" htmlFor="provider">
            LLM provider
          </label>
          <select
            id="provider"
            className="input"
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider)}>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
          </select>

          <label className="label" htmlFor="apiKey">
            API key
          </label>
          <input
            id="apiKey"
            className="input"
            type="password"
            placeholder={provider === "openai" ? "sk-…" : "DeepSeek API key"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />

          <label className="label" htmlFor="hsk">
            Target HSK level
          </label>
          <select
            id="hsk"
            className="input"
            value={targetHsk}
            onChange={(event) => setTargetHsk(Number(event.target.value))}>
            {HSK_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === 9 ? "HSK 7–9 (advanced)" : `HSK ${level}`}
              </option>
            ))}
          </select>

          <button className="save-btn" onClick={save}>
            {saved ? "Saved ✓" : "Save settings"}
          </button>

          <p className="hint">
            Your key is stored locally in the browser and is only sent to the provider you selected.
            Without a key, the extension runs in mock mode with sample data.
          </p>
        </>
      )}

      {tab === "deck" && (
        <>
          {deck.length === 0 ? (
            <p className="hint deck-empty">
              No words saved yet. While listening to a song, click any colored word in the overlay
              and hit “Save to Deck”.
            </p>
          ) : (
            <>
              <button className="export-btn" onClick={exportCsv} title="Download the deck as a CSV that imports into Anki">
                Export CSV (Anki)
              </button>
              <div className="deck">
                {deck.map((entry) => (
                  <div className="deck-item" key={entry.word}>
                    <div className="deck-head">
                      <span className={`deck-word c-${hskBucket(entry.hsk)}`}>{entry.word}</span>
                      <span className="deck-py">{entry.pinyin}</span>
                      <span className={`chip chip-${hskBucket(entry.hsk)}`}>
                        {entry.hsk === 0 ? "slang" : entry.hsk}
                      </span>
                      <button
                        className="del"
                        title="Remove from deck"
                        onClick={() => removeWord(entry.word)}>
                        ✕
                      </button>
                    </div>
                    <p className="deck-def">{entry.definition}</p>
                    {entry.sourceLyric && <p className="deck-src">“{entry.sourceLyric}”</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <style>{`
        .container {
          width: 320px;
          padding: 16px;
          font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
          font-size: 13px;
          color: #1d1d27;
        }
        .title {
          margin: 0 0 10px;
          font-size: 18px;
          font-weight: 700;
        }
        .tabs {
          display: flex;
          gap: 6px;
          margin-bottom: 6px;
        }
        .tab {
          flex: 1;
          padding: 6px 0;
          border: 1px solid #d5d5dc;
          border-radius: 7px;
          background: #fff;
          font-size: 12.5px;
          font-weight: 600;
          color: #55555e;
          cursor: pointer;
        }
        .tab-active {
          background: #1d1d27;
          border-color: #1d1d27;
          color: #fff;
        }
        .label {
          display: block;
          margin: 10px 0 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #55555e;
        }
        .input {
          width: 100%;
          box-sizing: border-box;
          padding: 7px 9px;
          border: 1px solid #d5d5dc;
          border-radius: 7px;
          font-size: 13px;
          background: #fff;
        }
        .input:focus {
          outline: none;
          border-color: #e63946;
        }
        .save-btn {
          width: 100%;
          margin-top: 16px;
          padding: 8px 0;
          border: none;
          border-radius: 7px;
          background: #e63946;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .save-btn:hover {
          background: #d02f3c;
        }
        .hint {
          margin: 10px 0 0;
          color: #8a8a94;
          font-size: 11px;
          line-height: 1.5;
        }
        .deck-empty {
          margin-top: 24px;
          text-align: center;
        }
        .deck {
          max-height: 320px;
          overflow-y: auto;
          margin-top: 8px;
        }
        .export-btn {
          width: 100%;
          margin-top: 10px;
          padding: 7px 0;
          border: 1px solid #d5d5dc;
          border-radius: 7px;
          background: #fff;
          color: #1d1d27;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
        }
        .export-btn:hover {
          border-color: #e63946;
          color: #e63946;
        }
        .deck-item {
          padding: 10px;
          border: 1px solid #e4e4ea;
          border-radius: 8px;
          margin-bottom: 8px;
        }
        .deck-head {
          display: flex;
          align-items: baseline;
          gap: 8px;
        }
        .deck-word {
          font-size: 16px;
          font-weight: 700;
        }
        .deck-py {
          flex: 1;
          color: #8a8a94;
          font-size: 11.5px;
        }
        .chip {
          padding: 1px 7px;
          border-radius: 999px;
          color: #fff;
          font-size: 10px;
          font-weight: 700;
        }
        .chip-easy {
          background: #16a34a;
        }
        .chip-mid {
          background: #d97706;
        }
        .chip-hard {
          background: #7c3aed;
        }
        .del {
          border: none;
          background: transparent;
          color: #b5b5bd;
          font-size: 12px;
          cursor: pointer;
        }
        .del:hover {
          color: #e63946;
        }
        .deck-def {
          margin: 6px 0 0;
          font-size: 12px;
          line-height: 1.5;
        }
        .deck-src {
          margin: 4px 0 0;
          color: #8a8a94;
          font-size: 11px;
          font-style: italic;
        }
        .c-easy {
          color: #16a34a;
        }
        .c-mid {
          color: #d97706;
        }
        .c-hard {
          color: #7c3aed;
        }
      `}</style>
    </div>
  )
}

export default IndexPopup
