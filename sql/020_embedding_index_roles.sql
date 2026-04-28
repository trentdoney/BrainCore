-- BrainCore Preserve Schema: embedding-index role vocabulary for population jobs.
--
-- Keeps embedding_dimension fixed at 384 and expands only the role CHECK
-- vocabulary needed by embedding_index population.

ALTER TABLE preserve.embedding_index
  DROP CONSTRAINT IF EXISTS chk_embedding_index_vector_role;

ALTER TABLE preserve.embedding_index
  ADD CONSTRAINT chk_embedding_index_vector_role CHECK (
    vector_role IN (
      'content',
      'title',
      'summary',
      'entity',
      'image',
      'layout',
      'region',
      'query',
      'other',
      'text',
      'evidence',
      'procedure',
      'media_caption',
      'visual_ocr',
      'visual_caption'
    )
  );
