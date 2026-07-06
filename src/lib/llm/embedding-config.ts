/**
 * Embedding provider + dimensions — FROZEN AT M0 (blueprint §3, §13.2).
 *
 * Voyage is the named exception to Anthropic-only generation: Anthropic has
 * no embeddings API. The schema imports EMBEDDING_DIMENSIONS so the vector
 * columns and this constant cannot drift apart; a schema/constant agreement
 * test enforces it against the live database. Changing the dimension after
 * M0 is a re-embed migration of every vector column, by design.
 */
export const EMBEDDING_MODEL = "voyage-3.5";
export const EMBEDDING_DIMENSIONS = 1024;
