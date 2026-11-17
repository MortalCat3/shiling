export const systemOperationsSql = `
ALTER TABLE shiling.publications ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE shiling.publication_revisions ALTER COLUMN actor_id DROP NOT NULL;
`;
