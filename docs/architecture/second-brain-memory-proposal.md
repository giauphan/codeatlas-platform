# Architecture: CodeAtlas Second Brain → Primary Memory, SQLite → Cache

## Current state

```
Hermes Turn
  ↓
MemoryManager injects state.db (MEMORY/USER entries)  ← PRIMARY
  ↓
CodeAtlas plugin injects dreams (pre_llm_call)  ← SUPPLEMENT (weak)
  ↓
LLM → Response
  ↓
CodeAtlas plugin saves dreams (post_llm_call)  ← local-only
```

## Target state

```
Hermes Turn
  ↓
MemoryManager → CodeAtlas MemoryProvider  ← PRIMARY (Dreams/Genome/Immune from Oracle)
  ↓
state.db → Local cache only (read-through, write-through)
  ↓
LLM → Response
  ↓
Save to CodeAtlas Oracle ← source of truth
  ↓
Update state.db cache asynchronously
```

## Changes needed

### 1. Plugin: Override memory injection
- In `__init__.py`, register a `pre_context_assembly` hook
- Query CodeAtlas Dreams/Genome/Immune FIRST
- Inject CodeAtlas results as PRIMARY context
- Cache results in `~/.hermes/second_brain/` JSON files (read-through)
- Demote state.db entries to secondary/cache

### 2. Plugin: Write-through saves
- `post_llm_call` saves to CodeAtlas API FIRST
- Then updates local cache
- Never save to state.db (only via MemoryProvider)

### 3. Plugin: Offline mode
- When CodeAtlas unavailable, use cached JSON (not state.db)
- State.db remains as working memory (conversation history, tool state)
- But knowledge memory → CodeAtlas only

## File changes
- `~/.hermes/plugins/codeatlas_second_brain/__init__.py` — add pre_context_assembly hook, prioritize cloud queries, write-through pattern
- NO changes to Hermes core (fully plugin-driven)
