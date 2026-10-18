# Mem0 (OSS) and Zep's Graphiti (the open-source engine behind Zep) behind one local HTTP API, for the benchmark.
#
#   bench/providers/.venv/bin/python bench/providers/server.py      # 127.0.0.1:8795 (SIDECAR_PORT)
#
# Both run the way their docs show, on the same model as Continuity (Claude Haiku 5.5, thinking off) and local
# embeddings (fastembed BAAI/bge-small-en-v1.5; Graphiti's reranker is ms-marco-MiniLM-L-6-v2, also local). Every
# Anthropic call is adapted for Haiku 5.5 (it rejects temperature/top_p/top_k) and its usage is counted against the
# namespace of the request that caused it, so the bench can bill each case exactly.
#
#   POST /{mem0|graphiti}/add     {ns, content, timestamp, name}
#   POST /{mem0|graphiti}/search  {ns, query, limit}  -> {results: [{text, ...}]}
#   GET  /usage/{ns}              -> {calls, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}
import asyncio
import concurrent.futures
import contextvars
import math
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path

os.environ.setdefault('EMBEDDING_DIM', '384')  # read by graphiti at import time
os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')
os.environ.setdefault('MEM0_TELEMETRY', 'False')

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
DATA.mkdir(exist_ok=True)


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(HERE.parents[1] / '.env')
KEY = os.environ.get('ANTHROPIC_API_KEY')
if not KEY:
    sys.exit('ANTHROPIC_API_KEY is not set')
MODEL = os.environ.get('PROVIDER_MODEL', 'claude-haiku-5-5')
WORKSPACE = os.environ.get('ANTHROPIC_WORKSPACE_ID')
EMBED_MODEL = 'BAAI/bge-small-en-v1.5'
RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
# What each layer is told to keep, where it has a knob for it: the same sentence for all three providers.
MISSION = os.environ.get('PROVIDER_MISSION', 'An AI agent works an email-based business deal for its company. Keep what it needs to act: the terms each party has stated (prices, quantities, dates, conditions) and which later messages changed or withdrew them, requests and promises still open and who owes them, documents sent and whether they are current, deadlines, and requirements the deal must meet.')

# ------------------------------------------------------------------ model calls: adapt for Haiku 5.5 and meter per namespace

import anthropic  # noqa: E402
from anthropic.resources.messages import AsyncMessages, Messages  # noqa: E402

NS: contextvars.ContextVar[str] = contextvars.ContextVar('ns', default='untagged')
USAGE: dict[str, dict[str, int]] = {}
FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')


def adapt(kw: dict) -> dict:
    kw = dict(kw)
    kw['model'] = MODEL
    for k in ('temperature', 'top_p', 'top_k'):
        kw.pop(k, None)
    kw['thinking'] = {'type': 'disabled'}
    if WORKSPACE:
        kw['extra_headers'] = {**(kw.get('extra_headers') or {}), 'anthropic-workspace-id': WORKSPACE}
    return kw


def record(resp) -> None:
    u = getattr(resp, 'usage', None)
    t = USAGE.setdefault(NS.get(), {'calls': 0, **{f: 0 for f in FIELDS}})
    t['calls'] += 1
    for f in FIELDS:
        t[f] += int(getattr(u, f, 0) or 0)


RETRYABLE = (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError)
_sync_create = Messages.create
_async_create = AsyncMessages.create


def create_sync(self, *a, **kw):
    kw = adapt(kw)
    for attempt in range(8):
        try:
            r = _sync_create(self, *a, **kw)
            record(r)
            return r
        except RETRYABLE:
            if attempt == 7:
                raise
            time.sleep(min(60, 2 ** attempt + random.random()))


async def create_async(self, *a, **kw):
    kw = adapt(kw)
    for attempt in range(8):
        try:
            r = await _async_create(self, *a, **kw)
            record(r)
            return r
        except RETRYABLE:
            if attempt == 7:
                raise
            await asyncio.sleep(min(60, 2 ** attempt + random.random()))


Messages.create = create_sync
AsyncMessages.create = create_async

# Mem0 fans work out to thread pools; carry the request's namespace into them.
_submit = concurrent.futures.ThreadPoolExecutor.submit


def submit_in_context(self, fn, /, *args, **kwargs):
    return _submit(self, contextvars.copy_context().run, fn, *args, **kwargs)


concurrent.futures.ThreadPoolExecutor.submit = submit_in_context

# ------------------------------------------------------------------ local embeddings and reranker

from fastembed import TextEmbedding  # noqa: E402
from fastembed.rerank.cross_encoder import TextCrossEncoder  # noqa: E402

EMBED = TextEmbedding(EMBED_MODEL)
RERANK = TextCrossEncoder(RERANK_MODEL)

# ------------------------------------------------------------------ Mem0

from mem0 import AsyncMemory  # noqa: E402

MEM0_CONFIG = {
    'llm': {'provider': 'anthropic', 'config': {'model': MODEL, 'api_key': KEY, 'max_tokens': 4000}},
    'embedder': {'provider': 'fastembed', 'config': {'model': EMBED_MODEL, 'embedding_dims': 384}},
    # a Qdrant server (bench/providers/up.sh), not Qdrant's local mode: local mode is not thread-safe, and parallel cases
    # corrupted its index (seen 2026-10-18); a lock around it made Mem0 serial
    'vector_store': {'provider': 'qdrant', 'config': {'collection_name': 'bench', 'host': '127.0.0.1', 'port': 6333, 'embedding_model_dims': 384}},
    'history_db_path': str(DATA / 'mem0-history.db'),
    'custom_instructions': MISSION,
}

# ------------------------------------------------------------------ Graphiti

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.cross_encoder.client import CrossEncoderClient  # noqa: E402
from graphiti_core.driver.falkordb_driver import FalkorDriver  # noqa: E402
from graphiti_core.embedder.client import EmbedderClient  # noqa: E402
from graphiti_core.llm_client.anthropic_client import AnthropicClient  # noqa: E402
from graphiti_core.llm_client.config import LLMConfig  # noqa: E402
from graphiti_core.nodes import EpisodeType, EpisodicNode  # noqa: E402
from graphiti_core.search.search_config_recipes import COMBINED_HYBRID_SEARCH_CROSS_ENCODER  # noqa: E402


def _embed(texts: list[str]) -> list[list[float]]:
    return [v.tolist() for v in EMBED.embed(texts)]


class FastEmbedder(EmbedderClient):
    async def create(self, input_data):
        text = input_data if isinstance(input_data, str) else (input_data[0] if isinstance(input_data, list) and input_data and isinstance(input_data[0], str) else str(input_data))
        return (await asyncio.to_thread(_embed, [text]))[0]

    async def create_batch(self, input_data_list: list[str]):
        return await asyncio.to_thread(_embed, list(input_data_list)) if input_data_list else []


class FastCrossEncoder(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        if not passages:
            return []
        logits = await asyncio.to_thread(lambda: list(RERANK.rerank(query, passages)))
        # graphiti expects relevance in [0, 1] (it filters on a minimum score)
        scored = [(p, 1 / (1 + math.exp(-float(s)))) for p, s in zip(passages, logits)]
        return sorted(scored, key=lambda x: -x[1])


# ------------------------------------------------------------------ HTTP

from fastapi import FastAPI  # noqa: E402
from pydantic import BaseModel  # noqa: E402

app = FastAPI()
STATE: dict = {}
GROUP_LOCKS: dict[str, asyncio.Lock] = {}
READY_GROUPS: set[str] = set()


class AddReq(BaseModel):
    ns: str
    content: str
    timestamp: str
    name: str = 'email'


class SearchReq(BaseModel):
    ns: str
    query: str
    limit: int = 20


@app.on_event('startup')
async def startup() -> None:
    STATE['mem0'] = AsyncMemory.from_config(MEM0_CONFIG)
    llm = AnthropicClient(config=LLMConfig(api_key=KEY, model=MODEL, small_model=MODEL, max_tokens=8192))
    STATE['graphiti'] = Graphiti(graph_driver=FalkorDriver(host='localhost', port=6379), llm_client=llm, embedder=FastEmbedder(), cross_encoder=FastCrossEncoder())
    await STATE['graphiti'].build_indices_and_constraints()


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


@app.post('/mem0/add')
async def mem0_add(r: AddReq):
    NS.set(r.ns)
    started = time.time()
    out = await STATE['mem0'].add([{'role': 'user', 'content': r.content}], user_id=r.ns, metadata={'date': r.timestamp, 'source': r.name})
    return {'ms': int((time.time() - started) * 1000), 'events': len(out.get('results', [])) if isinstance(out, dict) else None}


@app.post('/mem0/search')
async def mem0_search(r: SearchReq):
    NS.set(r.ns)
    out = await STATE['mem0'].search(r.query, top_k=r.limit, filters={'user_id': r.ns})
    rows = out.get('results', []) if isinstance(out, dict) else out
    return {'results': [{'text': x.get('memory'), 'score': x.get('score'), 'metadata': x.get('metadata')} for x in rows]}


async def graphiti_group(ns: str):
    g: Graphiti = STATE['graphiti']
    driver = g.driver.clone(database=ns)
    if ns not in READY_GROUPS:
        await driver.build_indices_and_constraints()
        READY_GROUPS.add(ns)
    return g, driver


@app.post('/graphiti/add')
async def graphiti_add(r: AddReq):
    NS.set(r.ns)
    started = time.time()
    # episodes of one group are added one at a time, in order (Graphiti's guidance); groups run in parallel
    async with GROUP_LOCKS.setdefault(r.ns, asyncio.Lock()):
        g, _ = await graphiti_group(r.ns)
        res = await g.add_episode(name=r.name, episode_body=r.content, source_description='email', reference_time=ts(r.timestamp), source=EpisodeType.message, group_id=r.ns, custom_extraction_instructions=MISSION)
    return {'ms': int((time.time() - started) * 1000), 'nodes': len(res.nodes), 'edges': len(res.edges)}


@app.post('/graphiti/search')
async def graphiti_search(r: SearchReq):
    NS.set(r.ns)
    g, driver = await graphiti_group(r.ns)
    cfg = COMBINED_HYBRID_SEARCH_CROSS_ENCODER.model_copy(deep=True)
    cfg.limit = r.limit
    res = await g.search_(r.query, config=cfg, group_ids=[r.ns], driver=driver)
    iso = lambda d: d.isoformat() if d else None  # noqa: E731
    # the episodes a fact came from, by the names we gave them (the source message ids)
    uuids = sorted({u for e in res.edges for u in (e.episodes or [])})
    names = {ep.uuid: ep.name for ep in (await EpisodicNode.get_by_uuids(driver, uuids) if uuids else [])}
    return {
        'facts': [{'text': e.fact, 'valid_at': iso(e.valid_at), 'invalid_at': iso(e.invalid_at), 'expired_at': iso(e.expired_at), 'sources': [names[u] for u in (e.episodes or []) if u in names]} for e in res.edges],
        'entities': [{'name': n.name, 'summary': n.summary} for n in res.nodes],
    }


@app.get('/usage/{ns}')
async def usage(ns: str):
    return USAGE.get(ns, {'calls': 0, **{f: 0 for f in FIELDS}})


if __name__ == '__main__':
    import uvicorn

    # loopback only: it holds the real API key
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('SIDECAR_PORT', 8795)), log_level='warning')
