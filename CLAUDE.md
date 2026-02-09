# reactiveSWR

A lightweight library that brings Meteor-style reactivity to modern React applications using SWR and Server-Sent Events (SSE).

## Project Structure

```
src/              # Source code
  index.ts        # Main exports
  SSEProvider.tsx # Provider component
  hooks/          # React hooks
  types.ts        # TypeScript types
docs/             # Documentation
  SPEC.md         # Technical specification
prd/              # Product requirement documents
```

## Development

```bash
bun install       # Install dependencies
bun run dev       # Start development
bun test          # Run unit tests
bun run lint      # Run linter
bun run test:e2e  # Run E2E tests
```

## A(i)-Team Integration

This project uses the A(i)-Team plugin for PRD-driven development.

### When to Use A(i)-Team

Use the A(i)-Team workflow when:
- Implementing features from a PRD document
- Working on multi-file changes that benefit from TDD
- Building features that need structured test -> implement -> review flow

### Commands

- `/ateam plan <prd-file>` - Decompose a PRD into tracked work items
- `/ateam run` - Execute the mission with parallel agents
- `/ateam status` - Check current progress
- `/ateam resume` - Resume an interrupted mission

### Workflow

1. Place your PRD in the `prd/` directory
2. Run `/ateam plan prd/your-feature.md`
3. Run `/ateam run` to execute

The A(i)-Team will:
- Break down the PRD into testable units
- Write tests first (TDD)
- Implement to pass tests
- Review each feature
- Probe for bugs
- Update documentation and commit

**Do NOT** work on PRD features directly without using `/ateam plan` first.
