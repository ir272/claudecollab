// Pull Claude's latest response text out of its session transcript.
//
// Claude Code writes a JSONL transcript (one message object per line) and hands
// every hook the path to it (`transcript_path`). We never scrape the repainting
// TUI for the response — we read the transcript at the Stop edge and take the
// assistant text produced since the last HUMAN prompt. That's the clean turn.
//
// The format has drifted across Claude versions, so every accessor is defensive:
// content may be a plain string or an array of typed blocks; a "user" line may be
// a real human prompt OR a tool_result being fed back to the model (which must NOT
// count as a turn boundary). Anything unparseable is skipped.

/** The text of an assistant message, or null if `obj` isn't one. */
function assistantText(obj) {
  if (!obj || obj.type !== 'assistant') return null;
  const content = obj.message?.content ?? obj.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return text || null;
  }
  return null;
}

/** True only for a real human prompt (not a tool_result fed back as a user turn). */
function isHumanPrompt(obj) {
  if (!obj || obj.type !== 'user') return false;
  const content = obj.message?.content ?? obj.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return false;
    return content.some((b) => b && b.type === 'text' && typeof b.text === 'string');
  }
  return false;
}

/**
 * Extract the assistant text produced after the last human prompt in a transcript.
 * @param {string} jsonl  the raw JSONL transcript contents (a tail is fine — a
 *                        truncated leading line is skipped)
 * @returns {string} the response text (may be ''); never throws
 */
export function extractLatestResponse(jsonl) {
  const objs = [];
  for (const line of String(jsonl ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      objs.push(JSON.parse(t));
    } catch {
      /* a partial/broken line (common when reading a tail) — skip it */
    }
  }
  let lastPrompt = -1;
  for (let i = 0; i < objs.length; i++) if (isHumanPrompt(objs[i])) lastPrompt = i;
  const parts = [];
  for (let i = lastPrompt + 1; i < objs.length; i++) {
    const txt = assistantText(objs[i]);
    if (txt) parts.push(txt);
  }
  return parts.join('\n\n').trim();
}
