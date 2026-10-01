'use strict';

/**
 * Frame log for the Jura client: one text line per frame that matters, in
 * the decoded ASCII form the client works with -- never the raw or the
 * encoded wire bytes (the obfuscation in crypto.js is reversible, so those
 * would give a PIN or a hash away just the same).
 *
 * Every line goes through redactFrame before it reaches the sink, so a
 * handshake (PIN, connection id, auth hash) never ends up in a log, and the
 * bug template asks users to paste these logs into a public issue.
 */

const REDACTED = '<redacted>';

// A bare, two-letter marker frame (@TB, @TS, ...), same shape as
// MARKER_FRAME_RE in juraClient.js.
const MARKER_RE = /^@[A-Z]{2}$/;

// The status-like replies the machine repeats over and over: only logged
// when they differ from the previous one of the same kind.
const DEDUPED_RE = /^@(?:tf|tv|hu|tg|tr):/i;

// The one kind for which the (idle) flag is part of the comparison: whether
// the answer to @HU? came in time or too late is exactly what the log has to
// show. For the other kinds it would only make the lines flip between idle
// and not idle, on firmware that does not answer @HU? (polls then last until
// the next broadcast).
const IDLE_COMPARED_KIND = '@hu:';

// A brew command: it restarts the dedupe, see FrameLog.
const BREW_COMMAND_RE = /^@TP:/i;

// The keep-alive: sent every poll, so left out of the log altogether.
const KEEP_ALIVE = '@HU?';

// What a TX of the empty closing frame is shown as.
const EMPTY_FRAME = '<empty>';

/**
 * Make one line of text safe to log. Case-insensitive and everywhere in the
 * text, so also in the middle of an error message that quotes a frame:
 *  - control characters (below 0x20, and 0x7f) become `\xNN`, so a frame
 *    cannot fake a log line of its own. This runs FIRST: the `\xNN` it
 *    writes ends in hex characters that can join up with hex characters
 *    next to them, and the rules below must see that text as it will be
 *    logged, or a second pass would still find something to redact;
 *  - `@HP:` and everything after it (the handshake: PIN, connection id and
 *    auth hash) becomes `@HP:<redacted>`;
 *  - `@hp<x>` followed by anything becomes `@hp<x>:<redacted>` (or without
 *    the colon), with two exceptions that stay literal because they carry
 *    nothing secret: a bare `@hp4` / `@hp5` (a trailing `:` too), and `@hp5:`
 *    followed by exactly two hex characters (`@hp5:01`);
 *  - every run of 64 or more hex characters becomes `<redacted>`, as a net
 *    for a hash outside a frame.
 * The redaction runs to the end of the text on purpose: a payload is never
 * assumed to stop where it looks like it does. Only a single closing `"` is
 * left in place, so a frame quoted by JSON.stringify() stays readable.
 * Applying it twice gives the same result as applying it once.
 * @param {string} text
 * @returns {string}
 */
function redactFrame(text) {
  let out = text === undefined || text === null ? '' : String(text);
  out = out.replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  out = out.replace(/@HP:[\s\S]*?("?)$/i, (m, quote) => `@HP:${REDACTED}${quote}`);
  out = out.replace(/@hp([^:])([\s\S]*?)("?)$/i, (m, variant, rest, quote) => {
    const harmless =
      rest === '' || rest === ':' || (variant === '5' && /^:[0-9a-f]{2}$/i.test(rest));
    if (harmless) return m;
    const sep = rest[0] === ':' || rest[0] === ' ' ? rest[0] : '';
    return `@hp${variant}${sep}${REDACTED}${quote}`;
  });
  out = out.replace(/[0-9a-f]{64,}/gi, REDACTED);
  return out;
}

/** `HH:MM:SS.mmm`, local time. */
function timestamp(d = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Turns the frames a JuraClient sends and receives into log lines:
 *
 *   HH:MM:SS.mmm TX|RX <redacted text> [(+n same)] [(idle)]
 *
 * TX: every command except the keep-alive `@HU?`; the empty closing frame
 * shows as `<empty>`.
 *
 * RX: `@TF:`, `@TV:`, `@hu:`, `@tg:` and `@tr:` only when they differ from
 * the previous one of the same kind. For `@hu:` the `(idle)` flag is part of
 * that comparison: an `@hu:800` that came in time and an identical one that
 * came in with no operation running (a late answer) are not the same
 * frame, and both are logged. For the other kinds only the text counts, so
 * an unchanged `@TF:` is one line whether it arrived during an operation or
 * between two. Markers and every other reply are always logged.
 *
 * `(+n same)` is the number of frames that were left out because they were
 * identical to the previous line of that kind. It is written on the next
 * line for that kind:
 *  - when the frame changes, on the line with the new text. The n repeats
 *    were of the text on the line above, not of the text on this line;
 *  - at a reset, on a line that repeats the last text itself (`RX <last
 *    text> (+n same)`), so the count is not lost. A reset is a marker, or a
 *    TX of `@TP:`: it comes first, and everything logged after it starts
 *    over, so the first @TF: or @hu: during and after a brew always shows
 *    up. That line carries the time of the reset, not of the repeats, and
 *    the `(idle)` flag of the last line logged for that kind.
 *
 * `(idle)` is added when no operation was running at that moment.
 *
 * A sink that throws is swallowed, and so is a promise it returns that
 * rejects: logging must never break an operation.
 */
class FrameLog {
  /** @param {(line: string) => void} sink */
  constructor(sink) {
    this._sink = typeof sink === 'function' ? sink : null;
    // kind (e.g. '@tf:') -> { text, idle, same }: the last one logged, its
    // (idle) flag, and how many identical ones were left out since. The flag
    // is only compared for IDLE_COMPARED_KIND.
    this._last = new Map();
  }

  /**
   * @param {string} cmd  the command as the client wrote it, before encoding
   * @param {{idle?: boolean}} [opts]
   */
  tx(cmd, opts) {
    try {
      const raw = cmd === undefined || cmd === null ? '' : String(cmd);
      if (raw === KEEP_ALIVE) return;
      if (BREW_COMMAND_RE.test(raw)) this._resetDedupe();
      this._emit('TX', raw === '' ? EMPTY_FRAME : raw, opts, 0);
    } catch {
      // logging must never break an operation
    }
  }

  /**
   * @param {string} reply  the frame as the client decoded it
   * @param {{idle?: boolean}} [opts]
   */
  rx(reply, opts) {
    try {
      const raw = reply === undefined || reply === null ? '' : String(reply);
      if (MARKER_RE.test(raw)) {
        this._resetDedupe();
        this._emit('RX', raw, opts, 0);
        return;
      }
      const kind = DEDUPED_RE.exec(raw);
      if (!kind) {
        this._emit('RX', raw, opts, 0);
        return;
      }
      // Compared in redacted form, so nothing but redacted text is kept.
      const text = redactFrame(raw);
      const idle = Boolean(opts && opts.idle);
      const key = kind[0].toLowerCase();
      const last = this._last.get(key);
      if (last && last.text === text && (key !== IDLE_COMPARED_KIND || last.idle === idle)) {
        last.same += 1;
        return;
      }
      this._last.set(key, { text, idle, same: 0 });
      this._emit('RX', text, opts, last ? last.same : 0);
    } catch {
      // logging must never break an operation
    }
  }

  /**
   * Restart the comparison. First writes, for every kind that has left out
   * repeats, the line that carries their count (see the class comment), so
   * nothing is lost by forgetting them.
   */
  _resetDedupe() {
    for (const last of this._last.values()) {
      if (last.same > 0) this._emit('RX', last.text, { idle: last.idle }, last.same);
    }
    this._last.clear();
  }

  /**
   * The one place a line is built and handed to the sink, and so the one
   * place that guarantees redactFrame has run over it, whatever the caller
   * did before. A sink that throws, or returns a promise that rejects,
   * loses this line only: a reset writes several in a row.
   * @param {'TX'|'RX'} dir
   * @param {string} text
   * @param {{idle?: boolean}|undefined} opts
   * @param {number} same  repeats left out before this line
   */
  _emit(dir, text, opts, same) {
    let line = `${timestamp()} ${dir} ${redactFrame(text)}`;
    if (same > 0) line += ` (+${same} same)`;
    if (opts && opts.idle) line += ' (idle)';
    if (!this._sink) return;
    try {
      const result = this._sink(line);
      if (result && typeof result.then === 'function') result.then(undefined, () => {});
    } catch {
      // a failing sink must not stop the lines after this one
    }
  }
}

module.exports = { FrameLog, redactFrame };
