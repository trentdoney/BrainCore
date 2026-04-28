-- Manual rollback only: restore pre-020 embedding_index vector_role CHECK.

ALTER TABLE IF EXISTS preserve.embedding_index
  DROP CONSTRAINT IF EXISTS chk_embedding_index_vector_role;

ALTER TABLE IF EXISTS preserve.embedding_index
  ADD CONSTRAINT chk_embedding_index_vector_role CHECK (
    vector_role IN ('content','title','summary','entity','image','layout','region','query','other')
  );
