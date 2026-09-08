/**
 * Incremental parser for text/event-stream bodies. Feed it decoded chunks as
 * they arrive; it returns the events completed by each chunk. Follows the
 * WHATWG rules that matter here: `event:` names the event, `data:` lines
 * accumulate joined by newlines, a blank line dispatches, lines starting
 * with `:` are comments, and `\r\n`, `\n` and `\r` all end a line.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Dispatch whatever is pending once the body has ended. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    // What is left is at most one partial line; a trailing `\r` that was
    // held back in case `\n` followed is a line ending after all.
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    if (rest) {
      const event = this.line(rest);
      if (event) events.push(event);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    // `id` and `retry` carry nothing for a one-shot completion.
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.data.length === 0) {
      this.event = '';
      return undefined;
    }
    const event = { event: this.event, data: this.data.join('\n') };
    this.event = '';
    this.data = [];
    return event;
  }
}
