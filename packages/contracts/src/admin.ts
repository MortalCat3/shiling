import { Type } from '@sinclair/typebox';
import { DateTimeSchema, RevisionSchema, UuidSchema } from './common.js';
import { BrandSchema } from './identity.js';
import { PermissionKeySchema } from './permissions.js';
import { AssetTypeSchema } from './uploads.js';

export const RoleWriteSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    permissionKeys: Type.Array(PermissionKeySchema, { uniqueItems: true, maxItems: 26 }),
  },
  { additionalProperties: false },
);
export const BrandSettingsSchema = BrandSchema;
export const AssetTypeCapabilitySchema = Type.Object(
  {
    id: AssetTypeSchema,
    name: Type.String({ minLength: 1, maxLength: 40 }),
    acceptUploads: Type.Boolean(),
    executePreview: Type.Boolean(),
    extensions: Type.Array(Type.String({ minLength: 1, maxLength: 16 }), {
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    }),
    maxBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const AssetTypeSettingsPatchSchema = Type.Object(
  {
    id: AssetTypeSchema,
    acceptUploads: Type.Boolean(),
    maxBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const ProductSettingsSchema = Type.Object(
  {
    revision: RevisionSchema,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    brand: BrandSettingsSchema,
    types: Type.Array(AssetTypeCapabilitySchema, { minItems: 3, maxItems: 3 }),
    publicEnabled: Type.Boolean(),
    executePreview: Type.Boolean(),
    logoBrandingAssetId: Type.Union([UuidSchema, Type.Null()]),
    faviconBrandingAssetId: Type.Union([UuidSchema, Type.Null()]),
    publicationImpact: Type.Object(
      { eligibleActiveCount: Type.Integer({ minimum: 0 }), evaluatedAt: DateTimeSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const ProductSettingsPatchSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    brand: Type.Optional(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 80 }),
          description: Type.String({ maxLength: 500 }),
          primaryColor: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }),
        },
        { additionalProperties: false },
      ),
    ),
    types: Type.Optional(
      Type.Array(AssetTypeSettingsPatchSchema, {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
    ),
    publicEnabled: Type.Optional(Type.Boolean()),
    executePreview: Type.Optional(Type.Boolean()),
    logoBrandingAssetId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    faviconBrandingAssetId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);
