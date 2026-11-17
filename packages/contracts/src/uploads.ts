import { Type, type Static } from '@sinclair/typebox';
import {
  ActionsSchema,
  DecimalSchema,
  DescriptionSchema,
  OrganizationWarningSchema,
  RevisionSchema,
  SafeErrorSchema,
  TitleSchema,
  UuidSchema,
} from './common.js';

export const AssetTypeSchema = Type.Union([
  Type.Literal('image'),
  Type.Literal('video'),
  Type.Literal('web_motion'),
]);
export const TransportStateSchema = Type.Union(
  ['pending', 'uploading', 'verifying', 'verified', 'failed', 'canceled', 'expired'].map((value) =>
    Type.Literal(value),
  ),
);
export const ProcessingStateSchema = Type.Union(
  ['processing', 'ready', 'failed', 'canceled'].map((value) => Type.Literal(value)),
);
export const UploadUiStateSchema = Type.Union(
  ['queued', 'uploading', 'verifying', 'processing', 'ready', 'failed', 'canceled', 'expired'].map(
    (value) => Type.Literal(value),
  ),
);
export const UploadMetadataSchema = Type.Object(
  {
    title: TitleSchema,
    description: DescriptionSchema,
    tagIds: Type.Array(UuidSchema, { maxItems: 20, uniqueItems: true }),
    collectionIds: Type.Array(UuidSchema, { maxItems: 20, uniqueItems: true }),
  },
  { additionalProperties: false },
);
export const UploadBatchCreateSchema = Type.Object(
  { clientBatchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) },
  { additionalProperties: false },
);
export const UploadItemCreateSchema = Type.Object(
  {
    clientItemId: Type.String({ minLength: 1, maxLength: 128 }),
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    declaredBytes: DecimalSchema,
    declaredMediaType: Type.String({ maxLength: 128 }),
    typeHint: Type.Optional(AssetTypeSchema),
    expectedSha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    initialMetadata: UploadMetadataSchema,
  },
  { additionalProperties: false },
);
export const UploadMetadataResponseSchema = Type.Object(
  { itemId: UuidSchema, revision: RevisionSchema, metadata: UploadMetadataSchema },
  { additionalProperties: false },
);
export const UploadItemSchema = Type.Object(
  {
    id: UuidSchema,
    batchId: UuidSchema,
    clientItemId: Type.String(),
    fileName: Type.String(),
    attemptId: Type.Union([UuidSchema, Type.Null()]),
    transportState: TransportStateSchema,
    processingState: Type.Union([ProcessingStateSchema, Type.Null()]),
    uiState: UploadUiStateSchema,
    assetId: Type.Union([UuidSchema, Type.Null()]),
    revision: RevisionSchema,
    metadata: UploadMetadataSchema,
    safeError: Type.Union([SafeErrorSchema, Type.Null()]),
    organizationWarnings: Type.Array(OrganizationWarningSchema),
    progress: Type.Object(
      { receivedBytes: Type.Union([DecimalSchema, Type.Null()]), totalBytes: DecimalSchema },
      { additionalProperties: false },
    ),
    actions: ActionsSchema,
  },
  { additionalProperties: false },
);
export type UploadItem = Static<typeof UploadItemSchema>;
export type UploadMetadata = Static<typeof UploadMetadataSchema>;
export const UploadRetrySchema = Type.Object(
  { scope: Type.Union([Type.Literal('transfer'), Type.Literal('processing')]) },
  { additionalProperties: false },
);
export const UploadCompleteSchema = Type.Object(
  {
    parts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            partNumber: Type.Integer({ minimum: 1, maximum: 10000 }),
            etag: Type.String({ maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 10000 },
      ),
    ),
  },
  { additionalProperties: false },
);
