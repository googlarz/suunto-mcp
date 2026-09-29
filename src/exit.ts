// process.exit() straight after a big process.stdout.write() drops whatever
// hasn't left the pipe buffer yet — on macOS `list-workouts | jq` lost
// everything past 64 KB. A write callback only fires once every chunk queued
// before it has been flushed, so exiting from an empty write's callback
// keeps all output. The error argument is ignored on purpose: a closed
// reader (`| head`) must still let the process exit.
//
// Returns a promise that never settles: unlike a bare process.exit(), the
// exit is asynchronous, so callers must `await` this to stop execution from
// falling through into whatever code follows (in index.ts, the MCP server
// startup).
export function exitAfterFlush(code = 0): Promise<never> {
  return new Promise<never>(() => {
    process.stdout.write("", () => process.exit(code));
  });
}
