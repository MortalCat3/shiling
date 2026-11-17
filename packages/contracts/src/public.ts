import { Type, type Static } from '@sinclair/typebox';
import {
  DateTimeSchema,
  DecimalSchema,
  DescriptionSchema,
  RevisionSchema,
  TitleSchema,
  UuidSchema,
} from './common.js';
import { AssetTypeSchema } from './uploads.js';
import { ArtifactDescriptorSchema } from './assets.js';

export const PublishRequestSchema = Type.Object(
  {
    expectedAssetRevision: RevisionSchema,
    expectedPublicationRevision: DecimalSchema,
    versionId: UuidSchema,
    publicMetadata: Type.Object(
      {
        title: TitleSchema,
        description: DescriptionSchema,
        tagIds: Type.Array(UuidSchema, { maxItems: 20, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const PublicAssetSchema = Type.Object(
  {
    id: UuidSchema,
    typeId: AssetTypeSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    publicTags: Type.Array(Type.String()),
    publicationRevision: RevisionSchema,
    publishedAt: DateTimeSchema,
    format: Type.String(),
    width: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    height: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    duration: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    artifacts: Type.Array(ArtifactDescriptorSchema),
  },
  { additionalProperties: false },
);
export type PublicAsset = Static<typeof PublicAssetSchema>;
