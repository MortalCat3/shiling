import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AppError,
  type BrandingPurpose,
  type BrandingService,
  type IdentityService,
} from '@shiling/backend';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { ApiConfig } from '../config.js';
import { requireMutationSession } from '../http/security.js';

export interface BrandingRouteServices {
  readonly branding: BrandingService;
  readonly identity: IdentityService;
}

interface MultipartField {
  readonly type: 'field';
  readonly fieldname: string;
  readonly value: unknown;
}

interface MultipartFile {
  readonly type: 'file';
  readonly fieldname: string;
  readonly mimetype: string;
  readonly file: AsyncIterable<Uint8Array> & { readonly truncated?: boolean };
}

type MultipartPart = MultipartField | MultipartFile;

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_777_216;
const BrandingResponseSchema = Type.Object(
  { brandingAssetId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const BrandingParamsSchema = Type.Object(
  { purpose: Type.Union([Type.Literal('logo'), Type.Literal('favicon')]) },
  { additionalProperties: false },
);

function multipartParts(request: FastifyRequest): AsyncIterable<MultipartPart> {
  const candidate = request as unknown as {
    parts(options: {
      limits: {
        files: number;
        fields: number;
        parts: number;
        fileSize: number;
      };
    }): AsyncIterable<MultipartPart>;
  };
  if (typeof candidate.parts !== 'function') {
    throw new AppError(415, 'MULTIPART_REQUIRED', '请使用 multipart/form-data 上传品牌图片。');
  }
  return candidate.parts({
    limits: { files: 1, fields: 1, parts: 2, fileSize: MAX_UPLOAD_BYTES },
  });
}

async function readCandidate(request: FastifyRequest): Promise<{
  purpose: BrandingPurpose;
  bytes: Buffer;
}> {
  let purpose: BrandingPurpose | undefined;
  let bytes: Buffer | undefined;
  try {
    for await (const part of multipartParts(request)) {
      if (part.type === 'field') {
        if (part.fieldname !== 'purpose' || (part.value !== 'logo' && part.value !== 'favicon')) {
          throw new AppError(400, 'INVALID_BRANDING_PURPOSE', '品牌图片用途无效。');
        }
        purpose = part.value;
        continue;
      }
      if (part.fieldname !== 'file' || bytes !== undefined) {
        throw new AppError(400, 'INVALID_BRANDING_UPLOAD', '品牌图片上传字段无效。');
      }
      const mediaType = part.mimetype.split(';', 1)[0]?.trim().toLowerCase();
      if (!mediaType || !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) {
        throw new AppError(
          415,
          'UNSUPPORTED_BRANDING_IMAGE',
          '仅支持静态 PNG、JPEG 或 WebP 图片。',
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        const value = Buffer.from(chunk);
        total += value.length;
        if (total > MAX_UPLOAD_BYTES) {
          throw new AppError(413, 'BRANDING_ASSET_TOO_LARGE', '品牌图片不能超过 2 MB。');
        }
        chunks.push(value);
      }
      if (part.file.truncated) {
        throw new AppError(413, 'BRANDING_ASSET_TOO_LARGE', '品牌图片不能超过 2 MB。');
      }
      bytes = Buffer.concat(chunks, total);
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError(413, 'BRANDING_ASSET_TOO_LARGE', '品牌图片不能超过 2 MB。');
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      throw new AppError(415, 'MULTIPART_REQUIRED', '请使用 multipart/form-data 上传品牌图片。');
    }
    if (code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') {
      throw new AppError(400, 'INVALID_BRANDING_UPLOAD', '品牌图片上传字段数量无效。');
    }
    throw error;
  }
  if (!purpose || !bytes?.length) {
    throw new AppError(400, 'INVALID_BRANDING_UPLOAD', '请提供图片和用途。');
  }
  return { purpose, bytes };
}

async function normalizeRaster(
  source: Buffer,
  purpose: BrandingPurpose,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const metadata = await sharp(source, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new AppError(415, 'UNSUPPORTED_BRANDING_IMAGE', '仅支持静态 PNG、JPEG 或 WebP 图片。');
    }
    const maximum = purpose === 'favicon' ? 512 : 1024;
    const normalized = await sharp(source, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: maximum,
        height: maximum,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    if (
      !normalized.info.width ||
      !normalized.info.height ||
      normalized.data.length > 8 * 1024 * 1024
    ) {
      throw new AppError(413, 'BRANDING_ASSET_TOO_LARGE', '规范化后的品牌图片过大。');
    }
    return {
      bytes: normalized.data,
      width: normalized.info.width,
      height: normalized.info.height,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(415, 'INVALID_BRANDING_IMAGE', '品牌图片无法安全解码。');
  }
}

export function registerBrandingRoutes(
  instance: FastifyInstance,
  config: ApiConfig,
  services: BrandingRouteServices,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/api/v1/team/admin/branding-assets',
    {
      schema: { response: { 201: BrandingResponseSchema } },
      config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { token } = await requireMutationSession(request, config, services.identity);
      await services.branding.assertCanCreate(token);
      const candidate = await readCandidate(request);
      const normalized = await normalizeRaster(candidate.bytes, candidate.purpose);
      const result = await services.branding.createCandidate(
        token,
        {
          purpose: candidate.purpose,
          source: Readable.from([normalized.bytes]),
          mediaType: 'image/png',
          width: normalized.width,
          height: normalized.height,
          expectedBytes: normalized.bytes.length,
        },
        request.id,
      );
      return reply.code(201).header('Cache-Control', 'no-store').send(result);
    },
  );

  app.get(
    '/api/v1/branding/:purpose',
    { schema: { params: BrandingParamsSchema } },
    async (request, reply) => {
      const asset = await services.branding.openActive(request.params.purpose);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Content-Type', asset.mediaType)
        .header('Content-Length', String(asset.bytes))
        .header('ETag', `"${asset.sha256}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(asset.stream);
    },
  );
}
