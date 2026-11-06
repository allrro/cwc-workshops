"use client";
import { useState } from "react";
import { api } from "@/lib/client-types";

export default function SubscriptionDesk() {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  async function send() {
    setBusy(true);
    setAnswer("");
    try {
      const result = await api<{ answer: string }>("/api/desk/astra", {
        method: "POST", body: JSON.stringify(review ? { text, effort: "high" } : { text }),
      });
      setAnswer(result.answer);
    } catch (error) {
      setAnswer(String(error));
    } finally {
      setBusy(false);
    }
  }
  return <section>
    <h2>ChatGPT · GPT-6 Astra · {review ? "High" : "Medium"}</h2>
    <p>Each question starts a new session with the desk watchlist. Paste any filing excerpts you want analyzed.</p>
    <label><input type="checkbox" checked={review} disabled={busy} onChange={e => setReview(e.target.checked)} /> Use high effort for manual review</label>
    <textarea aria-label="Research question" value={text} maxLength={8000} onChange={e => setText(e.target.value)} />
    <button disabled={busy || !text.trim()} onClick={send}>{busy ? "Running…" : "Ask"}</button>
    <div aria-live="polite" style={{whiteSpace:"pre-wrap"}}>{answer}</div>
  </section>;
}
