// The PTY wrapper: spawn Claude in a terminal that is `bandRows` shorter than
// the real one, and hand its output to the caller split on synchronized-update
// frame boundaries so the band can redraw without smearing mid-repaint.
//
// Two pieces:
//   • FrameSplitter — pure stream cutter on the `?2026l` marker (unit-tested).
//   • startPty()    — spawns node-pty, wires FrameSplitter + an idle flush, and
//                     exposes { onFrame, onExit, write, resize, kill }.
//
// node-pty is a native module and is imported lazily inside startPty, so this
// file (and FrameSplitter's tests) load fine even where node-pty isn't built.

/** Synchronized-update END marker. Claude ends every repaint frame with this. */
export const SU_END = '\x1b[?2026l';
/** Synchronized-update BEGIN marker (exported for reference / future use). */
export const SU_BEGIN = '\x1b[?2026h';

/**
 * Cuts a byte stream into frames on the `?2026l` boundary. Feed chunks with
 * push(); it returns every complete frame (each ending in the marker) and holds
 * the trailing partial frame until more arrives or you flush(). Handles a marker
 * that straddles a chunk boundary because it buffers before searching.
 */
export class FrameSplitter {
  #buf = '';

  /**
   * @param {string} chunk decoded terminal output
   * @returns {string[]} complete frames this chunk finished (possibly empty)
   */
  push(chunk) {
    this.#buf += chunk;
    const frames = [];
    let idx;
    while ((idx = this.#buf.indexOf(SU_END)) !== -1) {
      const end = idx + SU_END.length;
      frames.push(this.#buf.slice(0, end));
      this.#buf = this.#buf.slice(end);
    }
    return frames;
  }

  /** Return + clear whatever partial frame is buffered (null if empty). */
  flush() {
    if (this.#buf === '') return null;
    const rem = this.#buf;
    this.#buf = '';
    return rem;
  }

  /** Bytes currently buffered without a terminating marker. */
  get pending() {
    return this.#buf.length;
  }
}

/**
 * Spawn a command in a shortened PTY and stream its output as frames.
 *
 * @param {object} opts
 * @param {string} opts.cmd            binary to spawn (e.g. 'claude')
 * @param {string[]} [opts.args]       arguments
 * @param {number} [opts.bandRows=2]   rows reserved at the bottom for the band
 * @param {number} [opts.cols]         real terminal columns (default stdout)
 * @param {number} [opts.rows]         real terminal rows (default stdout)
 * @param {object} [opts.env]          extra env merged over process.env
 * @param {string} [opts.cwd]          working directory
 * @param {number} [opts.flushMs=8]    idle delay before flushing a markerless tail
 * @returns {Promise<{onFrame,onExit,write,resize,kill,cols,childRows}>}
 */
export async function startPty({
  cmd,
  args = [],
  bandRows = 2,
  cols,
  rows,
  env,
  cwd,
  flushMs = 8,
} = {}) {
  const mod = await import('node-pty');
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== 'function') {
    throw new Error('node-pty did not export spawn(); is it installed and built?');
  }

  const realCols = cols ?? process.stdout.columns ?? 80;
  const realRows = rows ?? process.stdout.rows ?? 24;
  const childRows = Math.max(1, realRows - bandRows);

  const term = spawn(cmd, args, {
    name: 'xterm-256color',
    cols: realCols,
    rows: childRows,
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
  });

  const splitter = new FrameSplitter();
  const frameCbs = new Set();
  const exitCbs = new Set();
  let flushTimer = null;

  const emit = (chunk) => {
    if (chunk) for (const cb of frameCbs) cb(chunk);
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      emit(splitter.flush());
    }, flushMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  term.onData((d) => {
    for (const frame of splitter.push(typeof d === 'string' ? d : d.toString('utf8'))) {
      emit(frame);
    }
    scheduleFlush();
  });

  term.onExit((e) => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    emit(splitter.flush()); // deliver any tail before we report exit
    for (const cb of exitCbs) cb(e);
  });

  return {
    /** Register a frame callback. Returns an unsubscribe fn. */
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    /** Register an exit callback ({exitCode, signal}). Returns an unsubscribe fn. */
    onExit(cb) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    /** Send input (keystrokes) to the child. */
    write(data) {
      term.write(typeof data === 'string' ? data : data.toString('utf8'));
    },
    /** Resize the child PTY to (newCols, newRows - bandRows). Defaults to stdout size. */
    resize(newCols, newRows) {
      const c = newCols ?? process.stdout.columns ?? realCols;
      const r = (newRows ?? process.stdout.rows ?? realRows) - bandRows;
      term.resize(Math.max(1, c), Math.max(1, r));
    },
    /**
     * Resize the child PTY to an EXACT size (cols × childRows), no band arithmetic.
     * The band's height is dynamic (it grows/shrinks with content), so the caller
     * computes Claude's region directly — rows minus the current band height — and
     * sets it here (dogfood finding: the child must shrink/grow so the band never
     * overlaps Claude's output). Undefined dimensions keep the current one.
     */
    resizeChild(newCols, childRows) {
      term.resize(Math.max(1, newCols ?? term.cols), Math.max(1, childRows ?? term.rows));
    },
    /** Kill the child. */
    kill(signal) {
      term.kill(signal);
    },
    get cols() {
      return term.cols;
    },
    get childRows() {
      return term.rows;
    },
  };
}
