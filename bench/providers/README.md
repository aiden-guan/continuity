# Third-party memory providers

Mem0, Zep and Hindsight run as bench conditions (`mem0`, `zep-graphiti`, `hindsight`), on the same cases, actor and
judge as Continuity and Primitive-native. The conditions live in `bench/conditions/memory-providers.ts`.

## How each one is plugged in

| | What runs | Ingest | Recall |
|---|---|---|---|
| Mem0 | `mem0ai` OSS 2.2.1, Qdrant server | each task email, as it arrives (`add`, inference on) | `search(goal + new message)`, top 20, ~2,000 tokens |
| Zep | Graphiti 0.31.1 (Zep's open-source engine), FalkorDB | each task email as an episode, in order | hybrid search + cross-encoder rerank, Zep's context-block format, ~2,000 tokens |
| Hindsight | `ghcr.io/vectorize-io/hindsight` (Docker) | each task email retained; waits for its background consolidation before the next | `recall(goal + new message)` at decision time, `max_tokens` 2,000 |

They all get the same treatment:

- **Model:** Claude Haiku 5.5 with thinking off, the same as Continuity's extractor.
- **Embeddings:** local, `BAAI/bge-small-en-v1.5` (Hindsight uses its own local defaults).
- **Mission:** one sentence telling each layer what to keep, wherever the layer has a setting for it:
  - Mem0: `custom_instructions`
  - Graphiti: `custom_extraction_instructions`
  - Hindsight: `retain_mission`
- **Ground-truth task membership:** they get it, which is generous, as it is for the other baselines. Continuity has to link mail to the task itself.

**Billing:** every model call a provider makes is billed to the case, including Hindsight's background consolidation:

- Mem0 and Graphiti: metered in-process, per namespace.
- Hindsight: each instance runs one case at a time and reaches the API through the proxy under its own tag.

**Caching:** memories are cached per case and trial under the bench cache. A rerun bills the cached usage but does not
re-ingest.

## Running

```bash
sh bench/providers/up.sh                                   # FalkorDB, Qdrant, 1 Hindsight instance (Docker)
node --env-file=.env bench/providers/proxy.ts              # 127.0.0.1:8787, adds the key, meters Hindsight
bench/providers/.venv/bin/python bench/providers/server.py # 127.0.0.1:8795, Mem0 + Graphiti
node --env-file=.env bench/run.ts run --name mp --split eval --variants 11,12 --conditions mem0,zep-graphiti,hindsight,continuity,primitive-native
```

To set up the venv:

```bash
python3.12 -m venv bench/providers/.venv
bench/providers/.venv/bin/pip install mem0ai graphiti-core[anthropic,falkordb] fastembed qdrant-client fastapi uvicorn
```

## Security

- The real API key stays on the host, in the proxy and the sidecar.
- Containers hold only a dummy key.
- Everything listens on loopback only.
