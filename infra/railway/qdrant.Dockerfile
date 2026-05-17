# Qdrant for Railway.
# Mount a persistent volume at /qdrant/storage so vectors survive restarts.
FROM qdrant/qdrant:latest
EXPOSE 6333 6334
