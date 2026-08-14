export const existingClaudeSettings = {
  defaultMode: "acceptEdits",
  enabledPlugins: {
    "superpowers@claude-plugins-official": true,
  },
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          {
            type: "command",
            command: "echo existing-session-hook",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: "echo existing-stop-hook",
          },
        ],
      },
    ],
  },
};

export const existingCodexHooks = {
  description: "Existing personal hooks",
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: "python3 ~/.codex/hooks/git_guard.py",
            timeout: 5,
          },
        ],
      },
    ],
  },
};
