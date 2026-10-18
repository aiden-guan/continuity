#!/bin/sh
# Start the providers' local services for the benchmark (Docker): FalkorDB for Graphiti, Qdrant for Mem0, and N Hindsight
# instances.
# Each Hindsight instance reaches Claude through the local proxy (bench/providers/proxy.ts) under its own tag, so the
# bench can bill a case exactly by running one case per instance at a time. Containers hold only a dummy key.
#   sh bench/providers/up.sh [instances=1]  (each needs ~1 GB of the Docker VM under load)
N=${1:-1}
docker start bench-qdrant 2>/dev/null || docker run -d --name bench-qdrant -p 127.0.0.1:6333:6333 -v bench-qdrant-data:/qdrant/storage qdrant/qdrant:v1.15.5
docker start bench-falkordb 2>/dev/null || docker run -d --name bench-falkordb -p 127.0.0.1:6379:6379 -v bench-falkordb-data:/var/lib/falkordb/data falkordb/falkordb:latest
for i in $(seq 1 "$N"); do
  docker rm -f "bench-hindsight-$i" >/dev/null 2>&1
  docker run -d --name "bench-hindsight-$i" --shm-size=1g -p "127.0.0.1:888$i:8888" \
    -e HINDSIGHT_API_LLM_PROVIDER=anthropic -e HINDSIGHT_API_LLM_API_KEY=dummy-key-proxy-adds-real-one \
    -e HINDSIGHT_API_LLM_MODEL=claude-haiku-5-5 -e "HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:8787/t/hs$i" \
    -e HINDSIGHT_API_LLM_MAX_CONCURRENT=8 -v "bench-hindsight-$i-data:/home/hindsight/.pg0" \
    ghcr.io/vectorize-io/hindsight:latest >/dev/null && echo "bench-hindsight-$i on 127.0.0.1:888$i"
done
