import { describe, expect, it } from 'vitest'
import { extractProject, extractProjectFromCwd } from '../../src/api/project-extraction.js'

describe('extractProject', () => {
  it('keeps existing claude project decoding behavior', () => {
    expect(
      extractProject('/Users/alice/.claude/projects/-Users-alice-WebstormProjects-myapp/session.jsonl')
    ).toBe('myapp')
  })

  it('falls back to a readable parent directory for generic local paths', () => {
    expect(
      extractProject('/Users/alice/worktrees/myapp/sessions/abc123.jsonl')
    ).toBe('myapp')
  })

  it('skips generic trailing directories such as logs and data', () => {
    expect(
      extractProject('/Users/alice/projects/myapp/data/logs/run.jsonl')
    ).toBe('myapp')
  })

  it('extracts qoder project names from session segment paths', () => {
    expect(
      extractProject('/Users/example/.qoder/logs/sessions/-Users-example-code-myproject/session-1/segments/2026-05-24T02-03-23.jsonl')
    ).toBe('code/myproject')
  })

  it('extracts codebuddy project names from encoded project paths', () => {
    expect(
      extractProject('/Users/example/.codebuddy/projects/-Users-example-WebstormProjects-myapp/session-1.jsonl')
    ).toBe('myapp')
  })

  it('extracts kimi project names from session paths', () => {
    expect(
      extractProject('/Users/example/.kimi-code/sessions/-Users-example-code-myapp/session-1/agents/main/wire.jsonl')
    ).toBe('code/myapp')
  })

  it('extracts task ids from VS Code task storage paths', () => {
    expect(
      extractProject('/Users/example/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/task-123/ui_messages.json')
    ).toBe('task/task-123')
  })

  it('joins multi-level claude project paths with / not -', () => {
    expect(
      extractProject('/Users/alice/.claude/projects/-Users-alice-WebstormProjects-myorg-myproject/session.jsonl')
    ).toBe('myorg/myproject')
  })

  it('returns unknown when every directory is generic or machine-like', () => {
    expect(
      extractProject('/tmp/data/logs/2026/05/16/123e4567-e89b-12d3-a456-426614174000.jsonl')
    ).toBe('unknown')
  })

  it('returns unknown for empty sourceFile', () => {
    expect(extractProject('')).toBe('unknown')
  })

  it('extracts openclaw agent name as project', () => {
    expect(
      extractProject('/Users/alice/.openclaw/agents/main/sessions/abc123.jsonl')
    ).toBe('openclaw/main')
  })

  it('extracts openclaw custom agent name', () => {
    expect(
      extractProject('/Users/alice/.openclaw/agents/my-agent/sessions/abc123.jsonl')
    ).toBe('openclaw/my-agent')
  })

  it('extracts hermes project from session title in sourceFile', () => {
    expect(
      extractProject('/Users/alice/.hermes/state.db:session:20260522_081752:Greeting and Assistance Offer')
    ).toBe('Greeting and Assistance Offer')
  })

  it('returns hermes for hermes sessions without title', () => {
    expect(
      extractProject('/Users/alice/.hermes/state.db:session:20260522_081752')
    ).toBe('hermes')
  })

  it('falls back for codex paths without cwd', () => {
    // Codex paths have no project info — project comes from cwd field
    const result = extractProject('/Users/alice/.codex/sessions/2026/05/22/rollout-abc123.jsonl')
    expect(result).not.toBe('unknown') // should extract something from generic path
  })
})

describe('extractProjectFromCwd', () => {
  it('strips WebstormProjects workspace root', () => {
    expect(extractProjectFromCwd('/Users/alice/WebstormProjects/myapp')).toBe('myapp')
  })

  it('returns project root even when cwd is a subdirectory', () => {
    expect(extractProjectFromCwd('/Users/alice/WebstormProjects/myapp/packages/cli')).toBe('myapp')
  })

  it('strips Documents workspace root', () => {
    expect(extractProjectFromCwd('/Users/alice/Documents/org-name/course/homework')).toBe('org-name')
  })

  it('handles path without a workspace root', () => {
    expect(extractProjectFromCwd('/Users/alice/Typora/notes')).toBe('Typora')
  })

  it('returns unknown for empty cwd', () => {
    expect(extractProjectFromCwd('')).toBe('unknown')
  })

  it('handles Windows-style paths', () => {
    expect(extractProjectFromCwd('C:/Users/alice/WebstormProjects/myproject')).toBe('myproject')
  })
})

describe('extractProjectFromCwd — configured workspace roots', () => {
  it('keeps the built-in behaviour when nothing is configured', () => {
    // Desktop is not a default root, so a project directly under it groups
    // as "Desktop" — correct for someone with a single project there.
    expect(extractProjectFromCwd('C:/Users/x/Desktop/aiusage')).toBe('Desktop')
  })

  it('adds configured roots without replacing the defaults', () => {
    expect(extractProjectFromCwd('C:/Users/x/Desktop/aiusage', ['Desktop'])).toBe('aiusage')
    // The built-ins still apply alongside it.
    expect(extractProjectFromCwd('/Users/a/WebstormProjects/my-project', ['Desktop'])).toBe('my-project')
  })

  it('ignores an empty configuration', () => {
    expect(extractProjectFromCwd('C:/Users/x/Desktop/aiusage', [])).toBe('Desktop')
  })
})

describe('extractProjectFromCwd — Windows drive letters', () => {
  // The home-directory strip only fires for paths under Users/home, so a
  // project anywhere else kept its drive letter as the first segment and was
  // reported as the project "C:".
  it('never reports a drive letter as the project', () => {
    expect(extractProjectFromCwd('C:\\work\\myproj')).toBe('work')
    expect(extractProjectFromCwd('D:\\myproj')).toBe('myproj')
    expect(extractProjectFromCwd('C:/work/myproj')).toBe('work')
  })

  it('skips the drive and then applies the workspace roots as usual', () => {
    expect(extractProjectFromCwd('D:\\src\\myproj')).toBe('myproj')
    expect(extractProjectFromCwd('D:\\src\\myproj\\packages\\cli')).toBe('myproj')
    expect(extractProjectFromCwd('E:\\Projects\\thing', ['Projects'])).toBe('thing')
  })

  it('has nothing to report for a bare drive root', () => {
    expect(extractProjectFromCwd('C:\\')).toBe('unknown')
    expect(extractProjectFromCwd('C:')).toBe('unknown')
  })

  it('leaves home-relative paths exactly as they were', () => {
    expect(extractProjectFromCwd('C:\\Users\\me\\src\\myproj')).toBe('myproj')
    expect(extractProjectFromCwd('C:\\Users\\me\\Desktop\\myproj')).toBe('Desktop')
    expect(extractProjectFromCwd('C:\\Users\\me\\Desktop\\myproj', ['Desktop'])).toBe('myproj')
    expect(extractProjectFromCwd('/Users/alice/WebstormProjects/my-project')).toBe('my-project')
  })

  it('does not mistake a directory that merely starts with a letter and colon', () => {
    // Only an exact single-letter drive spec is skipped.
    expect(extractProjectFromCwd('/CD:notes/app')).toBe('CD:notes')
    expect(extractProjectFromCwd('/C:extra/app')).toBe('C:extra')
  })
})

describe('extractProjectFromCwd — the home directory itself', () => {
  // The home directory is not a project any more than a drive letter is.
  // The strip used to require a trailing separator, so a cwd of exactly
  // C:\Users\alice matched nothing and came back as the project "Users" —
  // and one such row existed in production.
  it('has nothing to report for the home directory', () => {
    expect(extractProjectFromCwd('C:\\Users\\alice')).toBe('unknown')
    expect(extractProjectFromCwd('C:\\Users\\alice\\')).toBe('unknown')
    expect(extractProjectFromCwd('C:/Users/alice')).toBe('unknown')
    expect(extractProjectFromCwd('/Users/alice')).toBe('unknown')
    expect(extractProjectFromCwd('/Users/alice/')).toBe('unknown')
    expect(extractProjectFromCwd('/home/alice')).toBe('unknown')
    expect(extractProjectFromCwd('/root')).toBe('unknown')
    expect(extractProjectFromCwd('/root/')).toBe('unknown')
    expect(extractProjectFromCwd('C:\\Users\\Gakujun Yamaba')).toBe('unknown')
  })

  it('still strips the home prefix from everything under it', () => {
    expect(extractProjectFromCwd('C:\\Users\\alice\\Desktop\\proj')).toBe('Desktop')
    expect(extractProjectFromCwd('C:\\Users\\alice\\Desktop\\proj', ['Desktop'])).toBe('proj')
    expect(extractProjectFromCwd('C:\\Users\\alice\\src\\proj')).toBe('proj')
    expect(extractProjectFromCwd('/Users/alice/WebstormProjects/my-project')).toBe('my-project')
    expect(extractProjectFromCwd('/home/alice/code/thing')).toBe('thing')
    expect(extractProjectFromCwd('/root/work/thing')).toBe('work')
  })

  it('does not strip a directory that merely starts with the home name', () => {
    // /Users/alicia must not be read as /Users/alice + "ia".
    expect(extractProjectFromCwd('/Usersomething/proj')).toBe('Usersomething')
    expect(extractProjectFromCwd('/rootkit/proj')).toBe('rootkit')
  })
})
