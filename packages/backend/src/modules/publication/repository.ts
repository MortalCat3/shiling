import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../ports/database.js';
import type { AssetRow } from '../assets/repository.js';
import { appendAudit } from '../administration/audit.js';

export interface PublicationRow {
  id: string;
  asset_id: string;
  state: 'active' | 'withdrawn';
  revision: string;
  current_revision_id: string;
  version_id: string;
}
export async function currentPublication(
  tx: Transaction,
  assetId: string,
): Promise<PublicationRow | null> {
  return (
    (
      await tx.query<PublicationRow>(
        `SELECT p.*,r.version_id FROM shiling.publications p JOIN shiling.publication_revisions r ON r.id=p.current_revision_id WHERE p.asset_id=$1 FOR UPDATE OF p`,
        [assetId],
      )
    ).rows[0] ?? null
  );
}
export async function withdrawPublication(
  tx: Transaction,
  asset: AssetRow,
  actorId: string,
  requestId: string,
  reason = 'owner_withdraw',
): Promise<PublicationRow | null> {
  const publication = await currentPublication(tx, asset.id);
  if (!publication || publication.state === 'withdrawn') return publication;
  const revisionId = randomUUID();
  const nextRevision = String(BigInt(publication.revision) + 1n);
  await tx.query(
    "INSERT INTO shiling.publication_revisions(id,publication_id,asset_id,revision_no,action,version_id,source_asset_revision,actor_id,reason_code) VALUES($1,$2,$3,$4,'withdraw',$5,$6,$7,$8)",
    [
      revisionId,
      publication.id,
      asset.id,
      nextRevision,
      publication.version_id,
      asset.revision,
      actorId,
      reason,
    ],
  );
  await tx.query(
    "UPDATE shiling.publications SET state='withdrawn',current_revision_id=$2,updated_by=$3 WHERE id=$1",
    [publication.id, revisionId, actorId],
  );
  await appendAudit(tx, {
    actorId,
    action: 'publication.withdrawn',
    resourceType: 'asset',
    resourceId: asset.id,
    requestId,
    changes: { reason, publicationRevision: nextRevision },
  });
  return {
    ...publication,
    state: 'withdrawn',
    revision: nextRevision,
    current_revision_id: revisionId,
  };
}
