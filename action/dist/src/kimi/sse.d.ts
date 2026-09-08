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
export declare class SseParser {
    private buffer;
    private event;
    private data;
    feed(chunk: string): SseEvent[];
    /** Dispatch whatever is pending once the body has ended. */
    flush(): SseEvent[];
    private line;
    private dispatch;
}
//# sourceMappingURL=sse.d.ts.map