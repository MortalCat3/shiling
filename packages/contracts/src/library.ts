import { Type } from '@sinclair/typebox';
import {
  ActionsSchema,
  DescriptionSchema,
  RevisionSchema,
  TitleSchema,
  UuidSchema,
} from './common.js';

export const TagSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 40 }),
    description: DescriptionSchema,
    state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    revision: RevisionSchema,
  },
  { additionalProperties: false },
);
export const TagCreateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 40 }),
    description: Type.Optional(DescriptionSchema),
  },
  { additionalProperties: false },
);
export const CollectionSchema = Type.Object(
  {
    id: UuidSchema,
    name: TitleSchema,
    description: DescriptionSchema,
    ownerId: UuidSchema,
    state: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
    revision: RevisionSchema,
    visibleItemCount: Type.Integer({ minimum: 0 }),
    actions: ActionsSchema,
  },
  { additionalProperties: false },
);
export const CollectionWriteSchema = Type.Object(
  { name: TitleSchema, description: DescriptionSchema },
  { additionalProperties: false },
);
export const CollectionItemsSchema = Type.Object(
  {
    expectedRevision: RevisionSchema,
    action: Type.Union([Type.Literal('add'), Type.Literal('remove')]),
    assetIds: Type.Array(UuidSchema, { uniqueItems: true, minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);
export const AssetBatchSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('archive'),
      Type.Literal('restore'),
      Type.Literal('addTags'),
      Type.Literal('removeTags'),
    ]),
    items: Type.Array(
      Type.Object(
        { assetId: UuidSchema, expectedRevision: RevisionSchema },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    tagIds: Type.Optional(Type.Array(UuidSchema, { uniqueItems: true, maxItems: 20 })),
  },
  { additionalProperties: false },
);
