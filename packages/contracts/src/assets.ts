import { Type, type Static } from '@sinclair/typebox';
import {
  ActionsSchema,
  DateTimeSchema,
  DecimalSchema,
  DescriptionSchema,
  RevisionSchema,
  TitleSchema,
  UuidSchema,
} from './common.js';
import { AssetTypeSchema } from './uploads.js';

export const AssetLifecycleSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('active'),
  Type.Literal('archived'),
]);
export const ArtifactDescriptorSchema = Type.Object(
  {
    id: UuidSchema,
    role: Type.String(),
    mediaType: Type.String(),
    bytes: DecimalSchema,
    width: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    height: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export const TeamAssetSchema = Type.Object(
  {
    id: UuidSchema,
    typeId: AssetTypeSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    owner: Type.Object(
      { id: UuidSchema, displayName: Type.String() },
      { additionalProperties: false },
    ),
    lifecycle: AssetLifecycleSchema,
    currentVersionId: Type.Union([UuidSchema, Type.Null()]),
    revision: RevisionSchema,
    tags: Type.Array(
      Type.Object(
        {
          id: UuidSchema,
          name: Type.String(),
          state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
        },
        { additionalProperties: false },
      ),
    ),
    favorite: Type.Boolean(),
    publicationState: Type.Union([
      Type.Literal('none'),
      Type.Literal('active'),
      Type.Literal('withdrawn'),
    ]),
    artifacts: Type.Array(ArtifactDescriptorSchema),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    actions: ActionsSchema,
  },
  { additionalProperties: false },
);
export type TeamAsset = Static<typeof TeamAssetSchema>;
export const AssetEditSchema = Type.Object(
  {
    title: Type.Optional(TitleSchema),
    description: Type.Optional(DescriptionSchema),
    tagIds: Type.Optional(Type.Array(UuidSchema, { maxItems: 20, uniqueItems: true })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const DeliveryRequestSchema = Type.Object(
  {
    artifactId: UuidSchema,
    purpose: Type.Union([
      Type.Literal('download'),
      Type.Literal('preview'),
      Type.Literal('playback'),
    ]),
  },
  { additionalProperties: false },
);
export const DeliveryGrantSchema = Type.Object(
  {
    url: Type.String(),
    method: Type.Literal('GET'),
    expiresAt: DateTimeSchema,
    contentType: Type.String(),
    downloadName: Type.String(),
    rangeSupported: Type.Boolean(),
  },
  { additionalProperties: false },
);
