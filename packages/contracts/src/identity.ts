import { Type, type Static } from '@sinclair/typebox';
import { DateTimeSchema, RevisionSchema, UuidSchema } from './common.js';
import { PermissionKeySchema } from './permissions.js';

export const LoginNameSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: '^\\s*[A-Za-z0-9._-]{3,64}\\s*$',
});
export const PasswordSchema = Type.String({ minLength: 12, maxLength: 256 });
export const DisplayNameSchema = Type.String({ minLength: 1, maxLength: 80 });
export const UserStatusSchema = Type.Union([
  Type.Literal('invited'),
  Type.Literal('active'),
  Type.Literal('suspended'),
]);
export const RoleSchema = Type.Object(
  {
    id: UuidSchema,
    key: Type.String(),
    name: Type.String(),
    kind: Type.Union([Type.Literal('system'), Type.Literal('custom')]),
    revision: RevisionSchema,
  },
  { additionalProperties: false },
);
export const UserSchema = Type.Object(
  {
    id: UuidSchema,
    displayName: DisplayNameSchema,
    status: UserStatusSchema,
    roleId: UuidSchema,
    revision: RevisionSchema,
  },
  { additionalProperties: false },
);
export const SessionSchema = Type.Object(
  {
    user: UserSchema,
    role: RoleSchema,
    permissionKeys: Type.Array(PermissionKeySchema),
    authzVersion: Type.String(),
    csrfToken: Type.String(),
    expiresAt: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type User = Static<typeof UserSchema>;
export type Role = Static<typeof RoleSchema>;
export type Session = Static<typeof SessionSchema>;
export const LoginRequestSchema = Type.Object(
  { loginName: LoginNameSchema, password: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export const InitializeRequestSchema = Type.Object(
  {
    setupToken: Type.String({ minLength: 1, maxLength: 512 }),
    loginName: LoginNameSchema,
    displayName: DisplayNameSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false },
);
export const ReauthenticateRequestSchema = Type.Object(
  { password: Type.String({ minLength: 1, maxLength: 256 }) },
  { additionalProperties: false },
);
export const ChangePasswordRequestSchema = Type.Object(
  { currentPassword: Type.String({ minLength: 1, maxLength: 256 }), newPassword: PasswordSchema },
  { additionalProperties: false },
);
export const TokenRequestSchema = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 512 }) },
  { additionalProperties: false },
);
export const InvitationAcceptRequestSchema = Type.Object(
  {
    token: Type.String({ minLength: 16, maxLength: 512 }),
    loginName: LoginNameSchema,
    displayName: DisplayNameSchema,
    password: PasswordSchema,
  },
  { additionalProperties: false },
);
export const InvitationCreateRequestSchema = Type.Object(
  {
    loginName: Type.Optional(LoginNameSchema),
    roleId: UuidSchema,
    expiresInSeconds: Type.Optional(Type.Integer({ minimum: 300, maximum: 604800 })),
  },
  { additionalProperties: false },
);
export const InvitationSchema = Type.Object(
  {
    id: UuidSchema,
    userId: UuidSchema,
    revision: RevisionSchema,
    state: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked')]),
    expiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    reservedLoginName: Type.Union([LoginNameSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Invitation = Static<typeof InvitationSchema>;
export const RecoveryCompleteRequestSchema = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 512 }), newPassword: PasswordSchema },
  { additionalProperties: false },
);
export const RecoveryInspectResponseSchema = Type.Object(
  { expiresAt: DateTimeSchema },
  { additionalProperties: false },
);
export const RecoveryTokenCreateResponseSchema = Type.Object(
  {
    token: Type.Union([Type.String({ minLength: 16, maxLength: 512 }), Type.Null()]),
    expiresAt: DateTimeSchema,
    replayed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const ChangeMemberRoleRequestSchema = Type.Object(
  { roleId: UuidSchema, expectedRevision: RevisionSchema },
  { additionalProperties: false },
);
export const BrandSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.String({ maxLength: 500 }),
    primaryColor: Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }),
    logoUrl: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    faviconUrl: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export const BootstrapSchema = Type.Object(
  {
    initialized: Type.Boolean(),
    name: Type.String(),
    publicEnabled: Type.Boolean(),
    brand: BrandSchema,
    loginMethods: Type.Array(Type.Literal('password')),
  },
  { additionalProperties: false },
);
