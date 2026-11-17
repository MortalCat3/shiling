import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const UuidSchema = Type.String({ format: 'uuid' });
export const RevisionSchema = Type.String({ pattern: '^[1-9][0-9]*$' });
export const DecimalSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
export const DateTimeSchema = Type.String({ format: 'date-time' });
export const TitleSchema = Type.String({ minLength: 1, maxLength: 200 });
export const DescriptionSchema = Type.String({ maxLength: 5000 });
export const EmptySchema = Type.Object({}, { additionalProperties: false });
export const FieldErrorSchema = Type.Object(
  { field: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
export const ProblemSchema = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.String(),
    instance: Type.String(),
    code: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    fieldErrors: Type.Optional(Type.Array(FieldErrorSchema)),
  },
  { additionalProperties: false },
);
export type Problem = Static<typeof ProblemSchema>;
export const SafeErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean(),
    requestId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const OrganizationWarningSchema = Type.Object(
  { code: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
export const ActionsSchema = Type.Record(Type.String(), Type.Boolean());
export const PageInfoSchema = Type.Object(
  { nextCursor: Type.Union([Type.String(), Type.Null()]), hasMore: Type.Boolean() },
  { additionalProperties: false },
);
export function pageSchema<T extends TSchema>(item: T) {
  return Type.Object(
    { items: Type.Array(item), pageInfo: PageInfoSchema },
    { additionalProperties: false },
  );
}
export const ExpectedRevisionSchema = Type.Object(
  { expectedRevision: RevisionSchema },
  { additionalProperties: false },
);
export const PageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
