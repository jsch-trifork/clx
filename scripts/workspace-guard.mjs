// PreToolUse hook for workspace sessions: refuses subagents that would run in the
// cloud, where the sandbox and deny rules don't apply and your GitHub connection
// can reach every repo. Exit code 2 blocks the call, in every permission mode.
let input = "";
for await (const chunk of process.stdin) input += chunk;
let call = {};
try {
  call = JSON.parse(input);
} catch {}
if (call.tool_input?.isolation === "remote") {
  console.error(
    "clx workspace: remote (cloud) agents are blocked in workspace sessions. Run the agent locally instead.",
  );
  process.exit(2);
}
